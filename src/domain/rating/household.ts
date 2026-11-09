import {
  applicableRows,
  checkedCents,
  dateParts,
  isUnsupported,
  selectRateRow,
  validateAge,
} from "./rate-row.js";
import type {
  Household,
  HouseholdMember,
  HouseholdPremium,
  MemberPremium,
  PremiumIssue,
  RateRow,
} from "./types.js";

/** Completed years at coverage start. A Feb 29 birthday advances on March 1 in non-leap years. */
export function ageOnDate(
  dateOfBirth: string,
  coverageStartDate: string,
): number {
  const birth = dateParts(dateOfBirth),
    start = dateParts(coverageStartDate);
  if (dateOfBirth > coverageStartDate)
    throw new RangeError("Birth date is after coverage start");
  const beforeBirthday =
    start.month < birth.month ||
    (start.month === birth.month && start.day < birth.day);
  return start.year - birth.year - Number(beforeBirthday);
}

function memberAge(member: HouseholdMember, date: string): number {
  if (member.age !== undefined && member.dateOfBirth !== undefined)
    throw new RangeError("Provide age OR dateOfBirth");
  if (member.age !== undefined) {
    validateAge(member.age);
    return member.age;
  }
  if (member.dateOfBirth === undefined)
    throw new RangeError("An age or dateOfBirth is required");
  return ageOnDate(member.dateOfBirth, date);
}

export function householdMembers(household: Household) {
  dateParts(household.coverageStartDate);
  if (!household.members.length)
    throw new RangeError("At least one covered member is required");
  const ids = new Set<string>();
  return household.members.map((member, index) => {
    if (!member.id || ids.has(member.id))
      throw new RangeError("Member IDs must be present and unique");
    ids.add(member.id);
    if (typeof member.tobaccoUse !== "boolean")
      throw new RangeError("Tobacco use must be explicit");
    if (
      !["subscriber", "spouse", "child", "other"].includes(member.relationship)
    )
      throw new RangeError("Invalid relationship");
    return {
      member,
      age: memberAge(member, household.coverageStartDate),
      index,
    };
  });
}

/** Overrides require separately cited market rules or filed dental business rules. */
export interface PerMemberPolicy {
  maximumRatedChildren: number;
  noPreferenceUsesIndividual: boolean;
}

/** Filed per-member gross monthly premium only. No geography, eligibility or subsidy inference. */
export function householdPremium(
  rows: readonly RateRow[],
  plan: string,
  ratingArea: string,
  household: Household,
  policy: PerMemberPolicy = {
    maximumRatedChildren: 3,
    noPreferenceUsesIndividual: false,
  },
): HouseholdPremium {
  const aged = householdMembers(household);
  if (
    !Number.isSafeInteger(policy.maximumRatedChildren) ||
    policy.maximumRatedChildren < 1
  )
    throw new RangeError("Invalid child rating limit");
  const trace = {
    planId: plan,
    ratingAreaId: ratingArea,
    coverageStartDate: household.coverageStartDate,
    ratingMethod: household.ratingMethod,
    currency: "USD" as const,
    period: "month" as const,
  };
  const unsupported = applicableRows(
    rows,
    plan,
    ratingArea,
    household.coverageStartDate,
  ).filter(isUnsupported);
  if (household.ratingMethod !== "per_member" || unsupported.length) {
    return {
      ...trace,
      status: "unsupported_rating_method",
      totalCents: null,
      members: [],
      rowsUsed: unsupported,
      issues: [
        {
          memberId: null,
          status: "unsupported_rating_method",
          reason:
            "Family-tier, state family-tier and composite methods require a separate adapter",
          rateRows: unsupported,
        },
      ],
    };
  }
  // Same completed age: DOB breaks ties when both are known, otherwise input order.
  // Equal-age children share an age rate; never sort by price or tobacco surcharge.
  const chargedChildren = new Set(
    aged
      .filter(({ member, age }) => member.relationship === "child" && age < 21)
      .sort(
        (a, b) =>
          b.age - a.age ||
          (a.member.dateOfBirth && b.member.dateOfBirth
            ? a.member.dateOfBirth.localeCompare(b.member.dateOfBirth)
            : 0) ||
          a.index - b.index,
      )
      .slice(0, policy.maximumRatedChildren)
      .map(({ index }) => index),
  );
  const issues: PremiumIssue[] = [];
  const members: MemberPremium[] = aged.map(({ member, age, index }) => {
    const input = {
      memberId: member.id,
      age,
      relationship: member.relationship,
      tobaccoUse: member.tobaccoUse,
    };
    if (
      member.relationship === "child" &&
      age < 21 &&
      !chargedChildren.has(index)
    ) {
      return {
        ...input,
        charged: false,
        status: "not_charged",
        premiumCents: checkedCents(0),
        rateRows: [],
      };
    }
    const selection = selectRateRow(
      rows,
      plan,
      ratingArea,
      age,
      member.tobaccoUse,
      household.coverageStartDate,
    );
    if (selection.status !== "selected") {
      issues.push({
        memberId: member.id,
        status: selection.status,
        reason: selection.status,
        rateRows: selection.rows,
      });
      return {
        ...input,
        charged: true,
        status: selection.status,
        premiumCents: null,
        rateRows: selection.rows,
      };
    }
    const row = selection.row;
    const premiumCents =
      member.tobaccoUse &&
      !(policy.noPreferenceUsesIndividual && row.tobacco === "No Preference")
        ? row.individualTobaccoRateCents
        : row.individualRateCents;
    if (premiumCents === null) {
      issues.push({
        memberId: member.id,
        status: "unknown",
        reason: member.tobaccoUse
          ? "missing_individual_tobacco_rate"
          : "missing_individual_rate",
        rateRows: [row],
      });
    }
    return {
      ...input,
      charged: true,
      status: premiumCents === null ? "unknown" : "rated",
      premiumCents,
      rateRows: [row],
    };
  });
  const rowsUsed = [...new Set(members.flatMap((member) => member.rateRows))];
  // Retain all member failures. No numeric partial household total escapes on failure.
  const firstIssue = issues[0];
  if (firstIssue)
    return {
      ...trace,
      status: firstIssue.status,
      totalCents: null,
      members,
      rowsUsed,
      issues,
    };
  const totalCents = members.reduce(
    (sum, member) => checkedCents(sum + member.premiumCents!),
    checkedCents(0),
  );
  return {
    ...trace,
    status: "rated",
    totalCents,
    members,
    rowsUsed,
    issues: [],
  };
}
