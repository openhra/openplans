export type ProviderStatus =
  | "listed_participating"
  | "explicitly_not_participating"
  | "not_listed"
  | "unknown"
  | "conflicting";
export interface ProviderEvidence extends Record<string, unknown> {
  record_id: string;
  npi: string | null;
  type: string;
  network_tier: string;
  tier_status: "resolved" | "unresolved";
  participation_scope: "provider_record";
  evidence_status: "listed_participating" | "explicitly_not_participating";
  source_record: number;
  source_plan_index: number;
  snapshot_id: string;
  source_set_id: string;
  raw_snapshot_id: string;
  source_id: string;
  source_url: string | null;
  source_updated_at: string | null;
}
export interface ProviderParticipation {
  status: ProviderStatus;
  reason: string | null;
  requested_plan_id: string;
  base_hios_id: string | null;
  identity: string;
  plan_year: number;
  participation_scope: "provider_record";
  snapshot_id: string | null;
  manifest_snapshot_id: string | null;
  evidence: ProviderEvidence[];
  warnings: string[];
}
/** Multiple positive tiers are legitimate; positive and explicit negative evidence conflict. */
export function classifyProviderEvidence(
  evidence: ProviderEvidence[],
  complete: boolean,
): ProviderStatus {
  // A published association is participation evidence even when its tier label is undeclared.
  if (new Set(evidence.map((e) => e.evidence_status)).size > 1)
    return "conflicting";
  if (evidence.length) return evidence[0]!.evidence_status;
  return complete ? "not_listed" : "unknown";
}
/** Preserve issuer fields, normalizing its two observed spellings only at this boundary. */
export function providerSpecialties(record: {
  speciality?: unknown;
  specialty?: unknown;
}): string[] {
  const value = record.speciality ?? record.specialty;
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : typeof value === "string"
      ? [value]
      : [];
}
export {
  createProviderRepository,
  providerParticipation,
  providerIdentity,
} from "./repository.js";
