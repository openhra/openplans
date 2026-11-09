import { FAMILY_RATE_FIELDS } from "./types.js";
import type {
  AgeBand,
  Cents,
  CmsRateRow,
  RateProvenance,
  RateRow,
  RateSelection,
  RatingMethod,
  Tobacco,
} from "./types.js";

/** Decimal text to cents, without floating-point dollar arithmetic or rounding. */
export function parseCents(value: string): Cents {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) throw new RangeError(`Invalid dollar amount: ${value}`);
  return checkedCents(
    Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0")),
  );
}

export function checkedCents(value: number): Cents {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError("Cents must be a nonnegative safe integer");
  return value as Cents;
}

/** Strict calendar dates only; no clock, local timezone, or permissive Date parsing. */
export function dateParts(value: string): {
  year: number;
  month: number;
  day: number;
} {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new RangeError("Expected a YYYY-MM-DD date");
  const year = Number(match[1]),
    month = Number(match[2]),
    day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1]!
  ) {
    throw new RangeError("Invalid calendar date");
  }
  return { year, month, day };
}

export function validateAge(age: number): void {
  if (!Number.isSafeInteger(age) || age < 0)
    throw new RangeError("Age must be nonnegative completed years");
}

function parseAgeBand(value: string): AgeBand {
  if (value === "0-14" || value === "64 and over" || value === "Family Option")
    return value;
  if (/^(?:1[5-9]|[2-5][0-9]|6[0-3])$/.test(value)) return Number(value);
  throw new RangeError(`Unsupported CMS age band: ${value}`);
}

/** Pure adapter; I/O and CSV decoding belong to ingestion. Empty prices stay null. */
export function parseRateRow(
  raw: CmsRateRow,
  provenance: RateProvenance,
  method?: RatingMethod,
): RateRow {
  if (!/^\d{4}$/.test(raw.BusinessYear) || Number(raw.BusinessYear) < 1)
    throw new RangeError("Invalid business year");
  dateParts(raw.RateEffectiveDate);
  dateParts(raw.RateExpirationDate);
  if (raw.RateEffectiveDate > raw.RateExpirationDate)
    throw new RangeError("Reversed rate interval");
  if (!raw.PlanId || !raw.RatingAreaId || !raw.StateCode)
    throw new RangeError("Missing rate identity");
  if (
    !["", "No Preference", "Tobacco User/Non-Tobacco User"].includes(
      raw.Tobacco,
    )
  ) {
    throw new RangeError(
      `Unsupported CMS tobacco classification: ${raw.Tobacco}`,
    );
  }
  if (
    !provenance.snapshotId ||
    !provenance.sourceFile ||
    !Number.isSafeInteger(provenance.sourceRowNumber) ||
    provenance.sourceRowNumber < 2
  )
    throw new RangeError("A source snapshot, file and CSV row are required");
  const age = parseAgeBand(raw.Age);
  const amount = (value: string) => (value === "" ? null : parseCents(value));
  const familyRatesCents = Object.fromEntries(
    FAMILY_RATE_FIELDS.map((key) => [key, amount(raw[key])]),
  ) as RateRow["familyRatesCents"];
  // Preserve every family column (including zero); never reinterpret it as a member rate.
  const hasFamilyRates = Object.values(familyRatesCents).some(
    (value) => value !== null,
  );
  return {
    businessYear: Number(raw.BusinessYear),
    stateCode: raw.StateCode,
    planId: raw.PlanId,
    ratingAreaId: raw.RatingAreaId,
    age,
    tobacco: raw.Tobacco as Tobacco,
    effectiveDate: raw.RateEffectiveDate,
    expirationDate: raw.RateExpirationDate,
    individualRateCents: amount(raw.IndividualRate),
    individualTobaccoRateCents: amount(raw.IndividualTobaccoRate),
    familyRatesCents,
    ratingMethod:
      age === "Family Option" || hasFamilyRates
        ? "family_tier"
        : (method ?? "per_member"),
    provenance: { ...provenance },
    raw: { ...raw },
  };
}

function matchesTobacco(row: RateRow, tobacco: boolean): boolean {
  // Both published categories apply to either applicant. The dual category stores
  // the tobacco price in a separate column; No Preference never supplies a fallback price.
  return (
    typeof tobacco === "boolean" &&
    (row.tobacco === "No Preference" ||
      row.tobacco === "Tobacco User/Non-Tobacco User")
  );
}

export function applicableRows(
  rows: readonly RateRow[],
  plan: string,
  ratingArea: string,
  date: string,
): RateRow[] {
  const { year } = dateParts(date);
  return rows.filter(
    (row) =>
      row.planId === plan &&
      row.ratingAreaId === ratingArea &&
      row.businessYear === year &&
      row.effectiveDate <= date &&
      date <= row.expirationDate,
  );
}

export function isUnsupported(row: RateRow): boolean {
  return (
    ["NY", "VT"].includes(row.stateCode) ||
    row.ratingMethod !== "per_member" ||
    row.age === "Family Option" ||
    Object.values(row.familyRatesCents).some((value) => value !== null)
  );
}

/** Exact plan/area/year/date/age/tobacco applicability; never choose the first duplicate. */
export function selectRateRow(
  rows: readonly RateRow[],
  plan: string,
  ratingArea: string,
  age: number,
  tobacco: boolean,
  date: string,
): RateSelection {
  validateAge(age);
  const applicable = applicableRows(rows, plan, ratingArea, date);
  const unsupported = applicable.filter(isUnsupported);
  if (unsupported.length)
    return { status: "unsupported_rating_method", rows: unsupported };
  const band = age <= 14 ? "0-14" : age >= 64 ? "64 and over" : age;
  const matches = applicable.filter(
    (row) => row.age === band && matchesTobacco(row, tobacco),
  );
  if (matches.length === 0) return { status: "missing", rows: [] };
  if (matches.length > 1) return { status: "ambiguous", rows: matches };
  return { status: "selected", row: matches[0]! };
}
