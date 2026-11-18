import { z } from "zod";
import type { McpToolContext } from "./contracts.js";

/** Public comparison inputs are explicit ages, never inferred from dates of birth. */
export const offerCohortInputSchema = z
  .strictObject({
    zip: z
      .string()
      .regex(/^\d{5}$/)
      .optional(),
    county: z
      .string()
      .regex(/^\d{5}$/)
      .optional(),
    year: z.int().min(2014).max(9999),
    age: z.int().min(0).max(120).optional(),
    members: z
      .array(
        z.strictObject({
          age: z.int().min(0).max(120),
          relationship: z.enum(["subscriber", "spouse", "child", "other"]),
        }),
      )
      .min(1)
      .max(100)
      .optional(),
    metal: z
      .enum(["bronze", "expanded bronze", "silver", "gold"])
      .default("silver"),
    tobacco: z.literal(false).default(false),
    market: z.literal("individual").default("individual"),
    coverage: z.literal("medical").default("medical"),
    market_segment: z.literal("on_exchange").default("on_exchange"),
    premium_basis: z.literal("gross").default("gross"),
    coverage_start: z.string().optional(),
    evidence_page: z.int().min(1).max(100_000).default(1),
    data_generation: z.string().min(1).max(200).optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.age === undefined) === (value.members === undefined))
      ctx.addIssue({
        code: "custom",
        path: ["members"],
        message: "Provide one age or an explicit household",
      });
    if (!value.zip && !value.county)
      ctx.addIssue({
        code: "custom",
        path: ["zip"],
        message: "Location required",
      });
    if (value.coverage_start && value.coverage_start !== `${value.year}-01-01`)
      ctx.addIssue({
        code: "custom",
        path: ["coverage_start"],
        message: "January 1 required",
      });
    if (value.evidence_page > 1 && !value.data_generation)
      ctx.addIssue({
        code: "custom",
        path: ["data_generation"],
        message: "Generation required for evidence pages",
      });
  });
export type OfferCohortInput = z.output<typeof offerCohortInputSchema>;

const record = z.record(z.string(), z.unknown());
const count = z.int().nonnegative().nullable();
const exact = z.strictObject({
  numerator: z.int().nonnegative(),
  denominator: z.int().positive(),
  display_cents: z.int().nonnegative(),
});
export const offerStatisticsSchema = z.strictObject({
  median: exact.nullable(),
  mean: exact.nullable(),
  evidence_refs: z.array(z.string()),
  lowest_cents: count,
  p25_cents: count,
  p75_cents: count,
  small_offer_set: z.boolean(),
  quantile_method: z.literal("nearest_rank"),
  weighting: z.literal("unweighted_distinct_base_plan"),
  currency: z.literal("USD"),
  period: z.literal("month"),
});
export const offerCohortSchema = z.strictObject({
  status: z.string(),
  reason: z.string().nullable(),
  data_generation: z.string(),
  year: z.int(),
  location: record,
  basis: record,
  denominator: z.strictObject({
    unit: z.literal("distinct_base_plan"),
    candidate_count: count,
    rated_count: count,
    excluded_count: count,
    unknown_count: count,
  }),
  exclusions: z.array(
    z.strictObject({ reason: z.string(), count: z.int().nonnegative() }),
  ),
  completeness: z.strictObject({ catalog: z.string(), rates: z.string() }),
  statistics: offerStatisticsSchema.nullable(),
  evidence: z.strictObject({
    manifest: z.string(),
    offer_set: z.string().nullable(),
    snapshots: z.array(record),
    candidates: z.array(record),
    excluded: z.array(record),
    unknown: z.array(record),
    sources: z.array(z.unknown()),
    page: z.int(),
    page_size: z.int(),
    next_page: z.int().nullable(),
  }),
  bindable_quote: z.literal(false),
  subsidy_status: z.literal("not_evaluated"),
});
export type OfferCohort = z.output<typeof offerCohortSchema>;

/** The host charges a shared request budget; plugins cannot raise these limits. */
export interface CalculationBudget {
  remainingOffers: number;
}
export interface CalculationScope extends McpToolContext {
  budget?: CalculationBudget;
}
export type HouseholdDistributionInput = {
  zip?: string;
  county?: string;
  year: number;
} & (
  | { preset: "family-40-40-10-8-v1"; members?: never }
  | {
      members: {
        age: number;
        relationship: "subscriber" | "spouse" | "child" | "other";
        tobacco: boolean;
      }[];
      preset?: never;
    }
);
/** All calls use the caller's reader and signal. No persistence or publisher fallback. */
export interface CalculationHost {
  enumerateHouseholdOffers(
    input: OfferCohortInput,
    scope: CalculationScope,
  ): Promise<OfferCohort>;
  /** Request scoped household distribution. The host validates the profile and returns the
   * canonical service DTO without exposing pricing internals to plugins. */
  householdDistributions?(
    input: HouseholdDistributionInput,
    scope: CalculationScope,
    options?: { fourProfiles?: boolean },
  ): Promise<Record<string, unknown>>;
}
