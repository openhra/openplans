export type DrugStatus =
  | "listed_covered"
  | "explicitly_not_covered"
  | "not_listed"
  | "unknown"
  | "conflicting";
export interface DrugEvidence extends Record<string, unknown> {
  drug_tier: string;
  tier_status: "resolved" | "unresolved";
  cost_sharing: null;
  prior_authorization: boolean | null;
  step_therapy: boolean | null;
  quantity_limit: boolean | null;
  evidence_status: "listed_covered" | "explicitly_not_covered";
  snapshot_id: string;
  source_id: string;
  source_record: number;
  source_plan_index: number;
  source_set_id: string;
  raw_snapshot_id: string;
  source_url: string | null;
  source_updated_at: string | null;
}
export interface DrugCoverage {
  status: DrugStatus;
  reason: string | null;
  base_hios_id: string | null;
  requested_plan_id: string;
  rxcui: string;
  plan_year: number;
  tier_status: "resolved" | "unresolved" | null;
  cost_sharing: null;
  drug_tier: string | null;
  prior_authorization: boolean | null;
  step_therapy: boolean | null;
  quantity_limit: boolean | null;
  patient_price: null;
  evidence: DrugEvidence[];
  snapshot_id: string | null;
  manifest_snapshot_id: string | null;
}
/** Compare published facts, retaining every source rather than choosing a shard by order. */
export function classifyDrugEvidence(
  evidence: DrugEvidence[],
  complete: boolean,
): DrugStatus {
  if (!evidence.length) return complete ? "not_listed" : "unknown";
  if (
    new Set(evidence.map((e) => e.evidence_status)).size > 1 ||
    new Set(evidence.map((e) => e.drug_tier)).size > 1 ||
    (["prior_authorization", "step_therapy", "quantity_limit"] as const).some(
      (key) =>
        new Set(evidence.map((e) => e[key]).filter((value) => value !== null))
          .size > 1,
    )
  )
    return "conflicting";
  return evidence[0]!.evidence_status;
}
export { createDrugRepository, drugCoverage } from "./repository.js";
