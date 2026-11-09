import type { SqlSession } from "../db/database.js";
import { createRxnormRepository } from "../ingest/rxnorm/repository.js";
import { drugCoverage } from "../domain/drugs/repository.js";
import { drugConcept, normalizeNdc } from "../domain/drugs/concepts.js";
import * as v from "../api/validation.js";
import { ReadError } from "./errors.js";

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
    return v.fail("body", "TOO_MANY_PAIRS");
  const plans = body.plan_ids.map((id) => v.planId(id).full),
    codes = body.rxcuis.map(rxcui);
  if (new Set(plans).size !== plans.length)
    return v.fail("plan_ids", "DUPLICATE_PLAN_ID");
  if (new Set(codes).size !== codes.length)
    return v.fail("rxcuis", "DUPLICATE_RXCUI");
  if (typeof body.year !== "number" || !Number.isInteger(body.year))
    return v.fail("year");
  return { plans, codes, year: drugYear(String(body.year)) };
}

export async function searchDrugs(
  db: SqlSession,
  params: Record<string, string>,
) {
  const rx = createRxnormRepository(db);
  const q = params.q,
    ndc = params.ndc;
  if ((q === undefined) === (ndc === undefined))
    return v.fail("q", "QUERY_OR_NDC_REQUIRED");
  if (ndc !== undefined) {
    const normalized = normalizeNdc(ndc);
    if (!normalized) return v.fail("ndc", "INVALID_NDC");
    return {
      ndc: normalized,
      rxcuis: await rx.rxcuisForNdc(normalized),
      exact_concept_required: true,
    };
  }
  if (!q?.trim() || q.length > 200) return v.fail("q");
  const limit = params.limit ?? "50";
  if (!/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 100)
    return v.fail("limit");
  return {
    candidates: await rx.searchDrugs(q, { limit: Number(limit) }),
    exact_concept_required: true,
  };
}
export async function getDrug(db: SqlSession, value: unknown) {
  const concept = await drugConcept(db, rxcui(value));
  if (!concept) throw new ReadError({ code: "DRUG_NOT_FOUND" });
  return concept;
}
export const checkDrugCoverage = (
  db: SqlSession,
  plan: unknown,
  code: unknown,
  year: unknown,
) => drugCoverage(db, v.planId(plan).full, rxcui(code), drugYear(year));
export async function checkDrugCoverages(db: SqlSession, body: unknown) {
  const request = coverageRequest(body),
    results = [];
  for (const plan of request.plans)
    for (const code of request.codes)
      results.push(await drugCoverage(db, plan, code, request.year));
  return { results };
}
/** Terminology availability is separate from a successful empty candidate search. */
export const drugTerminology = (db: SqlSession) =>
  createRxnormRepository(db).activeRelease();
