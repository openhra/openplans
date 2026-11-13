import { z } from "zod";
import type {
  McpServer,
  JsonSchemaType,
  Tool,
} from "@modelcontextprotocol/server";
import { fromJsonSchema } from "@modelcontextprotocol/server";
import { drugCostRequestSchema } from "../api/medicare-schemas.js";
import { dataGeneration } from "../api/cache/generation.js";
import { restrictCacheLevel } from "../plugins/request-scope.js";
import { estimateMedicareDrugCost } from "../services/medicare.js";
import {
  drugCostDeps,
  estimateProvenanceProblems,
} from "../services/medicare-drug-cost.js";
import type {
  DrugCostDeps,
  DrugCostEstimate,
} from "../services/medicare-drug-cost.js";
import { getSnapshot } from "../services/provenance.js";
import { ToolError } from "./cursor.js";
import { date } from "./projection.js";
import { requestDependencies } from "./policy.js";
import {
  envelopeShape,
  evidenceCaution,
  HonestyError,
  toolAnnotations,
} from "./schemas.js";
import {
  errorResult,
  MAX_OUTPUT_BYTES,
  messageBytes,
  toolResult,
} from "./tools.js";
import type { McpDependencies } from "./tools.js";
import type { ToolName, ToolOutput } from "./schemas.js";

/**
 * estimate_medicare_drug_costs: the Part D drug-cost estimate over MCP. It calls the same service
 * as POST /v1/medicare/plans/{key}/drug-cost-estimates, so both transports give the same answer.
 *
 * - Listed only when OPENPLANS_MEDICARE_DRUG_COST=on and OPENPLANS_MEDICARE_PART_D=on. With either
 *   switch off the server registers nothing, so discovery bytes do not change.
 * - A fill schedule is personal. The tool needs the estimate grant: a verified MCP Bearer token
 *   over HTTP, or the stdio personalized-tool rules. Public household access never grants it.
 * - The answer is never cached, stored or logged. Each call marks its request scope `none`.
 * - Benefit type and drug classes come from the CMS files only; the strict input refuses them.
 */
export const MEDICARE_ESTIMATE_TOOL = "estimate_medicare_drug_costs";

export interface EstimateToolHooks {
  /** Both switches; the tool is registered only when this is true. */
  enabled: () => boolean;
  /** Whether the caller holds the estimate grant. */
  granted: (deps: McpDependencies) => boolean;
  /** Marks the request so no cache may store anything from it. */
  restrict: () => void;
  service: DrugCostDeps;
}
export const estimateToolHooks: EstimateToolHooks = {
  enabled: () => drugCostDeps.enabled() && drugCostDeps.partD(),
  granted: (deps) => deps.medicareEstimateGrant === true,
  restrict: () => restrictCacheLevel("none"),
  service: drugCostDeps,
};

export const estimateInputSchema = z.strictObject({
  plan_key: z.string().min(1).max(32),
  year: z.int().min(2006).max(2100),
  ...drugCostRequestSchema.shape,
});

const label = z.string().min(1).max(240);
const cents = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
const refs = z.array(z.string().min(1).max(32)).max(10_000);
/**
 * A figure is one exact amount (`value`), a range with both ends and no single amount
 * (`bounded`), or `unknown` with a reason.
 */
const figureSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("value"),
    cents,
    reason: z.null(),
    evidence_refs: refs,
  }),
  z.strictObject({
    status: z.literal("bounded"),
    cents: z.null(),
    minimum_cents: cents,
    maximum_cents: cents,
    reason: label,
    evidence_refs: refs,
  }),
  z.strictObject({
    status: z.literal("unknown"),
    cents: z.null(),
    reason: label.nullable(),
    evidence_refs: refs,
  }),
]);
const head = {
  plan_key: z.string().min(1).max(32),
  contract_year: z.int(),
  bindable_quote: z.literal(false),
  price_basis: z.enum(["none", "cms_plan_average"]),
  estimate_scope: z.literal("supplied_schedule"),
};
/** A gated, missing or unsupported answer: no figures, one reason. */
const closedSchema = z.strictObject({
  ...head,
  status: z.enum(["unknown", "unsupported"]),
  reason: label,
  as_of: z.string().max(64).nullable(),
});
const evidenceItemSchema = z.looseObject({
  id: z.string().min(1).max(32),
  kind: z.enum([
    "source_row",
    "source_rows",
    "pbp_row",
    "rule",
    "fee_range",
    "request",
  ]),
});
/** A plan-average fill's price: the unit cost total is information beside the gross range. */
const priceSchema = z.looseObject({
  basis: z.literal("cms_plan_average"),
  caveat: z.string().nullable(),
  figures: z.strictObject({
    unit_cost_total: figureSchema,
    total_lowest_fee: figureSchema,
    total_highest_fee: figureSchema,
    gross: figureSchema,
  }),
});
const fillSchema = z.looseObject({
  fill_id: z.string(),
  date: z.string(),
  rxcui: z.string(),
  status: z.enum(["estimated", "bounded", "unknown"]),
  figures: z.record(z.string(), figureSchema),
  price: priceSchema.nullable().optional(),
  before: z.record(z.string(), figureSchema),
  after: z.record(z.string(), figureSchema),
});
/** The full answer. Nested benefit evidence keeps the service's own shape. */
const estimatedSchema = z.looseObject({
  ...head,
  status: z.enum(["estimated", "partial", "unknown", "unsupported"]),
  scenario: z.string(),
  as_of: z.string().max(64),
  snapshot_ids: z.array(z.string().min(1).max(1024)).max(100),
  rules_documents: z.array(
    z.looseObject({ id: z.string(), url: z.string(), sha256: z.string() }),
  ),
  gaps: z.array(z.string()),
  plan_figures: z.record(z.string(), figureSchema),
  fills: z.array(fillSchema).max(50),
  totals: z.looseObject({
    patient_pay: figureSchema,
    premiums: z.strictObject({ status: z.literal("not_evaluated") }),
  }),
  evidence: z.array(evidenceItemSchema),
});
export const estimateOutputSchema = z.strictObject({
  ...envelopeShape,
  data: z.union([closedSchema, estimatedSchema]).nullable(),
});
export type EstimateOutput = z.output<typeof estimateOutputSchema>;

const title = "Estimate Medicare drug costs";
const description =
  "Estimate one Medicare Part D plan's covered-drug costs for an ordered fill schedule in the non-LIS scenario, from CMS benefit files and annual rules. Every figure cites its evidence; amounts without prices stay unknown. A bounded figure is a range from minimum_cents to maximum_cents, not one cost. Benefit type and drug classes come from CMS files, never the caller. The server keeps no copy of the schedule. Not a bindable quote, and premiums are not evaluated.";

function jsonSchema(schema: z.ZodType, io: "input" | "output") {
  return z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io,
  }) as JsonSchemaType;
}
/** The `tools/list` entry, built like a core entry. */
export function estimateToolDefinition(): Tool {
  return {
    name: MEDICARE_ESTIMATE_TOOL,
    title,
    description: `${description} ${evidenceCaution}`,
    annotations: toolAnnotations,
    inputSchema: jsonSchema(
      estimateInputSchema,
      "input",
    ) as Tool["inputSchema"],
    outputSchema: jsonSchema(
      estimateOutputSchema,
      "output",
    ) as Tool["outputSchema"],
  };
}

const envelopeStatus = {
  estimated: "ok",
  partial: "unknown",
  unknown: "unknown",
  unsupported: "unsupported",
} as const;

function reject(reason: string): never {
  throw new HonestyError(reason);
}
type Evidence = { kind: string; snapshot_id?: string; document?: string };
type FigureNode = {
  status?: unknown;
  cents?: unknown;
  minimum_cents?: unknown;
  maximum_cents?: unknown;
};

/**
 * Where the answer could pass a range off as an exact cost: a bounded figure with an amount, a
 * value with bounds, or a bounded figure missing an end. Walks every figure, price blocks too.
 */
export function boundsPresentedAsCost(value: unknown, path = "$"): string[] {
  if (Array.isArray(value))
    return value.flatMap((item, i) =>
      boundsPresentedAsCost(item, `${path}[${i}]`),
    );
  if (!value || typeof value !== "object") return [];
  const node = value as FigureNode & Record<string, unknown>;
  const problems: string[] = [];
  if ("evidence_refs" in node && "status" in node && "cents" in node) {
    const ends = "minimum_cents" in node || "maximum_cents" in node;
    if (node.status === "bounded" && node.cents !== null)
      problems.push(`${path}: bound given as an amount`);
    if (
      node.status === "bounded" &&
      !(
        Number.isSafeInteger(node.minimum_cents) &&
        Number.isSafeInteger(node.maximum_cents)
      )
    )
      problems.push(`${path}: bound missing an end`);
    if (node.status !== "bounded" && ends)
      problems.push(`${path}: bounds on an exact figure`);
  }
  for (const [key, child] of Object.entries(node))
    if (key !== "evidence")
      problems.push(...boundsPresentedAsCost(child, `${path}.${key}`));
  return problems;
}

/**
 * The answer must be the service answer byte for byte, every figure must cite evidence that
 * resolves to a published snapshot or pinned rule document, every unknown must say why, and no
 * answer may say "not covered".
 */
export function assertEstimateHonest(
  value: unknown,
  canonical?: DrugCostEstimate,
): asserts value is EstimateOutput {
  const checked = estimateOutputSchema.safeParse(value);
  if (!checked.success) reject("invalid output contract");
  const output = checked.data;
  if (output.status === "error") {
    if (output.data !== null || output.error === null) reject("error envelope");
    return;
  }
  if (output.error !== null || output.data === null) reject("missing result");
  if (!canonical) reject("missing canonical estimate");
  // Compare the unparsed answer: parsing may reorder keys, and the bytes must match the service.
  const data = (value as { data: Record<string, unknown> }).data;
  if (JSON.stringify(data) !== JSON.stringify(canonical))
    reject("changed estimate");
  if (
    output.status !== envelopeStatus[data.status as keyof typeof envelopeStatus]
  )
    reject("envelope status");
  if (boundsPresentedAsCost(data).length) reject("bound presented as a cost");
  if (estimateProvenanceProblems(data).length) reject("missing provenance");
  const sources = new Map(output.provenance.map((s) => [s.id, s]));
  if (sources.size !== output.provenance.length) reject("duplicate source IDs");
  const available = (id: string) => {
    const source = sources.get(id);
    return source?.status === "available" && source.snapshot_id === id;
  };
  for (const id of (data.snapshot_ids as string[] | undefined) ?? [])
    if (!available(id)) reject("unresolvable provenance");
  const documents = new Set(
    ((data.rules_documents as { id: string }[] | undefined) ?? []).map(
      (doc) => doc.id,
    ),
  );
  for (const item of (data.evidence as Evidence[] | undefined) ?? []) {
    if (
      item.kind === "source_row" ||
      item.kind === "source_rows" ||
      item.kind === "pbp_row" ||
      item.kind === "fee_range"
    ) {
      if (!item.snapshot_id || !available(item.snapshot_id))
        reject("unresolvable provenance");
    } else if (item.kind === "rule") {
      if (!item.document || !documents.has(item.document))
        reject("unresolvable rule citation");
    } else if (item.kind !== "request") reject("unknown evidence kind");
  }
  if (/not[ _-]?covered|out[ _-]of[ _-]network/i.test(JSON.stringify(output)))
    reject("unsupported negative vocabulary");
}

const publicUrl = (value: unknown) =>
  typeof value === "string" && /^https:\/\//.test(value) && value.length <= 2048
    ? value
    : null;

/** One provenance entry per cited snapshot; rows are named inside the answer's evidence list. */
async function provenance(deps: McpDependencies, answer: DrugCostEstimate) {
  const ids = new Set<string>();
  if ("snapshot_ids" in answer) {
    for (const id of answer.snapshot_ids) ids.add(id);
    for (const item of answer.evidence)
      if ("snapshot_id" in item && typeof item.snapshot_id === "string")
        ids.add(item.snapshot_id);
  }
  if (ids.size > 100) throw new ToolError("RESULT_TOO_LARGE");
  const sources = [];
  for (const id of [...ids].sort()) {
    const snapshot = await getSnapshot(deps.db, id);
    sources.push(
      snapshot
        ? {
            id,
            snapshot_id: id,
            publisher: snapshot.publisher,
            url: publicUrl(snapshot.url),
            sha256: snapshot.sha256,
            retrieved_at: date(snapshot.retrieved_at),
            publisher_updated_at: date(snapshot.publisher_updated_at),
            record_ref: null,
            status: "available" as const,
          }
        : {
            id,
            snapshot_id: id,
            publisher: null,
            url: null,
            sha256: null,
            retrieved_at: null,
            publisher_updated_at: null,
            record_ref: null,
            status: "unknown" as const,
          },
    );
  }
  return sources;
}

const notes = [
  "Not a bindable quote. Premiums are not evaluated.",
  "Unknown figures lack evidence or prices; they are not zero.",
  "A bounded figure lies between minimum_cents and maximum_cents; it is a range, never one cost.",
];

/** One call. The schedule stays in this function; nothing is cached, stored or logged. */
export async function callEstimateTool(
  deps: McpDependencies,
  args: unknown,
  requestId: string | number = 0,
  hooks: EstimateToolHooks = estimateToolHooks,
) {
  const checkedAt = new Date((deps.now ?? Date.now)()).toISOString();
  let generation = "unknown";
  hooks.restrict();
  deps.onCache?.("bypass");
  try {
    if (!hooks.granted(deps)) throw new ToolError("AUTH_REQUIRED");
    const parsed = estimateInputSchema.safeParse(args);
    // Keys outside the schema, such as an asserted benefit type or drug class, are refused.
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      throw new ToolError(
        issue.code === "unrecognized_keys"
          ? "UNSUPPORTED_FIELD"
          : "INVALID_INPUT",
        issue.path.length
          ? issue.path.map(String).join(".").slice(0, 80)
          : null,
      );
    }
    const { plan_key, year, ...body } = parsed.data;
    generation = await dataGeneration(deps.db);
    const answer = await estimateMedicareDrugCost(
      deps.db,
      plan_key,
      { year: String(year) },
      body,
      hooks.service,
    );
    if ((await dataGeneration(deps.db)) !== generation)
      throw new ToolError("DATA_CHANGED");
    const sources = await provenance(deps, answer);
    const output = {
      schema_version: "1" as const,
      status: envelopeStatus[answer.status],
      data_generation: generation,
      data: answer,
      provenance: sources,
      notes,
      truncated: false,
      freshness: {
        checked_at: checkedAt,
        status:
          sources.length && sources.every((s) => s.retrieved_at)
            ? ("current_local" as const)
            : ("unknown" as const),
      },
      page: null,
      error: null,
    };
    assertEstimateHonest(output, answer);
    const result = output as unknown as ToolOutput<ToolName>;
    // Never truncate a calculation: a schedule too large to answer asks for a smaller one.
    if (messageBytes(result, requestId) > MAX_OUTPUT_BYTES)
      throw new ToolError("RESULT_TOO_LARGE");
    return toolResult(result);
  } catch (error) {
    // The error envelope is the same for every tool; its fields name schema paths, never values.
    return errorResult("fetch", error, generation, checkedAt);
  }
}

/**
 * Core tools listed only behind switches, for the plugin loader's page budget. Counted whenever
 * their switches are on, whatever any caller's grant, so a plugin set that leaves no room for them
 * is refused at load.
 */
export function switchedCoreTools(
  hooks: EstimateToolHooks = estimateToolHooks,
): Tool[] {
  return hooks.enabled() ? [estimateToolDefinition()] : [];
}

/** Registers the tool when both switches are on and the caller holds the grant. */
export function registerEstimateTool(
  server: McpServer,
  deps: McpDependencies,
  hooks: EstimateToolHooks = estimateToolHooks,
): Tool | undefined {
  if (!hooks.enabled() || !hooks.granted(deps)) return undefined;
  const listed = estimateToolDefinition();
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
      callEstimateTool(
        requestDependencies(deps, ctx.mcpReq.signal),
        args,
        ctx.mcpReq.id,
        hooks,
      ),
  );
  return listed;
}
