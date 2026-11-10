import type { SqlSession } from "../db/database.js";
import {
  formatPlanKey,
  parseMoney,
  parsePlanKey,
  parseStars,
} from "../domain/medicare/index.js";
import type { MoneyCell, PlanKey } from "../domain/medicare/index.js";
import { zipToCounties } from "../ingest/geo/repository.js";
import { STATE_FIPS } from "../ingest/geo/states.js";
import { countyMap } from "../ingest/medicare/county-codes.js";
import * as v from "../api/validation.js";
import { ReadError } from "./errors.js";
import { partDDrug, partDPharmacies, partDStatus } from "./medicare-part-d.js";

export const pageSize = 50;
const types: Record<string, string> = {
  ma: "MA",
  ma_pd: "MA-PD",
  pdp: "PDP",
  snp: "SNP",
  cost: "Cost",
};
// Medicare files also cover the territories, which the individual-market table leaves out.
const fipsState: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(STATE_FIPS).map(([state, fips]) => [fips, state]),
  ),
  "60": "AS",
  "66": "GU",
  "69": "MP",
  "72": "PR",
  "78": "VI",
};

export const providerNetwork = {
  status: "unknown",
  reason: "published_only_by_each_organization",
} as const;

export function medicareYear(value: unknown): number {
  const parsed = v.year(value);
  if (parsed < 2006 || parsed > 2100) return v.fail("year", "INVALID_YEAR");
  return parsed;
}
export function planKey(value: unknown): PlanKey {
  const key = parsePlanKey(value);
  if (!key) return v.fail("plan_key", "INVALID_PLAN_KEY");
  return key;
}

export interface Release {
  snapshot_id: string;
  as_of: string;
  as_of_label: string;
  contract_year: number;
}
/** Newest ACTIVE release of one family for a contract (or rating) year. */
export async function activeRelease(
  db: SqlSession,
  family: string,
  year: number,
): Promise<Release | null> {
  return (
    (
      await db.query<Release & Record<string, unknown>>(
        `SELECT r.snapshot_id, r.as_of::text AS as_of, r.as_of_label, r.contract_year
         FROM medicare_release r JOIN snapshot s USING(snapshot_id)
         WHERE s.validation_state='ACTIVE' AND r.family=$1 AND r.contract_year=$2
         ORDER BY r.as_of DESC, r.imported_at DESC LIMIT 1`,
        [family, year],
      )
    ).rows[0] ?? null
  );
}

function money(cell: MoneyCell) {
  return cell.status === "value"
    ? { status: "value", cents: cell.cents }
    : { status: cell.status, cents: null };
}
function yesNo(value: string | undefined): boolean | null {
  if (value === "Yes") return true;
  if (value === "No") return false;
  return null;
}
function text(value: string | undefined): string | null {
  return value && value !== "Not Applicable" ? value : null;
}

interface PlanRow extends Record<string, unknown> {
  contract_id: string;
  plan_id: string;
  segment_id: string;
  cells: Record<string, string>;
  source_row: number;
  summary: Record<string, unknown> | null;
}

/** Projection of one Landscape plan segment (plus PBP Section A/D when loaded). */
export function planView(
  row: PlanRow,
  release: Release,
  county?: {
    lips_amount: string | null;
    ma_region_code: string | null;
    pdp_region_code: string | null;
  },
) {
  const c = row.cells;
  const key = formatPlanKey({
    contractId: row.contract_id,
    planId: row.plan_id,
    segmentId: row.segment_id,
  });
  const snp = yesNo(c["Special Needs Plan (SNP) Indicator"]);
  const summary = (row.summary ?? {}) as Record<string, unknown>;
  const pick = (name: string) => summary[name] ?? null;
  const stars = (name: string) => {
    const cell = parseStars(c[name]);
    return { status: cell.status, stars: cell.stars };
  };
  return {
    plan_key: key,
    contract_year: release.contract_year,
    name: c["Plan Name"] ?? null,
    plan_type: c["Plan Type"] ?? null,
    contract_category: c["Contract Category Type"] ?? null,
    organization: {
      contract_id: row.contract_id,
      contract_name: c["Contract Name"] ?? null,
      marketing_name: c["Organization Marketing Name"] ?? null,
      parent: c["Parent Organization Name"] ?? null,
      organization_type: c["Organization Type"] ?? null,
    },
    premiums_monthly: {
      part_c: money(parseMoney(c["Part C Premium"])),
      part_d_basic: money(parseMoney(c["Part D Basic Premium"])),
      part_d_supplemental: money(parseMoney(c["Part D Supplemental Premium"])),
      part_d_total: money(parseMoney(c["Part D Total Premium"])),
      consolidated: money(
        parseMoney(c["Monthly Consolidated Premium (Part C + D)"]),
      ),
    },
    part_d: {
      coverage: yesNo(c["Part D Coverage Indicator"]),
      benefit_category: text(c["Drug Benefit Category"]),
      benefit_type: text(c["Drug Benefit Type"]),
      national_pdp: yesNo(c["National PDP"]),
      deductible: money(parseMoney(c["Annual Part D Deductible Amount"])),
      oop_threshold: money(
        parseMoney(c["Part D Out-of-Pocket (OOP) Threshold"]),
      ),
      low_income_premium_subsidy: county
        ? money(parseMoney(county.lips_amount ?? ""))
        : { status: "varies_by_region", cents: null },
      lips_cms_pays: money(parseMoney(c["Part D LIPS (CMS Pays)"])),
      low_income_beneficiary_premium: money(
        parseMoney(c["Part D Low Income Beneficiary Premium Amount"]),
      ),
      no_deductible_tier: yesNo(
        c["Offers Drug Tier with No Part D Deductible"],
      ),
    },
    moop_in_network: money(
      parseMoney(c["In-Network Maximum Out-of-Pocket (MOOP) Amount"]),
    ),
    stars: {
      overall: stars("Overall Star Rating"),
      part_c_summary: stars("Part C Summary Star Rating"),
      part_d_summary: stars("Part D Summary Star Rating"),
    },
    snp: snp
      ? {
          type: text(c["SNP Type"]),
          institutional_type: text(c["SNP Institutional Type"]),
          dsnp_integration_status: text(
            c["Dual Eligible SNP (D-SNP) Integration Status"],
          ),
          csnp_condition_type: text(
            c["Chronic or Disabling Condition SNP (C-SNP) Condition Type"],
          ),
          zero_dollar_cost_sharing: yesNo(
            c["Medicare Zero-Dollar Cost Sharing D-SNP"],
          ),
        }
      : null,
    sanctioned: yesNo(c["Sanctioned Plan"]),
    regions: county
      ? {
          ma_region_code: text(county.ma_region_code ?? undefined),
          pdp_region_code: text(county.pdp_region_code ?? undefined),
        }
      : null,
    plan_benefit_package: row.summary
      ? {
          medical_deductible: pick("medical_deductible"),
          in_network_deductible: pick("in_network_deductible"),
          out_of_network_deductible: pick("out_of_network_deductible"),
          plan_premium: pick("plan_premium"),
          moop_combined: pick("moop_combined"),
          moop_out_of_network: pick("moop_out_of_network"),
          part_b_premium_reduction: pick("part_b_premium_reduction"),
          websites: {
            organization: pick("organization_website"),
            formulary: pick("formulary_website"),
            pharmacy_directory: pick("pharmacy_website"),
            provider_directory: pick("provider_directory_website"),
          },
          phones: {
            member: pick("member_phone"),
            prospective_member: pick("prospective_member_phone"),
            part_d_member: pick("part_d_member_phone"),
            part_d_prospective_member: pick("part_d_prospective_member_phone"),
            tty_member: pick("tty_member_phone"),
          },
        }
      : { status: "unknown", reason: "plan_benefit_package_not_loaded" },
    provider_network: providerNetwork,
    provenance: {
      snapshot_id: release.snapshot_id,
      as_of: release.as_of_label,
      source_row: row.source_row,
    },
  };
}

const planSelect = `p.contract_id,p.plan_id,p.segment_id,p.cells,p.source_row,b.summary`;
const pbpJoin = `LEFT JOIN medicare_pbp_plan b ON b.snapshot_id=$PBP AND b.contract_id=p.contract_id
  AND b.plan_id=p.plan_id AND b.segment_id=p.segment_id`;
function withPbp(sql: string, index: number) {
  return sql.replace("$PBP", `$${index}`);
}

async function resolveCounty(db: SqlSession, params: Record<string, string>) {
  if (params.county_fips !== undefined) {
    const fips = v.county(params.county_fips);
    return {
      status: "available" as const,
      county_fips: fips,
      counties: [] as unknown[],
    };
  }
  if (params.zip === undefined) return v.fail("zip", "ZIP_OR_COUNTY_REQUIRED");
  const located = await zipToCounties(db, v.zip(params.zip));
  const counties = located.counties.map((county) => ({
    county_fips: county.county_fips,
    county_name: county.county_name,
  }));
  if (located.status !== "available" || !counties.length)
    return { status: "unknown" as const, county_fips: null, counties };
  if (counties.length > 1)
    return {
      status: "multiple_counties" as const,
      county_fips: null,
      counties,
    };
  return {
    status: "available" as const,
    county_fips: counties[0]!.county_fips,
    counties,
  };
}

export async function searchMedicarePlans(
  db: SqlSession,
  params: Record<string, string>,
) {
  const year = medicareYear(params.year);
  const type = params.type;
  if (type !== undefined && !Object.hasOwn(types, type)) v.fail("type");
  const snpType = params.snp_type;
  if (
    snpType !== undefined &&
    (snpType.length > 40 || !/^[A-Za-z -]+$/.test(snpType))
  )
    v.fail("snp_type");
  const page = v.page(params.page);
  const location = await resolveCounty(db, params);
  const base = {
    contract_year: year,
    location,
    quote_method: "filed_public" as const,
    part_d_drug_data: await partDStatus(db, year),
  };
  if (location.status !== "available" || !location.county_fips)
    return {
      ...base,
      status: location.status,
      plans: [],
      page,
      page_size: pageSize,
      total: 0,
      next_page: null,
    };
  const state = fipsState[location.county_fips.slice(0, 2)];
  const landscape = await activeRelease(db, "landscape", year);
  if (!landscape || !state)
    return {
      ...base,
      status: "unknown",
      reason: landscape
        ? "county_outside_published_states"
        : "catalog_not_loaded",
      plans: [],
      page,
      page_size: pageSize,
      total: 0,
      next_page: null,
    };
  const pbp = await activeRelease(db, "pbp", year);
  const filters = [
    type ? `p.contract_category=$4` : "TRUE",
    snpType ? `p.snp_type=$5` : "TRUE",
  ];
  const args: unknown[] = [
    landscape.snapshot_id,
    location.county_fips,
    state,
    type ? types[type] : null,
    snpType ?? null,
    pbp?.snapshot_id ?? null,
  ];
  const where = `c.snapshot_id=$1 AND (c.county_fips=$2 OR (c.all_counties AND c.state=$3))
    AND ($4::text IS NULL OR ${filters[0]}) AND ($5::text IS NULL OR ${filters[1]})`;
  const total = Number(
    (
      await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM medicare_plan_county c JOIN medicare_plan p ON p.snapshot_id=c.snapshot_id
         AND p.contract_id=c.contract_id AND p.plan_id=c.plan_id AND p.segment_id=c.segment_id WHERE ${where}`,
        args.slice(0, 5),
      )
    ).rows[0]?.n ?? 0,
  );
  const rows = (
    await db.query<
      PlanRow & {
        lips_amount: string | null;
        ma_region_code: string | null;
        pdp_region_code: string | null;
      }
    >(
      withPbp(
        `SELECT ${planSelect},c.lips_amount,c.ma_region_code,c.pdp_region_code FROM medicare_plan_county c
         JOIN medicare_plan p ON p.snapshot_id=c.snapshot_id AND p.contract_id=c.contract_id AND p.plan_id=c.plan_id
           AND p.segment_id=c.segment_id ${pbpJoin}
         WHERE ${where} ORDER BY p.contract_id,p.plan_id,p.segment_id LIMIT ${pageSize} OFFSET $7`,
        6,
      ),
      [...args, (page - 1) * pageSize],
    )
  ).rows;
  const partial = pbp
    ? await partialCounties(db, pbp.snapshot_id, location.county_fips, rows)
    : new Map();
  return {
    ...base,
    status: "available",
    as_of: landscape.as_of_label,
    plans: rows.map((row) => {
      const view = planView(row, landscape, row);
      const key = view.plan_key;
      return {
        ...view,
        availability: {
          county: "available",
          partial_county: pbp ? (partial.get(key) ?? null) : null,
          service_area_source: "landscape",
        },
      };
    }),
    page,
    page_size: pageSize,
    total,
    next_page: page * pageSize < total ? page + 1 : null,
  };
}

/** PlanArea partial flags for this county; null when the plan has no PlanArea row (regional/PDP). */
async function partialCounties(
  db: SqlSession,
  pbpSnapshot: string,
  fips: string,
  rows: { contract_id: string; plan_id: string; segment_id: string }[],
): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  if (!rows.length) return out;
  const ssa = (await countyMap(db)).pairs
    .filter((pair) => pair.fips === fips)
    .map((pair) => pair.ssa);
  if (!ssa.length) return out;
  const found = await db.query<{
    contract_id: string;
    plan_id: string;
    segment_id: string;
    partial: boolean;
  }>(
    `SELECT contract_id,plan_id,segment_id,bool_or(partial_county) AS partial FROM medicare_plan_area
     WHERE snapshot_id=$1 AND source='plan_area' AND ssa_county_code = ANY($2::text[])
       AND (contract_id||'-'||plan_id||'-'||segment_id) = ANY($3::text[])
     GROUP BY contract_id,plan_id,segment_id`,
    [
      pbpSnapshot,
      ssa,
      rows.map((row) => `${row.contract_id}-${row.plan_id}-${row.segment_id}`),
    ],
  );
  for (const row of found.rows)
    out.set(`${row.contract_id}-${row.plan_id}-${row.segment_id}`, row.partial);
  return out;
}

async function planRow(db: SqlSession, key: PlanKey, year: number) {
  const landscape = await activeRelease(db, "landscape", year);
  if (!landscape) throw new ReadError({ code: "CATALOG_NOT_LOADED", year });
  const pbp = await activeRelease(db, "pbp", year);
  const row = (
    await db.query<PlanRow>(
      withPbp(
        `SELECT ${planSelect} FROM medicare_plan p ${pbpJoin}
         WHERE p.snapshot_id=$1 AND p.contract_id=$2 AND p.plan_id=$3 AND p.segment_id=$4`,
        5,
      ),
      [
        landscape.snapshot_id,
        key.contractId,
        key.planId,
        key.segmentId,
        pbp?.snapshot_id ?? null,
      ],
    )
  ).rows[0];
  if (!row)
    throw new ReadError({
      code: "PLAN_NOT_FOUND",
      plan_id: formatPlanKey(key),
      year,
    });
  return { row, landscape, pbp };
}

export async function getMedicarePlan(
  db: SqlSession,
  id: unknown,
  params: Record<string, string>,
) {
  const year = medicareYear(params.year);
  const key = planKey(id);
  const { row, landscape } = await planRow(db, key, year);
  const stars = await activeRelease(db, "stars", year);
  const contractStars = stars
    ? (
        await db.query<{
          measure: string;
          status: string;
          stars: string | null;
          published: string;
        }>(
          "SELECT measure,status,stars::text,published FROM medicare_star_rating WHERE snapshot_id=$1 AND contract_id=$2 ORDER BY measure",
          [stars.snapshot_id, key.contractId],
        )
      ).rows
    : [];
  const counties = (
    await db.query<{ n: number; states: string[] }>(
      `SELECT count(*)::int AS n, array_agg(DISTINCT state ORDER BY state) AS states FROM medicare_plan_county
       WHERE snapshot_id=$1 AND contract_id=$2 AND plan_id=$3 AND segment_id=$4`,
      [landscape.snapshot_id, key.contractId, key.planId, key.segmentId],
    )
  ).rows[0];
  return {
    ...planView(row, landscape),
    service_area_summary: {
      landscape_rows: counties?.n ?? 0,
      states: counties?.states ?? [],
    },
    contract_star_ratings: stars
      ? {
          rating_year: year,
          as_of: stars.as_of_label,
          snapshot_id: stars.snapshot_id,
          measures: Object.fromEntries(
            contractStars.map((star) => [
              star.measure,
              {
                status: star.status,
                stars: star.stars === null ? null : Number(star.stars),
                published: star.published,
              },
            ]),
          ),
        }
      : { status: "unknown", reason: "star_ratings_not_loaded" },
    part_d_drug_data: await partDStatus(db, year),
    quote_method: "filed_public",
  };
}

const benefitTable = /^pbp_(section_[ad]|b\d{1,2}[a-z]?_[a-z_]+|mrx(_tier)?)$/;
export async function getMedicareBenefits(
  db: SqlSession,
  id: unknown,
  params: Record<string, string>,
) {
  const year = medicareYear(params.year);
  const key = planKey(id);
  if (params.table !== undefined && !benefitTable.test(params.table))
    v.fail("table");
  const { pbp } = await planRow(db, key, year);
  if (!pbp)
    return {
      plan_key: formatPlanKey(key),
      contract_year: year,
      status: "unknown",
      reason: "plan_benefit_package_not_loaded",
      tables: [],
    };
  const rows = (
    await db.query<{
      table_name: string;
      fields: Record<string, string>;
      source_row: number;
    }>(
      `SELECT table_name,fields,source_row FROM medicare_pbp_row WHERE snapshot_id=$1 AND contract_id=$2
       AND plan_id=$3 AND segment_id=$4 AND ($5::text IS NULL OR table_name=$5) ORDER BY table_name,source_row`,
      [
        pbp.snapshot_id,
        key.contractId,
        key.planId,
        key.segmentId,
        params.table ?? null,
      ],
    )
  ).rows;
  const dictionary = new Map<
    string,
    { title: string | null; codes: Record<string, string> }
  >();
  for (const field of (
    await db.query<{
      table_name: string;
      field: string;
      title: string | null;
      codes: Record<string, string>;
    }>(
      `SELECT table_name,field,title,codes FROM medicare_pbp_field WHERE snapshot_id=$1
       AND table_name = ANY($2::text[])`,
      [pbp.snapshot_id, [...new Set(rows.map((row) => row.table_name))]],
    )
  ).rows)
    dictionary.set(`${field.table_name}:${field.field}`, field);
  return {
    plan_key: formatPlanKey(key),
    contract_year: year,
    status: rows.length ? "available" : "unknown",
    as_of: pbp.as_of,
    notes: [
      "Values as filed in the CMS Plan Benefit Package; code labels come from the release dictionary.",
      "A field that is absent was left blank in the filing; it is not a statement that a service is not covered.",
    ],
    tables: rows.map((row) => ({
      table: row.table_name,
      source: { snapshot_id: pbp.snapshot_id, source_row: row.source_row },
      fields: Object.entries(row.fields).map(([field, value]) => {
        const entry = dictionary.get(`${row.table_name}:${field}`);
        return {
          field,
          title: entry?.title ?? null,
          value,
          value_label:
            entry && Object.hasOwn(entry.codes, value)
              ? entry.codes[value]
              : null,
        };
      }),
    })),
  };
}

export async function getMedicareServiceArea(
  db: SqlSession,
  id: unknown,
  params: Record<string, string>,
) {
  const year = medicareYear(params.year);
  const key = planKey(id);
  const { landscape, pbp } = await planRow(db, key, year);
  const args = [key.contractId, key.planId, key.segmentId];
  const counties = (
    await db.query<{
      state: string;
      county_name: string;
      county_fips: string | null;
      all_counties: boolean;
      source_row: number;
    }>(
      `SELECT state,county_name,county_fips,all_counties,source_row FROM medicare_plan_county
       WHERE snapshot_id=$1 AND contract_id=$2 AND plan_id=$3 AND segment_id=$4 ORDER BY state,county_name`,
      [landscape.snapshot_id, ...args],
    )
  ).rows;
  const areas = pbp
    ? (
        await db.query<{
          source: string;
          ssa_county_code: string | null;
          county_name: string | null;
          state: string | null;
          region_type: string | null;
          region_code: string | null;
          region_name: string | null;
          partial_county: boolean;
          source_row: number;
        }>(
          `SELECT source,ssa_county_code,county_name,state,region_type,region_code,region_name,partial_county,source_row
           FROM medicare_plan_area WHERE snapshot_id=$1 AND contract_id=$2 AND plan_id=$3 AND segment_id=$4
           ORDER BY source,state,county_name,region_code`,
          [pbp.snapshot_id, ...args],
        )
      ).rows
    : [];
  const map = await countyMap(db);
  const fipsStatus = (ssa: string | null) => {
    if (!ssa) return "region";
    return fipsFor.has(ssa) ? "mapped" : "county_code_unmapped";
  };
  const fipsFor = new Map<string, string[]>();
  for (const pair of map.pairs)
    fipsFor.set(pair.ssa, [...(fipsFor.get(pair.ssa) ?? []), pair.fips]);
  return {
    plan_key: formatPlanKey(key),
    contract_year: year,
    landscape: {
      as_of: landscape.as_of_label,
      snapshot_id: landscape.snapshot_id,
      counties,
    },
    plan_benefit_package: pbp
      ? {
          snapshot_id: pbp.snapshot_id,
          areas: areas.map((area) => ({
            ...area,
            county_fips: area.ssa_county_code
              ? (fipsFor.get(area.ssa_county_code) ?? null)
              : null,
            county_fips_status: fipsStatus(area.ssa_county_code),
          })),
          zip_level_area: {
            status: "unknown",
            reason: "partial_county_zip_list_not_published",
          },
        }
      : { status: "unknown", reason: "plan_benefit_package_not_loaded" },
    county_code_sources: map.snapshots,
  };
}

export async function getMedicareLineage(
  db: SqlSession,
  id: unknown,
  params: Record<string, string>,
) {
  const year = medicareYear(params.year);
  const key = planKey(id);
  const lookup = async (releaseYear: number, side: "current" | "previous") => {
    const release = await activeRelease(db, "crosswalk", releaseYear);
    if (!release)
      return {
        status: "unknown",
        reason: "crosswalk_not_loaded",
        contract_year: releaseYear,
        rows: [],
      };
    const rows = (
      await db.query(
        `SELECT previous_contract_id,previous_plan_id,previous_plan_name,current_contract_id,current_plan_id,
         current_plan_name,status,source_row FROM medicare_plan_crosswalk WHERE snapshot_id=$1
         AND ${side}_contract_id=$2 AND ${side}_plan_id=$3 ORDER BY source_row`,
        [release.snapshot_id, key.contractId, key.planId],
      )
    ).rows;
    return {
      status: "available",
      contract_year: releaseYear,
      as_of: release.as_of_label,
      snapshot_id: release.snapshot_id,
      rows,
    };
  };
  return {
    plan_key: formatPlanKey(key),
    contract_year: year,
    level: "plan",
    note: "The CMS crosswalk is published per contract and plan; segments share their plan's lineage.",
    from_prior_year: await lookup(year, "current"),
    to_next_year: await lookup(year + 1, "previous"),
  };
}

export async function medicareAvailability(db: SqlSession) {
  const releases = (
    await db.query<{
      family: string;
      contract_year: number;
      as_of: string;
      as_of_label: string;
      snapshot_id: string;
      counts: Record<string, number>;
    }>(
      `SELECT DISTINCT ON (r.family,r.contract_year,CASE WHEN r.family='service_area' THEN split_part(r.as_of_label,'-',1) ELSE '' END)
         r.family,r.contract_year,r.as_of::text AS as_of,r.as_of_label,r.snapshot_id,r.counts
       FROM medicare_release r JOIN snapshot s USING(snapshot_id) WHERE s.validation_state='ACTIVE'
       ORDER BY r.family,r.contract_year,CASE WHEN r.family='service_area' THEN split_part(r.as_of_label,'-',1) ELSE '' END,r.as_of DESC`,
    )
  ).rows;
  const years = [
    ...new Set(
      releases
        .filter((r) => r.family === "landscape")
        .map((r) => r.contract_year),
    ),
  ].sort();
  return {
    line: "medicare",
    years: await Promise.all(
      years.map(async (year) => {
        const of = (family: string) =>
          releases.find((r) => r.family === family && r.contract_year === year);
        const status = (family: string) => {
          const release = of(family);
          return release
            ? {
                status: "available",
                as_of: release.as_of_label,
                snapshot_id: release.snapshot_id,
                counts: release.counts,
              }
            : { status: "unknown", reason: "not_loaded" };
        };
        return {
          contract_year: year,
          plans_premiums_stars: status("landscape"),
          plan_benefit_package: status("pbp"),
          contract_star_ratings: status("stars"),
          plan_crosswalk: status("crosswalk"),
          provider_network: providerNetwork,
          part_d_drug_data: await partDStatus(db, year),
          excluded: [
            "employer_group_plans",
            "national_pace",
            "demonstrations",
            "medigap",
          ],
        };
      }),
    ),
    county_codes: releases
      .filter((r) => r.family === "service_area")
      .map((r) => ({
        as_of: r.as_of_label,
        snapshot_id: r.snapshot_id,
        counts: r.counts,
      })),
  };
}

export async function getMedicareDrug(
  db: SqlSession,
  id: unknown,
  params: Record<string, string>,
) {
  const year = medicareYear(params.year);
  const key = planKey(id);
  if (typeof params.rxcui !== "string" || !/^\d{1,20}$/.test(params.rxcui))
    return v.fail("rxcui");
  await planRow(db, key, year);
  return {
    plan_key: formatPlanKey(key),
    contract_year: year,
    rxcui: params.rxcui,
    ...(await partDDrug(db, key, year, params.rxcui)),
  };
}

export async function getMedicarePharmacies(
  db: SqlSession,
  id: unknown,
  params: Record<string, string>,
) {
  const year = medicareYear(params.year);
  const key = planKey(id);
  const zip = v.zip(params.zip);
  await planRow(db, key, year);
  return {
    plan_key: formatPlanKey(key),
    contract_year: year,
    ...(await partDPharmacies(db, key, year, zip)),
  };
}
