// Synthetic structural shells; no clinical, participation or premium claims.
export const evidence = { evidence_refs: ["synthetic-source"], gaps: [] };
export const shellPlan = {
  kind: "plan",
  plan_ref: "87226TX0100013",
  hios_id: "87226TX0100013",
  plan_key: null,
  year: 2026,
  name: "Synthetic contract shell",
  metal: null,
  on_exchange: "unknown",
  selected_variant_id: null,
  cost_sharing_status: "unknown",
  enrollment_eligibility: "unknown",
  ...evidence,
};
export function envelope(data: unknown) {
  return {
    schema_version: "1",
    status: "ok",
    data_generation: "synthetic-contract-generation",
    data,
    provenance: [
      {
        id: "synthetic-source",
        snapshot_id: "synthetic-contract-snapshot",
        publisher: "Synthetic contract fixture",
        url: null,
        sha256: null,
        retrieved_at: null,
        publisher_updated_at: null,
        record_ref: null,
        status: "available",
      },
    ],
    notes: [],
    truncated: false,
    freshness: { checked_at: "2026-11-08T00:00:00Z", status: "unknown" },
    page: null,
    error: null,
  };
}
