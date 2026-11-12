import { readFile } from "node:fs/promises";
import type { SqlSession } from "../../db/database.js";
import type {
  CommunityFamilyRule,
  CommunityRate,
} from "../../domain/rating/index.js";
import { parseCommunityRules } from "./index.js";
import { reflectivePublication } from "./reflective.js";
import { normalizeEhbColumns } from "../ehb.js";
import { nyFiledIdentity } from "./ny-identity.js";
import { vtFiledMetal } from "./vt-metal.js";

const geography = JSON.parse(
  await readFile(
    new URL(
      "../../../data/rating-rules/state-geography-2026.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  plan_year: number;
  NY: {
    citation: string;
    references: string[];
    source_sha256: string;
    counties: {
      county_fips: string;
      county: string;
      rating_area_id: string;
      region: string;
    }[];
  };
  VT: { region: string; citation: string; references: string[] };
};

/** NY rate evidence is regional, not proof of county-specific enrollment eligibility.
 * VT guidance explicitly makes every Vermont ZIP part of the service area. */
export function stateRatingArea(state: string, year: number, county: string) {
  if (year !== geography.plan_year) return null;
  if (state === "VT" && /^50(00[13579]|01[13579]|02[1357])$/.test(county)) {
    return {
      rating_area_id: geography.VT.region,
      citation: geography.VT.citation,
      references: geography.VT.references,
      scope: "statewide" as const,
    };
  }
  if (state !== "NY") return null;
  const row = geography.NY.counties.find((row) => row.county_fips === county);
  return row
    ? {
        rating_area_id: row.rating_area_id,
        citation: geography.NY.citation,
        references: geography.NY.references,
        source_sha256: geography.NY.source_sha256,
        county_fips: county,
        scope: "rating_area" as const,
      }
    : null;
}

/** A representative county for each published DFS rating region. */
export function nyRatingCounties(year: number) {
  if (year !== geography.plan_year) return [];
  return [
    ...new Map(
      geography.NY.counties.map((r) => [r.rating_area_id, r.county_fips]),
    ).values(),
  ];
}

export interface StateCatalogRow extends Record<string, unknown> {
  state: "NY" | "VT";
  plan_year: number;
  import_id: string;
  publication_snapshot_id: string;
  record_index: number;
  plan_key: string;
  region: string;
  rate: CommunityRate;
  raw_record: {
    plan_id: string | null;
    issuer: string;
    plan_name?: string;
    metal: string | null;
    exchange: string;
    prices: Record<string, string>;
    raw: Record<string, string>;
  };
  rules_document: unknown;
  hios_id: string | null;
  hios_match: "matched" | "ambiguous" | "none" | null;
  hios_match_reason: string | null;
  hios_candidates: Record<string, unknown>[] | null;
  hios_match_rule: string | null;
  hios_match_provenance: Record<string, unknown> | null;
  sbe_exchange?: {
    on_exchange: boolean;
    off_exchange: boolean;
    snapshot_id: string;
    source_rows: number[];
    source_record?: string;
    source_url?: string;
    source_sha256?: string;
  } | null;
}
export async function stateCatalog(
  db: SqlSession,
  year: number,
  state?: string,
  key?: string,
  region?: string,
) {
  return (
    await db.query<StateCatalogRow>(
      `SELECT a.state,a.plan_year,r.*,i.rules_document,
    h.hios_id,h.hios_match,h.reason AS hios_match_reason,h.candidates AS hios_candidates,
    h.rule_version AS hios_match_rule,e.sbe_exchange,
    CASE WHEN h.state_import_id IS NOT NULL THEN jsonb_build_object(
      'state_import_id',h.state_import_id,'publication_snapshot_id',h.publication_snapshot_id,
      'filed',h.filed_provenance,'sbe_import_id',h.sbe_import_id) END AS hios_match_provenance
    FROM state_rate_active a
    JOIN state_rate_import i ON i.import_id=a.import_id
    JOIN snapshot s ON s.snapshot_id=i.import_id AND s.validation_state='ACTIVE'
    JOIN state_community_rate r ON r.import_id=i.import_id
    LEFT JOIN state_vt_hios_current h ON h.state_import_id=r.import_id
      AND h.source_index=r.source_index AND h.record_index=r.record_index
    LEFT JOIN LATERAL (
      SELECT jsonb_build_object('on_exchange',bool_or(pa.on_exchange),
        'off_exchange',bool_or(pa.off_exchange),'snapshot_id',f.snapshot_id,
        'source_rows',jsonb_agg(pa.source_row ORDER BY pa.source_row)) AS sbe_exchange
      FROM puf_import_file f JOIN plan_attribute pa ON pa.snapshot_id=f.snapshot_id
      WHERE f.import_id=h.sbe_import_id AND f.kind='plan-attributes'
        AND h.hios_match='matched' AND pa.base_plan_id=h.hios_id
        AND pa.state='VT' AND pa.plan_year=a.plan_year AND pa.market='Individual' AND NOT pa.dental_only
      GROUP BY f.snapshot_id
    ) e ON true
    WHERE a.plan_year=$1 AND ($2::text IS NULL OR a.state=$2)
      AND ($3::text IS NULL OR r.plan_key=$3 OR h.hios_id=$3) AND ($4::text IS NULL OR r.region=$4)
    ORDER BY r.plan_key,r.region,r.source_index,r.record_index`,
      [year, state ?? null, key ?? null, region ?? null],
    )
  ).rows.map((row) => {
    if (
      row.state === "VT" &&
      row.raw_record.exchange === "Off" &&
      reflectivePublication(
        row.rate.provenance.sourceUrl,
        row.rate.provenance.sourceSha256,
      )
    ) {
      // This exchange-evidence slot also carries the separately cited state
      // filing. An empty CSV-row list never pretends a PDF is a PUF.
      return {
        ...row,
        sbe_exchange: {
          on_exchange: false,
          off_exchange: true,
          snapshot_id: row.publication_snapshot_id,
          source_rows: [],
          source_record: row.rate.provenance.sourceRecord,
          source_url: row.rate.provenance.sourceUrl,
          source_sha256: row.rate.provenance.sourceSha256,
        },
      };
    }
    return row;
  });
}
export function catalogRule(row: StateCatalogRow): CommunityFamilyRule | null {
  // Revalidate the stored authorization at the API boundary; a per-age mutant
  // must not be accepted even if the import pointer is otherwise active.
  try {
    return (
      parseCommunityRules(JSON.stringify(row.rules_document)).find(
        (rule) => rule.state === row.state,
      ) ?? null
    );
  } catch {
    return null;
  }
}
export function stateSourceCell(row: StateCatalogRow, tier: string) {
  const column =
    row.state === "NY"
      ? (
          {
            single: "E",
            couple: "G",
            adult_children: "H:J",
            family: "K:M",
          } as Record<string, string>
        )[tier]
      : tier;
  return {
    publication_snapshot_id: row.publication_snapshot_id,
    source_url: row.rate.provenance.sourceUrl,
    source_sha256: row.rate.provenance.sourceSha256,
    source_record: row.rate.provenance.sourceRecord,
    column,
    tier,
    value: row.raw_record.prices[tier],
    currency: "USD",
    period: "month",
  };
}

/** Supplemental detail never authorizes a rate or a new filed-to-HIOS match. */
export async function stateDetailSource(
  db: SqlSession,
  state: string,
  year: number,
  hios: string | null | undefined,
  filedImport: string,
  planKey: string | undefined,
) {
  if (
    !["NY", "VT"].includes(state) ||
    !hios ||
    !new RegExp(`^\\d{5}${state}\\d{7}$`).test(hios)
  )
    return null;
  const { rows } = await db.query<{
    snapshot_id: string;
    import_id: string;
    bundle_url: string;
    bundle_sha256: string;
  }>(
    `WITH detail_catalog AS (
      SELECT p.import_id,c.bundle_url,c.bundle_sha256 FROM puf_import p
      JOIN sbe_catalog c ON c.import_id=p.import_id
      JOIN snapshot s ON s.snapshot_id=p.import_id AND s.validation_state='ACTIVE'
      WHERE p.state=$1 AND p.plan_year=$2 AND (SELECT count(*) FROM puf_import_file f
        JOIN snapshot fs ON fs.snapshot_id=f.snapshot_id AND fs.validation_state='ACTIVE'
        WHERE f.import_id=p.import_id)=6
      ORDER BY p.started_at DESC,p.import_id DESC LIMIT 1
    )
    SELECT f.snapshot_id,c.* FROM detail_catalog c
    JOIN puf_import_file f ON f.import_id=c.import_id AND f.kind='plan-attributes'
    WHERE EXISTS (SELECT 1 FROM plan_attribute pa WHERE pa.snapshot_id=f.snapshot_id
      AND pa.base_plan_id=$3 AND pa.state=$1 AND pa.plan_year=$2
      AND pa.market='Individual' AND NOT pa.dental_only)
    AND ($1='NY' OR EXISTS (SELECT 1 FROM state_vt_hios_current h
      WHERE h.state_import_id=$4 AND h.plan_key=$5 AND h.hios_id=$3
        AND h.hios_match='matched' AND h.sbe_import_id=c.import_id))`,
    [state, year, hios, filedImport, planKey ?? null],
  );
  return rows.length === 1 ? rows[0]! : null;
}

/** CMS state files use spaced headers and a single published family cell. */
export function stateDetailColumns(raw: Record<string, string>) {
  const names =
    `BusinessYear StateCode StandardComponentId PlanId PlanType IsHSAEligible
    PlanEffectiveDate PlanExpirationDate FormularyURL IsReferralRequiredForSpecialist
    PlanVariantMarketingName IssuerActuarialValue MedicalDrugDeductiblesIntegrated
    MedicalDrugMaximumOutofPocketIntegrated IsCovered QuantLimitOnSvc LimitQty LimitUnit
    Exclusions Explanation EHBVarReason IsExclFromInnMOOP IsExclFromOonMOOP
    MinimumStay IsSubjectedToDedTier1 IsSubjectedToDedTier2
    CopayInnTier1 CopayInnTier2 CopayOutofNet CoinsInnTier1 CoinsInnTier2 CoinsOutofNet`.split(
      /\s+/,
    );
  for (const prefix of ["MEHB", "DEHB", "TEHB"])
    for (const network of ["InnTier1", "InnTier2", "OutOfNet", "CombInnOon"])
      for (const scope of [
        "Individual",
        "Family",
        "FamilyPerPerson",
        "FamilyPerGroup",
      ]) {
        names.push(
          `${prefix}Ded${network}${scope}`,
          `${prefix}${network}${scope}MOOP`,
        );
      }
  for (const prefix of ["MEHB", "DEHB", "TEHB"])
    for (const network of ["InnTier1", "InnTier2", "OutOfNet", "CombInnOon"])
      names.push(`${prefix}Ded${network}Coinsurance`);
  const compact = (key: string) => key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const aliases = new Map(names.map((key) => [compact(key), key]));
  // The CA publication spells the tier-1 accumulator column COINSURNACE.
  for (const prefix of ["MEHB", "DEHB"])
    aliases.set(
      compact(`${prefix}DedInnTier1Coinsurnace`),
      `${prefix}DedInnTier1Coinsurance`,
    );
  // State publications name the federal design and EHB share columns differently.
  aliases.set("plandesigntype", "DesignType");
  aliases.set(
    "urlforsummaryofbenefitscoverage",
    "URLForSummaryofBenefitsCoverage",
  );
  aliases.set("planbrochure", "PlanBrochure");
  aliases.set("quantitylimitonsvc", "QuantLimitOnSvc");
  aliases.set("limitquantity", "LimitQty");
  aliases.set("isexcludedfrominnmoop", "IsExclFromInnMOOP");
  aliases.set("isexcludedfromoonmoop", "IsExclFromOonMOOP");
  const result = { ...raw };
  for (const [key, value] of Object.entries(raw)) {
    const canonical = aliases.get(compact(key));
    if (!canonical) continue;
    if (
      result[canonical] !== undefined &&
      result[canonical]!.trim() !== value.trim()
    )
      throw new Error("Conflicting supplemental detail columns");
    result[canonical] = value;
  }
  return normalizeEhbColumns(result);
}

/** CMS Plan Attributes rows for these NY plans from the newest fully active SBE bundle. */
async function nyDetailAttributes(
  db: SqlSession,
  year: number,
  ids: readonly string[],
) {
  return (
    await db.query<{
      metal: string;
      raw: Record<string, string>;
      source_row: number;
      base_plan_id: string;
      snapshot_id: string;
      import_id: string;
      bundle_url: string;
      bundle_sha256: string;
    }>(
      `WITH detail_catalog AS (
    SELECT p.import_id,c.bundle_url,c.bundle_sha256 FROM puf_import p
    JOIN sbe_catalog c ON c.import_id=p.import_id
    JOIN snapshot s ON s.snapshot_id=p.import_id AND s.validation_state='ACTIVE'
    WHERE p.state='NY' AND p.plan_year=$1 AND (SELECT count(*) FROM puf_import_file f
      JOIN snapshot fs ON fs.snapshot_id=f.snapshot_id AND fs.validation_state='ACTIVE'
      WHERE f.import_id=p.import_id)=6
    ORDER BY p.started_at DESC,p.import_id DESC LIMIT 1
  ) SELECT pa.metal,pa.raw,pa.source_row,pa.base_plan_id,f.snapshot_id,c.*
    FROM detail_catalog c JOIN puf_import_file f ON f.import_id=c.import_id AND f.kind='plan-attributes'
    JOIN plan_attribute pa ON pa.snapshot_id=f.snapshot_id
    WHERE pa.state='NY' AND pa.plan_year=$1 AND pa.market='Individual' AND NOT pa.dental_only
      AND pa.base_plan_id=ANY($2::text[]) ORDER BY pa.source_row`,
      [year, ids],
    )
  ).rows;
}

export interface RefusedTemplatePlan {
  issuer: string;
  reason: string;
  snapshot_id: string;
  url: string | null;
  filing: string | null;
  /** null when the stored refusal does not say where its plans are. */
  plan_id: string | null;
  region: string | null;
  metals: string[];
  attribute_snapshot_id: string | null;
  source_rows: number[];
}

/** Plans of refused issuer templates in one rating region, with any CMS metal evidence.
 * A refusal that does not list its plans counts as present in every region. */
export async function refusedTemplatePlans(
  db: SqlSession,
  state: "NY" | "VT",
  year: number,
  region: string,
): Promise<RefusedTemplatePlan[]> {
  const { rows } = await db.query<{
    issuer: string;
    issue_code: string;
    snapshot_id: string;
    explanation: string;
  }>(
    `SELECT q.source_record AS issuer,q.issue_code,q.snapshot_id,q.explanation FROM state_rate_active a
    JOIN quality_issue q ON starts_with(q.snapshot_id, a.import_id || ':refused:')
    WHERE a.state=$1 AND a.plan_year=$2
    ORDER BY q.snapshot_id,q.source_record,q.issue_code`,
    [state, year],
  );
  const listed: Omit<
    RefusedTemplatePlan,
    "metals" | "attribute_snapshot_id" | "source_rows"
  >[] = [];
  for (const row of rows) {
    let detail: { url?: unknown; filing?: unknown; listed_plans?: unknown };
    try {
      detail = JSON.parse(row.explanation) as typeof detail;
    } catch {
      detail = {};
    }
    const base = {
      issuer: row.issuer,
      reason: row.issue_code,
      snapshot_id: row.snapshot_id,
      url: typeof detail.url === "string" ? detail.url : null,
      filing: typeof detail.filing === "string" ? detail.filing : null,
    };
    const plans = detail.listed_plans;
    if (
      !Array.isArray(plans) ||
      !plans.length ||
      !plans.every(
        (p: { plan_id?: unknown; region?: unknown }) =>
          typeof p?.plan_id === "string" &&
          p.plan_id.startsWith(row.issuer) &&
          typeof p.region === "string",
      )
    ) {
      listed.push({ ...base, plan_id: null, region: null });
      continue;
    }
    for (const plan of plans as { plan_id: string; region: string }[])
      if (plan.region === region)
        listed.push({ ...base, plan_id: plan.plan_id, region });
  }
  const ids = listed.flatMap((p) => (p.plan_id ? [p.plan_id] : []));
  const attributes =
    state === "NY" && ids.length ? await nyDetailAttributes(db, year, ids) : [];
  return listed.map((plan) => {
    const matched = attributes.filter((a) => a.base_plan_id === plan.plan_id);
    return {
      ...plan,
      metals: [
        ...new Set(matched.map((a) => a.metal.trim().toLowerCase())),
      ].sort(),
      attribute_snapshot_id: matched[0]?.snapshot_id ?? null,
      source_rows: matched.map((a) => a.source_row),
    };
  });
}

/** CMS Plan Attributes membership supplies Exchange-offer evidence.
 * Reviewed DFS identity cells also identify filed off-Exchange and non-silver rows. */
export async function nyLcspCatalog(
  db: SqlSession,
  year: number,
  region?: string,
) {
  const catalog = await stateCatalog(db, year, "NY", undefined, region);
  const attributes = await nyDetailAttributes(
    db,
    year,
    catalog.map((r) => r.raw_record.plan_id).filter((id) => id !== null),
  );
  return catalog.map((row) => {
    const matched = attributes.filter(
      (a) => a.base_plan_id === row.raw_record.plan_id,
    );
    const source = matched[0];
    return {
      row,
      filed_identity: nyFiledIdentity(row),
      attributes: matched.map((a) => ({
        metal: a.metal,
        source_row: a.source_row,
        raw: stateDetailColumns(a.raw),
      })),
      exchange_evidence: source
        ? {
            source: "cms_sbe_puf_plan_attributes",
            evidence: "exchange_offer",
            hios_id: row.raw_record.plan_id,
            snapshot_id: source.snapshot_id,
            import_id: source.import_id,
            bundle_url: source.bundle_url,
            bundle_sha256: source.bundle_sha256,
            source_rows: matched.map((a) => a.source_row),
          }
        : null,
    };
  });
}

/** VT attributes must belong to the same fully active set as the identity join. */
export async function vtLcspCatalog(
  db: SqlSession,
  year: number,
  region?: string,
) {
  const catalog = await stateCatalog(db, year, "VT", undefined, region);
  const { rows: attributes } = await db.query<{
    plan_key: string;
    on_exchange: boolean;
    off_exchange: boolean;
    metal: string;
    raw: Record<string, string>;
    source_row: number;
    snapshot_id: string;
    import_id: string;
    bundle_url: string;
    bundle_sha256: string;
  }>(
    `SELECT h.plan_key,pa.on_exchange,pa.off_exchange,pa.metal,pa.raw,pa.source_row,f.snapshot_id,
      c.import_id,c.bundle_url,c.bundle_sha256
    FROM state_vt_hios_current h
    JOIN sbe_catalog c ON c.import_id=h.sbe_import_id
    JOIN puf_import_file f ON f.import_id=c.import_id AND f.kind='plan-attributes'
    JOIN plan_attribute pa ON pa.snapshot_id=f.snapshot_id AND pa.base_plan_id=h.hios_id
    WHERE h.hios_match='matched' AND pa.state='VT' AND pa.plan_year=$1
      AND pa.market='Individual' AND NOT pa.dental_only
    ORDER BY h.plan_key,pa.source_row`,
    [year],
  );
  return catalog.map((row) => {
    const matched = attributes.filter((a) => a.plan_key === row.plan_key);
    const source = matched[0];
    const cells = matched.map((a) => ({
      ...a,
      raw: stateDetailColumns(a.raw),
    }));
    const filed_identity = vtFiledMetal(row, cells, source);
    const reflective =
      row.sbe_exchange?.on_exchange === false &&
      reflectivePublication(
        row.rate.provenance.sourceUrl,
        row.rate.provenance.sourceSha256,
      );
    return {
      row,
      filed_identity,
      attributes: cells,
      exchange_evidence:
        filed_identity && source
          ? {
              source: "cms_sbe_puf_plan_attributes",
              evidence: "exchange_offer",
              hios_id: row.hios_id,
              snapshot_id: source.snapshot_id,
              import_id: source.import_id,
              bundle_url: source.bundle_url,
              bundle_sha256: source.bundle_sha256,
              source_rows: matched.map((a) => a.source_row),
            }
          : null,
      off_exchange: Boolean(reflective),
    };
  });
}
