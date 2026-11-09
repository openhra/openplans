import { STATE_FIPS } from "../geo/states.js";
import type { SqlSession } from "../../db/database.js";
import type { ImportFile, ImportKind } from "./import-source.js";
import { importColumns, importTables } from "./import-parse.js";

export async function insertImportRows(
  tx: SqlSession,
  kind: ImportKind,
  rows: unknown[][],
): Promise<void> {
  if (!rows.length) return;
  const values: unknown[] = [];
  const groups = rows.map(
    (row) =>
      `(${row
        .map((value) => {
          values.push(value);
          return `$${values.length}`;
        })
        .join(",")})`,
  );
  await tx.query(
    `INSERT INTO ${importTables[kind]} (${importColumns[kind]}) VALUES ${groups.join(",")}`,
    values,
  );
}
export async function saveImportSnapshot(
  tx: SqlSession,
  id: string,
  source: string,
  file?: ImportFile,
): Promise<void> {
  const m = file?.metadata;
  await tx.query(
    `INSERT INTO source(source_id,publisher,source_kind,registry_evidence)
    VALUES ($1,'Centers for Medicare & Medicaid Services',$3,$2) ON CONFLICT DO NOTHING`,
    [
      source,
      JSON.stringify(
        file
          ? file.source === "cms_sbe_puf"
            ? { url: file.url, member: file.member, sha256: file.sha256 }
            : [file.url]
          : [],
      ),
      file?.source ?? "exchange-puf",
    ],
  );
  await tx.query(
    `INSERT INTO snapshot(snapshot_id,source_id,requested_url,final_url,redirect_chain,retrieved_at,
    http_status,etag,last_modified,content_type,compressed_bytes,sha256,raw_path,schema_version,parser_version,
    expected_children,fetched_children,validation_state)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$15,$16,$14,0,'PARSED')`,
    [
      id,
      source,
      file?.url ?? null,
      m?.final_url ?? file?.url ?? null,
      JSON.stringify(m?.redirect_chain ?? []),
      file?.retrievedAt ?? null,
      m?.status ?? null,
      m?.etag ?? null,
      m?.last_modified ?? null,
      m?.content_type ?? null,
      file?.bytes ?? null,
      file?.sha256 ?? null,
      file?.path ?? null,
      file ? 0 : 6,
      file?.source === "cms_sbe_puf"
        ? "cms-sbe-puf-2026-observed"
        : "cms-puf-2026-2027-observed",
      file?.source === "cms_sbe_puf" ? "sbe-import-v1" : "puf-import-v1",
    ],
  );
}
export async function importIssue(
  tx: SqlSession,
  snapshot: string,
  code: string,
  explanation: string,
  row?: number,
  severity = "error",
): Promise<void> {
  await tx.query(
    `INSERT INTO quality_issue(snapshot_id,severity,issue_code,explanation,source_record) VALUES ($1,$2,$3,$4,$5)`,
    [
      snapshot,
      severity,
      code,
      explanation,
      row === undefined ? null : String(row),
    ],
  );
}
export async function deriveCatalogRows(
  tx: SqlSession,
  kind: ImportKind,
  snapshot: string,
): Promise<void> {
  if (kind === "plan-attributes") {
    await tx.query(
      `INSERT INTO issuer(snapshot_id,source_row,issuer_id,state,plan_year,marketing_names)
      SELECT snapshot_id,min(source_row),issuer_id,state,plan_year,COALESCE(jsonb_agg(DISTINCT raw->>'IssuerMarketPlaceMarketingName') FILTER (WHERE COALESCE(raw->>'IssuerMarketPlaceMarketingName','')<>''),'[]'::jsonb)
      FROM plan_attribute WHERE snapshot_id=$1 GROUP BY snapshot_id,issuer_id,state,plan_year`,
      [snapshot],
    );
    await tx.query(
      `INSERT INTO plan
      SELECT snapshot_id,min(source_row),plan_year,state,issuer_id,base_plan_id,market,metal,dental_only,network_id,service_area_id,plan_name,
        CASE WHEN bool_or(on_exchange) AND bool_or(off_exchange) THEN 'Both'
          WHEN bool_or(on_exchange) THEN 'On the Exchange' ELSE 'Off the Exchange' END,
        bool_or(on_exchange),bool_or(off_exchange)
      FROM plan_attribute WHERE snapshot_id=$1
      GROUP BY snapshot_id,plan_year,state,issuer_id,base_plan_id,market,metal,dental_only,network_id,service_area_id,plan_name`,
      [snapshot],
    );
    await tx.query(
      `INSERT INTO plan_variant
      SELECT snapshot_id,source_row,plan_year,state,issuer_id,published_plan_id,base_plan_id,right(published_plan_id,2),
        raw->>'CSRVariationType',raw->>'PlanVariantMarketingName',exchange_status,raw
      FROM plan_attribute WHERE snapshot_id=$1 AND length(published_plan_id)=17`,
      [snapshot],
    );
    await tx.query(
      `INSERT INTO state_rating_rule(snapshot_id,source_row,state,plan_year,market,method,citation)
      SELECT snapshot_id,min(source_row),state,plan_year,market,'unsupported',NULL
      FROM plan_attribute WHERE snapshot_id=$1 GROUP BY snapshot_id,state,plan_year,market`,
      [snapshot],
    );
  }
  if (kind === "service-area") {
    await tx.query(
      `INSERT INTO service_area
      SELECT snapshot_id,min(source_row),plan_year,state,issuer_id,service_area_id,market,dental_only,min(service_area_name),bool_or(cover_entire_state)
      FROM service_area_county WHERE snapshot_id=$1 GROUP BY snapshot_id,plan_year,state,issuer_id,service_area_id,market,dental_only`,
      [snapshot],
    );
  }
}
export interface CountyPlan extends Record<string, unknown> {
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
  zip_restricted: boolean;
  zip_codes: string[];
  raw_zip_codes: string[];
  rating_method: string;
}
export function createPufRepository(db: SqlSession) {
  return {
    async plansForCounty(
      countyFips: string,
      year: number,
      market: string,
    ): Promise<CountyPlan[]> {
      if (!/^\d{5}$/.test(countyFips) || !Number.isInteger(year) || !market)
        throw new TypeError("County, year and market are required");
      const state = Object.keys(STATE_FIPS).find(
        (state) => STATE_FIPS[state] === countyFips.slice(0, 2),
      );
      if (!state) return [];
      const { rows } = await db.query<CountyPlan>(
        `SELECT p.*,g.zip_restricted,g.raw_zip_codes,COALESCE(r.method,'unsupported') AS rating_method
        FROM puf_active_catalog a
        JOIN puf_import_file pf ON pf.import_id=a.import_id AND pf.kind='plan-attributes'
        JOIN puf_import_file sf ON sf.import_id=a.import_id AND sf.kind='service-area'
        JOIN plan p ON p.snapshot_id=pf.snapshot_id
        JOIN LATERAL (
          SELECT NOT bool_or(s.cover_entire_state OR s.partial_county IS FALSE) AS zip_restricted,
            array_agg(DISTINCT s.zip_codes) FILTER (WHERE s.zip_codes <> '') AS raw_zip_codes
          FROM service_area_county s WHERE s.snapshot_id=sf.snapshot_id
            AND s.issuer_id=p.issuer_id AND s.state=p.state AND s.plan_year=p.plan_year
            AND s.service_area_id=p.service_area_id AND s.market=p.market AND s.dental_only=p.dental_only
            AND (s.cover_entire_state OR s.county_fips=$1)
          HAVING count(*)>0
        ) g ON true
        LEFT JOIN state_rating_rule r ON r.snapshot_id=p.snapshot_id AND r.state=p.state AND r.plan_year=p.plan_year AND r.market=p.market
        WHERE a.plan_year=$2 AND p.market=$3 AND a.state=$4 ORDER BY p.base_plan_id`,
        [countyFips, year, market, state],
      );
      return rows.map((row) => ({
        ...row,
        raw_zip_codes: row.raw_zip_codes ?? [],
        zip_codes: [
          ...new Set(
            (row.raw_zip_codes ?? []).flatMap((value) =>
              value.split(/[,;\s]+/).filter(Boolean),
            ),
          ),
        ].sort(),
      }));
    },
  };
}
export async function plansForCounty(
  db: SqlSession,
  countyFips: string,
  year: number,
  market: string,
): Promise<CountyPlan[]> {
  return createPufRepository(db).plansForCounty(countyFips, year, market);
}
