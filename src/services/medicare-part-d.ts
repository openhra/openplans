import type { SqlSession } from "../db/database.js";
import type { PartDDrugName } from "../api/medicare-schemas.js";

/**
 * Part D formulary, pharmacy network and unit-cost serving waits on an owner decision about which
 * published terms govern the free files. It stays off unless the operator sets
 * OPENPLANS_MEDICARE_PART_D=on, and then serves only loaded releases with their as-of date.
 */
export function partDEnabled(): boolean {
  return process.env.OPENPLANS_MEDICARE_PART_D === "on";
}

export async function partDStatus(db: SqlSession, year: number) {
  if (!partDEnabled())
    return { status: "unknown", reason: "pending_terms_review" };
  const release = (
    await db
      .query<{ snapshot_id: string; as_of: string; kind: string }>(
        `SELECT r.snapshot_id, r.as_of::text AS as_of, r.kind FROM partd_release r JOIN snapshot s USING(snapshot_id)
         WHERE s.validation_state='ACTIVE' AND r.contract_year=$1 ORDER BY r.as_of DESC LIMIT 1`,
        [year],
      )
      .catch(() => ({
        rows: [] as { snapshot_id: string; as_of: string; kind: string }[],
      }))
  ).rows[0];
  return release
    ? {
        status: "available",
        as_of: release.as_of,
        release: release.kind,
        snapshot_id: release.snapshot_id,
        caveat:
          "Average plan costs as of the release date; not a price at any pharmacy.",
      }
    : { status: "unknown", reason: "not_loaded" };
}

interface PartDRelease extends Record<string, unknown> {
  snapshot_id: string;
  kind: string;
  as_of: string;
  tables: string[];
}
async function partDRelease(
  db: SqlSession,
  year: number,
  table: string,
): Promise<PartDRelease | null> {
  return (
    (
      await db.query<PartDRelease>(
        `SELECT r.snapshot_id,r.kind,r.as_of::text AS as_of,r.tables FROM partd_release r
         JOIN snapshot s USING(snapshot_id) WHERE s.validation_state='ACTIVE' AND r.contract_year=$1
         AND $2 = ANY(r.tables) ORDER BY r.as_of DESC LIMIT 1`,
        [year, table],
      )
    ).rows[0] ?? null
  );
}

const costTypes: Record<string, string> = {
  "0": "not_offered",
  "1": "copay",
  "2": "coinsurance",
};
const daysSupply: Record<string, string> = {
  "1": "30_days",
  "2": "90_days",
  "3": "other",
  "4": "60_days",
};
const coverageLevels: Record<string, string> = {
  "0": "pre_deductible",
  "1": "initial_coverage",
  "3": "catastrophic",
};
/** One channel of a beneficiary-cost row, as the record layout defines its type and amount. */
function channel(cells: Record<string, string>, suffix: string) {
  const type = costTypes[cells[`COST_TYPE_${suffix}`] ?? ""] ?? "unknown";
  const amount = cells[`COST_AMT_${suffix}`] ?? "";
  return {
    type,
    amount: type === "not_offered" || !amount ? null : amount,
    minimum: cells[`COST_MIN_AMT_${suffix}`] || null,
    maximum: cells[`COST_MAX_AMT_${suffix}`] || null,
  };
}

type PlanKeyParts = { contractId: string; planId: string; segmentId: string };

function drugName(row?: {
  name_snapshot_id: string | null;
  name: string | null;
  name_tty: string | null;
}): PartDDrugName {
  let reason: PartDDrugName["name_reason"] = null;
  if (!row) reason = "rxcui_not_in_plan_formulary";
  else if (!row.name_snapshot_id) reason = "rxnorm_not_loaded";
  else if (row.name === null) reason = "rxcui_not_in_loaded_rxnorm";
  return {
    name: row?.name ?? null,
    name_tty: row?.name_tty ?? null,
    name_reason: reason,
    name_snapshot_id: row?.name_snapshot_id ?? null,
  };
}

async function planFormulary(
  db: SqlSession,
  release: PartDRelease,
  key: PlanKeyParts,
) {
  return (
    await db.query<{ formulary_id: string; suppressed: boolean }>(
      `SELECT formulary_id,bool_or(suppressed) AS suppressed FROM partd_plan WHERE snapshot_id=$1
       AND contract_id=$2 AND plan_id=$3 AND segment_id=$4 GROUP BY formulary_id`,
      [release.snapshot_id, key.contractId, key.planId, key.segmentId],
    )
  ).rows;
}

/** Formulary listing, tier cost sharing and average unit cost of one RxCUI for one plan. */
export async function partDDrug(
  db: SqlSession,
  key: PlanKeyParts,
  year: number,
  rxcui: string,
) {
  if (!partDEnabled())
    return { status: "unknown", reason: "pending_terms_review" };
  const release = await partDRelease(db, year, "formulary");
  if (!release) return { status: "unknown", reason: "not_loaded" };
  const plans = await planFormulary(db, release, key);
  if (!plans.length)
    return {
      status: "unknown",
      reason: "plan_not_in_part_d_files",
      as_of: release.as_of,
    };
  if (plans.some((plan) => plan.suppressed))
    return {
      status: "unknown",
      reason: "plan_suppressed_by_cms",
      as_of: release.as_of,
    };
  if (plans.length > 1)
    return {
      status: "unknown",
      reason: "several_formularies_listed",
      as_of: release.as_of,
    };
  const formulary = plans[0]!.formulary_id;
  const listed = (
    await db.query<{
      ndc: string;
      tier: number | null;
      cells: Record<string, string>;
      source_row: number;
      name_snapshot_id: string | null;
      name: string | null;
      name_tty: string | null;
    }>(
      `WITH current_rx AS (
         SELECT r.snapshot_id FROM rx_release r JOIN snapshot s USING(snapshot_id)
         WHERE s.validation_state='ACTIVE' ORDER BY r.source_version DESC LIMIT 1
       )
       SELECT f.ndc,f.tier,f.cells,f.source_row,r.snapshot_id AS name_snapshot_id,n.name,n.tty AS name_tty
       FROM partd_formulary_drug f LEFT JOIN current_rx r ON true
       LEFT JOIN LATERAL (
         SELECT c.name,c.tty FROM rx_concept c
         WHERE c.snapshot_id=r.snapshot_id AND c.rxcui=f.rxcui
         ORDER BY CASE WHEN c.tty IN ('SCD','SBD') THEN 0 ELSE 1 END,
           c.tty,c.name,c.suppress,c.source_record LIMIT 1
       ) n ON true
       WHERE f.snapshot_id=$1 AND f.formulary_id=$2 AND f.rxcui=$3 ORDER BY f.ndc,f.source_row`,
      [release.snapshot_id, formulary, rxcui],
    )
  ).rows;
  const tiers = [
    ...new Set(
      listed
        .map((row) => row.tier)
        .filter((tier): tier is number => tier !== null),
    ),
  ];
  const costs = tiers.length
    ? (
        await db.query<{
          tier: number;
          cells: Record<string, string>;
          source_row: number;
        }>(
          `SELECT tier,cells,source_row FROM partd_plan_row WHERE snapshot_id=$1 AND table_name='beneficiary_cost'
           AND contract_id=$2 AND plan_id=$3 AND segment_id=$4 AND tier = ANY($5::int[]) ORDER BY tier,source_row`,
          [
            release.snapshot_id,
            key.contractId,
            key.planId,
            key.segmentId,
            tiers,
          ],
        )
      ).rows
    : [];
  const pricing = await partDRelease(db, year, "pricing");
  const unitCosts =
    pricing && listed.length
      ? (
          await db.query<{
            ndc: string;
            days_supply: number;
            unit_cost: string;
          }>(
            `SELECT c.ndc,c.days_supply,c.unit_cost::text FROM partd_pricing_release k
             JOIN partd_plan_unit_cost c ON c.release_key=k.release_key WHERE k.snapshot_id=$1
             AND c.contract_id=$2 AND c.plan_id=$3 AND c.segment_id=$4 AND c.ndc = ANY($5::text[])
             ORDER BY c.ndc,c.days_supply`,
            [
              pricing.snapshot_id,
              key.contractId,
              key.planId,
              key.segmentId,
              listed.map((row) => row.ndc),
            ],
          )
        ).rows
      : [];
  return {
    status: listed.length ? "listed" : "not_listed",
    ...drugName(listed[0]),
    note: listed.length
      ? "Listed on the plan's published formulary file."
      : "Not in the plan's published formulary file; ask the plan about exceptions.",
    as_of: release.as_of,
    snapshot_id: release.snapshot_id,
    formulary_id: formulary,
    packages: listed.map((row) => ({
      proxy_ndc: row.ndc,
      tier: row.tier,
      prior_authorization: row.cells.PRIOR_AUTHORIZATION_YN === "Y",
      step_therapy: row.cells.STEP_THERAPY_YN === "Y",
      quantity_limit:
        row.cells.QUANTITY_LIMIT_YN === "Y"
          ? {
              amount: row.cells.QUANTITY_LIMIT_AMOUNT || null,
              days: row.cells.QUANTITY_LIMIT_DAYS || null,
            }
          : null,
      selected_for_negotiation: row.cells.SELECTED_DRUG_YN === "Y",
      source_row: row.source_row,
    })),
    tier_cost_sharing: costs.map((row) => ({
      tier: row.tier,
      coverage_level:
        coverageLevels[row.cells.COVERAGE_LEVEL ?? ""] ?? "unknown",
      days_supply: daysSupply[row.cells.DAYS_SUPPLY ?? ""] ?? "unknown",
      specialty_tier: row.cells.TIER_SPECIALTY_YN === "Y",
      deductible_applies: row.cells.DED_APPLIES_YN === "Y",
      preferred_retail: channel(row.cells, "PREF"),
      standard_retail: channel(row.cells, "NONPREF"),
      preferred_mail: channel(row.cells, "MAIL_PREF"),
      standard_mail: channel(row.cells, "MAIL_NONPREF"),
      source_row: row.source_row,
    })),
    average_unit_cost: pricing
      ? {
          status: unitCosts.length ? "available" : "unknown",
          as_of: pricing.as_of,
          snapshot_id: pricing.snapshot_id,
          caveat:
            "Average cost per unit at in-area retail pharmacies for the plan; not a price at any pharmacy.",
          rows: unitCosts,
        }
      : { status: "unknown", reason: "pricing_not_loaded" },
    tier_labels: {
      status: "unknown",
      reason: "tier_names_not_in_public_files",
    },
  };
}

/** Network pharmacies of a plan in one ZIP; names and addresses come only from NPPES. */
export async function partDPharmacies(
  db: SqlSession,
  key: PlanKeyParts,
  year: number,
  zip: string,
) {
  if (!partDEnabled())
    return { status: "unknown", reason: "pending_terms_review" };
  const release = await partDRelease(db, year, "pharmacy_network");
  if (!release)
    return { status: "unknown", reason: "pharmacy_network_not_loaded" };
  const network = (
    await db.query<{ network_id: string }>(
      `SELECT network_id FROM partd_plan_network WHERE snapshot_id=$1 AND contract_id=$2 AND plan_id=$3 AND segment_id=$4`,
      [release.snapshot_id, key.contractId, key.planId, key.segmentId],
    )
  ).rows[0];
  if (!network)
    return {
      status: "unknown",
      reason: "plan_not_in_part_d_files",
      as_of: release.as_of,
    };
  const rows = (
    await db.query<{
      npi: string;
      cells: Record<string, string>;
      name: string | null;
      line_1: string | null;
      city: string | null;
      state: string | null;
      phone: string | null;
    }>(
      `SELECT n.npi,n.cells,
         coalesce(p.organization_name, nullif(concat_ws(' ',p.first_name,p.last_name),'')) AS name,
         a.line_1,a.city,a.state,a.phone
       FROM partd_network_pharmacy n
       LEFT JOIN npi_provider p ON p.npi=n.npi
       LEFT JOIN npi_address a ON a.npi=n.npi AND a.kind='practice' AND a.ordinal=0
       WHERE n.snapshot_id=$1 AND n.network_id=$2 AND n.zip=$3 ORDER BY n.npi LIMIT 500`,
      [release.snapshot_id, network.network_id, zip],
    )
  ).rows;
  return {
    status: "available",
    as_of: release.as_of,
    snapshot_id: release.snapshot_id,
    zip,
    pharmacies: rows.map((row) => ({
      npi: row.npi,
      retail: row.cells.PHARMACY_RETAIL === "Y",
      mail_order: row.cells.PHARMACY_MAIL === "Y",
      preferred_retail: row.cells.PREFERRED_STATUS_RETAIL === "Y",
      preferred_mail: row.cells.PREFERRED_STATUS_MAIL === "Y",
      in_service_area: row.cells.IN_AREA_FLAG === "1",
      nppes: row.name
        ? {
            status: "available",
            name: row.name,
            address: row.line_1,
            city: row.city,
            state: row.state,
            phone: row.phone,
          }
        : { status: "unknown", reason: "npi_not_in_loaded_nppes" },
    })),
  };
}
