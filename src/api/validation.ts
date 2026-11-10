import { csrSuffix, selectedVariant } from "../domain/csr/index.js";
import { parse_hios } from "../domain/hios/index.js";
import { parseCents } from "../domain/rating/index.js";
import { ageOnDate } from "../domain/rating/household.js";
import { dateParts, validateAge } from "../domain/rating/rate-row.js";
import type { HouseholdMember } from "../domain/rating/types.js";

export class InputError extends Error {
  constructor(
    readonly field: string,
    readonly code = "INVALID_INPUT",
  ) {
    super(code);
  }
}
export const fail = (field: string, code?: string): never => {
  throw new InputError(field, code);
};
export function year(value: unknown): number {
  if (
    typeof value !== "string" ||
    !/^\d{4}$/.test(value) ||
    Number(value) < 2014
  )
    return fail("year", "YEAR_REQUIRED");
  return Number(value);
}
export function zip(value: unknown): string {
  if (typeof value !== "string" || !/^\d{5}$/.test(value)) return fail("zip");
  return value;
}
export function county(value: unknown): string {
  if (typeof value !== "string" || !/^\d{5}$/.test(value))
    return fail("county");
  return value;
}
export function state(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Z]{2}$/.test(value) ||
    !STATES.has(value)
  )
    return fail("state");
  return value;
}
const STATES = new Set(
  "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(
    " ",
  ),
);
export function planId(value: unknown) {
  try {
    return parse_hios(value);
  } catch {
    return fail("plan_id");
  }
}
export function market(value: unknown = "individual"): "Individual" {
  if (value !== "individual") return fail("market", "UNSUPPORTED_MARKET");
  return "Individual";
}
export function page(value: unknown = "1"): number {
  if (
    typeof value !== "string" ||
    !/^[1-9]\d*$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    return fail("page");
  return Number(value);
}
export function metal(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    ![
      "bronze",
      "expanded bronze",
      "silver",
      "gold",
      "platinum",
      "catastrophic",
    ].includes(value.toLowerCase())
  )
    return fail("metal");
  return value.toLowerCase();
}
export interface LocationInput {
  zip?: string;
  county?: string;
}
export function location(value: Record<string, unknown>): LocationInput {
  if (value.zip === undefined && value.county === undefined)
    return fail("location", "LOCATION_REQUIRED");
  return {
    ...(value.zip === undefined ? {} : { zip: zip(value.zip) }),
    ...(value.county === undefined ? {} : { county: county(value.county) }),
  };
}
function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail(field);
  return value as Record<string, unknown>;
}
export function csrVariant(value: unknown): string | undefined {
  try {
    return csrSuffix(value);
  } catch {
    return fail("csr_variant");
  }
}
export function checkVariant(
  base: string,
  suffix: string | undefined,
  requested: string | null,
) {
  try {
    return selectedVariant(base, suffix, requested);
  } catch {
    return fail("csr_variant", "CONFLICTING_VARIANT");
  }
}
export function premiumRequest(value: unknown) {
  const body = record(value, "body");
  const hiosIds = body.plan_ids ?? [],
    keys = body.plan_keys ?? [];
  if (
    !Array.isArray(hiosIds) ||
    !Array.isArray(keys) ||
    hiosIds.length + keys.length < 1 ||
    hiosIds.length + keys.length > 50
  )
    return fail("plan_ids");
  const named = keys.map((key: unknown) => {
    if (
      typeof key !== "string" ||
      // eslint-disable-next-line no-control-regex -- Control characters must be rejected at this boundary.
      !/^[A-Z][A-Z0-9]{1,15}:[^\u0000-\u001f]{1,200}$/.test(key)
    )
      return fail("plan_keys");
    return { base: key, full: key, variant: null };
  });
  const ids = [...hiosIds.map(planId), ...named];
  if (new Set(ids.map((id) => id.full)).size !== ids.length)
    return fail("plan_ids", "DUPLICATE_PLAN_ID");
  const csr = csrVariant(body.csr_variant);
  for (const id of ids) checkVariant(id.base, csr, id.variant);
  const coverage = body.coverage_start;
  if (typeof coverage !== "string") return fail("coverage_start");
  let planYear: number;
  try {
    planYear = dateParts(coverage).year;
  } catch {
    return fail("coverage_start");
  }
  if (planYear < 2014) return fail("coverage_start");
  if (
    !Array.isArray(body.members) ||
    body.members.length < 1 ||
    body.members.length > 100
  )
    return fail("members");
  const members: HouseholdMember[] = body.members.map((value, index) => {
    const m = record(value, `members.${index}`),
      field = `members.${index}`;
    if ((m.age === undefined) === (m.dob === undefined))
      return fail(`${field}.age`, "AGE_OR_DOB_REQUIRED");
    if (typeof m.tobacco !== "boolean") return fail(`${field}.tobacco`);
    if (
      !["subscriber", "spouse", "child", "other"].includes(
        m.relationship as string,
      )
    )
      return fail(`${field}.relationship`);
    let age: number;
    try {
      if (m.age !== undefined) {
        if (typeof m.age !== "number") return fail(`${field}.age`);
        validateAge(m.age);
        age = m.age;
      } else {
        if (typeof m.dob !== "string") return fail(`${field}.dob`);
        age = ageOnDate(m.dob, coverage);
      }
    } catch {
      return fail(`${field}.age`);
    }
    if (age > 120) return fail(`${field}.age`);
    const common = {
      id: String(index),
      tobaccoUse: m.tobacco,
      relationship: m.relationship as HouseholdMember["relationship"],
    };
    return m.dob === undefined
      ? { ...common, age }
      : { ...common, dateOfBirth: m.dob as string };
  });
  return {
    ids,
    csrVariant: csr,
    coverage,
    year: planYear,
    members,
    subsidy: subsidyInput(body),
    location: location(body),
  };
}

export const TAX_FILINGS = [
  "single",
  "married_filing_jointly",
  "head_of_household",
  "qualifying_surviving_spouse",
  "married_filing_separately",
  "not_filing",
] as const;
export interface SubsidyInput {
  income: number;
  size: number;
  taxFiling?: (typeof TAX_FILINGS)[number];
}
/** Size describes the tax family; members describes only those seeking coverage. */
export function subsidyInput(
  body: Record<string, unknown>,
): SubsidyInput | undefined {
  if (
    body.household_income_annual === undefined &&
    body.household_size === undefined &&
    body.tax_filing === undefined
  )
    return undefined;
  const income = body.household_income_annual,
    size = body.household_size;
  if (typeof income !== "number" || !Number.isFinite(income) || income < 0)
    return fail("household_income_annual");
  try {
    parseCents(String(income));
  } catch {
    return fail("household_income_annual");
  }
  if (
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > 100
  )
    return fail("household_size");
  if (
    body.tax_filing !== undefined &&
    !TAX_FILINGS.includes(body.tax_filing as (typeof TAX_FILINGS)[number])
  )
    return fail("tax_filing");
  return {
    income,
    size,
    taxFiling: body.tax_filing as SubsidyInput["taxFiling"],
  };
}

/** Jan 1 quote, first age is subscriber; subsequent under-21 ages are dependent children. */
export function benchmarkRequest(query: Record<string, string>) {
  const planYear = year(query.year);
  if (
    !query.ages ||
    query.ages.length > 399 ||
    !/^\d{1,3}(,\d{1,3})*$/.test(query.ages)
  )
    return fail("ages");
  const ages = query.ages.split(",").map(Number);
  if (ages.length > 100 || ages.some((age) => age > 120)) return fail("ages");
  return premiumRequest({
    plan_ids: ["00000TX0000000"],
    ...location(query),
    coverage_start: `${planYear}-01-01`,
    members: ages.map((age, index) => {
      function memberRelationship() {
        if (index === 0) {
          return "subscriber";
        } else if (age < 21) {
          return "child";
        } else {
          return "other";
        }
      }
      return {
        age,
        tobacco: false,
        relationship: memberRelationship(),
      };
    }),
  });
}

/** Public quote tier bounds (owner defaults, 2026-11-09). */
export const PUBLIC_QUOTE_LIMITS = {
  members: 10,
  plans: 10,
  providers: 5,
  drugs: 5,
  pairs: 100,
} as const;
const MAX_AGE = 120;
const PUBLIC_QUOTE_FIELDS = new Set([
  "year",
  "zip",
  "county",
  "members",
  "plan_ids",
  "coverage",
  "metal",
  "csr_variant",
  "page",
  "npis",
  "rxcuis",
]);
const PUBLIC_MEMBER_FIELDS = new Set(["age", "relationship", "tobacco"]);
const INCOME_FIELDS = new Set([
  "household_income_annual",
  "household_size",
  "tax_filing",
]);
/** Refused field names are echoed, never their values; long keys are cut. */
const MAX_FIELD_ECHO = 100;
// eslint-disable-next-line no-control-regex -- Control characters must be rejected at this boundary.
const STATE_PLAN_KEY = /^[A-Z][A-Z0-9]{1,15}:[^\u0000-\u001f]{1,200}$/;
/** premiumRequest needs one ID; the quote service enumerates the catalog instead (as benchmarkRequest does). */
const CATALOG_PLACEHOLDER_ID = "00000TX0000000";
export type QuoteCoverage = "medical" | "dental";

export function npi(value: unknown): string {
  if (typeof value !== "string" || !/^[12][0-9]{9}$/.test(value))
    return fail("npi");
  return value;
}
export function rxcui(value: unknown): string {
  if (typeof value !== "string" || !/^\d{1,20}$/.test(value))
    return fail("rxcui");
  return value;
}

/** Income and dates of birth have their own codes; anything else unlisted is unknown. */
function refuseFields(
  value: Record<string, unknown>,
  allowed: Set<string>,
  prefix: string,
) {
  const keys = Object.keys(value),
    field = (key: string) => `${prefix}${key}`.slice(0, MAX_FIELD_ECHO);
  const income = keys.find((key) => INCOME_FIELDS.has(key));
  if (income !== undefined) fail(field(income), "INCOME_NOT_ACCEPTED");
  if (keys.includes("dob")) fail(field("dob"), "DOB_NOT_ACCEPTED");
  const unknown = keys.find((key) => !allowed.has(key));
  if (unknown !== undefined) fail(field(unknown), "UNKNOWN_FIELD");
}
function boundedList(
  value: unknown,
  field: string,
  max: number,
  code: string,
): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return fail(field);
  if (value.length > max) return fail(field, code);
  return value;
}
function distinct(values: string[], field: string, code: string): string[] {
  if (new Set(values).size !== values.length) return fail(field, code);
  return values;
}
/** Same default as benchmarkRequest: first member subscriber, later under-21 members children. */
function defaultRelationship(index: number, age: number) {
  if (index === 0) return "subscriber";
  return age < 21 ? "child" : "other";
}
function quoteYear(value: unknown): number {
  if (value === undefined) return fail("year", "YEAR_REQUIRED");
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 2014 ||
    value > 2100
  )
    return fail("year");
  return value;
}
function quotePage(value: unknown = 1): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    return fail("page");
  return value;
}
function quoteMember(value: unknown, index: number) {
  const field = `members.${index}`,
    member = record(value, field);
  refuseFields(member, PUBLIC_MEMBER_FIELDS, `${field}.`);
  const age = member.age;
  if (
    typeof age !== "number" ||
    !Number.isInteger(age) ||
    age < 0 ||
    age > MAX_AGE
  )
    return fail(`${field}.age`);
  // Optional; rated when true and never logged (owner, 2026-11-09).
  const tobacco = member.tobacco ?? false;
  if (typeof tobacco !== "boolean") return fail(`${field}.tobacco`);
  return {
    age,
    tobacco,
    relationship: member.relationship ?? defaultRelationship(index, age),
  };
}

/** Strict allow-list for anonymous quotes by age and ZIP; builds a premiumRequest without subsidy inputs. */
export function publicQuoteRequest(value: unknown) {
  const body = record(value, "body");
  refuseFields(body, PUBLIC_QUOTE_FIELDS, "");
  if (!Array.isArray(body.members) || body.members.length < 1)
    return fail("members");
  if (body.members.length > PUBLIC_QUOTE_LIMITS.members)
    return fail("members", "TOO_MANY_MEMBERS");
  const members = body.members.map(quoteMember);
  const planYear = quoteYear(body.year);
  const refs = boundedList(
    body.plan_ids,
    "plan_ids",
    PUBLIC_QUOTE_LIMITS.plans,
    "TOO_MANY_PLANS",
  );
  if (body.plan_ids !== undefined && refs.length === 0) return fail("plan_ids");
  const npis = distinct(
    boundedList(
      body.npis,
      "npis",
      PUBLIC_QUOTE_LIMITS.providers,
      "TOO_MANY_PROVIDERS",
    ).map(npi),
    "npis",
    "DUPLICATE_NPI",
  );
  const rxcuis = distinct(
    boundedList(
      body.rxcuis,
      "rxcuis",
      PUBLIC_QUOTE_LIMITS.drugs,
      "TOO_MANY_DRUGS",
    ).map(rxcui),
    "rxcuis",
    "DUPLICATE_RXCUI",
  );
  const coverage = body.coverage ?? "medical";
  if (coverage !== "medical" && coverage !== "dental") return fail("coverage");
  const page = quotePage(body.page);
  if (refs.length && page !== 1) return fail("page");
  const planCount = refs.length || PUBLIC_QUOTE_LIMITS.plans;
  if (planCount * (npis.length + rxcuis.length) > PUBLIC_QUOTE_LIMITS.pairs)
    return fail("body", "TOO_MANY_PAIRS");
  const isKey = (ref: unknown) =>
    typeof ref === "string" && STATE_PLAN_KEY.test(ref);
  const premium = premiumRequest({
    ...(refs.length
      ? {
          plan_ids: refs.filter((ref) => !isKey(ref)),
          plan_keys: refs.filter(isKey),
        }
      : { plan_ids: [CATALOG_PLACEHOLDER_ID] }),
    zip: body.zip,
    county: body.county,
    csr_variant: body.csr_variant,
    coverage_start: `${planYear}-01-01`,
    members,
  });
  return {
    premium,
    explicitPlans: refs.length > 0,
    npis,
    rxcuis,
    coverage: coverage as QuoteCoverage,
    metal: metal(body.metal),
    page,
  };
}

const ICHRA_FIELDS = {
  body: new Set([
    "plan_start",
    "months_available",
    "employee",
    "residence",
    "worksite",
    "hra",
    "income",
    "safe_harbors",
    "lcsp_premium_basis",
  ]),
  employee: new Set(["date_of_birth", "eligible_from"]),
  residence: new Set(["zip", "county"]),
  worksite: new Set(["zip", "county", "remote"]),
  hra: new Set(["self_only_annual_cents"]),
  safe_harbors: new Set(["location", "look_back"]),
} as const;
const ICHRA_INCOME_AMOUNT = {
  household: "annual_cents",
  w2: "annual_cents",
  rate_of_pay_hourly: "hourly_cents",
  rate_of_pay_salary: "monthly_cents",
  fpl: null,
} as const;
/** Optional fields of one income measure, beside its amount. */
const ICHRA_INCOME_OPTIONAL: Readonly<Record<string, readonly string[]>> = {
  w2: ["w2_months_offered", "w2_months_employed"],
  rate_of_pay_hourly: ["lowest_hourly_cents"],
  rate_of_pay_salary: ["salary_reduced"],
};
const MONTHS_IN_YEAR = 12;
const ICHRA_MAX_INCOME_MEASURES = 4;
/** Upper bound for any cents input: $100 million, far above any wage or HRA amount. */
const ICHRA_MAX_CENTS = 10_000_000_000;

function onlyFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  prefix: string,
) {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined)
    fail(`${prefix}${unknown}`.slice(0, MAX_FIELD_ECHO), "UNKNOWN_FIELD");
}
function isoDate(value: unknown, field: string): string {
  try {
    if (typeof value === "string") {
      dateParts(value);
      return value;
    }
  } catch {
    /* Reported below. */
  }
  return fail(field, "INVALID_DATE");
}
function cents(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > ICHRA_MAX_CENTS
  )
    return fail(field);
  return value;
}
function ichraLocation(
  value: unknown,
  field: string,
  allowed: ReadonlySet<string>,
) {
  const body = record(value, field);
  onlyFields(body, allowed, `${field}.`);
  if (body.zip === undefined && body.county === undefined)
    return fail(field, "LOCATION_REQUIRED");
  return {
    ...(body.zip === undefined ? {} : { zip: zip(body.zip) }),
    ...(body.county === undefined ? {} : { county: county(body.county) }),
  };
}
function ichraIncome(value: unknown, index: number) {
  const field = `income.${index}`,
    item = record(value, field);
  const measure = item.measure as keyof typeof ICHRA_INCOME_AMOUNT;
  if (typeof measure !== "string" || !(measure in ICHRA_INCOME_AMOUNT))
    return fail(`${field}.measure`);
  const amount = ICHRA_INCOME_AMOUNT[measure];
  onlyFields(
    item,
    new Set([
      "measure",
      ...(amount ? [amount] : []),
      ...(ICHRA_INCOME_OPTIONAL[measure] ?? []),
    ]),
    `${field}.`,
  );
  if (measure === "fpl") return { measure };
  const amountCents = cents(item[amount!], `${field}.${amount}`);
  switch (measure) {
    case "household":
    case "w2":
      return { measure, annualCents: amountCents };
    case "rate_of_pay_hourly": {
      const lowest = item.lowest_hourly_cents;
      if (lowest === undefined) return { measure, hourlyCents: amountCents };
      // A pay rate of zero is not a rate; the first-day rate keeps its existing range.
      if (cents(lowest, `${field}.lowest_hourly_cents`) < 1)
        return fail(`${field}.lowest_hourly_cents`);
      return {
        measure,
        hourlyCents: amountCents,
        lowestInMonthCents: lowest as number,
      };
    }
    case "rate_of_pay_salary": {
      const reduced = item.salary_reduced;
      if (reduced === undefined) return { measure, monthlyCents: amountCents };
      if (typeof reduced !== "boolean") return fail(`${field}.salary_reduced`);
      return { measure, monthlyCents: amountCents, reduced };
    }
  }
}
function monthCount(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MONTHS_IN_YEAR
  )
    return fail(field);
  return value;
}
/** Calendar-month counts for a partial-year W-2 offer: both or neither, offered <= employed. */
function w2Months(item: Record<string, unknown>, field: string) {
  const offered = item.w2_months_offered,
    employed = item.w2_months_employed;
  if (offered === undefined && employed === undefined) return null;
  if (offered === undefined)
    return fail(`${field}.w2_months_offered`, "W2_MONTHS_INCOMPLETE");
  if (employed === undefined)
    return fail(`${field}.w2_months_employed`, "W2_MONTHS_INCOMPLETE");
  const monthsOffered = monthCount(offered, `${field}.w2_months_offered`),
    monthsEmployed = monthCount(employed, `${field}.w2_months_employed`);
  if (monthsOffered > monthsEmployed)
    return fail(
      `${field}.w2_months_offered`,
      "W2_MONTHS_OFFERED_EXCEED_EMPLOYED",
    );
  return { monthsOffered, monthsEmployed };
}
function flag(value: unknown, field: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") return fail(field);
  return value;
}

/** POST /v1/ichra/affordability body. Unknown fields are refused; income is never echoed. */
export function ichraRequest(value: unknown) {
  const body = record(value, "body");
  onlyFields(body, ICHRA_FIELDS.body, "");
  const planStart = isoDate(body.plan_start, "plan_start");
  if (dateParts(planStart).year < 2014)
    return fail("plan_start", "INVALID_DATE");
  const months = body.months_available ?? 12;
  if (
    typeof months !== "number" ||
    !Number.isInteger(months) ||
    months < 1 ||
    months > 12
  )
    return fail("months_available");
  const employee = record(body.employee, "employee");
  onlyFields(employee, ICHRA_FIELDS.employee, "employee.");
  const dateOfBirth = isoDate(employee.date_of_birth, "employee.date_of_birth");
  if (dateOfBirth > planStart)
    return fail("employee.date_of_birth", "INVALID_DATE");
  const eligibleFrom =
    employee.eligible_from === undefined || employee.eligible_from === null
      ? null
      : isoDate(employee.eligible_from, "employee.eligible_from");
  const residence = ichraLocation(
    body.residence,
    "residence",
    ICHRA_FIELDS.residence,
  );
  const worksite =
    body.worksite === undefined || body.worksite === null
      ? null
      : {
          ...ichraLocation(body.worksite, "worksite", ICHRA_FIELDS.worksite),
          remote: flag(
            record(body.worksite, "worksite").remote,
            "worksite.remote",
          ),
        };
  const hra = record(body.hra, "hra");
  onlyFields(hra, ICHRA_FIELDS.hra, "hra.");
  const hraAnnualCents = cents(
    hra.self_only_annual_cents,
    "hra.self_only_annual_cents",
  );
  if (
    !Array.isArray(body.income) ||
    body.income.length < 1 ||
    body.income.length > ICHRA_MAX_INCOME_MEASURES
  )
    return fail("income");
  const income = body.income.map(ichraIncome);
  // The month counts travel beside the measures: the W-2 measure itself is wages only.
  const w2Index = income.findIndex((i) => i.measure === "w2");
  const w2PartialYear =
    w2Index < 0
      ? null
      : w2Months(
          record(body.income[w2Index], `income.${w2Index}`),
          `income.${w2Index}`,
        );
  distinct(
    income.map((i) => i.measure),
    "income",
    "DUPLICATE_MEASURE",
  );
  const harbors =
    body.safe_harbors === undefined
      ? {}
      : record(body.safe_harbors, "safe_harbors");
  onlyFields(harbors, ICHRA_FIELDS.safe_harbors, "safe_harbors.");
  const safeHarbors = {
    location: flag(harbors.location, "safe_harbors.location"),
    lookBack: flag(harbors.look_back, "safe_harbors.look_back"),
  };
  if (safeHarbors.location && !worksite)
    return fail("safe_harbors.location", "SAFE_HARBOR_INPUT_MISSING");
  const basis = body.lcsp_premium_basis ?? null;
  if (basis !== null && basis !== "gross" && basis !== "ehb_portion")
    return fail("lcsp_premium_basis");
  return {
    planStart,
    monthsAvailable: months,
    dateOfBirth,
    eligibleFrom,
    residence,
    worksite,
    hraAnnualCents,
    income,
    safeHarbors,
    lcspPremiumBasis: basis as "gross" | "ehb_portion" | null,
    ...(w2PartialYear ? { w2PartialYear } : {}),
  };
}
