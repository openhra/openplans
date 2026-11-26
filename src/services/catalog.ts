import { withCurrentDataPolicy } from "./data-window.js";
import { scopeResponseGeneration } from "../plugins/request-scope.js";
import { requireAnnualYear, annualRows } from "./data-window.js";
import {
  selectCatalogPlans,
  guardCatalogPlans,
  annotateCatalogPlan,
  catalogPolicyActive,
  withCatalogPolicyContext,
} from "./catalog-policy.js";
import {
  activeCatalog,
  directoryRows,
  planPageScope,
} from "../api/repository.js";
import type { SqlSession } from "../db/database.js";
import {
  countyState,
  findPlan,
  findPlans,
  planView,
  requestedPlansExist,
  resolveLocation,
  variantExists,
} from "../api/repository.js";
import { estimatePremium } from "./premiums.js";
import { requestReads } from "./request-reads.js";
import { benchmark, householdSubsidy, withSubsidy } from "./subsidies.js";
import { zipToCounties } from "../ingest/geo/repository.js";
import * as v from "../api/validation.js";
import { ReadError } from "./errors.js";
import { locationIssues } from "./location-issues.js";

/** HIOS and opaque state plan keys remain distinct identities. */
export function parsePlanRef(value: unknown) {
  if (
    typeof value === "string" &&
    // eslint-disable-next-line no-control-regex -- Control characters must be rejected at this boundary.
    /^[A-Z][A-Z0-9]{1,15}:[^\u0000-\u001f]{1,200}$/.test(value)
  ) {
    return { base: value, full: value, variant: null };
  }
  return v.planId(value);
}
export function lookupZip(db: SqlSession, value: unknown) {
  const zip = v.zip(value);
  return zipToCounties(db, zip, { generation: scopeResponseGeneration() });
}
export const lookupGeography = (
  db: SqlSession,
  input: Record<string, unknown>,
) => resolveLocation(db, v.location(input));

export async function searchPlans(
  db: SqlSession,
  params: Record<string, string>,
) {
  return withCurrentDataPolicy(async () => {
    const year = v.year(params.year),
      market = v.market(params.market);
    const csrVariant = v.csrVariant(params.csr_variant);
    const metal = v.metal(params.metal),
      page = v.page(params.page);
    await requireAnnualYear(db, year);
    const location = await resolveLocation(db, v.location(params));
    const scoped = planPageScope(db);
    // Every read below, the page's plan views included, goes through the page scope.
    const reads = requestReads(scoped);
    const issues = await locationIssues(db, location, year, "medical", reads);
    if (location.status !== "available" || !location.county) {
      return {
        status: location.status,
        year,
        market: market.toLowerCase(),
        location,
        issues,
        plans: [],
        page,
        page_size: 50,
        total: 0,
        next_page: null,
      };
    }
    const plans = await selectCatalogPlans(
      (await reads.countyPlans(location.county, year, location.zip)).filter(
        (p) => metal === undefined || p.metal.toLowerCase() === metal,
      ),
      year,
      (p) => p.base_plan_id,
    );
    const active = await activeCatalog(db, year, countyState(location.county));
    const start = (page - 1) * 50;
    const shown = plans.slice(start, start + 50);
    reads.plan(shown);
    const options = { csrVariant };
    return withCatalogPolicyContext({
      status: active.rows.length ? "available" : "unknown",
      ...(active.rows.length ? {} : { reason: "catalog_not_loaded" }),
      year,
      market: market.toLowerCase(),
      location,
      issues,
      plans: await Promise.all(
        shown.map(async (plan) =>
          annotateCatalogPlan(
            {
              ...(await planView(
                reads.db,
                plan,
                options,
                reads.costSharing(plan, options),
                reads.lineage,
              )),
              availability: {
                zip_restricted: plan.zip_restricted,
                zip_codes: plan.zip_codes,
              },
            },
            plan.base_plan_id,
            year,
          ),
        ),
      ),
      page,
      page_size: 50,
      total: plans.length,
      next_page: start + 50 < plans.length ? page + 1 : null,
    });
  });
}

export async function getPlan(
  db: SqlSession,
  ref: unknown,
  params: Record<string, string>,
) {
  const id = parsePlanRef(ref),
    year = v.year(params.year);
  await requireAnnualYear(db, year);
  const plan = await findPlan(db, id.base, year);
  if (
    !plan ||
    (id.variant !== null && !(await variantExists(db, plan, id.full)))
  )
    throw new ReadError({ code: "plan_not_found", plan_id: id.full, year });
  await guardCatalogPlans([id.full], year);
  const csrVariant = v.csrVariant(params.csr_variant);
  v.checkVariant(id.base, csrVariant, id.variant);
  const view = await planView(db, plan, {
    csrVariant,
    requestedVariant: id.variant,
    allBenefits: true,
  });
  return annotateCatalogPlan(
    {
      ...view,
      requested_variant_id: id.variant === null ? null : id.full,
      variant_cost_sharing_resolved:
        view.cost_sharing.status === "available" &&
        view.cost_sharing.benefits_status === "available",
      benefits_status: view.cost_sharing.benefits_status,
      benefits: view.cost_sharing.benefits,
    },
    id.full,
    year,
  );
}

export async function estimatePremiums(db: SqlSession, body: unknown) {
  const request = v.premiumRequest(body),
    plans = [];
  await requireAnnualYear(db, request.year);
  const found = await findPlans(
    db,
    request.ids.map((id) => id.base),
    request.year,
  );
  const exists = await requestedPlansExist(
    db,
    request.ids.map((id, index) => ({ ...id, plan: found[index] })),
  );
  for (const [index, id] of request.ids.entries()) {
    const plan = found[index];
    if (!plan || !exists[index])
      throw new ReadError({
        code: "plan_not_found",
        plan_id: id.full,
        year: request.year,
      });
    plans.push({ id, plan });
  }
  await guardCatalogPlans(
    request.ids.map((id) => id.full),
    request.year,
  );
  const location = await resolveLocation(db, request.location);
  const reads = requestReads(db);
  reads.plan(plans.map(({ plan }) => plan));
  const subsidy = await householdSubsidy(db, request, location, reads);
  const estimates = [];
  for (const { id, plan } of plans)
    estimates.push(
      await annotateCatalogPlan(
        withSubsidy(
          await estimatePremium(db, plan, id.full, request, location, reads),
          subsidy,
          plan,
        ),
        id.full,
        request.year,
      ),
    );
  return withCatalogPolicyContext({ estimates });
}

export async function benchmarkSilver(
  db: SqlSession,
  params: Record<string, string>,
) {
  const request = v.benchmarkRequest(params);
  await requireAnnualYear(db, request.year);
  return benchmark(db, request, await resolveLocation(db, request.location));
}

export async function listCarriersNetworks(
  db: SqlSession,
  kind: "carriers" | "networks",
  params: Record<string, string>,
) {
  if (catalogPolicyActive())
    throw new ReadError({ code: "msot_operation_unsupported" });
  const state = v.state(params.state),
    year = params.year === undefined ? null : v.year(params.year);
  if (year !== null) await requireAnnualYear(db, year);
  const rows = await annualRows(
    db,
    await directoryRows(db, kind, state, year),
    (row) => Number(row.plan_year),
  );
  return {
    status: rows.length ? "available" : "unknown",
    ...(rows.length ? {} : { reason: "catalog_not_loaded" }),
    [kind]: rows,
  } as { status: string; reason?: string } & Record<typeof kind, typeof rows>;
}
