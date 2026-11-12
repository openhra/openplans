import { z } from "zod";
import type { JsonSchemaType, Tool } from "@modelcontextprotocol/server";
import type { McpToolSpec } from "@openplans/plugin-sdk";
import { ToolError } from "../mcp/cursor.js";
import { switchedCoreTools } from "../mcp/medicare-estimate.js";
import {
  envelopeShape,
  evidenceCaution,
  HonestyError,
  toolAnnotations,
  toolNames,
} from "../mcp/schemas.js";
import type { ToolName, ToolOutput } from "../mcp/schemas.js";
import {
  coreToolDefinition,
  errorResult,
  MAX_OUTPUT_BYTES,
  MAX_TOOL_LIST_BYTES,
  messageBytes,
  TOOL_LIST_PAGE_SIZE,
  toolResult,
} from "../mcp/tools.js";
import type { McpDependencies } from "../mcp/tools.js";
import { currentRegistries } from "./registries.js";
import type { Registered, RefusalCode } from "./registries.js";

/** A plugin MCP tool as the registry keeps it: the owning plugin and its spec. */
export type PluginTool = Registered<McpToolSpec<unknown, unknown>>;

/** The tools of the plugins loaded in this process, in plugin order, then registration order. */
export function loadedPluginTools(): readonly PluginTool[] {
  return currentRegistries().mcpTools;
}

/** Core and plugin tool names, for transports that log or route by tool name. */
export function isToolName(
  name: unknown,
  plugins: readonly PluginTool[] = loadedPluginTools(),
): name is string {
  return (
    typeof name === "string" &&
    (toolNames.some((core) => core === name) ||
      plugins.some((tool) => tool.spec.name === name))
  );
}

export class PluginToolSchemaError extends Error {
  constructor() {
    super("Plugin tool schemas must convert to JSON Schema objects");
    this.name = "PluginToolSchemaError";
  }
}

function objectSchema(
  schema: z.ZodType,
  io: "input" | "output",
): JsonSchemaType {
  let json: Record<string, unknown>;
  try {
    json = z.toJSONSchema(schema, { target: "draft-2020-12", io });
  } catch {
    throw new PluginToolSchemaError();
  }
  if (json.type !== "object") throw new PluginToolSchemaError();
  return json as JsonSchemaType;
}

/** The `tools/list` entry for a plugin tool, built the same way as a core entry. */
export function pluginToolDefinition(
  spec: McpToolSpec<unknown, unknown>,
): Tool {
  return {
    name: spec.name,
    title: spec.title,
    description: `${spec.description} ${evidenceCaution}`,
    annotations: toolAnnotations,
    inputSchema: objectSchema(spec.inputSchema, "input") as Tool["inputSchema"],
    outputSchema: objectSchema(
      spec.outputSchema,
      "output",
    ) as Tool["outputSchema"],
  };
}

/** Bytes of a one-page `tools/list` response, with the same 512-byte reserve the handler keeps. */
export function toolListBytes(tools: readonly Tool[]): number {
  return (
    Buffer.byteLength(
      JSON.stringify({ jsonrpc: "2.0", id: 0, result: { tools } }),
    ) + 512
  );
}

export interface ToolPageRefusal {
  readonly plugin: string;
  readonly code: Extract<
    RefusalCode,
    "mcp_tool_page_overflow" | "plugin_registration_invalid"
  >;
}

/**
 * Every core tool plus every plugin tool must fit one `tools/list` page, by count and by bytes.
 * Core tools are counted even when a host would hide one, so the result never depends on grants.
 * A core tool listed behind switches counts whenever its switches are on.
 * Returns the first plugin, in configuration order, whose tools break the page.
 */
export function toolPageRefusal(
  plugins: readonly (readonly [
    plugin: string,
    specs: readonly McpToolSpec<unknown, unknown>[],
  ])[],
): ToolPageRefusal | undefined {
  const tools = [...toolNames.map(coreToolDefinition), ...switchedCoreTools()];
  for (const [plugin, specs] of plugins) {
    for (const spec of specs) {
      try {
        tools.push(pluginToolDefinition(spec));
      } catch (error) {
        if (error instanceof PluginToolSchemaError)
          return { plugin, code: "plugin_registration_invalid" };
        throw error;
      }
    }
    if (
      tools.length > TOOL_LIST_PAGE_SIZE ||
      toolListBytes(tools) > MAX_TOOL_LIST_BYTES
    )
      return { plugin, code: "mcp_tool_page_overflow" };
  }
  return undefined;
}

const pluginEnvelope = z.strictObject({
  ...envelopeShape,
  data: z.unknown().refine((value) => value !== undefined),
});
// No core answer uses these words: missing evidence is unknown, never a denial.
const DENIALS = new Set(["not_covered", "not_in_network", "out_of_network"]);
// Positive and negative evidence claims need resolvable sources, as in core answers.
const CLAIMS = new Set([
  "listed_covered",
  "listed_participating",
  "explicitly_not_covered",
  "explicitly_not_participating",
  "not_listed",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function reject(reason: string): never {
  throw new HonestyError(reason);
}

/**
 * The honesty check for plugin answers that carry a top-level `status`: the core envelope,
 * resolvable provenance, and no coverage or network denial without evidence.
 */
export function assertPluginHonest(value: unknown): void {
  const checked = pluginEnvelope.safeParse(value);
  if (!checked.success) reject("invalid output contract");
  const result = checked.data;
  if (result.status === "error") {
    if (result.data !== null || result.error === null) reject("error envelope");
  } else if (result.error !== null || result.data === null)
    reject("missing result");
  const sources = new Map(
    result.provenance.map((source) => [source.id, source]),
  );
  if (sources.size !== result.provenance.length) reject("duplicate source IDs");
  for (const source of sources.values())
    if (source.status === "available" && !source.snapshot_id)
      reject("missing snapshot");
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const entry = record(node);
    if (!entry) return;
    const status = typeof entry.status === "string" ? entry.status : "";
    if (DENIALS.has(status)) reject("denial without evidence");
    const refs = Array.isArray(entry.evidence_refs)
      ? entry.evidence_refs.map(String)
      : [];
    for (const ref of refs) {
      const source = sources.get(ref);
      if (!source?.snapshot_id || source.status !== "available")
        reject("unresolvable provenance");
    }
    if (CLAIMS.has(status) && !refs.length) reject("unsourced factual record");
    if (status === "not_listed" && entry.source_completeness !== "complete")
      reject("not_listed requires complete source set");
    Object.values(entry).forEach(walk);
  };
  walk(result.data);
}

/**
 * Runs one plugin tool call: input parsed by the plugin's schema, the handler under the request's
 * bounded database, the output parsed, checked for honesty when it has a `status`, and bounded by
 * `MAX_OUTPUT_BYTES`. Failures answer with the core error envelope.
 */
export async function callPluginTool(
  deps: McpDependencies,
  spec: McpToolSpec<unknown, unknown>,
  args: unknown,
  signal: AbortSignal,
  requestId: string | number = 0,
) {
  const checkedAt = new Date((deps.now ?? Date.now)()).toISOString();
  deps.onCache?.("bypass");
  try {
    const input = spec.inputSchema.safeParse(args);
    if (!input.success) throw new ToolError("INVALID_INPUT");
    const answer = await spec.handler(input.data, {
      db: deps.db as Parameters<typeof spec.handler>[1]["db"],
      signal,
    });
    const checked = spec.outputSchema.safeParse(answer);
    const output = checked.success ? record(checked.data) : null;
    if (!output) reject("invalid output contract");
    if ("status" in output) assertPluginHonest(output);
    // Same framing as core answers; the envelope type is only used for its byte layout.
    const listed = output as unknown as ToolOutput<ToolName>;
    if (messageBytes(listed, requestId) > MAX_OUTPUT_BYTES)
      throw new ToolError("RESULT_TOO_LARGE");
    return toolResult(listed);
  } catch (error) {
    // The error envelope is the same for every tool, so any core name builds it.
    return errorResult("fetch", error, "unknown", checkedAt);
  }
}
