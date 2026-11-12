import {
  exchangeAttributeRows,
  dentalBenchmarkRates,
  federalCatalog,
  childDentalBenefits,
  enrollmentAttributes,
} from "../api/repository.js";
import { stateCatalog } from "../ingest/state/catalog.js";
import type { SqlSession } from "../db/database.js";
import { ageOnDate, parseRateRow } from "../domain/rating/index.js";
import { checkedCents } from "../domain/rating/rate-row.js";
import {
  allocatePremium,
  estimateAptc,
  netPremium,
  pediatricDentalBenchmark,
  slcsp,
} from "../domain/subsidy/index.js";
import type {
  DentalCandidate,
  SlcspCandidate,
  SlcspHousehold,
} from "../domain/subsidy/index.js";
import { QUOTE_METADATA } from "../domain/subsidy/aptc.js";
import { ratingRule } from "../ingest/rating-rules/index.js";
import type { Plan, resolveLocation } from "../api/repository.js";
import {
  countyPlans,
  countyState,
  snapshots,
  zipEligible,
} from "../api/repository.js";
import { plansForCounty } from "../ingest/puf/import-repository.js";
import { ratePremium } from "./premiums.js";
import { agreedField, familyOffer } from "./coverage-family.js";
import type { estimatePremium } from "./premiums.js";
import type { premiumRequest } from "../api/validation.js";

type Request = ReturnType<typeof premiumRequest>;
type Location = Awaited<ReturnType<typeof resolveLocation>>;

const CHILD_DENTAL_BENEFITS = [
  "Dental Check-Up for Children",
  "Basic Dental Care - Child",
  "Major Dental Care - Child",
  "Orthodontia - Child",
];
function attributes(
  db: SqlSession,
  plan: Pick<Plan, "snapshot_id" | "base_plan_id">,
) {
  return exchangeAttributeRows(db, plan.snapshot_id, plan.base_plan_id);
}
async function dentalOffers(
  db: SqlSession,
  request: Request,
  location: Location,
  household: SlcspHousehold,
  area: string,
) {
  const plans = (
    await plansForCounty(db, location.county!, request.year, "Individual")
  ).filter(
    (p) => p.dental_only && p.on_exchange && zipEligible(p, location.zip),
  );
  const childAgeBands = [
    ...new Set(
      household.members
        .map((m) => m.age ?? ageOnDate(m.dateOfBirth!, request.coverage))
        .filter((age) => age < 19)
        .map((age) => (age < 15 ? "0-14" : String(age))),
    ),
  ];
  const candidates: DentalCandidate[] = [];
  const evidence = [];
  for (const plan of plans) {
    const attr = await attributes(db, plan);
    // Child-only SADPs can supply self-only policies for the children under (f)(5)(ii).
    const eligible = familyOffer(attr.rows, false, true);
    if (eligible === false) continue;
    if (eligible === null)
      return {
        monthlyCents: null,
        planIds: [],
        offers: [],
        issues: [`${plan.base_plan_id}: dental_coverage_eligibility_unknown`],
        evidence,
      };
    const files = await snapshots(db, plan);
    const rates = await dentalBenchmarkRates(
      db,
      files.rate,
      plan.base_plan_id,
      area,
      childAgeBands,
    );
    candidates.push({
      planId: plan.base_plan_id,
      pediatricEhbFraction: agreedField(
        attr.rows,
        "EHBPediatricDentalApportionmentQuantity",
      ),
      rows: rates.rows.map((r) =>
        parseRateRow(r.raw, {
          snapshotId: r.snapshot_id,
          sourceFile: "rate",
          sourceRowNumber: r.source_row,
        }),
      ),
    });
    evidence.push({
      plan_id: plan.base_plan_id,
      ehb_fraction: agreedField(
        attr.rows,
        "EHBPediatricDentalApportionmentQuantity",
      ),
      attribute_rows: attr.rows.map((r) => ({
        snapshot_id: plan.snapshot_id,
        source_row: r.source_row,
      })),
      rate_rows: rates.rows.map((r) => ({
        snapshot_id: r.snapshot_id,
        source_row: r.source_row,
      })),
    });
  }
  return { ...pediatricDentalBenchmark(candidates, household, area), evidence };
}

/** Single-location/policy benchmark: EHB allocation and pediatric dental before silver ranking. */
export async function benchmark(
  db: SqlSession,
  request: Request,
  location: Location,
) {
  const empty = {
    ...QUOTE_METADATA,
    year: request.year,
    coverage_start: request.coverage,
    location,
    rating_area_id: null as string | null,
    slcsp_monthly_cents: null,
    benchmark_plan_ids: [] as readonly string[],
    silver_plan_count: 0,
    lowest_silver_plans: [] as {
      plan_id: string;
      gross_monthly_cents: number;
      ehb_monthly_cents: number;
      benchmark_monthly_cents: number;
      pediatric_dental_adjustment_cents: number;
      ehb_fraction: string;
      provenance: unknown;
    }[],
    issues: [] as readonly string[],
    pediatric_dental: null as Awaited<ReturnType<typeof dentalOffers>> | null,
  };
  if (location.status !== "available" || !location.county)
    return { ...empty, status: location.status };
  const state = countyState(location.county);
  if (
    (state === "NY" || state === "VT") &&
    (await stateCatalog(db, request.year, state)).length
  ) {
    return {
      ...empty,
      quote_method: "state_filed_tier" as const,
      status: "requires_state_rules",
      issues: ["NY_Essential_Plan_or_VT_state_subsidies_require_state_rules"],
    };
  }
  const rule = state
    ? await ratingRule(db, state, request.year, "Individual")
    : null;
  if (rule?.method !== "per_member")
    return { ...empty, status: "unsupported_rating_method" };
  const catalog = await federalCatalog(db, state, request.year);
  if (!catalog.rows.length)
    return { ...empty, status: "unknown", issues: ["catalog_not_loaded"] };
  const silver = (plan: { on_exchange: boolean; metal: string }) =>
    plan.on_exchange && plan.metal.toLowerCase() === "silver";
  // Without a ZIP, a silver plan that serves only part of the county may or may not
  // be offered to the household, so neither benchmark nor credit is known.
  if (
    !location.zip &&
    (
      await plansForCounty(db, location.county, request.year, "Individual")
    ).some((p) => !p.dental_only && silver(p) && p.zip_restricted)
  )
    return {
      ...empty,
      status: "location_requires_zip",
      issues: ["zip_limited_service_area"],
    };
  const offered = (
    await countyPlans(db, location.county, request.year, location.zip)
  ).filter(silver);
  if (!offered.length) return { ...empty, status: "no_silver_plans" };
  const household: SlcspHousehold = {
    coverageStartDate: request.coverage,
    ratingMethod: "per_member",
    benchmarkScope: "single_location_single_policy",
    members: request.members.map((m) => ({ ...m, tobaccoUse: false })),
  };
  const ages = household.members.map(
    (m) => m.age ?? ageOnDate(m.dateOfBirth!, request.coverage),
  );
  const hasPediatricMember = ages.some((age) => age < 19);
  let dental: Awaited<ReturnType<typeof dentalOffers>> | null = null;
  const candidates: SlcspCandidate[] = [],
    ranked: typeof empty.lowest_silver_plans = [];
  for (const plan of offered) {
    const attr = await attributes(db, plan);
    const eligible = familyOffer(
      attr.rows,
      ages.some((age) => age >= 21),
      ages.some((age) => age < 21),
    );
    if (eligible === false) continue;
    if (eligible === null)
      return {
        ...empty,
        status: "incomplete_benchmark",
        issues: [`${plan.base_plan_id}: coverage_family_eligibility_unknown`],
      };
    const rated = await ratePremium(
      db,
      plan,
      plan.base_plan_id,
      { ...request, members: [...household.members] },
      location,
    );
    const premium = rated.householdPremium;
    if (!premium || premium.status !== "rated")
      return {
        ...empty,
        status:
          rated.estimate.status === "unsupported_rating_method"
            ? "unsupported_rating_method"
            : "incomplete_benchmark",
        issues: [`${plan.base_plan_id}: ${rated.estimate.status}`],
      };
    const fractionText = agreedField(attr.rows, "EHBPercentTotalPremium");
    const ehbCents = allocatePremium(premium.totalCents, fractionText);
    if (ehbCents === null)
      return {
        ...empty,
        status: "requires_benchmark_adjustments",
        issues: [`${plan.base_plan_id}: ehb_allocation_unknown`],
      };
    let dentalAdjustment = 0;
    let dentalBenefitRows: unknown[] = [];
    if (hasPediatricMember) {
      const files = await snapshots(db, plan);
      const benefits = await childDentalBenefits(
        db,
        files["benefits-and-cost-sharing"],
        plan.base_plan_id,
        CHILD_DENTAL_BENEFITS,
      );
      dentalBenefitRows = benefits.rows.map((b) => ({
        snapshot_id: files["benefits-and-cost-sharing"],
        source_row: b.source_row,
        benefit_name: b.benefit_name,
        is_ehb: b.raw.IsEHB,
        is_covered: b.raw.IsCovered,
      }));
      const states = CHILD_DENTAL_BENEFITS.map((name) => {
        const rows = benefits.rows.filter((b) => b.benefit_name === name);
        if (!rows.length || rows.some((b) => b.raw.IsEHB !== "Yes"))
          return "unknown";
        const covered = new Set(rows.map((b) => b.raw.IsCovered));
        return covered.size === 1 ? [...covered][0] : "unknown";
      });
      if (states.every((s) => s === "Not Covered")) {
        dental ??= await dentalOffers(
          db,
          request,
          location,
          household,
          premium.ratingAreaId,
        );
        if (dental.monthlyCents === null)
          return {
            ...empty,
            status: "requires_benchmark_adjustments",
            issues: dental.issues,
            pediatric_dental: dental,
          };
        dentalAdjustment = dental.monthlyCents;
      } else if (!states.every((s) => s === "Covered")) {
        return {
          ...empty,
          status: "requires_benchmark_adjustments",
          issues: [
            `${plan.base_plan_id}: pediatric_dental_EHB_coverage_missing_or_conflicting`,
          ],
        };
      }
    }
    // 26 CFR 1.36B-3(f)(3), (9) Example 3: add dental to each option BEFORE ranking.
    const benchmarkCents = checkedCents(ehbCents + dentalAdjustment);
    const ehbPremium = { ...premium, totalCents: benchmarkCents };
    candidates.push({
      planId: plan.base_plan_id,
      metalLevel: plan.metal,
      onExchange: plan.on_exchange,
      availableToHousehold: true,
      benchmarkBasis: "ehb_only_no_dental_adjustment_required",
      premium: ehbPremium,
    });
    if (premium.status === "rated")
      ranked.push({
        plan_id: plan.base_plan_id,
        gross_monthly_cents: premium.totalCents,
        ehb_monthly_cents: ehbCents,
        benchmark_monthly_cents: benchmarkCents,
        pediatric_dental_adjustment_cents: dentalAdjustment,
        ehb_fraction: fractionText!,
        provenance: {
          ...rated.estimate.provenance,
          pediatric_dental_benefit_rows: dentalBenefitRows,
          rating_area_id: premium.ratingAreaId,
          rate_rows_used: rated.estimate.rate_rows_used,
          ehb_attribute_rows: attr.rows.map((r) => ({
            snapshot_id: plan.snapshot_id,
            source_row: r.source_row,
          })),
        },
      });
  }
  const result = slcsp(candidates, household);
  ranked.sort(
    (a, b) =>
      a.benchmark_monthly_cents - b.benchmark_monthly_cents ||
      a.plan_id.localeCompare(b.plan_id),
  );
  return {
    ...empty,
    status: result.status,
    rating_area_id:
      result.status === "calculated"
        ? candidates[0]!.premium.ratingAreaId
        : null,
    slcsp_monthly_cents: result.slcspMonthlyCents,
    benchmark_plan_ids: result.planIds,
    silver_plan_count: result.uniquePlanCount,
    issues: result.issues,
    pediatric_dental: dental,
    lowest_silver_plans:
      result.status === "calculated" ? ranked.slice(0, 2) : [],
  };
}

export async function householdSubsidy(
  db: SqlSession,
  request: Request,
  location: Location,
) {
  if (!request.subsidy) return undefined;
  const input = {
    householdIncome: request.subsidy.income,
    householdSize: request.subsidy.size,
    state: location.county ? (countyState(location.county) ?? "") : "",
    year: request.year,
  };
  // Check parameter availability without substituting a numeric zero benchmark in the response.
  const enrollmentEhbFractions: Record<string, string | null> = {};
  // Facade searches use a placeholder requested ID and then quote the entire county catalog.
  const offeredIds = location.county
    ? (await countyPlans(db, location.county, request.year, location.zip)).map(
        (p) => p.base_plan_id,
      )
    : [];
  const ids = [
    ...new Set([...request.ids.map((id) => id.base), ...offeredIds]),
  ];
  const rows = await enrollmentAttributes(db, request.year, ids);
  for (const base of ids)
    enrollmentEhbFractions[base] =
      agreedField(
        rows.rows.filter((r) => r.base_plan_id === base),
        "EHBPercentTotalPremium",
      ) ?? null;
  const policy = estimateAptc({ ...input, slcspMonthlyCents: 0 });
  const b = await benchmark(db, request, location);
  const empty = {
    ...QUOTE_METADATA,
    quote_method: b.quote_method,
    enrollment_ehb_fractions: enrollmentEhbFractions,
    status: b.status,
    reason:
      b.status === "location_requires_zip"
        ? "zip_limited_service_area"
        : b.status,
    slcsp_monthly_cents: b.slcsp_monthly_cents,
    benchmark: b,
    rounding_policy: "form_8962_lines_8a_8b_whole_dollars" as const,
    estimated_monthly_tax_credit_cents: null as number | null,
    fpl_percent: null as number | null,
    applicable_percentage: null as number | null,
    expected_contribution_monthly_cents: null as number | null,
    expected_contribution_annual_cents: null as number | null,
  };
  if (policy.status === "parameters_unconfirmed")
    return { ...empty, status: policy.status, reason: policy.reason };
  if (b.status !== "calculated" || b.slcsp_monthly_cents === null) return empty;
  if (
    !request.subsidy.taxFiling ||
    ["married_filing_separately", "not_filing"].includes(
      request.subsidy.taxFiling,
    )
  ) {
    return {
      ...empty,
      status: "requires_tax_filing_review",
      reason: "tax_filing_eligibility_unresolved",
    };
  }
  if (request.subsidy.size < request.members.length)
    return {
      ...empty,
      status: "requires_tax_filing_review",
      reason: "coverage_family_exceeds_tax_family",
    };
  const result = estimateAptc({
    ...input,
    slcspMonthlyCents: b.slcsp_monthly_cents,
  });
  return {
    ...empty,
    status:
      result.status === "above_income_cliff"
        ? "over_income_limit"
        : result.status,
    reason: result.reason,
    estimated_monthly_tax_credit_cents: result.estimatedMonthlyCreditCents,
    fpl_percent: result.fplPercent,
    applicable_percentage: result.applicablePercentage,
    expected_contribution_monthly_cents: result.expectedContributionCents,
    expected_contribution_annual_cents: result.annualExpectedContributionCents,
  };
}

/** Keep gross rating status intact. The separate subsidy object carries its own status and trace. */
export function withSubsidy(
  quote: Awaited<ReturnType<typeof estimatePremium>>,
  subsidy: Awaited<ReturnType<typeof householdSubsidy>>,
  plan: Pick<Plan, "on_exchange" | "metal">,
) {
  if (!subsidy) return quote;
  const eligiblePlan =
    plan.on_exchange && plan.metal.toLowerCase() !== "catastrophic";
  const eligiblePremium =
    "total_cents" in quote &&
    typeof quote.total_cents === "number" &&
    quote.base_plan_id !== null
      ? allocatePremium(
          quote.total_cents,
          subsidy.enrollment_ehb_fractions[quote.base_plan_id],
        )
      : null;
  const price =
    eligiblePlan &&
    eligiblePremium !== null &&
    quote.status === "rated" &&
    "total_cents" in quote &&
    typeof quote.total_cents === "number" &&
    subsidy.estimated_monthly_tax_credit_cents !== null
      ? netPremium(
          quote.total_cents,
          subsidy.estimated_monthly_tax_credit_cents,
          eligiblePremium!,
        )
      : null;
  let status;
  if (subsidy.status === "requires_state_rules") {
    status = subsidy.status;
  } else if (!eligiblePlan) {
    status = "plan_ineligible_for_tax_credit";
  } else if (quote.status === "rated" && eligiblePremium === null) {
    status = "requires_premium_adjustments";
  } else if (
    quote.status === "rated" ||
    subsidy.estimated_monthly_tax_credit_cents === null
  ) {
    status = subsidy.status;
  } else if (quote.status === "unsupported_rating_method") {
    status = quote.status;
  } else {
    status = `premium_${quote.status}`;
  }
  const { enrollment_ehb_fractions: _fractions, ...trace } = subsidy;
  return {
    ...QUOTE_METADATA,
    ...quote,
    csr_eligibility_status: "not_evaluated" as const,
    slcsp_monthly_cents: subsidy.slcsp_monthly_cents,
    estimated_monthly_tax_credit_cents:
      price?.estimatedMonthlyCreditCents ?? null,
    estimated_net_monthly_cents: price?.estimatedNetMonthlyPremiumCents ?? null,
    subsidy_status: status,
    subsidy: {
      ...trace,
      status,
      enrollment_ehb_monthly_cents: eligiblePremium,
    },
  };
}
