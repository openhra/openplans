import { z } from "zod";

export const FIELD = "custom_payment_allowed";
export const segmentSchema = z.enum(["on_exchange", "off_exchange"]);
const key = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,99}$/);
export const dateSchema = z.iso.date();
export const valueSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("known"), value: z.boolean() }),
  z.strictObject({ state: z.literal("unknown"), value: z.null() }),
]);
export const scopeSchema = z.strictObject({
  issuer_id: z.union([key, z.literal("*")]).optional(),
  state: z.union([z.string().regex(/^[A-Z]{2}$/), z.literal("*")]).optional(),
  market_segment: z.union([segmentSchema, z.literal("*")]).optional(),
});
const author = { set_by: key, set_at: z.iso.datetime({ offset: true }) };
const definitionSchema = z.strictObject({
  name: z.literal(FIELD),
  entity: z.literal("plan"),
  definition_version: z.literal(1),
  type: z.literal("boolean"),
  allowed_values: z.tuple([z.literal(true), z.literal(false)]),
  default: z.strictObject({ state: z.literal("unknown"), value: z.null() }),
  description: z.string().min(1).max(500),
  visibility: z.strictObject({
    audience: z.literal("answer"),
    rest: z.literal(true),
    compat: z.boolean(),
    mcp: z.literal(true),
  }),
  filterable: z.boolean(),
  ...author,
});
export const ruleSchema = z.strictObject({
  id: key,
  field: z.literal(FIELD),
  scope: scopeSchema,
  valid_from: dateSchema,
  valid_until: dateSchema.nullable(),
  value: valueSchema,
  ...author,
  reason_code: key,
});
export const sourceSchema = z.strictObject({
  source_id: key,
  version: z.number().int().positive(),
  product_families: z
    .array(z.enum(["medical", "dental"]))
    .min(1)
    .default(["medical", "dental"]),
  business_markets: z.tuple([z.literal("individual")]).default(["individual"]),
  fields: z.tuple([definitionSchema]),
  rules: z.array(ruleSchema).max(10000),
});
export const optionsSchema = z
  .strictObject({ source: sourceSchema.optional() })
  .prefault({});
export const resolveInput = z.strictObject({
  source_id: key,
  plan_ids: z.array(z.string().min(1).max(220)).min(1).max(100),
  year: z.number().int().min(2014).max(2100),
  as_of: dateSchema.optional(),
  market_segment: segmentSchema.optional(),
});
export const publicPlanSchema = z.strictObject({
  id: z.string(),
  base_plan_id: z.string(),
  plan_year: z.number().int(),
  issuer_id: z.string().nullable(),
  state: z.string().nullable(),
  product_family: z.enum(["medical", "dental"]),
  business_market: z.string(),
  on_exchange: z.boolean().nullable(),
  off_exchange: z.boolean().nullable(),
  provenance: z.strictObject({
    snapshot_id: z.string(),
    source_row: z.number().int(),
    channel_granularity: z.literal("base_plan"),
  }),
});
export const provenanceSchema = z.strictObject({
  id: z.string(),
  origin: z.enum(["msot", "msot_default"]),
  source_id: z.string(),
  version: z.number(),
  definition: z.string(),
  rule_id: z.string().nullable(),
  matched_scope: scopeSchema.nullable(),
  ...author,
  valid_from: dateSchema.nullable(),
  valid_until: dateSchema.nullable(),
  reason_code: z.string(),
  unresolved_dimensions: z
    .array(z.enum(["issuer_id", "state", "market_segment"]))
    .optional(),
  candidate_rule_ids: z.array(z.string()).optional(),
});
const fieldSchema = valueSchema.and(
  z.object({
    origin: z.enum(["msot", "msot_default"]),
    provenance_ref: z.string(),
    public: z.strictObject({
      state: z.literal("not_defined"),
      value: z.null(),
    }),
  }),
);
const channelSchema = z.strictObject({
  applicability: z.enum(["applicable", "inapplicable", "unknown"]),
  fields: z.strictObject({ custom_payment_allowed: fieldSchema }),
});
export const resolveOutput = z.strictObject({
  msot: z.strictObject({
    source_id: z.string(),
    version: z.number(),
    version_hash: z.string(),
    as_of: dateSchema,
    catalog_generation: z.string(),
    evaluator_version: z.literal(1),
    dimension_schema_version: z.literal(1),
    provenance: z.array(provenanceSchema),
  }),
  plans: z.array(
    z.strictObject({
      id: z.string(),
      public: publicPlanSchema,
      msot: z.strictObject({
        by_market_segment: z.partialRecord(
          z.enum(["on_exchange", "off_exchange", "unknown"]),
          channelSchema,
        ),
      }),
    }),
  ),
});
export type Source = z.infer<typeof sourceSchema>;
export type Rule = z.infer<typeof ruleSchema>;
export type Scope = z.infer<typeof scopeSchema>;
export type Resolution = z.infer<typeof resolveOutput>;

// Matches the host's public evidence envelope. Operator instructions stay inside data.msot.
export const mcpOutput = z.strictObject({
  schema_version: z.literal("1"),
  status: z.literal("ok"),
  data_generation: z.string(),
  data: resolveOutput,
  provenance: z.array(
    z.strictObject({
      id: z.string(),
      snapshot_id: z.string(),
      publisher: z.null(),
      url: z.null(),
      sha256: z.null(),
      retrieved_at: z.null(),
      publisher_updated_at: z.null(),
      record_ref: z.null(),
      status: z.literal("available"),
    }),
  ),
  notes: z.array(z.string()),
  truncated: z.literal(false),
  freshness: z.strictObject({
    checked_at: z.iso.datetime({ offset: true }),
    status: z.literal("current_local"),
  }),
  page: z.null(),
  error: z.null(),
});
