import { z } from "zod";

export const annualDomainSchema = z.enum(["individual", "medicare"]);
export type AnnualDomain = z.infer<typeof annualDomainSchema>;
const years = z.array(z.int().min(2006).max(9999));
const annualWindow = z.strictObject({
  allowed_years: years,
  admitted_years: years,
  loaded_years: years,
  excluded_loaded_years: years,
  missing_allowed_years: years,
});
export const dataPolicySchema = z.strictObject({
  schema_version: z.literal(1),
  history_years: z.union([z.literal(3), z.literal("all")]),
  calendar_year: z.int(),
  generation: z.string().regex(/^[a-f0-9]{64}$/),
  domains: z.strictObject({ individual: annualWindow, medicare: annualWindow }),
});
export type DataPolicy = z.infer<typeof dataPolicySchema>;

export const dataNotLoadedSchema = z.strictObject({
  code: z.literal("not_loaded"),
  required_year: z.int(),
  domain: annualDomainSchema,
  reason: z.string(),
  allowed_years: z.array(z.int()).optional(),
  policy_generation: z.string().optional(),
});
/** Keep annual dependency errors intact when an adapter also handles ordinary calculation failures. */
export function dataNotLoaded(error: unknown) {
  const payload =
    error instanceof Error && "error" in error ? error.error : undefined;
  const result = dataNotLoadedSchema.safeParse(payload);
  return result.success ? result.data : undefined;
}
