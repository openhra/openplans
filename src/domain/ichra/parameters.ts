import { parameterRegistry } from "../subsidy/generated.js";
import { citedValue, isSubsidyParameters } from "../subsidy/parameters.js";
import type { Citation, Cited } from "../subsidy/parameters.js";
import { ichraRegistry } from "./generated.js";
import type { RuleId, RuleStatus } from "./types.js";

/** One file per calendar year in which an HRA plan year begins (Rev. Proc. "plan years beginning in"). */
export interface IchraParameterFile {
  readonly schemaVersion: 1;
  readonly year: Cited<number>;
  readonly status: "confirmed" | "unconfirmed";
  readonly statusReason: string;
  readonly lcspPremiumBasisDefault: Cited<PremiumBasis>;
  readonly rateOfPayHours: Cited<number>;
  readonly lowestAgeBand: Cited<{ label: "0-14"; ratingAge: number }>;
  readonly fplSafeHarbor: {
    readonly guidelines: Cited<readonly PovertyGuideline[]>;
    readonly selection: Cited<"latest_in_effect_on_plan_start">;
  };
  readonly rules: Readonly<
    Record<RuleId, Cited<{ status: RuleStatus; summary: string }>>
  >;
}
export type PremiumBasis = "gross" | "ehb_portion";
export interface PovertyGuideline {
  readonly guidelineYear: number;
  readonly effectiveDate: string;
}
export interface RuleEntry {
  readonly id: RuleId;
  readonly status: RuleStatus;
  readonly summary: string;
  readonly citations: readonly Citation[];
}
export interface IchraParameters {
  readonly year: number;
  readonly lcspPremiumBasisDefault: PremiumBasis;
  readonly rateOfPayHours: number;
  readonly lowestAgeBandRatingAge: number;
  readonly guidelines: readonly PovertyGuideline[];
  readonly rules: Readonly<Record<RuleId, RuleEntry>>;
  /** From data/subsidy/<year>.json, so the percentage has one source in the repository. */
  readonly requiredContributionBasisPoints: number;
  readonly requiredContributionCitations: readonly Citation[];
}
export type IchraParameterLookup =
  | { readonly status: "confirmed"; readonly parameters: IchraParameters }
  | { readonly status: "parameters_unconfirmed"; readonly reason: string };

export const RULE_IDS: readonly RuleId[] = [
  "affordability",
  "required_hra_contribution",
  "lcsp_premium",
  "monthly_hra_amount",
  "required_contribution_percentage",
  "employer_safe_harbors",
  "location_safe_harbor",
  "age_safe_harbor",
  "lowest_age_band",
  "look_back_month",
  "look_back_current_circumstances",
  "w2_safe_harbor",
  "rate_of_pay_safe_harbor",
  "fpl_safe_harbor",
];
const RULE_STATUSES: readonly RuleStatus[] = [
  "final",
  "proposed_reliance_permitted",
];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    ISO_DATE.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}

function guidelineErrors(value: unknown, failures: string[]) {
  if (!Array.isArray(value) || !value.length) {
    failures.push("fplSafeHarbor.guidelines: nonempty list required");
    return;
  }
  let previous = 0;
  for (const entry of value) {
    if (
      !record(entry) ||
      !Number.isSafeInteger(entry.guidelineYear) ||
      Number(entry.guidelineYear) <= previous ||
      !validDate(entry.effectiveDate) ||
      !entry.effectiveDate.startsWith(`${String(entry.guidelineYear)}-`)
    )
      failures.push(
        "fplSafeHarbor.guidelines: ascending years with an effective date in that year required",
      );
    previous = record(entry) ? Number(entry.guidelineYear) : previous;
  }
}

/** Schema and citation check; it proves traceability, not that the rules are still current. */
export function ichraParameterErrors(value: unknown): string[] {
  const failures: string[] = [];
  if (!record(value)) return ["parameters: expected object"];
  if (value.schemaVersion !== 1) failures.push("schemaVersion: expected 1");
  if (!["confirmed", "unconfirmed"].includes(String(value.status)))
    failures.push("status: expected confirmed or unconfirmed");
  if (typeof value.statusReason !== "string" || !value.statusReason.trim())
    failures.push("statusReason: required");
  const year = citedValue(value.year, "year", failures);
  if (!Number.isSafeInteger(year) || Number(year) < 2020)
    failures.push("year: unsupported plan year");
  const basis = citedValue(
    value.lcspPremiumBasisDefault,
    "lcspPremiumBasisDefault",
    failures,
  );
  if (basis !== "gross" && basis !== "ehb_portion")
    failures.push("lcspPremiumBasisDefault: gross or ehb_portion");
  const hours = citedValue(value.rateOfPayHours, "rateOfPayHours", failures);
  if (!Number.isSafeInteger(hours) || Number(hours) <= 0)
    failures.push("rateOfPayHours: positive integer required");
  const band = citedValue(value.lowestAgeBand, "lowestAgeBand", failures);
  if (!record(band) || band.label !== "0-14" || band.ratingAge !== 14)
    failures.push("lowestAgeBand: the 0-14 band rated at age 14");
  const fpl = record(value.fplSafeHarbor) ? value.fplSafeHarbor : {};
  guidelineErrors(
    citedValue(fpl.guidelines, "fplSafeHarbor.guidelines", failures),
    failures,
  );
  if (
    citedValue(fpl.selection, "fplSafeHarbor.selection", failures) !==
    "latest_in_effect_on_plan_start"
  )
    failures.push("fplSafeHarbor.selection: unsupported rule");
  const rules = record(value.rules) ? value.rules : {};
  for (const id of RULE_IDS) {
    const rule = citedValue(rules[id], `rules.${id}`, failures);
    if (
      !record(rule) ||
      !RULE_STATUSES.includes(rule.status as RuleStatus) ||
      typeof rule.summary !== "string" ||
      !rule.summary.trim()
    )
      failures.push(`rules.${id}: status and summary required`);
  }
  return failures;
}

function confirmedSubsidy(
  year: number,
  subsidyRegistry: typeof parameterRegistry,
) {
  const value = subsidyRegistry[year];
  return isSubsidyParameters(value) && value.status === "confirmed"
    ? value
    : undefined;
}

/** Any invalid, missing or unconfirmed file gives parameters_unconfirmed; no year falls back to another. */
export function ichraParameters(
  year: number,
  registry: Readonly<Record<number, unknown>> = ichraRegistry,
  subsidyRegistry: Readonly<Record<number, unknown>> = parameterRegistry,
): IchraParameterLookup {
  const file = registry[year];
  const errors = ichraParameterErrors(file);
  if (errors.length)
    return { status: "parameters_unconfirmed", reason: "invalid_or_missing" };
  const parameters = file as IchraParameterFile;
  if (parameters.status !== "confirmed" || parameters.year.value !== year)
    return { status: "parameters_unconfirmed", reason: "unconfirmed" };
  const subsidy = confirmedSubsidy(year, subsidyRegistry);
  if (!subsidy)
    return {
      status: "parameters_unconfirmed",
      reason: "required_contribution_percentage_unconfirmed",
    };
  const rules = Object.fromEntries(
    RULE_IDS.map((id) => [
      id,
      {
        id,
        status: parameters.rules[id].value.status,
        summary: parameters.rules[id].value.summary,
        citations: parameters.rules[id].citations,
      },
    ]),
  ) as Record<RuleId, RuleEntry>;
  return {
    status: "confirmed",
    parameters: {
      year,
      lcspPremiumBasisDefault: parameters.lcspPremiumBasisDefault.value,
      rateOfPayHours: parameters.rateOfPayHours.value,
      lowestAgeBandRatingAge: parameters.lowestAgeBand.value.ratingAge,
      guidelines: parameters.fplSafeHarbor.guidelines.value,
      rules,
      requiredContributionBasisPoints:
        subsidy.requiredContributionPercentageBasisPoints.value,
      requiredContributionCitations:
        subsidy.requiredContributionPercentageBasisPoints.citations,
    },
  };
}

export interface PovertyLine {
  readonly guidelineYear: number;
  readonly annualDollars: number;
  readonly citations: readonly Citation[];
}
/**
 * One-person poverty line for a guideline year, read from the confirmed subsidy table that
 * carries that guideline year. Alaska and Hawaii have their own tables (54.4980H-5(e)(2)(iv)).
 */
export function onePersonPovertyLine(
  guidelineYear: number,
  state: string,
  subsidyRegistry: Readonly<Record<number, unknown>> = parameterRegistry,
): PovertyLine | null {
  for (const key of Object.keys(subsidyRegistry)) {
    const subsidy = confirmedSubsidy(Number(key), subsidyRegistry);
    if (!subsidy || subsidy.fplGuidelineYear.value !== guidelineYear) continue;
    let region: "alaska" | "hawaii" | "contiguous" = "contiguous";
    if (state === "AK") region = "alaska";
    else if (state === "HI") region = "hawaii";
    const table = subsidy.fpl[region].annualDollarsBySize;
    return {
      guidelineYear,
      annualDollars: table.value[0]!,
      citations: table.citations,
    };
  }
  return null;
}
