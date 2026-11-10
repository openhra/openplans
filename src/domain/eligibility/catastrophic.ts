import { ageOnDate } from "../rating/household.js";
import type { HouseholdMember } from "../rating/types.js";

/**
 * 45 CFR 156.155(a): a catastrophic plan may enroll only people who have not attained
 * age 30 before the first day of the plan year, or who hold a hardship or affordability
 * exemption certificate.
 */
export const CATASTROPHIC_AGE_LIMIT = 30;

export type CatastrophicEligibility = "eligible" | "requires_exemption";

/** Age at the start of the plan year, or the lowest age it can be when only a later age is known. */
function planYearStartAge(
  member: HouseholdMember,
  coverageStart: string,
  planYear: number,
) {
  const yearStart = `${planYear}-01-01`;
  if (member.dateOfBirth !== undefined)
    return member.dateOfBirth > yearStart
      ? 0
      : ageOnDate(member.dateOfBirth, yearStart);
  // An age stated at a later coverage start can exceed the plan-year-start age by one.
  return coverageStart === yearStart ? member.age : member.age - 1;
}

/**
 * Applies the age rule to a household. A stated exemption keeps the plan; otherwise any
 * member who was 30 or older when the plan year began makes the household ineligible.
 */
export function catastrophicEligibility(
  members: readonly HouseholdMember[],
  coverageStart: string,
  planYear: number,
  exemptionStated: boolean,
): CatastrophicEligibility {
  if (exemptionStated) return "eligible";
  return members.some(
    (member) =>
      planYearStartAge(member, coverageStart, planYear) >=
      CATASTROPHIC_AGE_LIMIT,
  )
    ? "requires_exemption"
    : "eligible";
}
