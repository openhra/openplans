import { z } from "zod";

export const LOCATION_YEAR = z.strictObject({
  zip: z.string().regex(/^\d{5}$/),
  county: z
    .string()
    .regex(/^\d{5}$/)
    .optional(),
  year: z.number().int().min(2014).max(2100),
});
export const presetInput = LOCATION_YEAR.extend({
  preset: z.literal("family-40-40-10-8-v1"),
});
export const memberInput = z.strictObject({
  age: z.number().int().min(0).max(120),
  relationship: z.enum(["subscriber", "spouse", "child"]),
  tobacco: z.boolean(),
});
export const privateInput = LOCATION_YEAR.extend({
  members: z.array(memberInput).length(4),
  allowance_cents: z.number().int().nonnegative().max(10_000_000),
});
export const allowanceInput = z.union([presetInput, privateInput]);
export const allowanceOutput = z.record(z.string(), z.unknown());
export type AllowancePrivateInput = z.infer<typeof privateInput>;
