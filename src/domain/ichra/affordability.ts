import type {
  CentsRatio,
  IncomeMeasure,
  RuleId,
  Verdict,
  VerdictPurpose,
} from "./types.js";

const BASIS_POINTS = 10_000n;
const MONTHS_PER_YEAR = 12n;
export const MAX_MONTHS_AVAILABLE = 12;

function nonNegativeCents(value: number, name: string): bigint {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${name}: non-negative integer cents required`);
  return BigInt(value);
}
function gcd(a: bigint, b: bigint): bigint {
  while (b) [a, b] = [b, a % b];
  return a;
}
/** Reduced exact ratio; display rounds half up and is never used in a comparison. */
export function centsRatio(numerator: bigint, denominator: bigint): CentsRatio {
  const divisor = gcd(numerator, denominator) || 1n;
  const n = numerator / divisor,
    d = denominator / divisor;
  const display = (2n * n + d) / (2n * d);
  if (
    n > BigInt(Number.MAX_SAFE_INTEGER) ||
    d > BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw new RangeError("Amount exceeds the supported range");
  return {
    numerator: Number(n),
    denominator: Number(d),
    display: Number(display),
  };
}

function months(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_MONTHS_AVAILABLE)
    throw new RangeError("monthsAvailable: 1 to 12 required");
  return BigInt(value);
}

/** 1.36B-2(c)(5)(iii)(B): amount newly made available for the plan year / months available. */
export function monthlyHraAmount(
  annualCents: number,
  monthsAvailable: number,
): CentsRatio {
  return centsRatio(
    nonNegativeCents(annualCents, "hraAnnualCents"),
    months(monthsAvailable),
  );
}

/** 1.36B-2(c)(5)(ii): LCSP monthly premium minus the monthly HRA amount, not below zero. */
export function requiredHraContribution(
  lcspMonthlyCents: number,
  hraAnnualCents: number,
  monthsAvailable: number,
): CentsRatio {
  const m = months(monthsAvailable);
  const excess =
    nonNegativeCents(lcspMonthlyCents, "lcspMonthlyCents") * m -
    nonNegativeCents(hraAnnualCents, "hraAnnualCents");
  return centsRatio(excess > 0n ? excess : 0n, m);
}

export interface MeasureContext {
  readonly requiredContributionBasisPoints: number;
  readonly rateOfPayHours: number;
  readonly purpose: VerdictPurpose;
  /** Needed only for the poverty-line measure; null when no guideline is in effect. */
  readonly povertyLine: {
    readonly guidelineYear: number;
    readonly annualDollars: number;
  } | null;
  /** The W-2 safe harbor is computed only for a full calendar plan year (partial years: later). */
  readonly fullCalendarYear: boolean;
}

const MEASURE_RULES: Readonly<Record<IncomeMeasure["measure"], RuleId[]>> = {
  household: ["affordability"],
  w2: ["employer_safe_harbors", "w2_safe_harbor"],
  rate_of_pay_hourly: ["employer_safe_harbors", "rate_of_pay_safe_harbor"],
  rate_of_pay_salary: ["employer_safe_harbors", "rate_of_pay_safe_harbor"],
  fpl: ["employer_safe_harbors", "fpl_safe_harbor"],
};

/** Monthly income base as base / divisor cents, or a reason it cannot be formed. */
function monthlyBase(
  income: IncomeMeasure,
  context: MeasureContext,
): { base: bigint; divisor: bigint } | { reason: string } {
  switch (income.measure) {
    case "household":
      return {
        base: nonNegativeCents(income.annualCents, "annualCents"),
        divisor: MONTHS_PER_YEAR,
      };
    case "w2":
      if (!context.fullCalendarYear)
        return { reason: "w2_partial_year_not_supported" };
      return {
        base: nonNegativeCents(income.annualCents, "annualCents"),
        divisor: MONTHS_PER_YEAR,
      };
    case "rate_of_pay_hourly":
      return {
        base:
          BigInt(context.rateOfPayHours) *
          nonNegativeCents(income.hourlyCents, "hourlyCents"),
        divisor: 1n,
      };
    case "rate_of_pay_salary":
      return {
        base: nonNegativeCents(income.monthlyCents, "monthlyCents"),
        divisor: 1n,
      };
    case "fpl":
      if (!context.povertyLine)
        return { reason: "fpl_guideline_not_in_effect" };
      return {
        base: BigInt(context.povertyLine.annualDollars) * 100n,
        divisor: MONTHS_PER_YEAR,
      };
  }
}

/**
 * Affordable when the required HRA contribution does not exceed the threshold ("does not
 * exceed", so equal is affordable). Exact: rc.n / rc.d <= base * bp / (10000 * divisor).
 */
export function affordabilityVerdict(
  income: IncomeMeasure,
  contribution: CentsRatio,
  context: MeasureContext,
): Verdict {
  const purpose =
    income.measure === "household" ? context.purpose : "employer_4980H";
  const common = {
    measure: income.measure,
    purpose,
    ruleIds: [
      ...MEASURE_RULES[income.measure],
      "required_contribution_percentage",
    ] as RuleId[],
    ...(income.measure === "fpl" && context.povertyLine
      ? { fplGuidelineYear: context.povertyLine.guidelineYear }
      : {}),
  };
  const formed = monthlyBase(income, context);
  if ("reason" in formed)
    return {
      ...common,
      status: "unknown",
      reason: formed.reason,
      thresholdCents: null,
      affordable: null,
    };
  const bp = BigInt(context.requiredContributionBasisPoints);
  const thresholdNumerator = formed.base * bp,
    thresholdDenominator = BASIS_POINTS * formed.divisor;
  const affordable =
    BigInt(contribution.numerator) * thresholdDenominator <=
    thresholdNumerator * BigInt(contribution.denominator);
  return {
    ...common,
    status: "calculated",
    reason: null,
    thresholdCents: centsRatio(thresholdNumerator, thresholdDenominator),
    affordable,
  };
}
