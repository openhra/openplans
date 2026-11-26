import { requireAnnualYear } from "./data-window.js";
import { guardCatalogPlans, catalogPolicyActive } from "./catalog-policy.js";
import type { SqlSession } from "../db/database.js";
import { createRxnormRepository } from "../ingest/rxnorm/repository.js";
import { drugCoverage } from "../domain/drugs/repository.js";
import type { DrugIdentityStage } from "../domain/drugs/repository.js";
import { drugConcept, normalizeNdc } from "../domain/drugs/concepts.js";
import * as v from "../api/validation.js";
import { ReadError } from "./errors.js";
import { linkOutFloor, withLinkOuts } from "../domain/link-outs.js";
import { passThrough } from "../plugins/sources/passthrough.js";
import { consultPassThrough } from "./upstream-disclosure.js";
import { suggestDrugNames } from "./drug-name-search.js";
import type { CmsFallbackContext } from "../ingest/cms-api/fallback.js";

function rxcui(value: unknown): string {
  if (typeof value !== "string" || !/^\d{1,20}$/.test(value))
    return v.fail("rxcui");
  return value;
}
function drugYear(value: unknown): number {
  const parsed = v.year(value);
  if (parsed > 2100) return v.fail("year");
  return parsed;
}
function coverageRequest(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return v.fail("body");
  const body = value as Record<string, unknown>;
  if (
    !Array.isArray(body.plan_ids) ||
    body.plan_ids.length < 1 ||
    body.plan_ids.length > 50
  )
    return v.fail("plan_ids");
  if (
    !Array.isArray(body.rxcuis) ||
    body.rxcuis.length < 1 ||
    body.rxcuis.length > 100
  )
    return v.fail("rxcuis");
  if (body.plan_ids.length * body.rxcuis.length > 1000)
    return v.fail("body", "too_many_pairs");
  const plans = body.plan_ids.map((id) => v.planId(id).full),
    codes = body.rxcuis.map(rxcui);
  if (new Set(plans).size !== plans.length)
    return v.fail("plan_ids", "duplicate_plan_id");
  if (new Set(codes).size !== codes.length)
    return v.fail("rxcuis", "duplicate_rxcui");
  if (typeof body.year !== "number" || !Number.isInteger(body.year))
    return v.fail("year");
  return { plans, codes, year: drugYear(String(body.year)) };
}

/**
 * Name and NDC search. `scope` is the request's pass-through scope: with it and no ACTIVE RxNorm
 * release, a name search asks the name-search source (`suggestDrugNames`).
 */
export async function searchDrugs(
  db: SqlSession,
  params: Record<string, string>,
  scope?: CmsFallbackContext,
) {
  const rx = createRxnormRepository(db);
  const q = params.q,
    ndc = params.ndc;
  if ((q === undefined) === (ndc === undefined))
    return v.fail("q", "query_or_ndc_required");
  if (ndc !== undefined) {
    const normalized = normalizeNdc(ndc);
    if (!normalized) return v.fail("ndc", "invalid_ndc");
    return {
      ndc: normalized,
      rxcuis: await rx.rxcuisForNdc(normalized),
      exact_concept_required: true,
      ...(await terminology(rx)),
    };
  }
  if (!q?.trim() || q.length > 200) return v.fail("q");
  const limit = params.limit ?? "50";
  if (!/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 100)
    return v.fail("limit");
  const candidates = await rx.searchDrugs(q, { limit: Number(limit) });
  const status = await terminology(rx);
  // Only without an ACTIVE release: then RxNav's suggestions, labelled as such, replace the empty
  // list. They help pick an exact RxCUI and say nothing about coverage.
  if (status.terminology_status === "unknown") {
    const suggested = await drugNameSuggestions(q, scope);
    if (suggested)
      return {
        candidates: suggested.candidates.slice(0, Number(limit)),
        exact_concept_required: true,
        terminology_status: "passthrough" as const,
        terminology_evidence: suggested.evidence,
      };
  }
  return { candidates, exact_concept_required: true, ...status };
}
/**
 * Whether an RxNorm release is ACTIVE. With none, an empty search says so; with one, an empty
 * search means no concept matched.
 */
async function terminology(rx: ReturnType<typeof createRxnormRepository>) {
  return (await rx.activeRelease())
    ? { terminology_status: "available" as const }
    : {
        terminology_status: "unknown" as const,
        reason: "rxnorm_terminology_unavailable" as const,
      };
}
export async function getDrug(db: SqlSession, value: unknown) {
  const concept = await drugConcept(db, rxcui(value));
  if (!concept) throw new ReadError({ code: "drug_not_found" });
  return concept;
}
/**
 * The request's identity stage: the same scope as the later `apply("drug")` call, so the coverage
 * source can accept identities confirmed during this request. It goes through the host's
 * disclosure like every pass-through call: `passthrough=off` asks nothing upstream (the RxCUI then
 * stays `rxcui_not_in_rxnorm`), and an identity source that answered is named in
 * `x-openplans-upstream`.
 */
export const identityStage = (
  scope: CmsFallbackContext | undefined,
): DrugIdentityStage | undefined =>
  scope
    ? {
        api: {
          apply: (kind, answers, inner) =>
            consultPassThrough(passThrough, kind, answers, inner),
        },
        scope,
      }
    : undefined;

/**
 * `cms` is the request's pass-through scope; absent unless the operator enabled a pass-through
 * source (the CMS API fallback or the RxNav identity source).
 */
export async function checkDrugCoverage(
  db: SqlSession,
  plan: unknown,
  code: unknown,
  year: unknown,
  cms?: CmsFallbackContext,
) {
  await requireAnnualYear(db, drugYear(year));
  if (catalogPolicyActive())
    await guardCatalogPlans([v.planId(plan).full], drugYear(year));
  const answer = await drugCoverage(
    db,
    v.planId(plan).full,
    rxcui(code),
    drugYear(year),
    identityStage(cms),
  );
  // A pass-through source may answer what the files left unknown; the floor then drops the links.
  return cms
    ? withLinkOuts(
        (await consultPassThrough(passThrough, "drug", [answer], cms))[0]!,
      )
    : answer;
}
export async function checkDrugCoverages(
  db: SqlSession,
  body: unknown,
  cms?: CmsFallbackContext,
) {
  const request = coverageRequest(body),
    results = [];
  await requireAnnualYear(db, request.year);
  await guardCatalogPlans(request.plans, request.year);
  for (const plan of request.plans)
    for (const code of request.codes)
      results.push(
        await drugCoverage(db, plan, code, request.year, identityStage(cms)),
      );
  return {
    results: cms
      ? linkOutFloor(
          await consultPassThrough(passThrough, "drug", results, cms),
        )
      : results,
  };
}
/**
 * A name-search source's suggestions for a name, through the request's pass-through scope; null
 * without a scope or when no source served the name. Callers ask only without an ACTIVE release.
 */
export const drugNameSuggestions = async (
  name: string,
  scope: CmsFallbackContext | undefined,
) => (scope ? suggestDrugNames(passThrough, name, scope) : null);
/** Terminology availability is separate from a successful empty candidate search. */
export const drugTerminology = (db: SqlSession) =>
  createRxnormRepository(db).activeRelease();
