import type {
  CalculationHost,
  CalculationScope,
  OfferCohortInput,
} from "@openplans/plugin-sdk";
import type { MarketAnswer } from "./output.js";

export { marketOutput } from "./output.js";
export type { MarketAnswer } from "./output.js";

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
