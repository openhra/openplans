/** Cited policy data, validated without I/O. Percentages are integer basis points (210 = 2.10%). */
export interface Citation {
  readonly url: string;
  readonly title: string;
  readonly section: string;
  readonly retrievedOn: string;
}
export interface Cited<T> {
  readonly value: T;
  readonly citations: readonly Citation[];
}
export interface PercentageBand {
  readonly lowerFplPercent: number;
  readonly upperFplPercent: number;
  readonly initialBasisPoints: number;
  readonly finalBasisPoints: number;
}
export interface PovertyTable {
  /** Index 0 is a one-person tax family, index 7 an eight-person tax family. */
  readonly annualDollarsBySize: Cited<readonly number[]>;
  readonly additionalPersonDollars: Cited<number>;
}
export interface SubsidyParameters {
  readonly schemaVersion: 1;
  readonly year: Cited<number>;
  readonly status: "confirmed" | "unconfirmed";
  readonly statusReason: string;
  readonly fplGuidelineYear: Cited<number>;
  readonly fpl: Readonly<
    Record<"contiguous" | "alaska" | "hawaii", PovertyTable>
  >;
  readonly applicablePercentageBands: Cited<readonly PercentageBand[]>;
  /** Employer affordability threshold; deliberately NOT used as the household applicable percentage. */
  readonly requiredContributionPercentageBasisPoints: Cited<number>;
  readonly minimumFplPercent: Cited<number>;
  readonly maximumFplPercent: Cited<number | null>;
  /** Conservative review screen, not a Medicaid eligibility rule. */
  readonly stateRulesReviewThroughFplPercent: Cited<number>;
  readonly rounding: Cited<{
    readonly fpl: "truncate_whole_percent_exact_cliff";
    readonly applicablePercentage: "nearest_basis_point_half_up";
    readonly annualContribution: "nearest_dollar_half_up";
    readonly monthlyContribution: "annual_rounded_then_divide_12_nearest_dollar_half_up";
  }>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const PRIMARY_HOSTS = new Set([
  "www.irs.gov",
  "www.govinfo.gov",
  "www.federalregister.gov",
  "aspe.hhs.gov",
  "www.ecfr.gov",
  "uscode.house.gov",
  "www.healthcare.gov",
  "www.cms.gov",
]);
function cited(value: unknown, path: string, failures: string[]): unknown {
  if (
    !record(value) ||
    !("value" in value) ||
    !Array.isArray(value.citations) ||
    !value.citations.length
  ) {
    failures.push(`${path}: value and primary-source citations required`);
    return undefined;
  }
  for (const citation of value.citations) {
    if (!record(citation)) {
      failures.push(`${path}: invalid citation`);
      continue;
    }
    let primary = false;
    try {
      const url = new URL(String(citation.url));
      primary =
        url.protocol === "https:" &&
        PRIMARY_HOSTS.has(url.hostname) &&
        !url.username &&
        !url.password;
    } catch {
      /* Invalid URL is reported below. */
    }
    const date = citation.retrievedOn;
    if (
      !primary ||
      typeof citation.title !== "string" ||
      !citation.title.trim() ||
      typeof citation.section !== "string" ||
      !citation.section.trim() ||
      typeof date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date
    ) {
      failures.push(
        `${path}: valid primary URL, title, section and retrieval date required`,
      );
    }
  }
  return value.value;
}
const positiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** A schema/citation check proves traceability, not that a publisher has not subsequently changed policy. */
export function parameterErrors(value: unknown): string[] {
  const failures: string[] = [];
  if (!record(value)) return ["parameters: expected object"];
  if (value.schemaVersion !== 1) failures.push("schemaVersion: expected 1");
  if (!["confirmed", "unconfirmed"].includes(String(value.status)))
    failures.push("status: expected confirmed or unconfirmed");
  if (typeof value.statusReason !== "string" || !value.statusReason.trim())
    failures.push("statusReason: required");
  const year = cited(value.year, "year", failures);
  const guidelineYear = cited(
    value.fplGuidelineYear,
    "fplGuidelineYear",
    failures,
  );
  if (!positiveInteger(year) || year < 2000 || year > 2100)
    failures.push("year: unsupported coverage year");
  if (typeof year !== "number" || guidelineYear !== year - 1)
    failures.push("fplGuidelineYear: expected prior calendar year");
  for (const region of ["contiguous", "alaska", "hawaii"]) {
    const table = record(value.fpl) ? value.fpl[region] : undefined;
    const dollars = cited(
      record(table) ? table.annualDollarsBySize : undefined,
      `fpl.${region}.annualDollarsBySize`,
      failures,
    );
    const extra = cited(
      record(table) ? table.additionalPersonDollars : undefined,
      `fpl.${region}.additionalPersonDollars`,
      failures,
    );
    if (
      !positiveInteger(extra) ||
      !Array.isArray(dollars) ||
      dollars.length !== 8 ||
      !dollars.every(positiveInteger)
    ) {
      failures.push(
        `fpl.${region}: eight positive dollar amounts and additional-person increment required`,
      );
    } else if (dollars.some((n, i) => i > 0 && n - dollars[i - 1]! !== extra)) {
      failures.push(`fpl.${region}: inconsistent increments`);
    }
  }
  const min = cited(value.minimumFplPercent, "minimumFplPercent", failures);
  const max = cited(value.maximumFplPercent, "maximumFplPercent", failures);
  const review = cited(
    value.stateRulesReviewThroughFplPercent,
    "stateRulesReviewThroughFplPercent",
    failures,
  );
  if (
    !positiveInteger(min) ||
    (max !== null && (!positiveInteger(max) || max <= min))
  )
    failures.push("FPL limits: invalid");
  if (!positiveInteger(review) || typeof min !== "number" || review < min)
    failures.push("state review threshold: invalid");
  const required = cited(
    value.requiredContributionPercentageBasisPoints,
    "requiredContributionPercentageBasisPoints",
    failures,
  );
  if (!positiveInteger(required) || required > 10000)
    failures.push("required contribution: invalid basis points");
  const bands = cited(
    value.applicablePercentageBands,
    "applicablePercentageBands",
    failures,
  );
  if (!Array.isArray(bands) || !bands.length)
    failures.push("applicablePercentageBands: nonempty table required");
  else {
    let previousUpper: unknown = min;
    for (const band of bands) {
      if (
        !record(band) ||
        !positiveInteger(band.lowerFplPercent) ||
        !positiveInteger(band.upperFplPercent) ||
        band.lowerFplPercent !== previousUpper ||
        band.upperFplPercent <= band.lowerFplPercent ||
        !Number.isSafeInteger(band.initialBasisPoints) ||
        !Number.isSafeInteger(band.finalBasisPoints) ||
        Number(band.initialBasisPoints) < 0 ||
        Number(band.finalBasisPoints) < Number(band.initialBasisPoints) ||
        Number(band.finalBasisPoints) > 10000
      )
        failures.push(
          "applicablePercentageBands: invalid or noncontiguous band",
        );
      previousUpper = record(band) ? band.upperFplPercent : undefined;
    }
    if (max !== null && previousUpper !== max)
      failures.push("applicablePercentageBands: must end at cliff");
  }
  const rounding = cited(value.rounding, "rounding", failures);
  if (
    !record(rounding) ||
    rounding.fpl !== "truncate_whole_percent_exact_cliff" ||
    rounding.applicablePercentage !== "nearest_basis_point_half_up" ||
    rounding.annualContribution !== "nearest_dollar_half_up" ||
    rounding.monthlyContribution !==
      "annual_rounded_then_divide_12_nearest_dollar_half_up"
  )
    failures.push("rounding: unsupported policy");
  return failures;
}
export function isSubsidyParameters(
  value: unknown,
): value is SubsidyParameters {
  return parameterErrors(value).length === 0;
}
