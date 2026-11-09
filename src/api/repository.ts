import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { attributeCostSharing, selectedVariant } from "../domain/csr/index.js";
import {
  catalogRule,
  stateCatalog,
  stateRatingArea,
  stateDetailSource,
  stateDetailColumns,
} from "../ingest/state/catalog.js";
import type { StateCatalogRow } from "../ingest/state/catalog.js";
import type { SqlSession } from "../db/database.js";
import {
  ratingAreaForLocation,
  zipToCounties,
} from "../ingest/geo/repository.js";
import type { CountyShare, ZipCounties } from "../ingest/geo/repository.js";
import type { CmsLookupOptions } from "../ingest/geo/cms.js";
import { relationships } from "../ingest/geo/parse.js";
import { GEO_SOURCES } from "../ingest/geo/sources.js";
import { ratingRule } from "../ingest/rating-rules/index.js";
import { dentalRatingRule } from "../domain/rating/index.js";
import { plansForCounty } from "../ingest/puf/import-repository.js";
import type { CountyPlan } from "../ingest/puf/import-repository.js";
import type { LocationInput } from "./validation.js";
import { fail } from "./validation.js";
import { FEDERAL_PLAN_ATTRIBUTES, PLAN_COLUMN_KEYS } from "./plan-view.js";
import type { PublishedPlanAttributes } from "./plan-view.js";

// Stable Census identifiers, independent of state rating policy.
const STATE_FIPS = Object.fromEntries(
  "AL:01 AK:02 AZ:04 AR:05 CA:06 CO:08 CT:09 DE:10 DC:11 FL:12 GA:13 HI:15 ID:16 IL:17 IN:18 IA:19 KS:20 KY:21 LA:22 ME:23 MD:24 MA:25 MI:26 MN:27 MS:28 MO:29 MT:30 NE:31 NV:32 NH:33 NJ:34 NM:35 NY:36 NC:37 ND:38 OH:39 OK:40 OR:41 PA:42 RI:44 SC:45 SD:46 TN:47 TX:48 UT:49 VT:50 VA:51 WA:53 WV:54 WI:55 WY:56"
    .split(" ")
    .map((pair) => pair.split(":")),
);
export const countyState = (county: string): string | null =>
  Object.keys(STATE_FIPS).find(
    (state) => STATE_FIPS[state] === county.slice(0, 2),
  ) ?? null;

export interface Plan extends Record<string, unknown> {
  base_plan_id: string;
  plan_year: number;
  state: string;
  issuer_id: string;
  market: string;
  metal: string;
  dental_only: boolean;
  plan_name: string;
  network_id: string;
  service_area_id: string;
  on_exchange: boolean;
  off_exchange: boolean;
  snapshot_id: string;
  source_row: number;
  state_catalog?: boolean;
  plan_key?: string;
  hios_id?: string | null;
  hios_match?: StateCatalogRow["hios_match"];
  hios_match_reason?: string;
  hios_candidates?: Record<string, unknown>[];
  hios_match_rule?: string | null;
  hios_match_provenance?: Record<string, unknown> | null;
}

interface RelationshipSnapshot extends Record<string, unknown> {
  snapshot_id: string;
  raw_path: string;
  sha256: string;
  compressed_bytes: string;
}
// Keep one immutable national index, shared by concurrent requests. A changed file is reverified.
let relationshipIndex:
  { key: string; rows: Promise<Map<string, CountyShare[]>> } | undefined;

async function snapshotCounties(snapshot: RelationshipSnapshot) {
  let info;
  try {
    info = await stat(snapshot.raw_path);
  } catch (error) {
    // SQL-only deployments may not mount raw snapshots. Their existing lookup still applies.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (
    info.size !== Number(snapshot.compressed_bytes) ||
    info.size > GEO_SOURCES.relationship.maxBytes
  )
    throw new Error("Geography snapshot size mismatch");
  const key = JSON.stringify([snapshot, info.ino, info.mtimeMs, info.ctimeMs]);
  if (relationshipIndex?.key !== key) {
    const rows = (async () => {
      const bytes = await readFile(snapshot.raw_path);
      if (
        bytes.length !== info.size ||
        createHash("sha256").update(bytes).digest("hex") !== snapshot.sha256
      )
        throw new Error("Geography snapshot hash mismatch");
      const index = new Map<string, CountyShare[]>();
      for await (const row of relationships(Readable.from([bytes]))) {
        if (!row.zcta || !row.areas) continue;
        const [landZip, waterZip, landCounty, waterCounty, land, water] =
          row.areas;
        const share = (total: string) =>
          BigInt(total) === 0n ? null : String(Number(land) / Number(total));
        const counties = index.get(row.zcta) ?? [];
        counties.push({
          county_fips: row.countyFips,
          county_name: row.countyName,
          snapshot_id: snapshot.snapshot_id,
          source_row: row.rowNumber,
          arealand_zcta: landZip,
          areawater_zcta: waterZip,
          arealand_county: landCounty,
          areawater_county: waterCounty,
          arealand_part: land,
          areawater_part: water,
          zcta_land_share: share(landZip),
          county_land_share: share(landCounty),
          source: "zcta",
        });
        index.set(row.zcta, counties);
      }
      return index;
    })();
    relationshipIndex = { key, rows };
    // A failed read must be retryable once the operator repairs the cache.
    void rows.catch(() => {
      if (relationshipIndex?.key === key) relationshipIndex = undefined;
    });
  }
  return relationshipIndex.rows;
}

export async function locationZipCounties(
  db: SqlSession,
  zip: string,
  options: CmsLookupOptions = {},
): Promise<ZipCounties> {
  const result = await zipToCounties(db, zip, options);
  if (result.source === "zcta") return result;
  // A state-scoped import loads only its ZCTAs, but retains the national source.
  // Postal locality lists can omit secondary counties; consult that exact source before rejecting.
  const { rows: snapshots } = await db.query<RelationshipSnapshot>(
    `SELECT DISTINCT s.snapshot_id,s.raw_path,s.sha256,s.compressed_bytes::text,s.retrieved_at
    FROM snapshot s JOIN (
      SELECT DISTINCT ON (state) relationship_snapshot_id FROM geo_import
      ORDER BY state,imported_at DESC,plan_year DESC
    ) g ON g.relationship_snapshot_id=s.snapshot_id
    WHERE s.source_id=$1 AND s.requested_url=$2 AND s.validation_state='ACTIVE'
    ORDER BY s.retrieved_at DESC,s.snapshot_id`,
    [GEO_SOURCES.relationship.source, GEO_SOURCES.relationship.url],
  );
  for (const snapshot of snapshots) {
    const counties = (await snapshotCounties(snapshot))?.get(zip);
    if (counties?.length)
      return {
        zip,
        status: "available",
        geography: "2020_zcta",
        source: "zcta",
        counties: [...counties].sort((a, b) =>
          a.county_fips.localeCompare(b.county_fips),
        ),
      };
  }
  return result;
}

export async function resolveLocation(db: SqlSession, input: LocationInput) {
  if (!input.zip)
    return {
      status: "available" as const,
      ...input,
      counties: [],
      county: input.county!,
    };
  const result = await locationZipCounties(db, input.zip);
  if (result.status === "unknown")
    return { ...input, status: "unknown" as const, counties: result.counties };
  // A multi-county Vermont ZCTA has the same statewide medical service area.
  if (
    !input.county &&
    result.counties.length > 1 &&
    result.counties.every((c) => c.county_fips.startsWith("50"))
  ) {
    return {
      ...input,
      status: "available" as const,
      counties: result.counties,
      county: result.counties[0]!.county_fips,
      location_scope: "VT_statewide",
    };
  }
  if (
    input.county &&
    !result.counties.some((c) => c.county_fips === input.county)
  )
    fail("county", "ZIP_COUNTY_MISMATCH");
  if (!input.county && result.counties.length !== 1)
    return {
      ...input,
      status: "ambiguous" as const,
      counties: result.counties,
    };
  return {
    ...input,
    status: "available" as const,
    counties: result.counties,
    county: input.county ?? result.counties[0]!.county_fips,
  };
}
export function zipEligible(plan: CountyPlan, zip?: string): boolean {
  return (
    !plan.zip_restricted || (zip !== undefined && plan.zip_codes.includes(zip))
  );
}
export async function countyPlans(
  db: SqlSession,
  county: string,
  year: number,
  zip?: string,
  coverage: "medical" | "dental" = "medical",
) {
  const stateScope = countyState(county);
  if (stateScope === "NY" || stateScope === "VT")
    return coverage === "dental"
      ? []
      : stateCountyPlans(db, stateScope, county, year);
  const plans = (await plansForCounty(db, county, year, "Individual")).filter(
    (p) => p.dental_only === (coverage === "dental") && zipEligible(p, zip),
  );
  const state = countyState(county);
  if (!state || !plans.length) return plans;
  const [resolution, rule] = await Promise.all([
    ratingAreaForLocation(db, state, year, county, zip),
    ratingRule(db, state, year, "Individual"),
  ]);
  const area = resolution.status === "available" ? resolution.areas[0]! : null;
  const supported =
    coverage === "dental"
      ? dentalRatingRule(state, year, "Individual") !== null
      : rule?.method === "per_member";
  const premiumAvailability = !supported
    ? {
        status: "unsupported_rating_method",
        reason: "STATE_RATING_METHOD_UNSUPPORTED",
      }
    : area
      ? {
          status: "available",
          rating_area_id: area.rating_area_id,
          rating_area_provenance: {
            snapshot_id: area.snapshot_id,
            source_row: area.source_row,
          },
        }
      : { status: resolution.status, reason: "UNRESOLVED_RATING_AREA" };
  return plans.map((plan) => ({
    ...plan,
    premium_availability: premiumAvailability,
  }));
}
function statePlan(rows: StateCatalogRow[]): Plan & CountyPlan {
  const row = rows[0]!,
    raw = row.raw_record;
  const identityEvidence = Boolean(row.hios_candidates?.length);
  return {
    base_plan_id: row.plan_key,
    plan_key: row.plan_key,
    hios_id: raw.plan_id ?? row.hios_id,
    ...(row.state === "VT"
      ? {
          hios_match: row.hios_match ?? "none",
          // An unrelated supplemental catalog must not change an absence response.
          // The audit table retains precise no-candidate reasons and both sources.
          hios_match_reason: identityEvidence
            ? row.hios_match_reason!
            : "no_verified_hios_match",
          hios_candidates: row.hios_candidates ?? [],
          hios_match_rule: identityEvidence ? row.hios_match_rule : null,
          hios_match_provenance: identityEvidence
            ? row.hios_match_provenance
            : null,
        }
      : {}),
    plan_year: row.plan_year,
    state: row.state,
    issuer_id: row.hios_id?.slice(0, 5) ?? raw.issuer,
    market: "Individual",
    metal: raw.metal ?? "unknown",
    dental_only: false,
    plan_name: raw.plan_name ?? "unknown",
    network_id: "",
    service_area_id: "",
    on_exchange:
      row.sbe_exchange?.on_exchange ??
      (row.state === "VT" && raw.exchange === "On"),
    off_exchange: row.sbe_exchange?.off_exchange ?? false,
    ...(row.sbe_exchange ? { exchange_provenance: row.sbe_exchange } : {}),
    snapshot_id: row.import_id,
    source_row: row.record_index + 1,
    state_catalog: true,
    zip_restricted: false,
    zip_codes: [],
    raw_zip_codes: [],
    rating_method: "community_family_tier",
  };
}
async function stateCountyPlans(
  db: SqlSession,
  state: "NY" | "VT",
  county: string,
  year: number,
) {
  const area = stateRatingArea(state, year, county);
  if (!area) return [];
  const rows = await stateCatalog(
    db,
    year,
    state,
    undefined,
    area.rating_area_id,
  );
  const keys = [...new Set(rows.map((r) => r.plan_key))];
  return keys.map((key) => {
    const matches = rows.filter((r) => r.plan_key === key),
      plan = statePlan(matches);
    const supported = matches.every((row) => catalogRule(row) !== null);
    return {
      ...plan,
      premium_availability: {
        status: !supported
          ? "unsupported_rating_method"
          : matches.length > 1
            ? "ambiguous"
            : "available",
        ...(!supported ? { reason: "NO_APPLICABLE_COMMUNITY_RULE" } : {}),
        rating_area_id: area.rating_area_id,
        rating_area_provenance: area,
        quote_method: "state_filed_tier",
        bindable_quote: false,
      },
    };
  });
}
export async function findPlan(
  db: SqlSession,
  base: string,
  year: number,
): Promise<Plan | null> {
  const { rows } = await db.query<Plan>(
    `SELECT p.* FROM puf_active_catalog a
    JOIN puf_import_file f ON f.import_id=a.import_id AND f.kind='plan-attributes'
    JOIN plan p ON p.snapshot_id=f.snapshot_id
    WHERE p.base_plan_id=$1 AND a.plan_year=$2 AND p.plan_year=a.plan_year AND p.state=a.state`,
    [base, year],
  );
  if (rows[0] && !["NY", "VT"].includes(rows[0].state)) return rows[0];
  const stateRows = await stateCatalog(db, year, undefined, base);
  return stateRows.length ? statePlan(stateRows) : (rows[0] ?? null);
}
export async function snapshots(
  db: SqlSession,
  plan: Plan,
): Promise<Record<string, string>> {
  if (plan.state_catalog) return { "state-rates": plan.snapshot_id };
  const { rows } = await db.query<{ kind: string; snapshot_id: string }>(
    `SELECT f.kind,f.snapshot_id
    FROM puf_import_file anchor JOIN puf_import_file f ON f.import_id=anchor.import_id
    WHERE anchor.kind='plan-attributes' AND anchor.snapshot_id=$1`,
    [plan.snapshot_id],
  );
  return Object.fromEntries(rows.map((row) => [row.kind, row.snapshot_id]));
}
export interface CostSharingOptions {
  csrVariant?: string;
  requestedVariant?: string | null;
  allBenefits?: boolean;
}
export async function planCostSharing(
  db: SqlSession,
  plan: Plan,
  options: CostSharingOptions = {},
) {
  const supplement = plan.state_catalog
    ? await stateDetailSource(
        db,
        plan.state,
        plan.plan_year,
        plan.hios_id,
        plan.snapshot_id,
        plan.plan_key,
      )
    : null;
  const detailPlan = supplement
    ? {
        ...plan,
        state_catalog: false,
        base_plan_id: plan.hios_id!,
        snapshot_id: supplement.snapshot_id,
      }
    : plan;
  const selected = detailPlan.state_catalog
    ? null
    : selectedVariant(
        detailPlan.base_plan_id,
        options.csrVariant,
        options.requestedVariant,
      );
  const files = await snapshots(db, detailPlan);
  const [attributes, benefits] = detailPlan.state_catalog
    ? [{ rows: [] }, { rows: [] }]
    : await Promise.all([
        db.query<{
          variant_plan_id: string;
          csr_variation_type: string;
          variant_name: string;
          exchange_status: string;
          source_row: number;
          raw: Record<string, string>;
          published_attributes: PublishedPlanAttributes;
        }>(
          `SELECT variant_plan_id,csr_variation_type,variant_name,exchange_status,source_row,raw,
        jsonb_strip_nulls(jsonb_build_object(${PLAN_COLUMN_KEYS.map(
          (key) => `'${key}',raw->'${key}'`,
        ).join(",")})) AS published_attributes
      FROM plan_variant WHERE snapshot_id=$1 AND base_plan_id=$2 AND plan_year=$3 AND state=$4
      ORDER BY variant_plan_id`,
          [
            detailPlan.snapshot_id,
            detailPlan.base_plan_id,
            detailPlan.plan_year,
            detailPlan.state,
          ],
        ),
        db.query<{
          published_plan_id: string;
          benefit_name: string;
          cost_sharing_raw: Record<string, string>;
          cost_sharing_parsed: Record<string, unknown>;
          raw: Record<string, string>;
          snapshot_id: string;
          source_row: number;
        }>(
          `SELECT published_plan_id,benefit_name,cost_sharing_raw,cost_sharing_parsed,raw,snapshot_id,source_row FROM plan_benefit
      WHERE snapshot_id=$1 AND base_plan_id=$2 AND ($3::text IS NULL OR published_plan_id=$3)
      ORDER BY published_plan_id,source_row`,
          [
            files["benefits-and-cost-sharing"],
            detailPlan.base_plan_id,
            options.allBenefits ? null : selected,
          ],
        ),
      ]);
  if (supplement) {
    for (const row of attributes.rows) row.raw = stateDetailColumns(row.raw);
    for (const row of benefits.rows) {
      row.raw = stateDetailColumns(row.raw);
      row.cost_sharing_raw = stateDetailColumns(row.cost_sharing_raw);
    }
  }
  const variants = attributes.rows.map((row) => ({
    variant_plan_id: row.variant_plan_id,
    csr_variation_type: row.csr_variation_type,
    variant_name: row.variant_name,
    exchange_status: row.exchange_status,
    source_row: row.source_row,
    ...attributeCostSharing(row.raw),
    provenance: {
      snapshot_id: detailPlan.snapshot_id,
      source_row: row.source_row,
    },
    ...(options.allBenefits
      ? {
          benefits_status: benefits.rows.some(
            (b) => b.published_plan_id === row.variant_plan_id,
          )
            ? "available"
            : "unknown",
          benefits: benefits.rows.filter(
            (b) => b.published_plan_id === row.variant_plan_id,
          ),
        }
      : {}),
  }));
  const attribute = variants.find((row) => row.variant_plan_id === selected);
  const selectedAttributes = attributes.rows.find(
    (row) => row.variant_plan_id === selected,
  );
  const amounts = attributeCostSharing(selectedAttributes?.raw ?? {});
  // Orphan benefit rows never authorize substitution for missing variant attributes.
  const rows = attribute
    ? benefits.rows.filter((row) => row.published_plan_id === selected)
    : [];
  return {
    // Shared identity metadata accompanies both plan views and premium estimates.
    // The internal key continues to select the unchanged filed tier cells.
    ...(plan.state_catalog && plan.state === "VT"
      ? {
          base_plan_id: plan.hios_id ?? null,
          hios_id: plan.hios_id ?? null,
          plan_key: plan.plan_key,
          hios_match: plan.hios_match,
          hios_match_reason: plan.hios_match_reason,
          hios_candidates: plan.hios_candidates,
          hios_match_rule: plan.hios_match_rule,
          hios_match_provenance: plan.hios_match_provenance,
        }
      : {}),
    variant_ids: variants.map((row) => row.variant_plan_id),
    variants,
    csr_eligibility_status: "not_evaluated" as const,
    premium_basis: plan.state_catalog
      ? "state_filed_tier"
      : "base_plan_rate_puf",
    premium_varies_by_csr: plan.state_catalog ? null : false,
    premium_note: plan.state_catalog
      ? null
      : "Rate PUF premiums are filed at base plan level; CSR selection does not change the gross premium.",
    cost_sharing: {
      status: attribute ? ("available" as const) : ("unknown" as const),
      selected_variant_id: selected,
      ...(supplement && selectedAttributes
        ? {
            published_attributes: selectedAttributes.raw,
            supplemental_source: supplement,
          }
        : {}),
      ...(!supplement && selectedAttributes
        ? {
            [FEDERAL_PLAN_ATTRIBUTES]: selectedAttributes.published_attributes,
          }
        : {}),
      selection:
        options.csrVariant !== undefined || options.requestedVariant != null
          ? "explicit"
          : "standard_on_exchange_default",
      ...amounts,
      ...(attribute ? { provenance: attribute.provenance } : {}),
      benefits_status: rows.length
        ? ("available" as const)
        : ("unknown" as const),
      benefits: rows,
    },
  };
}
export async function planView(
  db: SqlSession,
  plan: Plan,
  options: CostSharingOptions = {},
) {
  const sharing = await planCostSharing(db, plan, options);
  if (plan.state_catalog)
    return {
      base_plan_id: plan.hios_id,
      hios_id: plan.hios_id,
      plan_key: plan.plan_key,
      ...sharing,
      plan_year: plan.plan_year,
      state: plan.state,
      market: "individual",
      plan_name: plan.plan_name,
      metal: plan.metal,
      issuer: { issuer_id: plan.issuer_id, marketing_names: [] },
      network: { status: "unknown", records: [] },
      on_exchange: plan.state === "NY" ? "unknown" : plan.on_exchange,
      off_exchange: plan.exchange_provenance ? plan.off_exchange : "unknown",
      enrollment_eligibility: "unknown",
      availability_basis:
        plan.state === "NY"
          ? "filed_rating_area"
          : "DVHA_2026_section_2.3_statewide",
      ...(plan.premium_availability
        ? { premium_availability: plan.premium_availability }
        : {}),
      provenance: {
        snapshot_ids: { "state-rates": plan.snapshot_id },
        ...(plan.exchange_provenance
          ? { exchange: plan.exchange_provenance }
          : {}),
      },
    };

  const files = await snapshots(db, plan);
  const [issuer, networks] = await Promise.all([
    db.query(
      `SELECT issuer_id,marketing_names,snapshot_id,source_row FROM issuer WHERE snapshot_id=$1 AND issuer_id=$2`,
      [plan.snapshot_id, plan.issuer_id],
    ),
    db.query(
      `SELECT network_id,network_name,network_url,snapshot_id,source_row FROM network
      WHERE snapshot_id=$1 AND issuer_id=$2 AND network_id=$3 AND market=$4 AND dental_only=$5 ORDER BY source_row`,
      [
        files.network,
        plan.issuer_id,
        plan.network_id,
        plan.market,
        plan.dental_only,
      ],
    ),
  ]);
  return {
    base_plan_id: plan.base_plan_id,
    ...sharing,
    plan_year: plan.plan_year,
    state: plan.state,
    market: plan.market.toLowerCase(),
    plan_name: plan.plan_name,
    metal: plan.metal,
    issuer: issuer.rows[0] ?? { issuer_id: plan.issuer_id, status: "unknown" },
    network: {
      network_id: plan.network_id,
      status: networks.rows.length ? "available" : "unknown",
      records: networks.rows,
    },
    on_exchange: plan.on_exchange,
    off_exchange: plan.off_exchange,
    ...(plan.premium_availability
      ? { premium_availability: plan.premium_availability }
      : {}),
    provenance: { snapshot_ids: files, plan_source_row: plan.source_row },
  };
}
export async function variantExists(
  db: SqlSession,
  plan: Plan,
  full: string,
): Promise<boolean> {
  const supplement = plan.state_catalog
    ? await stateDetailSource(
        db,
        plan.state,
        plan.plan_year,
        plan.hios_id,
        plan.snapshot_id,
        plan.plan_key,
      )
    : null;
  if (plan.state_catalog && !supplement) return false;
  return (
    (
      await db.query(
        "SELECT 1 FROM plan_variant WHERE snapshot_id=$1 AND variant_plan_id=$2",
        [supplement?.snapshot_id ?? plan.snapshot_id, full],
      )
    ).rows.length === 1
  );
}

// Read-service persistence queries.
export function premiumRateRows(
  db: SqlSession,
  snapshotId: string | undefined,
  base: string,
  area: string,
) {
  return db.query(
    `SELECT *,effective_date::text AS effective_date,expiration_date::text AS expiration_date
    FROM rate WHERE snapshot_id=$1 AND base_plan_id=$2 AND rating_area_id=$3`,
    [snapshotId, base, area],
  );
}

export function dentalBusinessRows(
  db: SqlSession,
  snapshotId: string | undefined,
  base: string,
  market: string,
) {
  return db.query<{ raw: Record<string, string>; source_row: number }>(
    `SELECT raw,source_row FROM business_rule WHERE snapshot_id=$1 AND base_plan_id=$2 AND dental_only AND market=$3 ORDER BY source_row`,
    [snapshotId, base, market],
  );
}

export function premiumAttributeRows(
  db: SqlSession,
  snapshotId: string,
  base: string,
) {
  return db.query<{ raw: Record<string, string>; source_row: number }>(
    `SELECT raw,source_row FROM plan_attribute WHERE snapshot_id=$1 AND base_plan_id=$2 ORDER BY source_row`,
    [snapshotId, base],
  );
}

export function exchangeAttributeRows(
  db: SqlSession,
  snapshotId: string,
  base: string,
) {
  return db.query<{ raw: Record<string, string>; source_row: number }>(
    `SELECT raw,source_row FROM plan_attribute
    WHERE snapshot_id=$1 AND base_plan_id=$2 AND on_exchange ORDER BY source_row`,
    [snapshotId, base],
  );
}

export function dentalBenchmarkRates(
  db: SqlSession,
  snapshotId: string | undefined,
  base: string,
  area: string,
  childAgeBands: string[],
) {
  return db.query<{
    raw: import("../domain/rating/index.js").CmsRateRow;
    snapshot_id: string;
    source_row: number;
  }>(
    `SELECT raw,snapshot_id,source_row FROM rate WHERE snapshot_id=$1 AND base_plan_id=$2 AND rating_area_id=$3 AND age_band = ANY($4::text[])`,
    [snapshotId, base, area, childAgeBands],
  );
}

export function federalCatalog(
  db: SqlSession,
  state: string | null,
  year: number,
) {
  return db.query(
    "SELECT 1 FROM puf_active_catalog WHERE state=$1 AND plan_year=$2",
    [state, year],
  );
}

export function childDentalBenefits(
  db: SqlSession,
  snapshotId: string | undefined,
  base: string,
  names: string[],
) {
  return db.query<{
    benefit_name: string;
    raw: Record<string, string>;
    source_row: number;
  }>(
    `SELECT benefit_name,raw,source_row FROM plan_benefit WHERE snapshot_id=$1 AND base_plan_id=$2
          AND benefit_name = ANY($3::text[])`,
    [snapshotId, base, names],
  );
}

export function enrollmentAttributes(
  db: SqlSession,
  year: number,
  ids: string[],
) {
  return db.query<{
    raw: Record<string, string>;
    source_row: number;
    base_plan_id: string;
  }>(
    `SELECT pa.base_plan_id,pa.raw,pa.source_row FROM puf_active_catalog a
    JOIN puf_import_file f ON f.import_id=a.import_id AND f.kind='plan-attributes'
    JOIN plan_attribute pa ON pa.snapshot_id=f.snapshot_id
    WHERE a.plan_year=$1 AND pa.base_plan_id = ANY($2::text[]) AND pa.on_exchange`,
    [year, ids],
  );
}

export function sbeAvailabilitySources(db: SqlSession) {
  return db.query<{
    state: string;
    plan_year: number;
    import_id: string;
    bundle_url: string;
    bundle_sha256: string;
  }>(
    `SELECT p.state,p.plan_year,c.import_id,c.bundle_url,c.bundle_sha256 FROM sbe_catalog c JOIN puf_import p USING(import_id) JOIN puf_active_catalog a USING(import_id) JOIN snapshot s ON s.snapshot_id=c.import_id AND s.validation_state='ACTIVE'`,
  );
}

export function availabilityGeography(db: SqlSession) {
  return db.query<{
    state: string;
    plan_year: number;
    county_areas: number;
    zip3_areas: number;
  }>(`
    SELECT g.state,g.plan_year,
      (SELECT count(*)::int FROM rating_area r WHERE r.snapshot_id=g.rating_snapshot_id AND r.state=g.state AND r.plan_year=g.plan_year) AS county_areas,
      (SELECT count(*)::int FROM rating_area_zip z WHERE z.snapshot_id=g.rating_snapshot_id AND z.state=g.state AND z.plan_year=g.plan_year) AS zip3_areas
    FROM geo_import g`);
}

export function availabilityRateEvidence(
  db: SqlSession,
  entry: {
    state: string;
    plan_year: number;
    market: string;
    issuer_id: string | null;
    snapshot_id: string | null;
  },
) {
  return db.query<{
    snapshot_id: string;
    rate_rows: number;
    medical_plans: number;
  }>(
    `
      SELECT rf.snapshot_id, count(r.base_plan_id)::int AS rate_rows,
        count(DISTINCT p.base_plan_id)::int AS medical_plans
      FROM puf_active_catalog a
      JOIN puf_import_file pf ON pf.import_id=a.import_id AND pf.kind='plan-attributes'
      JOIN puf_import_file rf ON rf.import_id=a.import_id AND rf.kind='rate'
      LEFT JOIN plan p ON p.snapshot_id=pf.snapshot_id AND NOT p.dental_only AND p.market=$3
        AND ($4::text IS NULL OR p.issuer_id=$4)
      LEFT JOIN rate r ON r.snapshot_id=rf.snapshot_id AND r.base_plan_id=p.base_plan_id
      WHERE a.state=$1 AND a.plan_year=$2 AND a.import_id=$5 GROUP BY rf.snapshot_id`,
    [
      entry.state,
      entry.plan_year,
      entry.market,
      entry.issuer_id,
      entry.snapshot_id,
    ],
  );
}

export function activeStateScopes(db: SqlSession) {
  return db.query<{
    state: string;
    plan_year: number;
  }>(`SELECT a.state,a.plan_year FROM state_rate_active a
    JOIN snapshot s ON s.snapshot_id=a.import_id AND s.validation_state='ACTIVE' ORDER BY a.state,a.plan_year`);
}

export async function directoryRows(
  db: SqlSession,
  kind: "carriers" | "networks",
  state: string,
  year: number | null,
) {
  const fileKind = kind === "carriers" ? "plan-attributes" : "network";
  const columns =
    kind === "carriers"
      ? "r.issuer_id,r.marketing_names,r.state,r.plan_year,r.snapshot_id,r.source_row"
      : "r.network_id,r.issuer_id,r.network_name,r.network_url,r.state,r.plan_year,r.market,r.dental_only,r.snapshot_id,r.source_row";
  const { rows } = await db.query(
    `SELECT ${columns} FROM puf_active_catalog a
    JOIN puf_import_file f ON f.import_id=a.import_id AND f.kind=$1
    JOIN ${kind === "carriers" ? "issuer" : "network"} r ON r.snapshot_id=f.snapshot_id
    WHERE a.state=$2 AND ($3::integer IS NULL OR a.plan_year=$3) ORDER BY r.plan_year,r.issuer_id,r.source_row`,
    [fileKind, state, year],
  );
  return rows;
}

export function activeCatalog(
  db: SqlSession,
  year: number,
  state: string | null,
) {
  return db.query(
    `SELECT 1 FROM puf_active_catalog WHERE plan_year=$1 AND state=$2
    UNION ALL SELECT 1 FROM state_rate_active a JOIN snapshot s ON s.snapshot_id=a.import_id AND s.validation_state='ACTIVE'
    WHERE a.plan_year=$1 AND a.state=$2`,
    [year, state],
  );
}

export interface SnapshotMetadata extends Record<string, unknown> {
  snapshot_id: string;
  source_id: string;
  publisher: string;
  source_kind: string;
  url: string | null;
  sha256: string | null;
  bytes: string | null;
  retrieved_at: string | null;
  publisher_updated_at: string | null;
  validation_state: string;
  expected_children: number | null;
  fetched_children: number;
  parent_snapshot_ids: string[];
  child_snapshot_ids: string[];
}
/** Explicit public columns: never expose raw filesystem paths, headers or destinations. */
export async function snapshotMetadata(
  db: SqlSession,
  id: string,
): Promise<SnapshotMetadata | null> {
  const { rows } = await db.query<SnapshotMetadata>(
    `WITH edges AS (
    SELECT source_set_id AS parent,snapshot_id AS child FROM provider_shard WHERE source_set_id=$1 OR snapshot_id=$1
    UNION SELECT snapshot_id,raw_snapshot_id FROM provider_shard WHERE raw_snapshot_id IS NOT NULL AND (snapshot_id=$1 OR raw_snapshot_id=$1)
    UNION SELECT source_set_id,snapshot_id FROM formulary_shard WHERE source_set_id=$1 OR snapshot_id=$1
    UNION SELECT snapshot_id,raw_snapshot_id FROM formulary_shard WHERE raw_snapshot_id IS NOT NULL AND (snapshot_id=$1 OR raw_snapshot_id=$1)
    UNION SELECT import_id,snapshot_id FROM puf_import_file WHERE import_id=$1 OR snapshot_id=$1
    UNION SELECT import_id,publication_snapshot_id FROM state_community_rate WHERE import_id=$1 OR publication_snapshot_id=$1
  ) SELECT s.snapshot_id,s.source_id,p.publisher,p.source_kind,coalesce(s.final_url,s.requested_url) AS url,
    s.sha256,s.uncompressed_bytes::text AS bytes,s.retrieved_at::text,s.publisher_updated_at::text,
    s.validation_state,s.expected_children,s.fetched_children,
    ARRAY(SELECT parent FROM edges WHERE child=s.snapshot_id ORDER BY parent) AS parent_snapshot_ids,
    ARRAY(SELECT child FROM edges WHERE parent=s.snapshot_id ORDER BY child) AS child_snapshot_ids
    FROM snapshot s JOIN source p USING(source_id) WHERE s.snapshot_id=$1`,
    [id],
  );
  return rows[0] ?? null;
}
