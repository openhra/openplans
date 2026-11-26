import { withDataPolicy } from "../services/data-window.js";
import { boundOutput, measuredToolResult, outputSizeError } from "./bounded.js";
import { assertCatalogToolAdmission } from "../plugins/catalog-policy.js";
import { dataGeneration } from "../db/generation.js";
import { z } from "zod";
import { cachedJsonSchema, cachedToolDefinition } from "./definition-cache.js";
import type {
  McpServer,
  Tool,
  JsonSchemaType,
} from "@modelcontextprotocol/server";
import {
  admitsHandyScope,
  benchmarkInputSchema,
  householdHandyInputSchema,
  householdMarketInputSchema,
  lowestInput,
  lowestInputSchema,
  marketSummaryInput,
  marketSummaryInputSchema,
} from "../api/handy.js";
import {
  householdHandy,
  getMarketSummary,
  lowestPremiums,
  HandyDataChanged,
} from "../services/handy.js";
import { benchmarkSilver } from "../services/catalog.js";
import { loadConfig } from "../config/index.js";
import { evidenceCaution, toolAnnotations } from "./schemas.js";
import { requestDependencies, withRequestDependencies } from "./policy.js";
import {
  errorResult,
  mayEstimate,
  mayQuotePublic,
  MAX_OUTPUT_BYTES,
} from "./tools.js";
import type { McpDependencies } from "./tools.js";
import { cursorCodec, ToolError } from "./cursor.js";

export const LOWEST_TOOL = "get_lowest_premiums";
export const MARKET_SUMMARY_TOOL = "get_market_summary";
export const lowestToolTitle = "Lowest metal premium";
export const lowestToolDescription =
  "Find the lowest gross on-exchange silver, bronze, expanded bronze or gold premium for one age, year and location. Tobacco can be selected. Requires complete pricing evidence. Does not evaluate subsidies.";
const mcpLowestInput = lowestInputSchema
  .partial({ age: true, tobacco: true })
  .extend({
    members: householdHandyInputSchema.shape.members.optional(),
    tobacco: z.boolean().optional(),
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
export function boundLowestResult(result: LowestBoundedResult): string {
  let text = "";
  boundOutput(result, {
    maxBytes: MAX_OUTPUT_BYTES,
    measure: (value) => {
      const measured = measuredToolResult(value, 4096);
      text = measured.answer.content[0]!.text;
      return measured.bytes;
    },
    groups: ["candidates", "excluded", "evidence", "ties"].map((key) => {
      const field = key as keyof LowestBoundedResult["omitted"];
      return {
        rows: field === "ties" ? result.ties : result.provenance[field],
        onOmit: () => {
          result.omitted[field]++;
        },
      };
    }),
    complete: (omitted) => {
      if (omitted) result.truncated = true;
    },
  });
  return text;
}

const lowestDefinitionKeys = { full: {}, single_age_silver: {} };
const summaryDefinitionKeys = { full: {}, single_age_silver: {} };
const benchmarkDefinitionKey = {};

// The complete canonical service result is returned, including ordered source and rate-row refs.
export function lowestToolDefinition(
  scope = loadConfig().lowestPremiumsScope,
): Tool {
  return cachedToolDefinition(lowestDefinitionKeys[scope], () => ({
    name: LOWEST_TOOL,
    title: lowestToolTitle,
    description: `${scope === "single_age_silver" ? "Find the lowest gross non-tobacco Silver premium for one age, year and ZIP. Requires complete pricing evidence. Does not evaluate subsidies." : lowestToolDescription} ${evidenceCaution}`,
    annotations: toolAnnotations,
    inputSchema: z.toJSONSchema(
      scope === "single_age_silver"
        ? mcpLowestInput
            .omit({ members: true })
            .required({ zip: true, age: true })
            .extend({
              metal: z.literal("silver").default("silver"),
              tobacco: z.literal(false).optional(),
            })
        : mcpLowestInput,
      {
        io: "input",
      },
    ) as Tool["inputSchema"],
    outputSchema: z.toJSONSchema(
      z.union([
        lowestOutput,
        lowestOutput.omit({ truncated: true, omitted: true }),
      ]),
    ) as Tool["outputSchema"],
  }));
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
  const definition = lowestToolDefinition(
    deps.lowestPremiumsScope ?? loadConfig().lowestPremiumsScope,
  );
  server.registerTool(
    LOWEST_TOOL,
    {
      title: definition.title,
      description: definition.description,
      annotations: toolAnnotations,
      inputSchema: cachedJsonSchema(definition.inputSchema as JsonSchemaType),
      outputSchema: cachedJsonSchema(definition.outputSchema as JsonSchemaType),
    },
    async (args, ctx) =>
      withRequestDependencies(deps, ctx.mcpReq.signal, (scoped) =>
        callLowestTool(scoped, args),
      ),
  );
  return definition;
}
async function callScopedLowestTool(deps: McpDependencies, value: unknown) {
  deps.onCache?.("bypass");
  try {
    assertCatalogToolAdmission(deps.catalogPolicy, "get_lowest_premiums");
    if (
      !(deps.lowestPremiums ?? loadConfig().lowestPremiums) ||
      !mayQuotePublic(deps)
    )
      throw new ToolError("quoting_disabled");
    const parsed = mcpLowestInput.safeParse(value);
    if (!parsed.success) throw new ToolError("invalid_input");
    if (
      !admitsHandyScope(
        deps.lowestPremiumsScope ?? loadConfig().lowestPremiumsScope,
        parsed.data,
      )
    )
      throw new ToolError("invalid_input");
    if (parsed.data.members !== undefined) {
      if (!mayEstimate(deps)) throw new ToolError("unauthorized");
      if (parsed.data.age !== undefined || parsed.data.tobacco !== undefined)
        throw new ToolError("invalid_input");
      const { cursor, ...fields } = parsed.data;
      const generation = await dataGeneration(deps.db);
      const binding = {
        tool: LOWEST_TOOL,
        filters: fields,
        generation,
        scope: deps.principal?.id ?? "anonymous",
      };
      const codec = cursorCodec(deps.cursorSecret, deps.now);
      const offset = codec.read(cursor, binding);
      const native = await householdHandy(deps.db, {
        ...fields,
        page: cursor ? offset / 50 + 1 : fields.page,
      });
      if (native.data_generation !== generation)
        throw new ToolError("data_changed");
      const result = {
        ...native,
        next_cursor:
          "next_page" in native && native.next_page
            ? codec.issue(
                binding,
                (cursor ? offset / 50 + 1 : fields.page) * 50,
              )
            : null,
      };
      return pricingToolResult(result);
    }
    if (parsed.data.age === undefined) throw new ToolError("invalid_input");
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
      { builtOnly: true, evidencePage: evidence_page ?? 1 },
    );
    if (native.data_generation !== generation)
      throw new ToolError("data_changed");
    const result = {
      ...native,
      next_cursor: native.next_page ? codec.issue(binding, page * 50) : null,
      truncated: false,
      omitted: { ties: 0, candidates: 0, excluded: 0, evidence: 0 },
    };
    const text = boundLowestResult(result);
    lowestOutput.parse(result);
    return {
      content: [{ type: "text" as const, text }],
      structuredContent: result,
    };
  } catch (error) {
    return errorResult(
      "fetch",
      error instanceof HandyDataChanged ? new ToolError("data_changed") : error,
      "unknown",
      new Date((deps.now ?? Date.now)()).toISOString(),
    );
  }
}

export function registerMarketSummaryTool(
  server: McpServer,
  deps: McpDependencies,
): Tool | undefined {
  if (
    !(deps.lowestPremiums ?? loadConfig().lowestPremiums) ||
    !mayQuotePublic(deps)
  )
    return undefined;
  const definition = marketSummaryToolDefinition(
    deps.lowestPremiumsScope ?? loadConfig().lowestPremiumsScope,
  );
  server.registerTool(
    MARKET_SUMMARY_TOOL,
    {
      title: definition.title,
      description: definition.description,
      annotations: toolAnnotations,
      inputSchema: cachedJsonSchema(definition.inputSchema as JsonSchemaType),
      outputSchema: cachedJsonSchema(definition.outputSchema as JsonSchemaType),
    },
    async (args, ctx) =>
      withRequestDependencies(deps, ctx.mcpReq.signal, (scoped) =>
        callMarketSummaryTool(scoped, args),
      ),
  );
  return definition;
}

export function marketSummaryToolDefinition(
  scope = loadConfig().lowestPremiumsScope,
): Tool {
  return cachedToolDefinition(summaryDefinitionKeys[scope], () => ({
    name: MARKET_SUMMARY_TOOL,
    title: "Market summary",
    description: `${scope === "single_age_silver" ? "Count base plans and issuers by metal for a ZIP and year. Premium ranges and household input are unavailable in this scope." : "Count base plans and issuers by metal, with optional gross premium ranges."} ${evidenceCaution}`,
    annotations: toolAnnotations,
    inputSchema: z.toJSONSchema(
      scope === "single_age_silver"
        ? marketSummaryInputSchemaForMcp
            .omit({
              members: true,
              age: true,
              tobacco: true,
              evidence_page: true,
            })
            .required({ zip: true })
        : marketSummaryInputSchemaForMcp,
    ) as Tool["inputSchema"],
    outputSchema: z.toJSONSchema(jsonObject) as Tool["outputSchema"],
  }));
}

const marketSummaryInputSchemaForMcp = marketSummaryInputSchema.extend({
  members: householdMarketInputSchema.shape.members.optional(),
  evidence_page: householdMarketInputSchema.shape.evidence_page
    .removeDefault()
    .optional(),
});

async function callScopedMarketSummaryTool(
  deps: McpDependencies,
  value: unknown,
) {
  deps.onCache?.("bypass");
  try {
    assertCatalogToolAdmission(deps.catalogPolicy, "get_market_summary");
    if (
      !(deps.lowestPremiums ?? loadConfig().lowestPremiums) ||
      !mayQuotePublic(deps)
    )
      throw new ToolError("quoting_disabled");
    const parsed = marketSummaryInputSchemaForMcp.safeParse(value);
    if (!parsed.success) throw new ToolError("invalid_input");
    if (
      !admitsHandyScope(
        deps.lowestPremiumsScope ?? loadConfig().lowestPremiumsScope,
        parsed.data,
        true,
      )
    )
      throw new ToolError("invalid_input");
    if (parsed.data.members !== undefined) {
      if (!mayEstimate(deps)) throw new ToolError("unauthorized");
      if (parsed.data.age !== undefined || parsed.data.tobacco !== undefined)
        throw new ToolError("invalid_input");
      return pricingToolResult(
        await householdHandy(deps.db, parsed.data, true),
      );
    }
    if (parsed.data.evidence_page !== undefined)
      throw new ToolError("invalid_input");
    const fields = { ...parsed.data };
    delete fields.evidence_page;
    const result = await getMarketSummary(deps.db, marketSummaryInput(fields));
    return pricingToolResult(result);
  } catch (error) {
    return errorResult(
      "fetch",
      error,
      "unknown",
      new Date((deps.now ?? Date.now)()).toISOString(),
    );
  }
}

/** Refuse an oversized evidence result rather than emit dangling evidence references. */
function pricingToolResult<T extends Record<string, unknown>>(result: T) {
  const { answer, bytes } = measuredToolResult(result, 4096);
  if (bytes > MAX_OUTPUT_BYTES) throw outputSizeError();
  return answer;
}
export const BENCHMARK_TOOL = "get_benchmark";
export function benchmarkToolDefinition(): Tool {
  return cachedToolDefinition(benchmarkDefinitionKey, () => ({
    name: BENCHMARK_TOOL,
    title: "Silver household benchmark",
    description: `Read the existing January 1 non-tobacco household silver benchmark, with EHB and pediatric dental adjustments and full evidence. ${evidenceCaution}`,
    annotations: toolAnnotations,
    inputSchema: z.toJSONSchema(benchmarkInputSchema) as Tool["inputSchema"],
    outputSchema: z.toJSONSchema(jsonObject) as Tool["outputSchema"],
  }));
}
export function registerBenchmarkTool(
  server: McpServer,
  deps: McpDependencies,
): Tool | undefined {
  if (
    !(deps.lowestPremiums ?? loadConfig().lowestPremiums) ||
    (deps.lowestPremiumsScope ?? loadConfig().lowestPremiumsScope) !== "full" ||
    !mayEstimate(deps)
  )
    return undefined;
  const definition = benchmarkToolDefinition();
  server.registerTool(
    BENCHMARK_TOOL,
    {
      title: definition.title,
      description: definition.description,
      annotations: toolAnnotations,
      inputSchema: cachedJsonSchema(definition.inputSchema as JsonSchemaType),
      outputSchema: cachedJsonSchema(definition.outputSchema as JsonSchemaType),
    },
    async (args, ctx) =>
      callBenchmarkTool(requestDependencies(deps, ctx.mcpReq.signal), args),
  );
  return definition;
}
async function callScopedBenchmarkTool(deps: McpDependencies, value: unknown) {
  deps.onCache?.("bypass");
  try {
    assertCatalogToolAdmission(deps.catalogPolicy, BENCHMARK_TOOL);
    if (
      !(deps.lowestPremiums ?? loadConfig().lowestPremiums) ||
      (deps.lowestPremiumsScope ?? loadConfig().lowestPremiumsScope) !== "full"
    )
      throw new ToolError("quoting_disabled");
    if (!mayEstimate(deps)) throw new ToolError("unauthorized");
    const parsed = benchmarkInputSchema.safeParse(value);
    if (!parsed.success) throw new ToolError("invalid_input");
    const input = parsed.data;
    for (let attempt = 0; attempt < 2; attempt++) {
      const generation = await dataGeneration(deps.db);
      const result = await benchmarkSilver(deps.db, {
        ...input.location,
        year: String(input.year),
        ages: input.ages.join(","),
      });
      if ((await dataGeneration(deps.db)) !== generation) continue;
      return pricingToolResult({
        ...result,
        basis: {
          ages: input.ages,
          tobacco_rating: "excluded",
          coverage_start: `${input.year}-01-01`,
          premium_basis: "ehb_plus_pediatric_dental",
          market_segment: "on_exchange",
          selection_universe: "public_catalog",
        },
      });
    }
    throw new HandyDataChanged("data_changed");
  } catch (error) {
    return errorResult(
      "fetch",
      error instanceof HandyDataChanged ? new ToolError("data_changed") : error,
      "unknown",
      new Date((deps.now ?? Date.now)()).toISOString(),
    );
  }
}

export function callLowestTool(deps: McpDependencies, value: unknown) {
  return withDataPolicy(
    deps.data ?? loadConfig().data,
    () => callScopedLowestTool(deps, value),
    new Date((deps.now ?? Date.now)()),
  );
}
export function callMarketSummaryTool(deps: McpDependencies, value: unknown) {
  return withDataPolicy(
    deps.data ?? loadConfig().data,
    () => callScopedMarketSummaryTool(deps, value),
    new Date((deps.now ?? Date.now)()),
  );
}

export function callBenchmarkTool(deps: McpDependencies, value: unknown) {
  return withDataPolicy(
    deps.data ?? loadConfig().data,
    () => callScopedBenchmarkTool(deps, value),
    new Date((deps.now ?? Date.now)()),
  );
}
