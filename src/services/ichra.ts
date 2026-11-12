import {
  countyPlans,
  countyState,
  exchangeAttributeRows,
  federalCatalog,
  resolveLocation,
} from "../api/repository.js";
import type { Plan } from "../api/repository.js";
import type { LocationInput, premiumRequest } from "../api/validation.js";
import type { SqlSession } from "../db/database.js";
import {
  affordabilityVerdict,
  applicableAge,
  guidelineInEffect,
  ichraParameters,
  isCalendarYearPlan,
  lcspLocationSource,
  lookBackMonth,
  lowestAgeBandLcsp,
  monthlyHraAmount,
  onePersonPovertyLine,
  requiredHraContribution,
} from "../domain/ichra/index.js";
import type {
  CentsRatio,
  IchraParameters,
  IncomeMeasure,
  PremiumBasis,
  RuleId,
  SafeHarborChoices,
  Verdict,
} from "../domain/ichra/index.js";
import {
  catalogRule,
  nyLcspCatalog,
  vtLcspCatalog,
  nyRatingCounties,
  refusedTemplatePlans,
  stateRatingArea,
  stateSourceCell,
} from "../ingest/state/catalog.js";
import type { RefusedTemplatePlan } from "../ingest/state/catalog.js";
import { vtMetalCatalogComplete } from "../ingest/state/vt-metal.js";
import { checkedCents, dateParts } from "../domain/rating/rate-row.js";
import { allocatePremium, lowestCostSilver } from "../domain/subsidy/index.js";
import type {
  SlcspCandidate,
  SlcspHousehold,
} from "../domain/subsidy/index.js";
import { plansForCounty } from "../ingest/puf/import-repository.js";
import { ratingRule } from "../ingest/rating-rules/index.js";
import { agreedField, familyOffer } from "./coverage-family.js";
import { ratePremium } from "./premiums.js";

export interface IchraRequest {
  readonly planStart: string;
  readonly monthsAvailable: number;
  readonly dateOfBirth: string;
  readonly eligibleFrom: string | null;
  readonly residence: LocationInput;
  readonly worksite: (LocationInput & { readonly remote: boolean }) | null;
  /** Self-only amount, or the one amount an HRA offers for every tier (1.36B-2(c)(5)(ii)(B)). */
  readonly hraAnnualCents: number;
  readonly income: readonly IncomeMeasure[];
  readonly safeHarbors: Omit<SafeHarborChoices, "lowestAgeBand">;
  readonly lcspPremiumBasis: PremiumBasis | null;
  /**
   * Calendar-month counts for a partial-year W-2 offer, 26 CFR 54.4980H-5(e)(2)(ii)(B). Absent:
   * the W-2 verdict is computed for a full calendar plan year only.
   */
  readonly w2PartialYear?: {
    readonly monthsOffered: number;
    readonly monthsEmployed: number;
  } | null;
}

/**
 * When the month counts settle the W-2 safe harbor. The domain test assumes one monthly
 * contribution for every offered month, which holds only when the offered months are the months
 * the HRA is available in a calendar plan year. Anything else stays unknown with a reason.
 */
export function w2PartialYearContext(
  request: Pick<
    IchraRequest,
    "planStart" | "monthsAvailable" | "w2PartialYear"
  >,
) {
  const counts = request.w2PartialYear;
  if (!counts) return {};
  if (!isCalendarYearPlan(request.planStart))
    return { w2Unavailable: "w2_non_calendar_plan_year_not_supported" };
  if (counts.monthsOffered !== request.monthsAvailable)
    return { w2Unavailable: "w2_months_offered_differs_from_months_available" };
  return { w2PartialYear: counts };
}

const BASES: readonly PremiumBasis[] = ["gross", "ehb_portion"];
const QUOTE = {
  quote_method: "puf_calculation",
  bindable_quote: false,
} as const;

type LcspStatus =
  | "calculated"
  | "unknown"
  | "requires_state_rules"
  | "unsupported_state"
  | "unsupported_rating_method"
  | "location_requires_zip"
  | "incomplete_lcsp"
  | "ambiguous_lcsp"
  | "no_silver_plans";
interface BasisPick {
  readonly status: string;
  readonly plan_ids: readonly string[];
  /** null when tied plans at the lowest age band differ in price at the applicable age. */
  readonly monthly_cents: number | null;
  readonly prices_at_age: readonly number[];
  readonly issues: readonly string[];
}
interface LcspEvidence {
  readonly status: LcspStatus;
  readonly reason: string | null;
  readonly basis_used: PremiumBasis;
  readonly plan_ids: readonly string[];
  readonly monthly_cents: number | null;
  readonly by_basis: Readonly<Record<PremiumBasis, BasisPick | null>>;
  readonly location: {
    readonly source: "residence" | "worksite";
    readonly county_fips: string | null;
    readonly zip: string | null;
    readonly rating_area_id: string | null;
  };
  readonly coverage_month: string;
  readonly identified_at_age: number | null;
  readonly priced_at_age: number | null;
  readonly age_rating?: "none";
  readonly silver_plan_count: number;
  readonly provenance: Record<string, unknown> | null;
  readonly issues: readonly string[];
}
interface LcspQuestion {
  readonly source: "residence" | "worksite";
  readonly location: LocationInput;
  readonly month: string;
  readonly age: number;
  readonly identificationAge: number;
  readonly lookBack: boolean;
  readonly basis: PremiumBasis;
}

function member(age: number) {
  return {
    id: "0",
    age,
    relationship: "subscriber" as const,
    tobaccoUse: false,
  };
}
function employeeHousehold(age: number, month: string): SlcspHousehold {
  return {
    coverageStartDate: month,
    ratingMethod: "per_member",
    benchmarkScope: "single_location_single_policy",
    members: [member(age)],
  };
}
function ratingRequest(
  location: LocationInput,
  month: string,
  age: number,
): ReturnType<typeof premiumRequest> {
  return {
    ids: [],
    csrVariant: undefined,
    coverage: month,
    year: dateParts(month).year,
    members: [member(age)],
    subsidy: undefined,
    location,
  };
}

/** One rated candidate per basis and age. The EHB basis is null when the fraction is unknown. */
interface Rated {
  readonly gross: SlcspCandidate;
  readonly ehb: SlcspCandidate | null;
  readonly provenance: Record<string, unknown>;
}
type RateOutcome =
  Rated | { readonly status: LcspStatus; readonly reason: string };

async function rateCandidate(
  db: SqlSession,
  plan: Plan,
  attributes: Awaited<ReturnType<typeof exchangeAttributeRows>>["rows"],
  location: Awaited<ReturnType<typeof resolveLocation>>,
  question: LcspQuestion,
  age: number,
): Promise<RateOutcome> {
  const rated = await ratePremium(
    db,
    plan,
    plan.base_plan_id,
    ratingRequest(question.location, question.month, age),
    location,
  );
  const premium = rated.householdPremium;
  if (!premium || premium.status !== "rated") {
    const reason = String(
      "reason" in rated.estimate
        ? rated.estimate.reason
        : rated.estimate.status,
    );
    if (rated.estimate.status === "unsupported_rating_method")
      return { status: "unsupported_rating_method", reason };
    if (reason === "UNRESOLVED_RATING_AREA" && !question.location.zip)
      return {
        status: "location_requires_zip",
        reason: "rating_area_needs_zip",
      };
    return {
      status:
        dateParts(question.month).month === 1 ? "incomplete_lcsp" : "unknown",
      reason:
        dateParts(question.month).month !== 1 &&
        rated.estimate.status === "missing"
          ? "month_rate_rows_missing"
          : `${plan.base_plan_id}: ${reason}`,
    };
  }
  const fraction = agreedField(attributes, "EHBPercentTotalPremium");
  const ehbCents = allocatePremium(premium.totalCents, fraction);
  const candidate = (totalCents: number): SlcspCandidate => ({
    planId: plan.base_plan_id,
    metalLevel: plan.metal,
    onExchange: plan.on_exchange,
    availableToHousehold: true,
    benchmarkBasis: "lcsp_self_only_premium",
    premium: { ...premium, totalCents: checkedCents(totalCents) },
  });
  return {
    gross: candidate(premium.totalCents),
    ehb: ehbCents === null ? null : candidate(ehbCents),
    provenance: {
      plan_id: plan.base_plan_id,
      gross_monthly_cents: premium.totalCents,
      ehb_monthly_cents: ehbCents,
      ehb_fraction: fraction ?? null,
      rate_snapshot_id:
        (rated.estimate.provenance.snapshot_ids as { rate?: string }).rate ??
        null,
      rate_rows_used: rated.estimate.rate_rows_used,
      ...(dateParts(question.month).month !== 1 &&
      premium.rowsUsed.every(
        (row) => row.effectiveDate === `${plan.plan_year}-01-01`,
      )
        ? {
            rate_basis: {
              basis: "calendar_year_individual_rate",
              coverage_month: question.month,
              note: "The January 1 individual-market rate row is used for this coverage month within its filed effective and expiration dates.",
              citation: {
                source: "CMS Rate PUF",
                fields: ["RateEffectiveDate", "RateExpirationDate"],
                dates: premium.rowsUsed.map((row) => ({
                  effective_date: row.effectiveDate,
                  expiration_date: row.expirationDate,
                })),
              },
            },
          }
        : {}),
      ehb_attribute_rows: attributes.map((r) => ({
        snapshot_id: plan.snapshot_id,
        source_row: r.source_row,
      })),
    },
  };
}

function pick(
  atAge: readonly SlcspCandidate[],
  atBand: readonly SlcspCandidate[],
  question: LcspQuestion,
): BasisPick {
  const household = employeeHousehold(question.age, question.month);
  if (question.identificationAge === question.age) {
    const result = lowestCostSilver(atAge, household);
    return {
      status: result.status,
      plan_ids: result.planIds,
      monthly_cents: result.lcspMonthlyCents,
      prices_at_age:
        result.lcspMonthlyCents === null ? [] : [result.lcspMonthlyCents],
      issues: result.issues,
    };
  }
  const result = lowestAgeBandLcsp(
    atBand,
    employeeHousehold(question.identificationAge, question.month),
    atAge,
    household,
  );
  return {
    status: result.status,
    plan_ids: result.planIds,
    monthly_cents: result.lcspMonthlyCents,
    prices_at_age: result.pricesAtAge,
    issues: result.issues,
  };
}

/** Evidence for one lowest cost silver plan question; never falls back to another year or place. */
async function lcspEvidence(
  db: SqlSession,
  question: LcspQuestion,
): Promise<LcspEvidence> {
  const base = {
    reason: null as string | null,
    basis_used: question.basis,
    plan_ids: [] as readonly string[],
    monthly_cents: null as number | null,
    by_basis: { gross: null, ehb_portion: null } as LcspEvidence["by_basis"],
    location: {
      source: question.source,
      county_fips: question.location.county ?? null,
      zip: question.location.zip ?? null,
      rating_area_id: null as string | null,
    },
    coverage_month: question.month,
    identified_at_age: question.identificationAge,
    priced_at_age: question.age,
    silver_plan_count: 0,
    provenance: null,
    issues: [] as readonly string[],
  };
  const refuse = (
    status: LcspStatus,
    reason: string | null = null,
  ): LcspEvidence => ({ status, ...base, reason });
  const location = await resolveLocation(db, question.location);
  if (location.status === "ambiguous")
    return refuse("unknown", "location_ambiguous");
  if (location.status !== "available" || !location.county)
    return refuse("unknown", "location_unknown");
  const county = location.county;
  base.location.county_fips = county;
  const state = countyState(county);
  if (!state) return refuse("unsupported_state");
  if (state === "NY" || state === "VT")
    return filedLcspEvidence(db, question, base, county, state);
  const year = dateParts(question.month).year;
  if (!(await federalCatalog(db, state, year)).rows.length)
    return refuse(
      "unknown",
      question.lookBack ? "lookback_catalog_not_loaded" : "catalog_not_loaded",
    );
  const rule = await ratingRule(db, state, year, "Individual");
  if (rule?.method !== "per_member") return refuse("unsupported_rating_method");
  // Preserve January request behavior; annual-row use is approved for months after January.
  if (
    dateParts(question.month).month === 1 &&
    dateParts(question.month).day !== 1
  )
    return refuse("unknown", "month_rate_rows_missing");
  const silver = (plan: { on_exchange: boolean; metal: string }) =>
    plan.on_exchange && plan.metal.toLowerCase() === "silver";
  const offered = (await countyPlans(db, county, year, location.zip)).filter(
    silver,
  );
  if (!location.zip) {
    // A ZIP-limited silver plan may or may not be offered; sub-county rating areas need a ZIP too.
    const zipLimited = (
      await plansForCounty(db, county, year, "Individual")
    ).some((p) => !p.dental_only && silver(p) && p.zip_restricted);
    const subCounty = offered.some(
      (p) =>
        (p.premium_availability as { reason?: string } | undefined)?.reason ===
        "UNRESOLVED_RATING_AREA",
    );
    if (zipLimited || subCounty)
      return refuse(
        "location_requires_zip",
        zipLimited ? "zip_limited_service_area" : "sub_county_rating_area",
      );
  }
  if (!offered.length) return refuse("no_silver_plans");
  const atAge: Rated[] = [],
    atBand: Rated[] = [];
  for (const plan of offered) {
    const attributes = (
      await exchangeAttributeRows(db, plan.snapshot_id, plan.base_plan_id)
    ).rows;
    const eligible = familyOffer(
      attributes,
      question.age >= 21,
      question.age < 21,
    );
    if (eligible === false) continue;
    if (eligible === null)
      return refuse(
        "incomplete_lcsp",
        `${plan.base_plan_id}: coverage_family_eligibility_unknown`,
      );
    const priced = await rateCandidate(
      db,
      plan,
      attributes,
      location,
      question,
      question.age,
    );
    if ("status" in priced) return refuse(priced.status, priced.reason);
    atAge.push(priced);
    if (question.identificationAge !== question.age) {
      const band = await rateCandidate(
        db,
        plan,
        attributes,
        location,
        question,
        question.identificationAge,
      );
      if ("status" in band) return refuse(band.status, band.reason);
      atBand.push(band);
    }
  }
  if (!atAge.length) return refuse("no_silver_plans");
  const gross = pick(
    atAge.map((r) => r.gross),
    atBand.map((r) => r.gross),
    question,
  );
  const ehbComplete = atAge.every((r) => r.ehb) && atBand.every((r) => r.ehb);
  const ehb: BasisPick = ehbComplete
    ? pick(
        atAge.map((r) => r.ehb!),
        atBand.map((r) => r.ehb!),
        question,
      )
    : {
        status: "requires_premium_adjustments",
        plan_ids: [],
        monthly_cents: null,
        prices_at_age: [],
        issues: atAge
          .filter((r) => !r.ehb)
          .map(
            (r) => `${String(r.provenance.plan_id)}: ehb_allocation_unknown`,
          ),
      };
  const byBasis = { gross, ehb_portion: ehb };
  const used = byBasis[question.basis];
  const status = (
    used.status === "calculated" ? "calculated" : used.status
  ) as LcspStatus;
  const chosen = new Set(used.plan_ids);
  return {
    status,
    ...base,
    reason: status === "calculated" ? null : (used.issues[0] ?? null),
    plan_ids: used.plan_ids,
    monthly_cents: used.monthly_cents,
    by_basis: byBasis,
    location: {
      ...base.location,
      rating_area_id: atAge[0]!.gross.premium.ratingAreaId,
    },
    silver_plan_count: atAge.length,
    provenance: {
      rate_rows_by_plan: atAge
        .filter((r) => chosen.has(String(r.provenance.plan_id)))
        .map((r) => r.provenance),
    },
    issues: [
      ...used.issues,
      ...(question.basis === "gross" ? ehb.issues : gross.issues),
    ],
  };
}

const FILED_METALS = [
  "bronze",
  "expanded bronze",
  "silver",
  "gold",
  "platinum",
  "catastrophic",
];
/** Only one consistent, recognized non-silver CMS metal rules a refused plan out. */
const couldRankSilver = ({ metals }: RefusedTemplatePlan) =>
  !(
    metals.length === 1 &&
    FILED_METALS.includes(metals[0]!) &&
    metals[0] !== "silver"
  );

/** Filed single-tier prices have no age or tobacco factors. */
async function filedLcspEvidence(
  db: SqlSession,
  question: LcspQuestion,
  base: Omit<LcspEvidence, "status">,
  county: string,
  state: "NY" | "VT",
): Promise<LcspEvidence> {
  const year = dateParts(question.month).year;
  const area = stateRatingArea(state, year, county);
  const evidence = {
    ...base,
    identified_at_age: null,
    priced_at_age: null,
    age_rating: "none" as const,
    location: {
      ...base.location,
      rating_area_id: area?.rating_area_id ?? null,
    },
  };
  const catalog =
    state === "NY"
      ? await nyLcspCatalog(db, year, area?.rating_area_id)
      : await vtLcspCatalog(db, year, area?.rating_area_id);
  const provenance = {
    geography: area,
    plans: catalog.map(
      ({ row, exchange_evidence, attributes, filed_identity }) => ({
        plan_key: row.plan_key,
        hios_id: row.hios_id ?? row.raw_record.plan_id,
        single: stateSourceCell(row, "single"),
        state_rule: catalogRule(row),
        exchange_evidence,
        ...(filed_identity ? { filed_identity } : {}),
        attribute_rows: attributes.map((a) => ({
          source_row: a.source_row,
          metal: a.metal,
          child_only_offering: a.raw.ChildOnlyOffering ?? null,
          ehb_fraction: a.raw.EHBPercentTotalPremium ?? null,
        })),
      }),
    ),
  };
  const refuse = (status: LcspStatus, reason: string): LcspEvidence => ({
    status,
    ...evidence,
    reason,
    provenance,
  });
  if (!catalog.length || !area)
    return refuse(
      "unknown",
      question.lookBack ? "lookback_catalog_not_loaded" : "catalog_not_loaded",
    );
  if (
    dateParts(question.month).month !== 1 ||
    dateParts(question.month).day !== 1
  )
    return refuse("unknown", "month_rate_rows_missing");
  // A refused issuer template leaves its plans unpriced. If one of them could be the lowest
  // silver here, the benchmark is unknown; it is never computed without that issuer.
  const refused = (
    await refusedTemplatePlans(db, state, year, area.rating_area_id)
  ).filter(couldRankSilver);
  if (refused.length)
    return {
      ...refuse("unknown", refused[0]!.reason),
      issues: refused.map((p) => `${p.plan_id ?? p.issuer}: ${p.reason}`),
      provenance: { ...provenance, refused_templates: refused },
    };
  if (
    state === "VT" &&
    !vtMetalCatalogComplete(catalog.map((entry) => entry.row))
  )
    return refuse("incomplete_lcsp", "metal_level_unknown");
  const candidates: { id: string; gross: number; ehb: number | null }[] = [];
  const keys = new Set<string>();
  for (const entry of catalog) {
    const { row, attributes, exchange_evidence, filed_identity } = entry;
    if (state === "VT") {
      if ("off_exchange" in entry && entry.off_exchange) continue;
      if (!filed_identity)
        return refuse("incomplete_lcsp", "metal_level_unknown");
    }
    if (row.rate.childOnly) continue;
    const metals = new Set(attributes.map((a) => a.metal.trim().toLowerCase()));
    if (filed_identity) metals.add(filed_identity.metal.toLowerCase());
    if (row.raw_record.metal)
      metals.add(row.raw_record.metal.trim().toLowerCase());
    if (metals.size !== 1 || !FILED_METALS.includes([...metals][0] ?? ""))
      return refuse("incomplete_lcsp", "metal_level_unknown");
    if (!metals.has("silver")) continue;
    if (filed_identity?.off_exchange) {
      if (exchange_evidence)
        return refuse("incomplete_lcsp", "exchange_offering_conflict");
      continue;
    }
    if (!exchange_evidence)
      return refuse("incomplete_lcsp", "exchange_offering_unverified");
    const eligible = familyOffer(
      attributes,
      question.age >= 21,
      question.age < 21,
    );
    if (eligible === false) continue;
    if (eligible === null)
      return refuse("incomplete_lcsp", "coverage_family_eligibility_unknown");
    if (!catalogRule(row))
      return refuse("requires_state_rules", "state_filed_tier_pending");
    if (keys.has(row.plan_key))
      return refuse("incomplete_lcsp", "conflicting_filed_tier_rows");
    keys.add(row.plan_key);
    const gross = row.rate.prices.single;
    candidates.push({
      id: row.plan_key,
      gross,
      ehb: allocatePremium(
        gross,
        agreedField(attributes, "EHBPercentTotalPremium"),
      ),
    });
  }
  if (!candidates.length) return refuse("no_silver_plans", "no_silver_plans");
  const byBasis = Object.fromEntries(
    BASES.map((basis) => {
      const prices = candidates.map((c) =>
        basis === "gross" ? c.gross : c.ehb,
      );
      if (prices.some((p) => p === null))
        return [
          basis,
          {
            status: "incomplete_lcsp",
            plan_ids: [],
            monthly_cents: null,
            prices_at_age: [],
            issues: ["ehb_allocation_unknown"],
          },
        ];
      const minimum = Math.min(...(prices as number[]));
      return [
        basis,
        {
          status: "calculated",
          monthly_cents: minimum,
          plan_ids: candidates
            .filter((_, i) => prices[i] === minimum)
            .map((c) => c.id)
            .sort(),
          prices_at_age: [minimum],
          issues: [],
        },
      ];
    }),
  ) as unknown as Record<PremiumBasis, BasisPick>;
  const used = byBasis[question.basis];
  return {
    status: used.status as LcspStatus,
    ...evidence,
    reason: used.issues[0] ?? null,
    by_basis: byBasis,
    plan_ids: used.plan_ids,
    monthly_cents: used.monthly_cents,
    silver_plan_count: candidates.length,
    provenance,
    issues: [...byBasis.gross.issues, ...byBasis.ehb_portion.issues],
  };
}

/** State-wide readiness is conservative when any loaded DFS region is incomplete. */
export async function nyLcspAvailability(db: SqlSession, year: number) {
  return filedLcspAvailability(db, year, nyRatingCounties(year));
}

export async function vtLcspAvailability(db: SqlSession, year: number) {
  return filedLcspAvailability(db, year, year === 2026 ? ["50007"] : []);
}

async function filedLcspAvailability(
  db: SqlSession,
  year: number,
  counties: string[],
) {
  // One county per filed rating area; each area has one common price set.
  let answered = false;
  for (const county of counties) {
    const result = await lcspEvidence(db, {
      source: "residence",
      location: { county },
      month: `${year}-01-01`,
      age: 40,
      identificationAge: 40,
      lookBack: false,
      basis: "gross",
    });
    if (result.reason === "catalog_not_loaded") continue;
    if (result.status !== "calculated")
      return {
        status: ["incomplete_lcsp", "requires_state_rules"].includes(
          result.status,
        )
          ? result.status
          : "unknown",
        reason: result.reason,
      };
    answered = true;
  }
  return answered
    ? { status: "available", reason: null }
    : { status: "unknown", reason: "catalog_not_loaded" };
}

interface VerdictOut {
  readonly measure: IncomeMeasure["measure"];
  readonly purpose: Verdict["purpose"];
  readonly lcsp: "premium_tax_credit" | "employer";
  readonly status: "calculated" | "unknown" | "ambiguous_lcsp";
  readonly reason: string | null;
  readonly required_hra_contribution_cents: CentsRatio | null;
  readonly threshold_cents: CentsRatio | null;
  readonly affordable: boolean | null;
  readonly affordable_by_basis: Readonly<Record<PremiumBasis, boolean | null>>;
  readonly rule_ids: readonly RuleId[];
  readonly fpl_guideline_year?: number;
}

function verdictAt(
  income: IncomeMeasure,
  prices: readonly number[],
  request: IchraRequest,
  context: Parameters<typeof affordabilityVerdict>[2],
) {
  const results = prices.map((cents) => {
    const contribution = requiredHraContribution(
      cents,
      request.hraAnnualCents,
      request.monthsAvailable,
    );
    return {
      contribution,
      verdict: affordabilityVerdict(income, contribution, context),
    };
  });
  const answers = new Set(results.map((r) => r.verdict.affordable));
  return { results, answer: answers.size === 1 ? [...answers][0]! : undefined };
}

function measureVerdict(
  income: IncomeMeasure,
  evidence: LcspEvidence,
  request: IchraRequest,
  context: Parameters<typeof affordabilityVerdict>[2],
  lcsp: VerdictOut["lcsp"],
): VerdictOut {
  const byBasis = Object.fromEntries(
    BASES.map((basis) => {
      const picked = evidence.by_basis[basis];
      if (!picked || picked.status !== "calculated") return [basis, null];
      return [
        basis,
        verdictAt(income, picked.prices_at_age, request, context).answer ??
          null,
      ];
    }),
  ) as Record<PremiumBasis, boolean | null>;
  const used = evidence.by_basis[evidence.basis_used]!;
  const { results, answer } = verdictAt(
    income,
    used.prices_at_age,
    request,
    context,
  );
  const first = results[0]!;
  const ambiguous = answer === undefined;
  return {
    measure: income.measure,
    purpose: first.verdict.purpose,
    lcsp,
    status: ambiguous ? "ambiguous_lcsp" : first.verdict.status,
    reason: ambiguous
      ? "lowest_age_band_tie_verdicts_differ"
      : first.verdict.reason,
    required_hra_contribution_cents:
      results.length === 1 ? first.contribution : null,
    threshold_cents: first.verdict.thresholdCents,
    affordable: ambiguous ? null : answer,
    affordable_by_basis: byBasis,
    rule_ids: first.verdict.ruleIds,
    ...(first.verdict.fplGuidelineYear === undefined
      ? {}
      : { fpl_guideline_year: first.verdict.fplGuidelineYear }),
  };
}

function ruleList(parameters: IchraParameters, ids: Iterable<RuleId>) {
  return [...new Set(ids)].map((id) => {
    const rule = parameters.rules[id];
    return {
      id,
      status: rule.status,
      summary: rule.summary,
      citations: rule.citations,
    };
  });
}

/** Plan or verdict differs between bases; null when the EHB-portion basis could not be computed. */
function basisSensitive(
  evidence: readonly LcspEvidence[],
  verdicts: readonly VerdictOut[],
): boolean | null {
  let plansDiffer = false;
  for (const e of evidence) {
    const { gross, ehb_portion: ehb } = e.by_basis;
    if (gross?.status !== "calculated" || ehb?.status !== "calculated")
      return null;
    if (gross.plan_ids.join() !== ehb.plan_ids.join()) plansDiffer = true;
  }
  if (plansDiffer) return true;
  const pairs = verdicts.map((v) => v.affordable_by_basis);
  if (pairs.some((p) => p.gross === null || p.ehb_portion === null))
    return null;
  return pairs.some((p) => p.gross !== p.ehb_portion);
}

/**
 * ICHRA affordability for one employee and the first month of the plan year. The premium tax
 * credit verdict uses the residence LCSP for that month. Employer verdicts (any non-household
 * measure, or the location/look-back safe harbors) use the applicable LCSP of prop.
 * 54.4980H-5(f)(7)(iii): identified at the lowest age band, priced at the applicable age.
 */
export async function ichraAffordability(
  db: SqlSession,
  request: IchraRequest,
) {
  const year = dateParts(request.planStart).year;
  const lookup = ichraParameters(year);
  const empty = {
    ...QUOTE,
    plan_start: request.planStart,
    lcsp: null,
    employer_lcsp: null,
    verdicts: [],
  };
  if (lookup.status !== "confirmed")
    return {
      ...empty,
      status: "parameters_unconfirmed",
      reason: lookup.reason,
    };
  const parameters = lookup.parameters;
  const basis = request.lcspPremiumBasis ?? parameters.lcspPremiumBasisDefault;
  const age = applicableAge(
    request.dateOfBirth,
    request.planStart,
    request.eligibleFrom,
  );
  const harbors = request.safeHarbors;
  const employerHarbor = harbors.location || harbors.lookBack;
  const needsPtc =
    request.income.some((i) => i.measure === "household") && !employerHarbor;
  const needsEmployer =
    employerHarbor || request.income.some((i) => i.measure !== "household");
  const ptcQuestion: LcspQuestion = {
    source: "residence",
    location: request.residence,
    month: request.planStart,
    age,
    identificationAge: age,
    lookBack: false,
    basis,
  };
  const source = lcspLocationSource(harbors.location, request.worksite);
  const employerQuestion: LcspQuestion = {
    source,
    location: source === "worksite" ? request.worksite! : request.residence,
    month: harbors.lookBack
      ? lookBackMonth(request.planStart)
      : request.planStart,
    age,
    identificationAge: parameters.lowestAgeBandRatingAge,
    lookBack: harbors.lookBack,
    basis,
  };
  const ptc = needsPtc ? await lcspEvidence(db, ptcQuestion) : null;
  const employer = needsEmployer
    ? await lcspEvidence(db, employerQuestion)
    : null;
  const failed = [ptc, employer].find((e) => e && e.status !== "calculated");
  const applicable_age = age;
  if (failed)
    return {
      ...empty,
      ...([ptc, employer].some((e) => e?.age_rating === "none")
        ? { quote_method: "state_filed_tier" }
        : {}),
      applicable_age,
      status: failed.status,
      reason: failed.reason,
      lcsp: ptc,
      employer_lcsp: employer,
    };
  const employmentLocation = request.worksite ?? request.residence;
  const employmentState = await stateOf(db, employmentLocation);
  const guideline = guidelineInEffect(request.planStart, parameters.guidelines);
  const line =
    guideline && employmentState
      ? onePersonPovertyLine(guideline.guidelineYear, employmentState)
      : null;
  const context = (purpose: Verdict["purpose"]) => ({
    requiredContributionBasisPoints: parameters.requiredContributionBasisPoints,
    rateOfPayHours: parameters.rateOfPayHours,
    purpose,
    povertyLine: line,
    fullCalendarYear:
      isCalendarYearPlan(request.planStart) && request.monthsAvailable === 12,
    ...w2PartialYearContext(request),
  });
  const verdicts = request.income.map((income) =>
    income.measure === "household" && ptc
      ? measureVerdict(
          income,
          ptc,
          request,
          context("premium_tax_credit"),
          "premium_tax_credit",
        )
      : measureVerdict(
          income,
          employer!,
          request,
          context("employer_4980H"),
          "employer",
        ),
  );
  const ruleIds: RuleId[] = [
    "required_hra_contribution",
    "lcsp_premium",
    "monthly_hra_amount",
    "required_contribution_percentage",
    ...verdicts.flatMap((v) => v.rule_ids),
  ];
  const applied: RuleId[] = [];
  if (employer) {
    applied.push("age_safe_harbor", "lowest_age_band");
    if (source === "worksite") applied.push("location_safe_harbor");
    if (harbors.lookBack) {
      applied.push("look_back_month");
      if (dateParts(request.planStart).month !== 1)
        applied.push("look_back_current_circumstances");
    }
  }
  return {
    ...QUOTE,
    ...([ptc, employer].some((e) => e?.age_rating === "none")
      ? { quote_method: "state_filed_tier" }
      : {}),
    status: "calculated",
    plan_start: request.planStart,
    months_available: request.monthsAvailable,
    applicable_age,
    lcsp: ptc,
    employer_lcsp: employer,
    basis_sensitive: basisSensitive(
      [ptc, employer].filter((e) => e !== null),
      verdicts,
    ),
    monthly_hra_cents: monthlyHraAmount(
      request.hraAnnualCents,
      request.monthsAvailable,
    ),
    required_contribution_percentage_bp:
      parameters.requiredContributionBasisPoints,
    required_contribution_percentage_citations:
      parameters.requiredContributionCitations,
    ...(line
      ? {
          poverty_line: {
            guideline_year: line.guidelineYear,
            state: employmentState,
            annual_dollars: line.annualDollars,
            citations: line.citations,
          },
        }
      : {}),
    verdicts,
    safe_harbors_applied: applied,
    rules: ruleList(parameters, [...ruleIds, ...applied]),
    issues: [...(ptc?.issues ?? []), ...(employer?.issues ?? [])],
  };
}

async function stateOf(
  db: SqlSession,
  location: LocationInput,
): Promise<string | null> {
  const resolved = await resolveLocation(db, location);
  return resolved.status === "available" && resolved.county
    ? countyState(resolved.county)
    : null;
}
