import { z } from "zod";

export const partDDrugNameSchema = z.object({
  name: z.string().nullable(),
  name_tty: z.string().nullable(),
  name_reason: z
    .enum([
      "rxnorm_not_loaded",
      "rxcui_not_in_loaded_rxnorm",
      "rxcui_not_in_plan_formulary",
    ])
    .nullable(),
  name_snapshot_id: z.string().nullable(),
});

const envelope = {
  plan_key: z.string(),
  contract_year: z.int(),
  rxcui: z.string().regex(/^\d{1,20}$/),
};
const channel = z.strictObject({
  type: z.enum(["not_offered", "copay", "coinsurance", "unknown"]),
  amount: z.string().nullable(),
  minimum: z.string().nullable(),
  maximum: z.string().nullable(),
});

export const medicareDrugResponseSchema = z.union([
  z.strictObject({
    ...envelope,
    status: z.literal("unknown"),
    reason: z.string(),
    as_of: z.string().optional(),
  }),
  z.strictObject({
    ...envelope,
    ...partDDrugNameSchema.shape,
    status: z.enum(["listed", "not_listed"]),
    note: z.string(),
    as_of: z.string(),
    snapshot_id: z.string(),
    formulary_id: z.string(),
    packages: z.array(
      z.strictObject({
        proxy_ndc: z.string(),
        tier: z.int().nullable(),
        prior_authorization: z.boolean(),
        step_therapy: z.boolean(),
        quantity_limit: z
          .strictObject({
            amount: z.string().nullable(),
            days: z.string().nullable(),
          })
          .nullable(),
        selected_for_negotiation: z.boolean(),
        source_row: z.int(),
      }),
    ),
    tier_cost_sharing: z.array(
      z.strictObject({
        tier: z.int(),
        coverage_level: z.enum([
          "pre_deductible",
          "initial_coverage",
          "catastrophic",
          "unknown",
        ]),
        days_supply: z.enum([
          "30_days",
          "90_days",
          "other",
          "60_days",
          "unknown",
        ]),
        specialty_tier: z.boolean(),
        deductible_applies: z.boolean(),
        preferred_retail: channel,
        standard_retail: channel,
        preferred_mail: channel,
        standard_mail: channel,
        source_row: z.int(),
      }),
    ),
    average_unit_cost: z.union([
      z.strictObject({
        status: z.literal("unknown"),
        reason: z.literal("pricing_not_loaded"),
      }),
      z.strictObject({
        status: z.enum(["available", "unknown"]),
        as_of: z.string(),
        snapshot_id: z.string(),
        caveat: z.string(),
        rows: z.array(
          z.strictObject({
            ndc: z.string(),
            days_supply: z.int(),
            unit_cost: z.string(),
          }),
        ),
      }),
    ]),
    tier_labels: z.strictObject({
      status: z.literal("unknown"),
      reason: z.literal("tier_names_not_in_public_files"),
    }),
  }),
]);

export type PartDDrugName = z.infer<typeof partDDrugNameSchema>;
