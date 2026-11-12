import { applicationVersion } from "./version.js";
import { sharedResponseCache } from "../api/cache/index.js";
import { requestDependencies } from "./policy.js";
import {
  McpServer,
  ResourceTemplate,
  fromJsonSchema,
  ProtocolError,
  ProtocolErrorCode,
} from "@modelcontextprotocol/server";
import type { JsonSchemaType, Tool } from "@modelcontextprotocol/server";
import {
  toolNames,
  inputJsonSchemas,
  outputJsonSchemas,
  toolAnnotations,
  evidenceCaution,
  assertHonest,
  PERSONALIZED_TOOLS,
} from "./schemas.js";
import {
  callPluginTool,
  loadedPluginTools,
  pluginToolDefinition,
} from "../plugins/mcp-tools.js";
import {
  callTool,
  limits,
  MAX_INPUT_ELEMENTS,
  MAX_OUTPUT_BYTES,
  MAX_TOOL_LIST_BYTES,
  TOOL_LIST_PAGE_SIZE,
  coreToolDefinition,
  toolDescriptions,
  messageBytes,
  mayCall,
  errorResult,
} from "./tools.js";
import type { McpDependencies } from "./tools.js";
import type { ToolName, ToolOutput } from "./schemas.js";
import { entityId } from "../services/discovery.js";
import { getDataStatus } from "../services/provenance.js";
import { dataGeneration } from "../api/cache/generation.js";
import { projector } from "./projection.js";
import { ToolError, cursorCodec } from "./cursor.js";
import { registerEstimateTool } from "./medicare-estimate.js";

export type { McpDependencies, McpPolicy, McpPrincipal } from "./tools.js";
export const instructions =
  "OpenPlans reads imported public data only. Call get_data_status first to inspect loaded scopes and gaps. " +
  "Use search for literal discovery and fetch with returned typed IDs for full records; arbitrary URLs and paths are refused. " +
  "Every answer carries provenance and an evidence status. Unknown means missing or incomplete evidence, never not covered or not in network. " +
  "quote_plans quotes plans by age and ZIP without income or subsidies. quote_premiums adds income and subsidy estimates; an operator may require a token for it. " +
  "Quotes are not bindable and never determine CSR eligibility. " +
  "Follow next_cursor with the same filters; restart after CURSOR_EXPIRED. Results describe the current local data generation, not a live publisher check.";

const mutable = { ttlMs: 0, cacheScope: "private" as const };
const definition = { ttlMs: 300_000, cacheScope: "public" as const };
const immutable = { ttlMs: 3_600_000, cacheScope: "public" as const };

/** In-process factory only. Transport/authentication, request cancellation and HTTP limits belong to the host. */
export function buildServer(deps: McpDependencies): McpServer {
  deps = { ...deps, cache: deps.cache ?? sharedResponseCache(deps.db) };
  const server = new McpServer(
    { name: "openplans", version: applicationVersion },
    {
      instructions,
      maxToolInputElements: MAX_INPUT_ELEMENTS,
      capabilities: {
        tools: { listChanged: false },
        resources: { listChanged: false },
      },
      supportedProtocolVersions: ["2026-07-28", "2025-11-25", "2025-06-18"],
      cacheHints: {
        "tools/list": mutable,
        "prompts/list": definition,
        "resources/list": definition,
        "resources/templates/list": definition,
        "resources/read": mutable,
        "server/discover": immutable,
      },
    },
  );
  const definitions: Tool[] = [];
  for (const tool of toolNames) {
    // Denied personalized tools are never registered. A disabled public quote tool stays
    // callable so that it answers QUOTING_DISABLED, but it is not listed.
    if (PERSONALIZED_TOOLS.has(tool) && !mayCall(deps, tool)) continue;
    const [title, description] = toolDescriptions[tool];
    if (mayCall(deps, tool)) definitions.push(coreToolDefinition(tool));
    server.registerTool(
      tool,
      {
        title,
        description: `${description} ${evidenceCaution}`,
        annotations: toolAnnotations,
        inputSchema: fromJsonSchema(inputJsonSchemas[tool]),
        outputSchema: fromJsonSchema(outputJsonSchemas[tool]),
      },
      async (args, ctx) => {
        const token = ctx.mcpReq._meta?.progressToken;
        if (token !== undefined)
          await ctx.mcpReq.notify({
            method: "notifications/progress",
            params: { progressToken: token, progress: 0 },
          });
        return callTool(
          requestDependencies(deps, ctx.mcpReq.signal),
          tool,
          args,
          ctx.mcpReq.id,
        );
      },
    );
  }
  // The default-off Medicare estimate follows the core tools when both switches are on and the
  // caller holds its grant. Otherwise nothing is registered and discovery bytes stay the same.
  // The plugin loader counts it in the page budget, so it always fits.
  const estimate = registerEstimateTool(server, deps);
  if (estimate) definitions.push(estimate);
  // Plugin tools follow the core list, so the first entries never move for existing clients.
  for (const tool of deps.pluginTools ?? loadedPluginTools()) {
    const listed = pluginToolDefinition(tool.spec);
    definitions.push(listed);
    server.registerTool(
      listed.name,
      {
        title: listed.title,
        description: listed.description,
        annotations: toolAnnotations,
        inputSchema: fromJsonSchema(listed.inputSchema as JsonSchemaType),
        outputSchema: fromJsonSchema(listed.outputSchema as JsonSchemaType),
      },
      async (args, ctx) =>
        callPluginTool(
          requestDependencies(deps, ctx.mcpReq.signal),
          tool.spec,
          args,
          ctx.mcpReq.signal,
          ctx.mcpReq.id,
        ),
    );
  }
  // Keep the catalogue on one page; signed cursors still resume earlier listings.
  server.server.setRequestHandler("tools/list", (request, ctx) => {
    const codec = cursorCodec(deps.cursorSecret, deps.now),
      binding = {
        tool: "tools/list",
        filters: definitions.map((t) => t.name),
        generation: "mcp-definitions-v1",
        scope: deps.principal?.id ?? "anonymous",
      };
    try {
      const offset = codec.read(request.params?.cursor, binding),
        tools = definitions.slice(offset, offset + TOOL_LIST_PAGE_SIZE);
      if (offset > definitions.length) throw new ToolError("INVALID_CURSOR");
      if (offset === definitions.length) return { tools: [] };
      while (tools.length) {
        const nextCursor =
          offset + tools.length < definitions.length
            ? codec.issue(binding, offset + tools.length)
            : undefined;
        const result = { tools, ...(nextCursor ? { nextCursor } : {}) };
        if (
          Buffer.byteLength(
            JSON.stringify({ jsonrpc: "2.0", id: ctx.mcpReq.id, result }),
          ) +
            512 <=
          MAX_TOOL_LIST_BYTES
        )
          return result;
        tools.pop();
      }
      throw new ToolError("RESULT_TOO_LARGE");
    } catch (error) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        error instanceof ToolError ? error.code : "INVALID_CURSOR",
      );
    }
  });
  function resource(
    uri: URL,
    output: ToolOutput<ToolName>,
    requestId: string | number,
  ) {
    let result = {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(output),
        },
      ],
    };
    if (
      Buffer.byteLength(
        JSON.stringify({ jsonrpc: "2.0", id: requestId, result }),
      ) +
        512 >
      MAX_OUTPUT_BYTES
    ) {
      const failed = errorResult(
        "fetch",
        new ToolError("RESULT_TOO_LARGE"),
        output.data_generation,
        new Date((deps.now ?? Date.now)()).toISOString(),
      ).structuredContent;
      result = {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(failed),
          },
        ],
      };
    }
    return result;
  }
  server.registerResource(
    "availability",
    "openplans://availability",
    {
      title: "Loaded data and gaps",
      mimeType: "application/json",
      description:
        "Current local capability manifest; use get_data_status and its cursor for all rows.",
      cacheHint: mutable,
    },
    async (uri, ctx) =>
      resource(
        uri,
        (
          await callTool(
            requestDependencies(deps, ctx.mcpReq.signal),
            "get_data_status",
            {},
            ctx.mcpReq.id,
          )
        ).structuredContent,
        ctx.mcpReq.id,
      ),
  );

  server.registerResource(
    "sources",
    "openplans://sources",
    {
      title: "Public source metadata",
      mimeType: "application/json",
      description:
        "Bounded publication metadata referenced by the loaded manifest; no raw paths or request credentials.",
      cacheHint: mutable,
    },
    async (uri, ctx) => {
      try {
        const db = requestDependencies(deps, ctx.mcpReq.signal).db;
        const native = await getDataStatus(db),
          p = await projector(db, native.entries.slice(0, 10));
        const ids = [...p.metadata.keys()].sort(),
          records = ids.slice(0, 25).map(p.snapshot);
        const generation = await dataGeneration(db);
        if (generation !== native.data_generation)
          throw new ToolError("DATA_CHANGED");
        const output = {
          schema_version: "1" as const,
          status: "ok" as const,
          data_generation: generation,
          data: {
            id: uri.href,
            title: "Public source metadata",
            url: uri.href,
            text: "",
            entity: "dataset" as const,
            section: "provenance" as const,
            records,
          },
          provenance: [...p.sources.values()],
          notes: [
            "For remaining sources, page get_data_status and read each snapshot via openplans://provenance/{snapshot_id}.",
          ],
          truncated: ids.length > records.length || native.entries.length > 10,
          freshness: {
            checked_at: new Date((deps.now ?? Date.now)()).toISOString(),
            status: "unknown" as const,
          },
          page: null,
          error: null,
        };
        assertHonest("fetch", output, p.context);
        if (messageBytes(output) > MAX_OUTPUT_BYTES)
          throw new ToolError("RESULT_TOO_LARGE");
        return resource(uri, output, ctx.mcpReq.id);
      } catch (error) {
        return resource(
          uri,
          errorResult(
            "fetch",
            error,
            "unknown",
            new Date((deps.now ?? Date.now)()).toISOString(),
          ).structuredContent,
          ctx.mcpReq.id,
        );
      }
    },
  );
  server.registerResource(
    "limits",
    "openplans://limits",
    {
      title: "Query limits",
      mimeType: "application/json",
      cacheHint: definition,
    },
    async (uri, ctx) => {
      // This resource describes static adapter policy and remains readable before a DB is available.
      const output = {
        schema_version: "1" as const,
        status: "ok" as const,
        data_generation: "not_evaluated",
        data: {
          id: uri.href,
          title: "Query limits",
          url: uri.href,
          text: JSON.stringify(limits),
          entity: "dataset" as const,
          section: "summary" as const,
          records: [],
        },
        provenance: [],
        notes: [
          "These are adapter policy limits, not claims about publisher data.",
        ],
        truncated: false,
        freshness: {
          checked_at: new Date((deps.now ?? Date.now)()).toISOString(),
          status: "unknown" as const,
        },
        page: null,
        error: null,
      };
      assertHonest("fetch", output);
      return resource(uri, output, ctx.mcpReq.id);
    },
  );
  server.registerResource(
    "provenance",
    new ResourceTemplate("openplans://provenance/{snapshot_id}", {
      list: undefined,
    }),
    {
      title: "Snapshot provenance",
      mimeType: "application/json",
      cacheHint: immutable,
    },
    async (uri, variables, ctx) =>
      resource(
        uri,
        (
          await callTool(
            requestDependencies(deps, ctx.mcpReq.signal),
            "fetch",
            {
              id: entityId(
                "snapshot",
                decodeURIComponent(String(variables.snapshot_id)),
              ),
              section: "provenance",
            },
            ctx.mcpReq.id,
          )
        ).structuredContent,
        ctx.mcpReq.id,
      ),
  );
  server.registerResource(
    "plan",
    new ResourceTemplate("openplans://plan/{year}/{plan_id}", {
      list: undefined,
    }),
    { title: "Plan summary", mimeType: "application/json", cacheHint: mutable },
    async (uri, variables, ctx) =>
      resource(
        uri,
        (
          await callTool(
            requestDependencies(deps, ctx.mcpReq.signal),
            "get_plan",
            {
              year: Number(variables.year),
              plan_ref: decodeURIComponent(String(variables.plan_id)),
            },
            ctx.mcpReq.id,
          )
        ).structuredContent,
        ctx.mcpReq.id,
      ),
  );
  return server;
}
