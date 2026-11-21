import type {
  DocumentDrugAnswer,
  FeedSource,
  SqlSession,
} from "@openplans/plugin-sdk";
import { currentRegistries } from "../../plugins/registries.js";
import type { DrugCoverage, FormularyDocumentCoverage } from "./index.js";

/**
 * Drug coverage from issuer-published documents (feed sources with `drugCoverage`, such as the
 * carrier formulary PDFs), between the issuer's machine-readable files and the pass-through
 * sources:
 *
 * 1. Loaded machine-readable files win. A settled answer (`listed_covered`,
 *    `explicitly_not_covered`, `not_listed`, `conflicting`) is never changed; when a document also
 *    answers, `passthrough_conflict` records whether the two agree, as the pass-through core does
 *    for a stored source's answer.
 * 2. Only an `unknown` answer for one of `DOCUMENT_OPENING_REASONS` may be filled, so the RxCUI is
 *    already identified and the plan is in the active catalog. A document's `covered` answer is
 *    served as `listed_covered` with the document rows in `formulary_document`.
 * 3. Anything else stays as the files gave it, so the pass-through sources (the CMS fallback) see
 *    the same `unknown` and the same reason. A document-served answer is settled for them: a stored
 *    CMS answer for the same question is only checked against it (`cms_api_conflict`).
 *
 * Documents are local data: answering from them calls nothing upstream and discloses nothing.
 */
export const DOCUMENT_OPENING_REASONS: readonly string[] = Object.freeze([
  "source_set_not_available",
  "source_set_incomplete",
  "source_access_denied",
]);
const SETTLED = new Set([
  "listed_covered",
  "explicitly_not_covered",
  "not_listed",
  "conflicting",
]);

type DocumentSource = FeedSource & Required<Pick<FeedSource, "drugCoverage">>;

/** Registered feed sources that answer drug coverage, in configuration order. */
export function documentCoverageSources(): DocumentSource[] {
  return currentRegistries()
    .sources.map((entry) => entry.spec)
    .filter(
      (spec): spec is DocumentSource =>
        spec.kind === "feed" && typeof spec.drugCoverage === "function",
    );
}

async function ask(
  source: DocumentSource,
  db: SqlSession,
  answer: DrugCoverage,
): Promise<DocumentDrugAnswer | null> {
  try {
    return await source.drugCoverage(db, {
      planId: answer.requested_plan_id,
      planYear: answer.plan_year,
      rxcui: answer.rxcui,
    });
  } catch {
    // A document source that fails leaves the answer as the loaded files gave it.
    return null;
  }
}

/**
 * Records, without changing either side, how a document's answer compares with the loaded
 * files' settled answer: one `passthrough_conflict` row per document snapshot. As for the CMS
 * fallback, only the direction is compared (listed or not); a document's printed tier is never
 * mapped onto the plan's tiers, so tiers are not compared.
 */
async function recordConflict(
  writer: SqlSession,
  source: DocumentSource,
  answer: DrugCoverage,
  found: Extract<DocumentDrugAnswer, { status: "covered" }>,
): Promise<void> {
  try {
    for (const snapshot of new Set(found.evidence.map((e) => e.snapshot_id)))
      await writer.query(
        `INSERT INTO passthrough_conflict(source_id,kind,plan_id,identity,plan_year,source_snapshot_id,
          source_outcome,local_status,agrees)
        VALUES($1,'drug',$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
        [
          source.id,
          answer.requested_plan_id,
          answer.rxcui,
          answer.plan_year,
          snapshot,
          found.status,
          answer.status,
          answer.status === "listed_covered",
        ],
      );
  } catch {
    // A comparison that cannot be recorded never changes an answer.
  }
}

function served(
  answer: DrugCoverage,
  source: DocumentSource,
  found: Extract<DocumentDrugAnswer, { status: "covered" }>,
): DrugCoverage {
  const document: FormularyDocumentCoverage = {
    source_id: source.id,
    tier: found.tier,
    tier_label: found.tier_label,
    quantity_limit_text: found.quantity_limit_text,
    evidence: found.evidence,
  };
  return {
    ...answer,
    status: "listed_covered",
    reason: null,
    // The tier as the document prints it; it is not resolved against the plan's own tiers.
    drug_tier: found.tier_label ?? String(found.tier),
    tier_status: "unresolved",
    prior_authorization: found.prior_authorization,
    step_therapy: found.step_therapy,
    quantity_limit: found.quantity_limit,
    snapshot_id: found.evidence[0]?.snapshot_id ?? answer.snapshot_id,
    formulary_document: document,
  };
}

/**
 * Applies the document layer to one answer from the loaded files. `writer` is the request's
 * pass-through writer: without it (read-only scopes) conflicts are not recorded.
 */
export async function withDocumentCoverage(
  db: SqlSession,
  answer: DrugCoverage,
  writer?: SqlSession,
): Promise<DrugCoverage> {
  const fillable =
    answer.status === "unknown" &&
    DOCUMENT_OPENING_REASONS.includes(answer.reason ?? "");
  const settled = SETTLED.has(answer.status);
  if (!fillable && !(settled && writer)) return answer;
  for (const source of documentCoverageSources()) {
    const found = await ask(source, db, answer);
    // Not covered by the documents is never "not covered": the answer stays as it was.
    if (found?.status !== "covered" || !found.evidence.length) continue;
    if (!fillable) {
      await recordConflict(writer!, source, answer, found);
      continue;
    }
    return served(answer, source, found);
  }
  return answer;
}
