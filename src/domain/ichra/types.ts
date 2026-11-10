/** Money is integer cents; percentages are integer basis points (996 = 9.96%). */
export type IncomeMeasure =
  | { readonly measure: "household"; readonly annualCents: number }
  | { readonly measure: "w2"; readonly annualCents: number }
  | {
      readonly measure: "rate_of_pay_hourly";
      /** Hourly rate on the first day of the coverage period. */
      readonly hourlyCents: number;
      /** Lowest hourly rate during the calendar month, when it is known to differ. */
      readonly lowestInMonthCents?: number;
    }
  | {
      readonly measure: "rate_of_pay_salary";
      /** Monthly salary on the first day of the coverage period. */
      readonly monthlyCents: number;
      /** True when the monthly salary was reduced, including through fewer work hours. */
      readonly reduced?: boolean;
    }
  | { readonly measure: "fpl" };
export type MeasureName = IncomeMeasure["measure"];

export type RuleStatus = "final" | "proposed_reliance_permitted";
export type RuleId =
  | "affordability"
  | "required_hra_contribution"
  | "lcsp_premium"
  | "monthly_hra_amount"
  | "required_contribution_percentage"
  | "employer_safe_harbors"
  | "location_safe_harbor"
  | "age_safe_harbor"
  | "lowest_age_band"
  | "look_back_month"
  | "w2_safe_harbor"
  | "rate_of_pay_safe_harbor"
  | "fpl_safe_harbor";

export interface SafeHarborChoices {
  readonly location: boolean;
  readonly lookBack: boolean;
  readonly lowestAgeBand: boolean;
}

/** An exact amount in cents as numerator / denominator; `display` is rounded half up for people only. */
export interface CentsRatio {
  readonly numerator: number;
  readonly denominator: number;
  readonly display: number;
}

/**
 * premium_tax_credit: 26 CFR 1.36B-2(c)(5), the employee's own eligibility test.
 * employer_4980H: the employer safe harbors, which never decide premium tax credit eligibility.
 */
export type VerdictPurpose = "premium_tax_credit" | "employer_4980H";

export interface Verdict {
  readonly measure: MeasureName;
  readonly purpose: VerdictPurpose;
  readonly status: "calculated" | "unknown";
  readonly reason: string | null;
  readonly thresholdCents: CentsRatio | null;
  /** null whenever the evidence or the rule needed for a yes/no answer is missing. */
  readonly affordable: boolean | null;
  readonly ruleIds: readonly RuleId[];
  readonly fplGuidelineYear?: number;
}
