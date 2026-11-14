import type { SqlSession } from "../db/database.js";
import type { Plan } from "../api/repository.js";
import {
  countyState,
  findPlan,
  resolveLocation,
  variantExists,
} from "../api/repository.js";
import * as v from "../api/validation.js";
import { applyQuoteFallback, readQuoteCoverage } from "./quote-coverage.js";
import type { CmsFallbackContext } from "../ingest/cms-api/fallback.js";
import { dataAvailability } from "./availability.js";
import { estimatePremium } from "./premiums.js";
import { requestReads } from "./request-reads.js";
import type { RequestReads } from "./request-reads.js";
import { ReadError } from "./errors.js";
import { locationIssues } from "./location-issues.js";

export type QuoteTier = "public_quote";
type QuoteRequest = ReturnType<typeof v.publicQuoteRequest>;
type Location = Awaited<ReturnType<typeof resolveLocation>>;
interface QuotedPlan {
  requestedId: string;
  plan: Plan;
}
type EvidenceStatus = "available" | "partial" | "unknown";

export const QUOTE_PAGE_SIZE = v.PUBLIC_QUOTE_LIMITS.plans;

/** Explicit plans keep the premium route's 404 semantics for unknown IDs and variants. */
async function requestedPlans(
  db: SqlSession,
  request: QuoteRequest,
): Promise<QuotedPlan[]> {
  const plans: QuotedPlan[] = [];
  for (const id of request.premium.ids) {
    const plan = await findPlan(db, id.base, request.premium.year);
    if (
      !plan ||
      (id.variant !== null && !(await variantExists(db, plan, id.full)))
    )
      throw new ReadError({
        code: "PLAN_NOT_FOUND",
        plan_id: id.full,
        year: request.premium.year,
      });
    plans.push({ requestedId: id.full, plan });
  }
  return plans;
}

async function catalogPage(
  reads: RequestReads,
  request: QuoteRequest,
  county: string,
  zip: string | undefined,
) {
  const offered = (
    await reads.countyPlans(county, request.premium.year, zip, request.coverage)
  )
    .filter(
      (plan) =>
        request.metal === undefined ||
        plan.metal.toLowerCase() === request.metal,
    )
    .sort((a, b) => a.base_plan_id.localeCompare(b.base_plan_id));
  const start = (request.page - 1) * QUOTE_PAGE_SIZE;
  return {
    plans: offered
      .slice(start, start + QUOTE_PAGE_SIZE)
      .map((plan) => ({ requestedId: plan.base_plan_id, plan })),
    total: offered.length,
  };
}

/** Evidence semantics stay with providerParticipation and drugCoverage; unknown is never "not covered". */
async function quotePlan(
  db: SqlSession,
  { requestedId, plan }: QuotedPlan,
  request: QuoteRequest,
  location: Location,
  reads: RequestReads,
) {
  const { providers, drugs } = await readQuoteCoverage(
    db,
    requestedId,
    request.npis,
    request.rxcuis,
    request.premium.year,
  );
  return {
    ...(await estimatePremium(
      db,
      plan,
      requestedId,
      request.premium,
      location,
      reads,
    )),
    providers,
    drugs,
  };
}

function summarize(statuses: unknown[]): EvidenceStatus {
  if (statuses.length && statuses.every((status) => status === "available"))
    return "available";
  return statuses.includes("available") ? "partial" : "unknown";
}
/** Per-issuer manifest rows for the quoted state/year; no rows means unknown. */
async function quoteDataAvailability(
  db: SqlSession,
  state: string | null,
  year: number,
  plans: QuotedPlan[],
) {
  const issuers = new Set(plans.map(({ plan }) => plan.issuer_id));
  const rows = state
    ? await dataAvailability(db, { state, year, issuers })
    : [];
  return {
    catalog: summarize(rows.map((row) => row.catalog_status)),
    providers: summarize(rows.map((row) => row.provider_status)),
    drugs: summarize(rows.map((row) => row.formulary_status)),
  };
}

/** An unresolved or ambiguous location returns no quotes, mirroring plan search. */
async function selectPlans(
  db: SqlSession,
  request: QuoteRequest,
  location: Location,
  reads: RequestReads,
) {
  if (location.status !== "available" || !location.county)
    return { plans: [] as QuotedPlan[], total: 0, located: null };
  if (!request.explicitPlans)
    return {
      ...(await catalogPage(reads, request, location.county, location.zip)),
      located: location.county,
    };
  const plans = await requestedPlans(db, request);
  return { plans, total: plans.length, located: location.county };
}

/** Anonymous quotes by age and ZIP: gross premiums only, never subsidy or income inputs. */
export async function quotePlans(
  db: SqlSession,
  body: unknown,
  tier: QuoteTier = "public_quote",
  cms?: CmsFallbackContext,
) {
  const request = v.publicQuoteRequest(body);
  const { premium } = request;
  const location = await resolveLocation(db, premium.location);
  // Every quote below shares this request's county catalog and plan reads.
  const reads = requestReads(db);
  const selection = await selectPlans(db, request, location, reads);
  const quotes = [];
  for (const plan of selection.plans)
    quotes.push(await quotePlan(db, plan, request, location, reads));
  const pageSize = request.explicitPlans
    ? selection.plans.length
    : QUOTE_PAGE_SIZE;
  const hasNext =
    !request.explicitPlans && request.page * QUOTE_PAGE_SIZE < selection.total;
  return {
    schema_version: "1",
    tier,
    bindable_quote: false,
    year: premium.year,
    coverage_start: premium.coverage,
    coverage: request.coverage,
    location,
    issues: await locationIssues(
      db,
      location,
      premium.year,
      request.coverage,
      reads,
    ),
    members: premium.members.map((member) => ({
      member_id: member.id,
      age: member.age,
      relationship: member.relationship,
      tobacco: member.tobaccoUse,
    })),
    tobacco_rating: "requested_flags",
    subsidy: { status: "not_evaluated", reason: "PUBLIC_QUOTE_TIER" },
    csr_eligibility_status: "not_evaluated",
    data_availability: await quoteDataAvailability(
      db,
      selection.located ? countyState(selection.located) : null,
      premium.year,
      selection.plans,
    ),
    quotes: await applyQuoteFallback(quotes, cms),
    page: request.page,
    page_size: pageSize,
    total: selection.total,
    next_page: hasNext ? request.page + 1 : null,
  };
}
