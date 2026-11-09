import { activeCatalog, directoryRows } from "../api/repository.js";
import type { SqlSession } from "../db/database.js";
import {
  countyPlans,
  countyState,
  findPlan,
  planView,
  resolveLocation,
  variantExists,
} from "../api/repository.js";
import { estimatePremium } from "./premiums.js";
import { benchmark, householdSubsidy, withSubsidy } from "./subsidies.js";
import { zipToCounties } from "../ingest/geo/repository.js";
import * as v from "../api/validation.js";
import { ReadError } from "./errors.js";

/** HIOS and opaque state plan keys remain distinct identities. */
export function parsePlanRef(value: unknown) {
  if (
    typeof value === "string" &&
    /^[A-Z][A-Z0-9]{1,15}:[^\u0000-\u001f]{1,200}$/.test(value)
  ) {
    return { base: value, full: value, variant: null };
  }
  return v.planId(value);
}
export const lookupZip = (db: SqlSession, value: unknown) =>
  zipToCounties(db, v.zip(value));
export const lookupGeography = (
  db: SqlSession,
  input: Record<string, unknown>,
) => resolveLocation(db, v.location(input));

export async function searchPlans(
  db: SqlSession,
  params: Record<string, string>,
) {
  const year = v.year(params.year),
    market = v.market(params.market);
  const csrVariant = v.csrVariant(params.csr_variant);
  const metal = v.metal(params.metal),
    page = v.page(params.page);
  const location = await resolveLocation(db, v.location(params));
  if (location.status !== "available" || !location.county) {
    return {
      status: location.status,
      year,
      market: market.toLowerCase(),
      location,
      plans: [],
      page,
      page_size: 50,
      total: 0,
      next_page: null,
    };
  }
  const plans = (
    await countyPlans(db, location.county, year, location.zip)
  ).filter((p) => metal === undefined || p.metal.toLowerCase() === metal);
  const active = await activeCatalog(db, year, countyState(location.county));
  const start = (page - 1) * 50;
  return {
    status: active.rows.length ? "available" : "unknown",
    year,
    market: market.toLowerCase(),
    location,
    plans: await Promise.all(
      plans.slice(start, start + 50).map(async (plan) => ({
        ...(await planView(db, plan, { csrVariant })),
        availability: {
          zip_restricted: plan.zip_restricted,
          zip_codes: plan.zip_codes,
        },
      })),
    ),
    page,
    page_size: 50,
    total: plans.length,
    next_page: start + 50 < plans.length ? page + 1 : null,
  };
}

export async function getPlan(
  db: SqlSession,
  ref: unknown,
  params: Record<string, string>,
) {
  const id = parsePlanRef(ref),
    year = v.year(params.year);
  const plan = await findPlan(db, id.base, year);
  if (
    !plan ||
    (id.variant !== null && !(await variantExists(db, plan, id.full)))
  )
    throw new ReadError({ code: "PLAN_NOT_FOUND", plan_id: id.full, year });
  const csrVariant = v.csrVariant(params.csr_variant);
  v.checkVariant(id.base, csrVariant, id.variant);
  const view = await planView(db, plan, {
    csrVariant,
    requestedVariant: id.variant,
    allBenefits: true,
  });
  return {
    ...view,
    requested_variant_id: id.variant === null ? null : id.full,
    variant_cost_sharing_resolved:
      view.cost_sharing.status === "available" &&
      view.cost_sharing.benefits_status === "available",
    benefits_status: view.cost_sharing.benefits_status,
    benefits: view.cost_sharing.benefits,
  };
}

export async function estimatePremiums(db: SqlSession, body: unknown) {
  const request = v.premiumRequest(body),
    plans = [];
  for (const id of request.ids) {
    const plan = await findPlan(db, id.base, request.year);
    if (
      !plan ||
      (id.variant !== null && !(await variantExists(db, plan, id.full)))
    )
      throw new ReadError({
        code: "PLAN_NOT_FOUND",
        plan_id: id.full,
        year: request.year,
      });
    plans.push({ id, plan });
  }
  const location = await resolveLocation(db, request.location);
  const subsidy = await householdSubsidy(db, request, location);
  const estimates = [];
  for (const { id, plan } of plans)
    estimates.push(
      withSubsidy(
        await estimatePremium(db, plan, id.full, request, location),
        subsidy,
        plan,
      ),
    );
  return { estimates };
}

export async function benchmarkSilver(
  db: SqlSession,
  params: Record<string, string>,
) {
  const request = v.benchmarkRequest(params);
  return benchmark(db, request, await resolveLocation(db, request.location));
}

export async function listCarriersNetworks(
  db: SqlSession,
  kind: "carriers" | "networks",
  params: Record<string, string>,
) {
  const state = v.state(params.state),
    year = params.year === undefined ? null : v.year(params.year);
  const rows = await directoryRows(db, kind, state, year);
  return { status: rows.length ? "available" : "unknown", [kind]: rows };
}
