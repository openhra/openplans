import { z } from "zod";
import * as v from "./validation.js";

/** Slice 1 accepts only the inputs it can certify. */
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
  metal: z.literal("silver").default("silver"),
  tobacco: z.literal(false).default(false),
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
    if (value.tobacco !== "false") return v.fail("tobacco");
    value.tobacco = false;
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
