import type { SqlSession } from "../../db/database.js";
import { parse_hios } from "../hios/index.js";
import { providerAvailability } from "./availability.js";
import { classifyProviderEvidence } from "./index.js";
import type { ProviderEvidence, ProviderParticipation } from "./index.js";

export function createProviderRepository(db: SqlSession) {
  return {
    providerParticipation: (planId: string, identity: string, year: number) =>
      providerParticipation(db, planId, identity, year),
    providerIdentity: (recordId: string, snapshot: string) =>
      providerIdentity(db, recordId, snapshot),
  };
}
/** NPPES is identity/taxonomy enrichment; no membership is derived from this join. */
export async function providerIdentity(
  db: SqlSession,
  recordId: string,
  snapshot: string,
) {
  return (
    (
      await db.query(
        `SELECT r.*,n.npi AS nppes_npi,n.entity_type,n.deactivated,n.organization_name,
    n.first_name,n.last_name,n.snapshot_id AS nppes_snapshot_id,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('code',t.code,'is_primary',t.is_primary,'snapshot_id',t.snapshot_id)
      ORDER BY t.ordinal) FROM npi_taxonomy t WHERE t.npi=n.npi),'[]') AS taxonomy
    FROM qhp_provider_record r LEFT JOIN npi_provider n ON n.npi=r.npi
    WHERE r.record_id=$1 AND r.snapshot_id=$2`,
        [recordId, snapshot],
      )
    ).rows[0] ?? null
  );
}
export async function providerParticipation(
  db: SqlSession,
  planId: string,
  identity: string,
  year: number,
): Promise<ProviderParticipation> {
  const result: ProviderParticipation = {
    status: "unknown",
    reason: null,
    requested_plan_id: planId,
    base_hios_id: null,
    identity,
    plan_year: year,
    participation_scope: "provider_record",
    snapshot_id: null,
    manifest_snapshot_id: null,
    evidence: [],
    warnings: [],
  };
  let hios: ReturnType<typeof parse_hios>;
  try {
    hios = parse_hios(planId);
  } catch {
    return { ...result, reason: "invalid_plan_id" };
  }
  result.base_hios_id = hios.base;
  if (!Number.isInteger(year) || year < 2014 || year > 2100)
    return { ...result, reason: "invalid_year" };
  if (typeof identity !== "string" || !identity.length)
    return { ...result, reason: "invalid_identity" };
  const plan = (
    await db.query<{ issuer_id: string; state: string; snapshot_id: string }>(
      `SELECT p.issuer_id,p.state,p.snapshot_id
    FROM puf_active_catalog a JOIN puf_import_file f ON f.import_id=a.import_id AND f.kind='plan-attributes'
    JOIN plan p ON p.snapshot_id=f.snapshot_id AND p.state=a.state AND p.plan_year=a.plan_year
    WHERE p.base_plan_id=$1 AND a.plan_year=$2`,
      [hios.base, year],
    )
  ).rows[0];
  if (!plan) return { ...result, reason: "plan_not_in_catalog" };
  if (
    hios.variant &&
    !(
      await db.query(
        `SELECT 1 FROM plan_variant WHERE snapshot_id=$1 AND variant_plan_id=$2`,
        [plan.snapshot_id, hios.full],
      )
    ).rows.length
  )
    return { ...result, reason: "variant_not_in_catalog" };
  const availability = (
    await providerAvailability(db, {
      issuer: plan.issuer_id,
      year,
      state: plan.state,
    })
  )[0];
  if (availability?.status === "access_denied")
    return {
      ...result,
      reason: "source_access_denied",
      manifest_snapshot_id: availability.snapshot_id,
      warnings: ["SOURCE_ACCESS_DENIED"],
    };
  const rows = (
    await db.query<
      ProviderEvidence & {
        manifest_status: string;
        manifest_id: string;
        active_id: string;
      }
    >(
      `SELECT
    m.status AS manifest_status,m.snapshot_id AS manifest_id,a.snapshot_id AS active_id,
    e.*,r.npi,r.type,r.source_record,r.source_updated_at,s.source_set_id,s.raw_snapshot_id,
    p.source_id,p.final_url AS source_url
    FROM qhp_coverage_manifest m
    LEFT JOIN provider_active_set a ON a.issuer_id=m.issuer_id AND a.plan_year=m.plan_year AND a.state=m.state
    LEFT JOIN provider_shard s ON s.source_set_id=a.snapshot_id
    LEFT JOIN snapshot p ON p.snapshot_id=s.snapshot_id AND p.validation_state='ACTIVE'
    LEFT JOIN qhp_provider_record r ON r.snapshot_id=p.snapshot_id AND (r.npi=$5 OR r.record_id=$5)
    LEFT JOIN qhp_provider_plan e ON e.snapshot_id=r.snapshot_id AND e.record_id=r.record_id AND e.base_hios_id=$4 AND e.plan_year=$2
    WHERE m.issuer_id=$1 AND m.plan_year=$2 AND m.state=$3 AND m.kind='provider'
    ORDER BY s.snapshot_id,r.source_record,e.source_plan_index`,
      [plan.issuer_id, year, plan.state, hios.base, identity],
    )
  ).rows;
  const manifest = rows[0];
  if (!manifest) return { ...result, reason: "source_set_not_available" };
  result.snapshot_id = manifest.active_id ?? null;
  result.manifest_snapshot_id = manifest.manifest_id;
  const evidence = rows
    .filter((row) => row.network_tier != null)
    .map((row) => ({
      record_id: row.record_id,
      npi: row.npi,
      type: row.type,
      source_record: Number(row.source_record),
      source_plan_index: row.source_plan_index,
      network_tier: row.network_tier,
      tier_status: row.tier_status,
      participation_scope: row.participation_scope,
      evidence_status: row.evidence_status,
      snapshot_id: row.snapshot_id,
      source_set_id: row.source_set_id,
      raw_snapshot_id: row.raw_snapshot_id,
      source_id: row.source_id,
      source_url: row.source_url,
      source_updated_at: row.source_updated_at,
    }));
  const status = classifyProviderEvidence(
    evidence,
    availability?.status === "complete" &&
      manifest.manifest_status === "complete" &&
      manifest.manifest_id === manifest.active_id,
  );
  const warnings = [
    ...(evidence.some((e) => e.tier_status === "unresolved")
      ? ["UNRESOLVED_NETWORK_TIER"]
      : []),
    ...(availability?.status !== "complete" ? ["SOURCE_INCOMPLETE"] : []),
  ];
  function participationReason() {
    if (status === "unknown") {
      return availability?.reason ?? "source_set_incomplete";
    } else if (status === "conflicting") {
      return "conflicting_source_records";
    } else {
      return null;
    }
  }
  return {
    ...result,
    status,
    evidence,
    warnings,
    reason: participationReason(),
  };
}
