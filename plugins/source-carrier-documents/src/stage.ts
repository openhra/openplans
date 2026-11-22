import type { SqlSession } from "@openplans/plugin-sdk";
import type { IssuerScope } from "./args.js";
import { drugNameKey } from "./evidence.js";
import { admittedTiers } from "./checks.js";
import { UNKNOWN_REASON } from "./constants.js";
import type { ExtractedFormulary } from "./extract.js";
import type { CatalogPlan, PlanLink } from "./match.js";

export const DOCUMENT_TABLE = "plg_carrierdoc_document";
export const ROW_TABLE = "plg_carrierdoc_formulary_row";
export const LINK_TABLE = "plg_carrierdoc_plan_link";
const ROW_BATCH = 1000;

/** The base plans of an issuer's active federal catalog for one plan year (medical, individual). */
export async function catalogPlans(
  tx: SqlSession,
  issuer: IssuerScope,
  planYear: number,
): Promise<CatalogPlan[]> {
  const { rows } = await tx.query<{ base_plan_id: string; plan_name: string }>(
    `SELECT p.base_plan_id, p.plan_name
     FROM plan p
     JOIN puf_import_file f ON f.snapshot_id = p.snapshot_id
     JOIN puf_active_catalog a ON a.import_id = f.import_id
       AND a.state = p.state AND a.plan_year = p.plan_year
     WHERE p.state = $1 AND p.issuer_id = $2 AND p.plan_year = $3
       AND NOT p.dental_only AND lower(p.market) = 'individual'
     ORDER BY p.base_plan_id`,
    [issuer.state, issuer.issuerId, planYear],
  );
  return rows.map((row) => ({
    basePlanId: row.base_plan_id,
    planName: row.plan_name,
  }));
}

/**
 * Drop what an earlier run staged for the same documents or for the same issuers and years, so
 * the tables hold one reading of each. Runs inside the core's transaction: a refused run leaves
 * the earlier reading in place.
 */
export async function clearEarlier(
  tx: SqlSession,
  urls: readonly string[],
  issuerIds: readonly string[],
  years: readonly number[],
): Promise<void> {
  const earlier = `SELECT snapshot_id FROM ${DOCUMENT_TABLE} WHERE url = ANY($1::text[])`;
  await tx.query(`DELETE FROM ${ROW_TABLE} WHERE snapshot_id IN (${earlier})`, [
    urls,
  ]);
  await tx.query(
    `DELETE FROM ${LINK_TABLE} WHERE snapshot_id IN (${earlier})`,
    [urls],
  );
  await tx.query(
    `DELETE FROM ${LINK_TABLE} WHERE issuer_id = ANY($1::text[]) AND plan_year = ANY($2::int[])`,
    [issuerIds, years],
  );
  await tx.query(`DELETE FROM ${DOCUMENT_TABLE} WHERE url = ANY($1::text[])`, [
    urls,
  ]);
}

export async function writeDocument(
  tx: SqlSession,
  file: {
    snapshotId: string;
    url: string;
    urlYear: number;
    states: string[];
    approvalBasis: string | null;
  },
  extracted: ExtractedFormulary,
): Promise<void> {
  const histogram: Record<string, number> = {};
  const confidence: Record<string, number> = {};
  for (const row of extracted.rows) {
    histogram[row.tier] = (histogram[row.tier] ?? 0) + 1;
    confidence[row.confidence] = (confidence[row.confidence] ?? 0) + 1;
  }
  await tx.query(
    `INSERT INTO ${DOCUMENT_TABLE}(snapshot_id,document_sha256,url,url_year,plan_year,states,pages,
       legend_tiers,legend_flags,tier_histogram,confidence_counts,ql_flag_rows,ql_text_rows,cover_plan_names,
       stated_tiers,approval_basis)
     VALUES ($1,$2,$3,$4,$5,$6::text[],$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14::jsonb,$15::jsonb,$16)`,
    [
      file.snapshotId,
      extracted.sha256,
      file.url,
      file.urlYear,
      extracted.cover.plan_year,
      file.states,
      extracted.summary.pages,
      JSON.stringify(extracted.legend.tiers),
      JSON.stringify(extracted.legend.flags),
      JSON.stringify(histogram),
      JSON.stringify(confidence),
      extracted.rows.filter((row) => row.flags.includes("QL")).length,
      extracted.rows.filter((row) => row.ql_text).length,
      JSON.stringify(extracted.cover.plan_names),
      JSON.stringify(extracted.legend.stated_tiers),
      file.approvalBasis,
    ],
  );
  const admitted = admittedTiers({
    legendTiers: Object.keys(extracted.legend.tiers).map(Number),
    statedTiers: extracted.legend.stated_tiers,
  });
  for (let at = 0; at < extracted.rows.length; at += ROW_BATCH) {
    const batch = extracted.rows.slice(at, at + ROW_BATCH).map((row) => ({
      ...row,
      name_key: drugNameKey(row.name),
      raw_text: row.raw.join("\n"),
      unknown_reason: admitted.includes(row.tier)
        ? null
        : UNKNOWN_REASON.tierNotDefined,
    }));
    await tx.query(
      `INSERT INTO ${ROW_TABLE}(snapshot_id,page,line,category,drug_name,name_key,tier,tier_label,flags,
         ql_text,raw_text,confidence,reasons,unknown_reason)
       SELECT $1, r.page, r.line, r.category, r.name, r.name_key, r.tier, r.tier_label, r.flags,
         r.ql_text, r.raw_text, r.confidence, r.reasons, r.unknown_reason
       FROM jsonb_to_recordset($2::jsonb) AS r(page int, line int, category text, name text,
         name_key text, tier int, tier_label text, flags jsonb, ql_text text, raw_text text,
         confidence text, reasons jsonb, unknown_reason text)`,
      [file.snapshotId, JSON.stringify(batch)],
    );
  }
}

export async function writeLinks(
  tx: SqlSession,
  snapshotId: string,
  issuer: IssuerScope,
  planYear: number,
  links: readonly PlanLink[],
): Promise<void> {
  if (!links.length) return;
  await tx.query(
    `INSERT INTO ${LINK_TABLE}(snapshot_id,state,issuer_id,plan_year,cover_name,base_plan_id,status,candidates)
     SELECT $1, $2, $3, $4, l.cover_name, l.base_plan_id, l.status, l.candidates
     FROM jsonb_to_recordset($5::jsonb) AS l(cover_name text, base_plan_id text, status text, candidates int)`,
    [
      snapshotId,
      issuer.state,
      issuer.issuerId,
      planYear,
      JSON.stringify(
        links.map((link) => ({
          cover_name: link.coverName,
          base_plan_id: link.basePlanId,
          status: link.status,
          candidates: link.candidates,
        })),
      ),
    ],
  );
}

/**
 * `data_availability.formulary_document_status` for one issuer and year: `available` when every
 * catalog plan is attached to a document, `partial` when some are, otherwise `unknown`.
 * Only existing individual-market rows change; no row is created.
 */
export async function recordAvailability(
  tx: SqlSession,
  issuer: IssuerScope,
  planYear: number,
  catalogSize: number,
  attached: number,
): Promise<string> {
  let status = "unknown";
  if (catalogSize > 0 && attached === catalogSize) status = "available";
  else if (attached > 0) status = "partial";
  await tx.query(
    `UPDATE data_availability SET formulary_document_status = $1
     WHERE state = $2 AND plan_year = $3 AND issuer_id = $4 AND lower(market) = 'individual'`,
    [status, issuer.state, planYear, issuer.issuerId],
  );
  return status;
}
