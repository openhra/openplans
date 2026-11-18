import { offerCohortSchema } from "@openplans/plugin-sdk";
import { z } from "zod";

const source = z.strictObject({
  id: z.string(),
  snapshot_id: z.string().nullable(),
  publisher: z.string().nullable(),
  url: z.string().nullable(),
  sha256: z.string().nullable(),
  retrieved_at: z.string().nullable(),
  publisher_updated_at: z.string().nullable(),
  record_ref: z.string().nullable(),
  status: z.enum(["available", "unknown"]),
});
export const marketOutput = z.strictObject({
  schema_version: z.literal("1"),
  status: z.enum(["ok", "unknown", "ambiguous", "unsupported", "error"]),
  data_generation: z.string(),
  provenance: z.array(source),
  notes: z.array(z.string()),
  truncated: z.boolean(),
  freshness: z.strictObject({
    checked_at: z.string(),
    status: z.literal("current_local"),
  }),
  page: z.null(),
  error: z.null(),
  data: z.strictObject({ comparison: offerCohortSchema }),
});
export type MarketAnswer = z.output<typeof marketOutput>;
