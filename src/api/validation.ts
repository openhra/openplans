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
