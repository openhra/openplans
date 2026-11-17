import { z } from "zod";
import * as v from "./validation.js";

/** Handy minimum inputs remain explicit and bounded. */
export const lowestInputSchema = z.strictObject({
  zip: z
    .string()
    .regex(/^\d{5}$/)
    .optional(),
  county: z
    .string()
    .regex(/^\d{5}$/)
    .optional(),
  year: z.int().min(2014).max(9999),
  age: z.int().min(0).max(120),
  metal: z
    .enum(["silver", "bronze", "expanded bronze", "gold"])
    .default("silver"),
  tobacco: z.boolean().default(false),
  coverage_start: z.string().optional(),
  market: z.literal("individual").default("individual"),
  coverage: z.literal("medical").default("medical"),
  market_segment: z.literal("on_exchange").default("on_exchange"),
  premium_basis: z.literal("gross").default("gross"),
  page: z.int().min(1).max(1_000_000).default(1),
});
export type LowestInput = z.output<typeof lowestInputSchema>;

export function lowestInput(value: unknown): LowestInput {
  const parsed = lowestInputSchema.safeParse(value);
  if (!parsed.success)
    return v.fail(String(parsed.error.issues[0]?.path[0] ?? "input"));
  const input = parsed.data;
  v.location(input);
  if (
    input.coverage_start !== undefined &&
    input.coverage_start !== `${input.year}-01-01`
  )
    return v.fail("coverage_start");
  const { zip, county, ...scope } = input;
  return {
    ...(zip === undefined ? {} : { zip }),
    ...(county === undefined ? {} : { county }),
    ...scope,
    coverage_start: `${input.year}-01-01`,
  };
}

export function lowestQuery(params: Record<string, string>) {
  const value: Record<string, unknown> = { ...params };
  for (const field of ["year", "age", "page", "evidence_page"]) {
    if (value[field] !== undefined) {
      if (!/^\d+$/.test(String(value[field]))) return v.fail(field);
      value[field] = Number(value[field]);
    }
  }
  if (value.tobacco !== undefined) {
    if (value.tobacco !== "false" && value.tobacco !== "true")
      return v.fail("tobacco");
    value.tobacco = value.tobacco === "true";
  }
  if (value.evidence_page !== undefined) {
    if (
      !Number.isInteger(value.evidence_page) ||
      Number(value.evidence_page) < 1 ||
      Number(value.evidence_page) > 100_000
    )
      return v.fail("evidence_page");
    delete value.evidence_page;
  }
  return lowestInput(value);
}

export const marketSummaryInputSchema = z.strictObject({
  zip: z
    .string()
    .regex(/^\d{5}$/)
    .optional(),
  county: z
    .string()
    .regex(/^\d{5}$/)
    .optional(),
  year: z.int().min(2014).max(9999),
  metal: z.enum(["silver", "bronze", "expanded bronze", "gold"]).optional(),
  market_segment: z.literal("on_exchange").optional(),
  age: z.int().min(0).max(120).optional(),
  tobacco: z.boolean().optional(),
  coverage_start: z.string().optional(),
});
export type MarketSummaryInput = z.output<typeof marketSummaryInputSchema>;

export function marketSummaryInput(value: unknown): MarketSummaryInput {
  const parsed = marketSummaryInputSchema.safeParse(value);
  if (!parsed.success)
    return v.fail(String(parsed.error.issues[0]?.path[0] ?? "input"));
  const input = parsed.data;
  v.location(input);
  if (input.age === undefined && input.tobacco !== undefined)
    return v.fail("tobacco");
  if (
    input.coverage_start !== undefined &&
    input.coverage_start !== `${input.year}-01-01`
  )
    return v.fail("coverage_start");
  return {
    ...input,
    market_segment: input.market_segment ?? "on_exchange",
    coverage_start: `${input.year}-01-01`,
  };
}

export function marketSummaryQuery(params: Record<string, string>) {
  const value: Record<string, unknown> = { ...params };
  for (const field of ["year", "age"]) {
    if (value[field] !== undefined) {
      if (!/^\d+$/.test(String(value[field]))) return v.fail(field);
      value[field] = Number(value[field]);
    }
  }
  if (value.tobacco !== undefined) {
    if (value.tobacco !== "false" && value.tobacco !== "true")
      return v.fail("tobacco");
    value.tobacco = value.tobacco === "true";
  }
  return marketSummaryInput(value);
}

/** Household pricing uses explicit public quote members, with no preset or tax fields. */
export const householdHandyInputSchema = lowestInputSchema
  .omit({ age: true, tobacco: true })
  .extend({
    evidence_page: z.int().min(1).max(100_000).default(1),
    members: z
      .array(
        z.strictObject({
          age: z.int().min(0).max(120),
          relationship: z.enum(["subscriber", "spouse", "child", "other"]),
          tobacco: z.boolean(),
        }),
      )
      .min(1)
      .max(v.PUBLIC_QUOTE_LIMITS.members),
  });
export const householdMarketInputSchema = householdHandyInputSchema
  .omit({ metal: true, page: true })
  .extend({
    metal: lowestInputSchema.shape.metal.removeDefault().optional(),
  });
export type HouseholdHandyInput = z.output<typeof householdHandyInputSchema>;
export function householdHandyInput(value: unknown, summary = false) {
  const parsed = (
    summary ? householdMarketInputSchema : householdHandyInputSchema
  ).safeParse(value);
  if (!parsed.success)
    return v.fail(String(parsed.error.issues[0]?.path[0] ?? "input"));
  v.location(parsed.data);
  return parsed.data;
}
export const benchmarkInputSchema = z.strictObject({
  year: z.int().min(2014).max(9999),
  location: z.strictObject({
    zip: z
      .string()
      .regex(/^\d{5}$/)
      .optional(),
    county: z
      .string()
      .regex(/^\d{5}$/)
      .optional(),
  }),
  ages: z.array(z.int().min(0).max(120)).min(1).max(100),
});

/** Exposure restriction for the public ZIP launch; full self-hosted contracts remain available. */
export function admitsHandyScope(
  scope: "full" | "single_age_silver",
  input: Record<string, unknown>,
  summary = false,
): boolean {
  if (scope === "full") return true;
  if (!input.zip || input.members !== undefined) return false;
  if (summary) return input.age === undefined && input.tobacco === undefined;
  return (
    (input.metal ?? "silver") === "silver" && (input.tobacco ?? false) === false
  );
}
