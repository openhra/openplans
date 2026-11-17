import { offerCohortSchema } from "@openplans/plugin-sdk";
import type {
  CalculationHost,
  CalculationScope,
  OfferCohortInput,
} from "@openplans/plugin-sdk";
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

export async function marketCosts(
  host: CalculationHost,
  input: OfferCohortInput,
  scope: CalculationScope,
): Promise<MarketAnswer> {
  const comparison = await host.enumerateHouseholdOffers(input, scope);
  const provenance = comparison.evidence.snapshots.map((row) => ({
    id: String(row.snapshot_id),
    snapshot_id: String(row.snapshot_id),
    publisher: typeof row.publisher === "string" ? row.publisher : null,
    url: typeof row.url === "string" ? row.url : null,
    sha256: typeof row.sha256 === "string" ? row.sha256 : null,
    retrieved_at:
      typeof row.retrieved_at === "string" ? row.retrieved_at : null,
    publisher_updated_at:
      typeof row.publisher_updated_at === "string"
        ? row.publisher_updated_at
        : null,
    record_ref: null,
    status: "available" as const,
  }));
  return {
    schema_version: "1",
    status: ["calculated", "no_plans"].includes(comparison.status)
      ? "ok"
      : "unknown",
    data_generation: comparison.data_generation,
    provenance,
    notes: comparison.reason ? [comparison.reason] : [],
    truncated: false,
    freshness: {
      checked_at: new Date().toISOString(),
      status: "current_local",
    },
    page: null,
    error: null,
    data: { comparison },
  };
}
