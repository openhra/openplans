import { dataGeneration } from "../api/cache/generation.js";
import { z } from "zod";
import { fromJsonSchema } from "@modelcontextprotocol/server";
import type {
  McpServer,
  Tool,
  JsonSchemaType,
} from "@modelcontextprotocol/server";
import { lowestInput, lowestInputSchema } from "../api/handy.js";
import { lowestPremiums, HandyDataChanged } from "../services/handy.js";
import { loadConfig } from "../config/index.js";
import { evidenceCaution, toolAnnotations } from "./schemas.js";
import { requestDependencies } from "./policy.js";
import { errorResult, mayQuotePublic, MAX_OUTPUT_BYTES } from "./tools.js";
import type { McpDependencies } from "./tools.js";
import { cursorCodec, ToolError } from "./cursor.js";

export const LOWEST_TOOL = "get_lowest_premiums";
export const lowestToolTitle = "Lowest silver premium";
export const lowestToolDescription =
  "Find the lowest gross on-exchange silver premium for one age, year and location. Requires complete pricing evidence; no subsidies are evaluated.";
const mcpLowestInput = lowestInputSchema.extend({
  page: z.number().int().min(1).max(100_000).default(1),
  evidence_page: z.number().int().min(1).max(100_000).optional(),
  cursor: z.string().max(4096).optional(),
});
const jsonObject = z.record(z.string(), z.unknown());
const lowestOutput = z.strictObject({
  schema_version: z.literal("1"),
  status: z.enum([
    "calculated",
    "no_plans",
    "unknown",
    "ambiguous",
    "location_requires_zip",
  ]),
  reason: z.string().nullable(),
  year: z.int(),
  location: jsonObject,
  basis: jsonObject,
  lowest: z.strictObject({
    plan_id: z.string().nullable(),
    monthly_cents: z.int().nonnegative().nullable(),
    tied_plan_count: z.int().nonnegative().nullable(),
  }),
  ties: z.array(z.string()).max(50),
  candidate_count: z.int().nonnegative().nullable(),
  completeness: jsonObject,
  issues: z.array(z.string()),
  provenance: jsonObject,
  bindable_quote: z.literal(false),
  subsidy_status: z.literal("not_evaluated"),
  page: z.int().positive(),
  page_size: z.literal(50),
  next_page: z.int().positive().nullable(),
  evidence_page: z.int().positive(),
  evidence_page_size: z.int().positive(),
  next_evidence_page: z.int().positive().nullable(),
  evidence_total: z.int().nonnegative(),
  candidates_total: z.int().nonnegative(),
  truncated: z.boolean(),
  omitted: z.strictObject({
    ties: z.int().nonnegative(),
    candidates: z.int().nonnegative(),
    excluded: z.int().nonnegative(),
    evidence: z.int().nonnegative(),
  }),
  data_generation: z.string(),
  next_cursor: z.string().nullable(),
});
type LowestBoundedResult = {
  ties: string[];
  provenance: {
    candidates: unknown[];
    excluded: unknown[];
    evidence: unknown[];
  };
  truncated: boolean;
  omitted: {
    ties: number;
    candidates: number;
    excluded: number;
    evidence: number;
  };
};

/** Keep every MCP answer below the transport budget by dropping detail rows and counting them. */
export function boundLowestResult(result: LowestBoundedResult): void {
  const fits = () => {
    const answer = {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
    };
    return Buffer.byteLength(JSON.stringify(answer)) + 4096 <= MAX_OUTPUT_BYTES;
  };
  while (!fits()) {
    if (result.provenance.candidates.length) {
      result.provenance.candidates.pop();
      result.omitted.candidates++;
    } else if (result.provenance.excluded.length) {
      result.provenance.excluded.pop();
      result.omitted.excluded++;
    } else if (result.provenance.evidence.length) {
      result.provenance.evidence.pop();
      result.omitted.evidence++;
    } else if (result.ties.length) {
      result.ties.pop();
      result.omitted.ties++;
    } else {
      break;
    }
    result.truncated = true;
  }
}

// The complete canonical service result is returned, including ordered source and rate-row refs.
export function lowestToolDefinition(): Tool {
  return {
    name: LOWEST_TOOL,
    title: lowestToolTitle,
    description: `${lowestToolDescription} ${evidenceCaution}`,
    annotations: toolAnnotations,
    inputSchema: z.toJSONSchema(mcpLowestInput) as Tool["inputSchema"],
    outputSchema: z.toJSONSchema(lowestOutput) as Tool["outputSchema"],
  };
}
export function registerLowestTool(
  server: McpServer,
  deps: McpDependencies,
): Tool | undefined {
  if (
    !(deps.lowestPremiums ?? loadConfig().lowestPremiums) ||
    !mayQuotePublic(deps)
  )
    return undefined;
  const definition = lowestToolDefinition();
  server.registerTool(
    LOWEST_TOOL,
    {
      title: definition.title,
      description: definition.description,
      annotations: toolAnnotations,
      inputSchema: fromJsonSchema(definition.inputSchema as JsonSchemaType),
      outputSchema: fromJsonSchema(definition.outputSchema as JsonSchemaType),
    },
    async (args, ctx) =>
      callLowestTool(requestDependencies(deps, ctx.mcpReq.signal), args),
  );
  return definition;
}
export async function callLowestTool(deps: McpDependencies, value: unknown) {
  deps.onCache?.("bypass");
  try {
    if (
      !(deps.lowestPremiums ?? loadConfig().lowestPremiums) ||
      !mayQuotePublic(deps)
    )
      throw new ToolError("QUOTING_DISABLED");
    const parsed = mcpLowestInput.safeParse(value);
    if (!parsed.success) throw new ToolError("INVALID_INPUT");
    const { cursor, evidence_page, ...fields } = parsed.data;
    const input = lowestInput(fields),
      generation = await dataGeneration(deps.db);
    const codec = cursorCodec(deps.cursorSecret, deps.now);
    const binding = {
      tool: LOWEST_TOOL,
      filters: input,
      generation,
      scope: deps.principal?.id ?? "anonymous",
    };
    const offset = codec.read(cursor, binding);
    const page = cursor ? offset / 50 + 1 : parsed.data.page;
    const native = await lowestPremiums(
      deps.db,
      {
        ...input,
        page,
      },
      { evidencePage: evidence_page ?? 1 },
    );
    if (native.data_generation !== generation)
      throw new ToolError("DATA_CHANGED");
    const result = {
      ...native,
      next_cursor: native.next_page ? codec.issue(binding, page * 50) : null,
      truncated: false,
      omitted: { ties: 0, candidates: 0, excluded: 0, evidence: 0 },
    };
    boundLowestResult(result);
    lowestOutput.parse(result);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
      structuredContent: result,
    };
  } catch (error) {
    return errorResult(
      "fetch",
      error instanceof HandyDataChanged ? new ToolError("DATA_CHANGED") : error,
      "unknown",
      new Date((deps.now ?? Date.now)()).toISOString(),
    );
  }
}
