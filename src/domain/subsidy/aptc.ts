import { parseCents } from "../rating/index.js";
import { checkedCents } from "../rating/rate-row.js";
import { parameterRegistry } from "./generated.js";
import { isSubsidyParameters } from "./parameters.js";
import type { SubsidyParameters } from "./parameters.js";

export const QUOTE_METADATA = {
  quote_method: "puf_calculation",
  bindable_quote: false,
} as const;
export interface AptcInput {
  /** Annual household MAGI in dollars, at most two decimal places. Not monthly income. */
  readonly householdIncome: number;
  /** Tax family size, which may differ from the SLCSP coverage family size. */
  readonly householdSize: number;
  readonly state: string;
  /** Coverage/tax year, not the poverty guideline publication year. */
  readonly year: number;
  readonly slcspMonthlyCents: number;
}
export type AptcStatus =
  | "estimated"
  | "requires_state_rules"
  | "above_income_cliff"
  | "parameters_unconfirmed";
export interface AptcEstimate {
  readonly fplPercent: number | null;
  /** Fraction of annual income (0.0660 means 6.60%), NOT percentage points. */
  readonly applicablePercentage: number | null;
  /** Monthly contribution, rounded via annual contribution as in Form 8962 lines 8a–8b. */
  readonly expectedContributionCents: number | null;
  readonly annualExpectedContributionCents: number | null;
  readonly estimatedMonthlyCreditCents: number | null;
  readonly status: AptcStatus;
  readonly reason:
    | "conditional_estimate"
    | "below_100_fpl"
    | "medicaid_expansion_review"
    | "unsupported_state"
    | "above_income_cliff"
    | "parameters_unconfirmed";
  readonly quote_method: "puf_calculation";
  readonly bindable_quote: false;
}
const STATES = new Set(
  "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(
    " ",
  ),
);
const halfUp = (numerator: bigint, denominator: bigint): bigint =>
  (2n * numerator + denominator) / (2n * denominator);

export function fplAnnualDollars(
  parameters: SubsidyParameters,
  householdSize: number,
  state: string,
): number {
  if (!isSubsidyParameters(parameters) || parameters.status !== "confirmed")
    throw new RangeError("Confirmed cited parameters required");
  if (!Number.isSafeInteger(householdSize) || householdSize < 1)
    throw new RangeError("Tax family size must be a positive safe integer");
  if (!STATES.has(state))
    throw new RangeError("A supported state/DC abbreviation is required");
  const region =
    state === "AK" ? "alaska" : state === "HI" ? "hawaii" : "contiguous";
  const table = parameters.fpl[region];
  const dollars =
    table.annualDollarsBySize.value[Math.min(householdSize, 8) - 1]! +
    Math.max(0, householdSize - 8) * table.additionalPersonDollars.value;
  checkedCents(dollars * 100);
  return dollars;
}

/** Input is the IRS whole-percent FPL figure; the engine checks the exact cliff before truncation. */
export function applicablePercentageForFpl(
  fplPercent: number,
  parameters: SubsidyParameters,
): number | null {
  if (!isSubsidyParameters(parameters) || parameters.status !== "confirmed")
    return null;
  if (!Number.isSafeInteger(fplPercent) || fplPercent < 0)
    throw new RangeError("FPL percent must be a nonnegative whole percent");
  if (
    fplPercent < parameters.minimumFplPercent.value ||
    (parameters.maximumFplPercent.value !== null &&
      fplPercent > parameters.maximumFplPercent.value)
  )
    return null;
  const bands = parameters.applicablePercentageBands.value;
  const band = bands.find(
    (item, index) =>
      fplPercent >= item.lowerFplPercent &&
      (fplPercent < item.upperFplPercent ||
        (index === bands.length - 1 && fplPercent === item.upperFplPercent)),
  );
  if (!band) return null;
  const width = BigInt(band.upperFplPercent - band.lowerFplPercent);
  const numerator =
    BigInt(band.initialBasisPoints) * width +
    BigInt(fplPercent - band.lowerFplPercent) *
      BigInt(band.finalBasisPoints - band.initialBasisPoints);
  return Number(halfUp(numerator, width)) / 10000;
}

/**
 * Conditional arithmetic estimate, not an eligibility determination. Caller must resolve other MEC,
 * tax filing, immigration and coverage-family eligibility. No CSR inference. The employer required
 * contribution percentage is data for another subsystem; it is not substituted for the sliding table.
 * Optional parameters allow audited snapshots without domain I/O; invalid/unconfirmed years fail closed.
 */
export function estimateAptc(
  input: AptcInput,
  parameters: unknown = parameterRegistry[input.year],
): AptcEstimate {
  const empty = {
    fplPercent: null,
    applicablePercentage: null,
    expectedContributionCents: null,
    annualExpectedContributionCents: null,
    estimatedMonthlyCreditCents: null,
    ...QUOTE_METADATA,
  };
  if (
    !Number.isSafeInteger(input.year) ||
    !isSubsidyParameters(parameters) ||
    parameters.year.value !== input.year ||
    parameters.status !== "confirmed"
  ) {
    return {
      ...empty,
      status: "parameters_unconfirmed",
      reason: "parameters_unconfirmed",
    };
  }
  if (!Number.isSafeInteger(input.householdSize) || input.householdSize < 1)
    throw new RangeError("Tax family size must be a positive safe integer");
  if (!Number.isFinite(input.householdIncome) || input.householdIncome < 0)
    throw new RangeError("Annual household income must be nonnegative dollars");
  const incomeCents = BigInt(parseCents(String(input.householdIncome)));
  checkedCents(input.slcspMonthlyCents);
  if (!STATES.has(input.state))
    return {
      ...empty,
      status: "requires_state_rules",
      reason: "unsupported_state",
    };
  const povertyCents =
    BigInt(fplAnnualDollars(parameters, input.householdSize, input.state)) *
    100n;
  const fplPercent = Number((incomeCents * 100n) / povertyCents);
  // IRS Worksheet 2 checks exact income above 400% BEFORE dropping fractional FPL percent.
  const cliff = parameters.maximumFplPercent.value;
  if (cliff !== null && incomeCents * 100n > povertyCents * BigInt(cliff)) {
    return {
      ...empty,
      fplPercent: cliff + 1,
      estimatedMonthlyCreditCents: 0,
      status: "above_income_cliff",
      reason: "above_income_cliff",
    };
  }
  if (
    incomeCents * 100n <
    povertyCents * BigInt(parameters.minimumFplPercent.value)
  ) {
    return {
      ...empty,
      fplPercent,
      status: "requires_state_rules",
      reason: "below_100_fpl",
    };
  }
  // This does not decide Medicaid: states use current guidelines, monthly income, age and other rules.
  if (
    incomeCents * 100n <=
    povertyCents * BigInt(parameters.stateRulesReviewThroughFplPercent.value)
  ) {
    return {
      ...empty,
      fplPercent,
      status: "requires_state_rules",
      reason: "medicaid_expansion_review",
    };
  }
  const applicablePercentage = applicablePercentageForFpl(
    fplPercent,
    parameters,
  );
  if (applicablePercentage === null)
    return {
      ...empty,
      status: "parameters_unconfirmed",
      reason: "parameters_unconfirmed",
    };
  const basisPoints = BigInt(Math.round(applicablePercentage * 10000));
  // IRS Instructions for Form 8962, line 8a: "rounded to the nearest whole dollar amount."
  // https://www.irs.gov/instructions/i8962
  // income cents × basis points / 1,000,000 = annual dollars; keep the half-dollar exact.
  const annualDollars = halfUp(incomeCents * basisPoints, 1_000_000n);
  // Same instructions, line 8b: "Divide line 8a by 12.0"; then nearest whole dollar.
  // This is the existing Form-based estimate policy, not unrounded Marketplace APTC arithmetic.
  const monthlyDollars = halfUp(annualDollars, 12n);
  const annualExpectedContributionCents = checkedCents(
    Number(annualDollars * 100n),
  );
  const expectedContributionCents = checkedCents(Number(monthlyDollars * 100n));
  return {
    ...QUOTE_METADATA,
    fplPercent,
    applicablePercentage,
    expectedContributionCents,
    annualExpectedContributionCents,
    estimatedMonthlyCreditCents: Math.max(
      0,
      input.slcspMonthlyCents - expectedContributionCents,
    ),
    status: "estimated",
    reason: "conditional_estimate",
  };
}

/**
 * 26 CFR 1.36B-3(d)(1), (j)(1): cap at enrollment premium after excluding non-EHB benefits.
 * https://www.ecfr.gov/current/title-26/section-1.36B-3
 * Gross remains the amount billed; only the eligible EHB portion can absorb a credit.
 * Default is for callers explicitly supplying an all-EHB premium.
 */
export function netPremium(
  gross: number,
  credit: number,
  eligiblePremium: number = gross,
): {
  grossMonthlyPremiumCents: number;
  estimatedMonthlyCreditCents: number;
  estimatedNetMonthlyPremiumCents: number;
  quote_method: "puf_calculation";
  bindable_quote: false;
} {
  checkedCents(gross);
  checkedCents(credit);
  checkedCents(eligiblePremium);
  if (eligiblePremium > gross)
    throw new RangeError("Eligible premium cannot exceed gross");
  const appliedCredit = Math.min(eligiblePremium, credit);
  return {
    grossMonthlyPremiumCents: gross,
    estimatedMonthlyCreditCents: appliedCredit,
    estimatedNetMonthlyPremiumCents: gross - appliedCredit,
    ...QUOTE_METADATA,
  };
}
