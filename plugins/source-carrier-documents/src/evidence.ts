import type { SqlSession } from "@openplans/plugin-sdk";
import { SERVED_CONFIDENCE, UNKNOWN_REASON } from "./constants.js";

/** The comparable form of a drug name as printed: whitespace collapsed, case folded. */
export const drugNameKey = (name: string) =>
  name.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Text evidence from an issuer's formulary PDF. It says what the document prints; it is not a
 * coverage flag. No RxCUI is attached: joining a printed name to an RxCUI needs the drug
 * identity stage, and a name is never guessed into one.
 */
export interface FormularyDocumentText {
  kind: "issuer_formulary_document_text";
  text: string;
  drug_name: string;
  /** The tier number and label exactly as the document prints them, never mapped onto a plan's tiers. */
  tier: number;
  tier_label: string | null;
  requirements: string[];
  quantity_limit: string | null;
  document: {
    url: string;
    sha256: string;
    plan_year: number;
    page: number;
    line: number;
  };
  identity: "not_resolved";
}

export type FormularyDocumentAnswer =
  | { status: "listed"; evidence: FormularyDocumentText[] }
  | {
      status: "unknown";
      reason: string;
      /** Where the document prints the rows kept as unknown (`tier_not_defined_in_document`). */
      evidence?: {
        url: string;
        sha256: string;
        plan_year: number;
        page: number;
        line: number;
      }[];
    };

type StagedRow = {
  drug_name: string;
  tier: number;
  tier_label: string | null;
  flags: string[];
  ql_text: string;
  confidence: string;
  unknown_reason: string | null;
  page: number;
  line: number;
  url: string;
  document_sha256: string;
  plan_year: number;
};

export const ACTIVE_LINKS = `
  FROM plg_carrierdoc_plan_link l
  JOIN snapshot s ON s.snapshot_id = l.snapshot_id AND s.validation_state = 'ACTIVE'`;

/**
 * Why a plan has no attached document. With documents for the issuer and year, either some cover
 * names matched more than one plan (this plan may be among them) or the plan is not on any cover.
 */
export async function unattachedReason(
  db: SqlSession,
  basePlanId: string,
  planYear: number,
): Promise<string> {
  const { rows } = await db.query<{ status: string }>(
    `SELECT DISTINCT l.status ${ACTIVE_LINKS}
     WHERE l.issuer_id = $1 AND l.plan_year = $2`,
    [basePlanId.slice(0, 5), planYear],
  );
  const statuses = rows.map((row) => row.status);
  if (!statuses.length) return UNKNOWN_REASON.noDocument;
  if (statuses.includes("plan_mapping_ambiguous"))
    return UNKNOWN_REASON.ambiguous;
  return UNKNOWN_REASON.notOnCover;
}

function text(row: StagedRow): FormularyDocumentText {
  const label = row.tier_label ? ` (${row.tier_label})` : "";
  return {
    kind: "issuer_formulary_document_text",
    text: `Listed in the issuer's ${row.plan_year} formulary document as "${row.drug_name}", tier ${row.tier}${label}, page ${row.page}.`,
    drug_name: row.drug_name,
    tier: row.tier,
    tier_label: row.tier_label,
    requirements: row.flags,
    quantity_limit: row.ql_text || null,
    document: {
      url: row.url,
      sha256: row.document_sha256,
      plan_year: row.plan_year,
      page: row.page,
      line: row.line,
    },
    identity: "not_resolved",
  };
}

/**
 * What the active formulary documents print for a drug name on one plan (a 14-character base
 * plan id or a variant id) and plan year. The name must match a printed name exactly after
 * `drugNameKey`. Only `high` confidence rows are served; a name found only in lower-confidence
 * rows answers `unknown` with `pdf_low_confidence`. A name the document does not list is
 * `unknown` too, never "not covered".
 */
export async function formularyDocumentEvidence(
  db: SqlSession,
  query: { planId: string; planYear: number; drugName: string },
): Promise<FormularyDocumentAnswer> {
  const basePlanId = query.planId.slice(0, 14);
  const { rows } = await db.query<StagedRow>(
    `SELECT r.drug_name, r.tier, r.tier_label, r.flags, r.ql_text, r.confidence, r.unknown_reason, r.page, r.line,
            d.url, d.document_sha256, d.plan_year
     ${ACTIVE_LINKS}
     JOIN plg_carrierdoc_document d ON d.snapshot_id = l.snapshot_id
     JOIN plg_carrierdoc_formulary_row r ON r.snapshot_id = l.snapshot_id AND r.name_key = $3
     WHERE l.base_plan_id = $1 AND l.plan_year = $2 AND l.status = 'attached'
     ORDER BY d.url, r.page, r.line`,
    [basePlanId, query.planYear, drugNameKey(query.drugName)],
  );
  const served = rows.filter(
    (row) => row.confidence === SERVED_CONFIDENCE && !row.unknown_reason,
  );
  if (served.length) return { status: "listed", evidence: served.map(text) };
  const undefinedTier = rows.filter((row) => row.unknown_reason);
  if (undefinedTier.length)
    return {
      status: "unknown",
      reason: UNKNOWN_REASON.tierNotDefined,
      evidence: undefinedTier.map((row) => ({
        url: row.url,
        sha256: row.document_sha256,
        plan_year: row.plan_year,
        page: row.page,
        line: row.line,
      })),
    };
  if (rows.length)
    return { status: "unknown", reason: UNKNOWN_REASON.lowConfidence };
  const attached = await db.query<{ present: boolean }>(
    `SELECT EXISTS (SELECT 1 ${ACTIVE_LINKS}
       WHERE l.base_plan_id = $1 AND l.plan_year = $2 AND l.status = 'attached') AS present`,
    [basePlanId, query.planYear],
  );
  if (attached.rows[0]?.present)
    return { status: "unknown", reason: UNKNOWN_REASON.notListed };
  return {
    status: "unknown",
    reason: await unattachedReason(db, basePlanId, query.planYear),
  };
}
