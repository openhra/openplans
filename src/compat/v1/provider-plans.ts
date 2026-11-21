import type { SqlSession } from "../../db/database.js";
import { providerAvailability } from "../../domain/providers/availability.js";
import type { ProviderAvailability } from "../../domain/providers/availability.js";

/** Gap label prefix; the suffix counts issuer scopes whose provider set is not loaded complete. */
export const PLAN_LIST_PARTIAL = "provider_plan_list_partial";

export interface ProviderPlanList {
  /** Base (14-character) plan ids a complete, current, ACTIVE source set lists the NPI under. */
  planIds: string[];
  /** Issuer/state scopes of the year whose provider set is not complete, current and ACTIVE. */
  unknownScopes: number;
  /** Issuer/state scopes known for the year: the active catalog plus every provider set. */
  scopes: number;
}

interface Witness extends Record<string, unknown> {
  base_hios_id: string;
  issuer_id: string;
  state: string;
  source_set_id: string;
  positive: boolean;
}

const scopeKey = (issuer: string, state: string) => `${issuer}|${state}`;

/**
 * A set witnesses only when the availability check calls it complete (current discovery,
 * manifest complete) and the set it validated is the active one the evidence came from.
 */
function witnessingSet(source: ProviderAvailability | undefined, set: string) {
  return source?.status === "complete" && source.active_snapshot_id === set;
}

/**
 * The plans whose issuer's own provider source set for `year` lists the NPI as participating.
 * Positive witnesses only: an NPI absent from a set, an explicit non-participation row, a plan
 * with conflicting rows, an incomplete or superseded set and stored pass-through answers never
 * add a plan. Reads only issuer provider files (`qhp_provider_*`) and their availability.
 */
export async function providerPlanList(
  db: SqlSession,
  npi: string,
  year: number,
): Promise<ProviderPlanList> {
  const availability = (await providerAvailability(db)).filter(
    (row) => row.plan_year === year,
  );
  const bySet = new Map(
    availability.map((row) => [scopeKey(row.issuer_id, row.state), row]),
  );
  const catalog = (
    await db.query<{ issuer_id: string; state: string }>(
      `SELECT DISTINCT p.issuer_id,p.state
      FROM puf_active_catalog a JOIN puf_import_file f ON f.import_id=a.import_id AND f.kind='plan-attributes'
      JOIN plan p ON p.snapshot_id=f.snapshot_id AND p.state=a.state AND p.plan_year=a.plan_year
      WHERE a.plan_year=$1`,
      [year],
    )
  ).rows;
  const scopes = new Set([
    ...catalog.map((row) => scopeKey(row.issuer_id, row.state)),
    ...bySet.keys(),
  ]);
  const unknownScopes = [...scopes].filter(
    (key) => bySet.get(key)?.status !== "complete",
  ).length;
  // The plan id must belong to the issuer/state whose set lists it, as in the per-plan check.
  const witnesses = (
    await db.query<Witness>(
      `SELECT e.base_hios_id,a.issuer_id,a.state,a.snapshot_id AS source_set_id,
        bool_and(e.evidence_status='listed_participating') AS positive
      FROM provider_active_set a
      JOIN provider_shard s ON s.source_set_id=a.snapshot_id
      JOIN snapshot p ON p.snapshot_id=s.snapshot_id AND p.validation_state='ACTIVE'
      JOIN qhp_provider_record r ON r.snapshot_id=p.snapshot_id AND r.npi=$1
      JOIN qhp_provider_plan e ON e.snapshot_id=r.snapshot_id AND e.record_id=r.record_id
        AND e.plan_year=$2 AND left(e.base_hios_id,7)=a.issuer_id||a.state
      WHERE a.plan_year=$2
      GROUP BY e.base_hios_id,a.issuer_id,a.state,a.snapshot_id`,
      [npi, year],
    )
  ).rows;
  // One active set per scope, so each plan has one row; a negative or mixed row is no witness.
  const planIds = witnesses
    .filter(
      (witness) =>
        witness.positive &&
        witnessingSet(
          bySet.get(scopeKey(witness.issuer_id, witness.state)),
          witness.source_set_id,
        ),
    )
    .map((witness) => witness.base_hios_id);
  return {
    planIds: [...new Set(planIds)].sort(),
    unknownScopes,
    scopes: scopes.size,
  };
}

/** Gap labels for the list: partial when any scope is unknown, unavailable with no scope at all. */
export function planListGaps(list: ProviderPlanList): string[] {
  if (!list.scopes) return ["hios_ids_unavailable"];
  return list.unknownScopes
    ? [`${PLAN_LIST_PARTIAL}:${list.unknownScopes}`]
    : [];
}
