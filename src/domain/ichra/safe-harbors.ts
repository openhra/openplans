import { ageOnDate } from "../rating/household.js";
import { dateParts } from "../rating/rate-row.js";
import type { PovertyGuideline } from "./parameters.js";

/**
 * Prop. 26 CFR 54.4980H-5(f)(7)(i): age on the first day of the plan year, or on the date the
 * HRA can first take effect for an employee who becomes eligible later in the plan year.
 */
export function applicableAge(
  dateOfBirth: string,
  planStart: string,
  eligibleFrom: string | null = null,
): number {
  const reference =
    eligibleFrom !== null && eligibleFrom > planStart
      ? eligibleFrom
      : planStart;
  return ageOnDate(dateOfBirth, reference);
}

/** A plan year that starts on January 1 is a calendar-year plan. */
export function isCalendarYearPlan(planStart: string): boolean {
  const { month, day } = dateParts(planStart);
  return month === 1 && day === 1;
}

/**
 * Prop. 54.4980H-5(f)(4)(i): January of the prior calendar year for a calendar-year plan,
 * January of the current calendar year otherwise.
 */
export function lookBackMonth(planStart: string): string {
  const { year } = dateParts(planStart);
  return `${isCalendarYearPlan(planStart) ? year - 1 : year}-01-01`;
}

/** The first day of the month that contains `date`. */
export function monthStart(date: string): string {
  const { year, month } = dateParts(date);
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

export type LcspLocationSource = "residence" | "worksite";
/**
 * 1.36B-2(c)(5)(ii)(A) uses the residence. Prop. (f)(6)(i)-(ii) lets an employer use the primary
 * site of employment instead; a remote employee with no site to report to uses the residence.
 */
export function lcspLocationSource(
  locationSafeHarbor: boolean,
  worksite: { readonly remote: boolean } | null,
): LcspLocationSource {
  return locationSafeHarbor && worksite && !worksite.remote
    ? "worksite"
    : "residence";
}

/**
 * The newest known guideline whose effective date is on or before the plan start. When it is the
 * newest guideline on file and its successor year has begun, the successor may already be in
 * effect, so the six-month allowance (79 FR 8565) must cover it instead; otherwise null.
 * Conservative assumption: guidelines for year Y never take effect before January 1 of Y.
 */
export function guidelineInEffect(
  planStart: string,
  guidelines: readonly PovertyGuideline[],
): PovertyGuideline | null {
  let index = -1;
  guidelines.forEach((g, i) => {
    if (g.effectiveDate <= planStart) index = i;
  });
  if (index < 0) return null;
  const chosen = guidelines[index]!;
  if (index < guidelines.length - 1) return chosen;
  if (planStart < `${chosen.guidelineYear + 1}-01-01`) return chosen;
  const { year, month, day } = dateParts(planStart);
  const sixMonthsBefore =
    month > 6
      ? `${year}-${String(month - 6).padStart(2, "0")}-${String(day).padStart(2, "0")}`
      : `${year - 1}-${String(month + 6).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return sixMonthsBefore < `${chosen.guidelineYear + 1}-01-01` &&
    chosen.effectiveDate <= sixMonthsBefore
    ? chosen
    : null;
}
