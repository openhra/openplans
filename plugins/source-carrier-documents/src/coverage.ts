import type { SqlSession } from "@openplans/plugin-sdk";
import {
  COVERAGE_UNKNOWN_REASON,
  IDENTITY_CONFIRMATION_MAX_AGE_DAYS,
  SERVED_CONFIDENCE,
  UNKNOWN_REASON,
} from "./constants.js";
import { ACTIVE_LINKS, unattachedReason } from "./evidence.js";
import { IDENTITY_TABLE } from "./join.js";

/** One document row behind a coverage answer, and how its printed name became the RxCUI. */
export interface FormularyCoverageEvidence extends Record<string, unknown> {
  kind: "issuer_formulary_document_row";
  /** The document's snapshot. */
  snapshot_id: string;
  document: {
    url: string;
    sha256: string;
    plan_year: number;
    page: number;
    line: number;
    raw_text: string;
    drug_name: string;
  };
  identity: {
    source_id: string;
    rxcui: string;
    concept_name: string;
    query: string;
    joined_at: string;
    /** When the identity source or the RxNorm release last confirmed the RxCUI. */
    confirmed_at: string;
    /** The identity stage's evidence blocks: the name search and the confirmation. */
    evidence: Record<string, unknown>;
  };
}

export type FormularyCoverageAnswer =
  | {
      status: "covered";
      /** The tier number and label exactly as the document prints them. */
      tier: number;
      tier_label: string | null;
      prior_authorization: boolean;
      step_therapy: boolean;
      quantity_limit: boolean;
      quantity_limit_text: string | null;
      evidence: FormularyCoverageEvidence[];
    }
  | {
      status: "unknown";
      reason: string;
      evidence?: FormularyCoverageEvidence[];
    };

type CoveredRow = {
  snapshot_id: string;
  tier: number;
  tier_label: string | null;
  flags: string[];
  ql_text: string;
  raw_text: string;
  drug_name: string;
  page: number;
  line: number;
  url: string;
  document_sha256: string;
  plan_year: number;
  rxcui: string;
  concept_name: string;
  query: string;
  identity_source: string;
  evidence: Record<string, unknown>;
  joined_at: Date | string;
  confirmed_at: Date | string;
  /** Confirmed within `IDENTITY_CONFIRMATION_MAX_AGE_DAYS` of the question. */
  fresh: boolean;
};

function rowEvidence(row: CoveredRow): FormularyCoverageEvidence {
  return {
    kind: "issuer_formulary_document_row",
    snapshot_id: row.snapshot_id,
    document: {
      url: row.url,
      sha256: row.document_sha256,
      plan_year: row.plan_year,
      page: row.page,
      line: row.line,
      raw_text: row.raw_text,
      drug_name: row.drug_name,
    },
    identity: {
      source_id: row.identity_source,
      rxcui: row.rxcui,
      concept_name: row.concept_name,
      query: row.query,
      joined_at: new Date(row.joined_at).toISOString(),
      confirmed_at: new Date(row.confirmed_at).toISOString(),
      evidence: row.evidence,
    },
  };
}

const termsOf = (row: CoveredRow) =>
  JSON.stringify([
    row.tier,
    row.tier_label,
    [...row.flags].sort(),
    row.ql_text,
  ]);

/**
 * Drug coverage from the active formulary documents for one plan (base or variant id), plan year
 * and RxCUI. A row answers only when it is `high` confidence on a tier the document defines and the
 * RxCUI join resolved it to exactly this RxCUI: then the drug is covered at the document's printed
 * tier, with its PA, ST and QL flags, and every row is cited. Rows that disagree answer `unknown`
 * with all of them as evidence. A drug the documents do not resolve to is `unknown`, never "not
 * covered": while any row is unresolved the reason is `identity_unresolved`. With the plugin's
 * `identityJoin` switch off, no joined row is used. A row whose RxCUI was last confirmed more than
 * `IDENTITY_CONFIRMATION_MAX_AGE_DAYS` before `now` is not used either: with only such rows the
 * answer is `unknown` (`identity_confirmation_stale`) until a join run confirms them again.
 */
export async function formularyDrugCoverage(
  db: SqlSession,
  query: {
    planId: string;
    planYear: number;
    rxcui: string;
    identityJoin: boolean;
    now?: Date;
  },
): Promise<FormularyCoverageAnswer> {
  if (!query.identityJoin)
    return { status: "unknown", reason: COVERAGE_UNKNOWN_REASON.joinOff };
  const basePlanId = query.planId.slice(0, 14);
  const now = query.now ?? new Date();
  const { rows: matched } = await db.query<CoveredRow>(
    `SELECT l.snapshot_id, r.tier, r.tier_label, r.flags, r.ql_text, r.raw_text, r.drug_name, r.page, r.line,
            d.url, d.document_sha256, d.plan_year,
            i.rxcui, i.concept_name, i.query, i.identity_source, i.evidence, i.joined_at,
            coalesce(i.confirmed_at, i.joined_at) AS confirmed_at,
            coalesce(i.confirmed_at, i.joined_at) > $5::timestamptz - make_interval(days => $6) AS fresh
     ${ACTIVE_LINKS}
     JOIN plg_carrierdoc_document d ON d.snapshot_id = l.snapshot_id
     JOIN plg_carrierdoc_formulary_row r ON r.snapshot_id = l.snapshot_id
     JOIN ${IDENTITY_TABLE} i ON i.snapshot_id = r.snapshot_id AND i.page = r.page AND i.line = r.line
     WHERE l.base_plan_id = $1 AND l.plan_year = $2 AND l.status = 'attached'
       AND i.status = 'resolved' AND i.rxcui = $3
       AND r.confidence = $4 AND r.unknown_reason IS NULL
     ORDER BY d.url, r.page, r.line`,
    [
      basePlanId,
      query.planYear,
      query.rxcui,
      SERVED_CONFIDENCE,
      now.toISOString(),
      IDENTITY_CONFIRMATION_MAX_AGE_DAYS,
    ],
  );
  // Only identities confirmed again within the window answer.
  const rows = matched.filter((row) => row.fresh);
  if (matched.length && !rows.length)
    return { status: "unknown", reason: COVERAGE_UNKNOWN_REASON.identityStale };
  if (rows.length) {
    const evidence = rows.map(rowEvidence);
    if (new Set(rows.map(termsOf)).size > 1)
      return {
        status: "unknown",
        reason: COVERAGE_UNKNOWN_REASON.rowsConflict,
        evidence,
      };
    const [row] = rows;
    return {
      status: "covered",
      tier: row!.tier,
      tier_label: row!.tier_label,
      prior_authorization: row!.flags.includes("PA"),
      step_therapy: row!.flags.includes("ST"),
      quantity_limit: row!.flags.includes("QL"),
      quantity_limit_text: row!.ql_text || null,
      evidence,
    };
  }
  const { rows: attached } = await db.query<{ unresolved: number }>(
    `SELECT count(r.*) FILTER (WHERE i.status IS DISTINCT FROM 'resolved')::int AS unresolved
     ${ACTIVE_LINKS}
     JOIN plg_carrierdoc_formulary_row r ON r.snapshot_id = l.snapshot_id
     LEFT JOIN ${IDENTITY_TABLE} i ON i.snapshot_id = r.snapshot_id AND i.page = r.page AND i.line = r.line
     WHERE l.base_plan_id = $1 AND l.plan_year = $2 AND l.status = 'attached'
     HAVING count(*) > 0`,
    [basePlanId, query.planYear],
  );
  if (!attached.length)
    return {
      status: "unknown",
      reason: await unattachedReason(db, basePlanId, query.planYear),
    };
  // Even with every row resolved, a drug the documents do not list is not "not covered".
  return {
    status: "unknown",
    reason: attached[0]!.unresolved
      ? COVERAGE_UNKNOWN_REASON.identityUnresolved
      : UNKNOWN_REASON.notListed,
  };
}
