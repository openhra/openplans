// Hand-checked ICHRA affordability cases for the pure domain rules.
// SYNTHETIC inputs: the lowest cost silver plan (LCSP) amounts below are given numbers, not
// rated here. They equal TX PY2026/PY2027 PUF ratings for Harris (48201, Rating Area 10) and
// Travis (48453, Rating Area 3) at the listed ages, which the service tests rate from real rows.
// Percentages: 2026 = 9.96% (IRS Rev. Proc. 2025-25 s.3.02); 2027 = 10.22% (Rev. Proc. 2026-26
// s.3.02). One-person poverty line: 2025 HHS guideline $15,650 (in effect 2025-01-15) for 2026
// plans; 2026 HHS guideline $15,960 (in effect 2026-01-13) for 2027 plans.
// `kills` names the source mutants that must break the case.
export const HARRIS = "48201";
export const TRAVIS = "48453";

/** SYNTHETIC lookup: county:year:age -> LCSP monthly cents. */
export const LCSP = {
  [`${HARRIS}:2026:21`]: 45_869,
  [`${HARRIS}:2026:40`]: 58_621,
  [`${HARRIS}:2026:64`]: 137_607,
  [`${HARRIS}:2027:21`]: 51_362,
  [`${HARRIS}:2027:40`]: 65_639,
  [`${TRAVIS}:2026:40`]: 60_790,
  [`${TRAVIS}:2026:41`]: 61_932,
  [`${TRAVIS}:2026:64`]: 142_699,
  [`${TRAVIS}:2027:21`]: 56_537,
  [`${TRAVIS}:2027:64`]: 169_608,
};

export const CASES = [
  {
    id: "C1 Harris 2026 age 40, household income, affordable",
    input: {
      planStart: "2026-01-01",
      dob: "1985-10-01",
      residence: HARRIS,
      hraAnnualCents: 360_000,
      income: { measure: "household", annualCents: 4_000_000 },
    },
    hand: "Age 40 on 2026-01-01. LCSP $586.21. HRA 3,600/12 = $300.00. Required HRA contribution 586.21 - 300.00 = $286.21. Threshold 40,000 x 9.96% / 12 = $332.00. 286.21 <= 332.00.",
    expect: {
      affordable: true,
      age: 40,
      rc: 28_621,
      threshold: 33_200,
      purpose: "premium_tax_credit",
    },
  },
  {
    id: "C2 Harris 2026 age 64 unaffordable",
    input: {
      planStart: "2026-01-01",
      dob: "1962-01-01",
      residence: HARRIS,
      hraAnnualCents: 600_000,
      income: { measure: "household", annualCents: 6_000_000 },
    },
    hand: "LCSP $1,376.07; HRA $500.00; contribution $876.07 > 60,000 x 9.96% / 12 = $498.00.",
    expect: { affordable: false, age: 64, rc: 87_607, threshold: 49_800 },
  },
  {
    id: "C3 Harris 2027 age 21 unaffordable",
    input: {
      planStart: "2027-01-01",
      dob: "2005-06-15",
      residence: HARRIS,
      hraAnnualCents: 240_000,
      income: { measure: "household", annualCents: 3_600_000 },
    },
    hand: "LCSP $513.62; HRA $200.00; contribution $313.62 > 36,000 x 10.22% / 12 = $306.60.",
    expect: { affordable: false, age: 21, rc: 31_362, threshold: 30_660 },
  },
  {
    id: "C4 Travis 2026 age 40, affordable by $0.66",
    input: {
      planStart: "2026-01-01",
      dob: "1985-06-30",
      residence: TRAVIS,
      hraAnnualCents: 300_000,
      income: { measure: "household", annualCents: 4_320_000 },
    },
    hand: "Age 40 on the plan start (41 on 2026-06-30). LCSP $607.90; HRA $250.00; contribution $357.90 <= 43,200 x 9.96% / 12 = $358.56. At age 41: $369.32, unaffordable.",
    expect: { affordable: true, age: 40, rc: 35_790, threshold: 35_856 },
    kills: ["age_on_last_day_of_plan_year"],
  },
  {
    id: "C5 Travis 2026 age 64 affordable",
    input: {
      planStart: "2026-01-01",
      dob: "1962-01-01",
      residence: TRAVIS,
      hraAnnualCents: 1_200_000,
      income: { measure: "household", annualCents: 5_500_000 },
    },
    hand: "LCSP $1,426.99; HRA $1,000.00; contribution $426.99 <= 55,000 x 9.96% / 12 = $456.50.",
    expect: { affordable: true, age: 64, rc: 42_699, threshold: 45_650 },
  },
  {
    id: "C6 Travis 2027 age 21, affordable by $0.35",
    input: {
      planStart: "2027-01-01",
      dob: "2005-03-01",
      residence: TRAVIS,
      hraAnnualCents: 360_000,
      income: { measure: "household", annualCents: 3_120_000 },
    },
    hand: "LCSP $565.37; HRA $300.00; contribution $265.37 <= 31,200 x 10.22% / 12 = $265.72. With 2026's 9.96%: $258.96, unaffordable.",
    expect: { affordable: true, age: 21, rc: 26_537, threshold: 26_572 },
    kills: ["prior_year_percentage"],
  },
  {
    id: "C7a poverty-line safe harbor, Harris 2027 age 40, affordable",
    input: {
      planStart: "2027-01-01",
      dob: "1986-07-04",
      residence: HARRIS,
      hraAnnualCents: 630_000,
      income: { measure: "fpl" },
    },
    hand: "LCSP $656.39; HRA $525.00; contribution $131.39. Guideline in effect 2027-01-01: 2026, $15,960. Threshold 15,960 x 10.22% / 12 = $135.926.",
    expect: {
      affordable: true,
      age: 40,
      rc: 13_139,
      threshold: 13_593,
      guideline: 2026,
      purpose: "employer_4980H",
    },
  },
  {
    id: "C7b poverty-line safe harbor, Harris 2027 age 40, unaffordable",
    input: {
      planStart: "2027-01-01",
      dob: "1986-07-04",
      residence: HARRIS,
      hraAnnualCents: 624_000,
      income: { measure: "fpl" },
    },
    hand: "HRA $520.00; contribution 656.39 - 520.00 = $136.39 > $135.926.",
    expect: { affordable: false, rc: 13_639, guideline: 2026 },
  },
  {
    id: "C7c poverty-line safe harbor, Harris 2026 age 21, affordable by $1.21",
    input: {
      planStart: "2026-01-01",
      dob: "2004-09-01",
      residence: HARRIS,
      hraAnnualCents: 396_000,
      income: { measure: "fpl" },
    },
    hand: "LCSP $458.69; HRA $330.00; contribution $128.69. Guideline in effect 2026-01-01: 2025, $15,650. Threshold 15,650 x 9.96% / 12 = $129.895.",
    expect: {
      affordable: true,
      age: 21,
      rc: 12_869,
      threshold: 12_990,
      guideline: 2025,
    },
  },
  {
    id: "C8a look-back month and hourly rate of pay, Harris 2027 age 40, affordable",
    input: {
      planStart: "2027-01-01",
      dob: "1986-07-04",
      residence: HARRIS,
      hraAnnualCents: 500_000,
      income: { measure: "rate_of_pay_hourly", hourlyCents: 1_500 },
      safeHarbors: { lookBack: true },
    },
    hand: "Calendar plan: look-back month January 2026; age stays 40. LCSP Jan 2026 $586.21. HRA 5,000/12 = $416.667; contribution $169.543. Threshold 130 x $15.00 x 10.22% = $199.29.",
    expect: {
      affordable: true,
      age: 40,
      rc: 16_954,
      threshold: 19_929,
      lcspMonth: "2026-01-01",
    },
  },
  {
    id: "C8b same employee without the look-back month, unaffordable",
    input: {
      planStart: "2027-01-01",
      dob: "1986-07-04",
      residence: HARRIS,
      hraAnnualCents: 500_000,
      income: { measure: "rate_of_pay_hourly", hourlyCents: 1_500 },
    },
    hand: "LCSP Jan 2027 $656.39; contribution 656.39 - 416.667 = $239.723 > $199.29.",
    expect: { affordable: false, lcspMonth: "2027-01-01" },
  },
  {
    id: "C9a location safe harbor: lives in Travis, works in Harris, 2026 age 40, affordable",
    input: {
      planStart: "2026-01-01",
      dob: "1985-10-01",
      residence: TRAVIS,
      worksite: HARRIS,
      hraAnnualCents: 340_000,
      income: { measure: "rate_of_pay_salary", monthlyCents: 310_000 },
      safeHarbors: { location: true },
    },
    hand: "Worksite LCSP $586.21; HRA 3,400/12 = $283.333; contribution $302.877 <= 3,100 x 9.96% = $308.76.",
    expect: { affordable: true, county: HARRIS, rc: 30_288, threshold: 30_876 },
  },
  {
    id: "C9b same employee at the residence, unaffordable",
    input: {
      planStart: "2026-01-01",
      dob: "1985-10-01",
      residence: TRAVIS,
      worksite: HARRIS,
      hraAnnualCents: 340_000,
      income: { measure: "rate_of_pay_salary", monthlyCents: 310_000 },
    },
    hand: "Residence LCSP $607.90; contribution 607.90 - 283.333 = $324.567 > $308.76.",
    expect: { affordable: false, county: TRAVIS },
  },
  {
    id: "C9c remote employee with no site to report to keeps the residence",
    input: {
      planStart: "2026-01-01",
      dob: "1985-10-01",
      residence: TRAVIS,
      worksite: HARRIS,
      remote: true,
      hraAnnualCents: 340_000,
      income: { measure: "rate_of_pay_salary", monthlyCents: 310_000 },
      safeHarbors: { location: true },
    },
    hand: "Prop. (f)(6)(ii): a remote employee's primary site is the residence, so the result equals C9b.",
    expect: { affordable: false, county: TRAVIS },
  },
  {
    id: "C11 W-2 safe harbor, Travis 2027 age 64, affordable",
    input: {
      planStart: "2027-01-01",
      dob: "1963-01-01",
      residence: TRAVIS,
      hraAnnualCents: 1_500_000,
      income: { measure: "w2", annualCents: 5_250_000 },
    },
    hand: "LCSP $1,696.08; HRA $1,250.00; contribution $446.08 a month = $5,352.96 a year <= 10.22% x 52,500 = $5,365.50.",
    expect: { affordable: true, age: 64, rc: 44_608 },
  },
  {
    id: "C11b W-2 safe harbor needs a full calendar plan year",
    input: {
      planStart: "2027-01-01",
      dob: "1963-01-01",
      residence: TRAVIS,
      monthsAvailable: 6,
      hraAnnualCents: 750_000,
      income: { measure: "w2", annualCents: 5_250_000 },
    },
    hand: "Six months available and no calendar-month counts given, so the W-2 verdict is unknown.",
    expect: { affordable: null, reason: "w2_partial_year_not_supported" },
  },
  {
    id: "C13 exact boundary: equal is affordable ('does not exceed')",
    input: {
      planStart: "2026-01-01",
      dob: "1985-10-01",
      residence: HARRIS,
      hraAnnualCents: 359_832,
      income: { measure: "household", annualCents: 3_450_000 },
    },
    hand: "HRA 3,598.32/12 = $299.86; contribution 586.21 - 299.86 = $286.35. Threshold 34,500 x 9.96% / 12 = $286.35 exactly.",
    expect: { affordable: true, rc: 28_635, threshold: 28_635 },
    kills: ["strict_less_than"],
  },
  {
    id: "C13b one cent less income is unaffordable",
    input: {
      planStart: "2026-01-01",
      dob: "1985-10-01",
      residence: HARRIS,
      hraAnnualCents: 359_832,
      income: { measure: "household", annualCents: 3_449_999 },
    },
    hand: "Threshold 34,499.99 x 9.96% / 12 = $286.349917 < $286.35.",
    expect: { affordable: false },
  },
  {
    id: "C14 HRA larger than the premium: contribution is zero, affordable",
    input: {
      planStart: "2026-01-01",
      dob: "1985-10-01",
      residence: HARRIS,
      hraAnnualCents: 800_000,
      income: { measure: "household", annualCents: 0 },
    },
    hand: "HRA $666.67 > LCSP $586.21; contribution floors at $0.00 <= $0.00.",
    expect: { affordable: true, rc: 0, threshold: 0 },
  },
];

/** Composes the domain rules; `m` is the ICHRA domain module (or a mutant of one file). */
export function evaluateCase(input, m) {
  const harbors = {
    location: false,
    lookBack: false,
    lowestAgeBand: false,
    ...input.safeHarbors,
  };
  const year = Number(input.planStart.slice(0, 4));
  const lookup = m.ichraParameters(year);
  if (lookup.status !== "confirmed") return { status: lookup.status };
  const p = lookup.parameters;
  const age = m.applicableAge(input.dob, input.planStart, null);
  const source = m.lcspLocationSource(
    harbors.location,
    input.worksite ? { remote: Boolean(input.remote) } : null,
  );
  const county = source === "worksite" ? input.worksite : input.residence;
  const lcspMonth = harbors.lookBack
    ? m.lookBackMonth(input.planStart)
    : input.planStart;
  const lcsp = LCSP[`${county}:${lcspMonth.slice(0, 4)}:${age}`];
  if (lcsp === undefined) return { status: "no_synthetic_lcsp", age };
  const months = input.monthsAvailable ?? 12;
  const rc = m.requiredHraContribution(lcsp, input.hraAnnualCents, months);
  const guideline = m.guidelineInEffect(input.planStart, p.guidelines);
  const line = guideline
    ? m.onePersonPovertyLine(guideline.guidelineYear, "TX")
    : null;
  const employer =
    harbors.location || harbors.lookBack || harbors.lowestAgeBand;
  const verdict = m.affordabilityVerdict(input.income, rc, {
    requiredContributionBasisPoints: p.requiredContributionBasisPoints,
    rateOfPayHours: p.rateOfPayHours,
    purpose: employer ? "employer_4980H" : "premium_tax_credit",
    povertyLine: line,
    fullCalendarYear: m.isCalendarYearPlan(input.planStart) && months === 12,
  });
  return {
    status: "calculated",
    affordable: verdict.affordable,
    reason: verdict.reason,
    age,
    county,
    lcspMonth,
    rc: rc.display,
    threshold: verdict.thresholdCents?.display ?? null,
    guideline: verdict.fplGuidelineYear ?? null,
    purpose: verdict.purpose,
  };
}

/** True when every expected field matches. */
export function matches(result, expect) {
  return Object.entries(expect).every(([key, value]) => result[key] === value);
}
