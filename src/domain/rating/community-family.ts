import { ageOnDate } from "./household.js";
import { checkedCents, dateParts, validateAge } from "./rate-row.js";
import type { Cents, HouseholdMember } from "./types.js";

export const COMMUNITY_TIERS = [
  "single",
  "couple",
  "adult_children",
  "family",
] as const;
export type CommunityTier = (typeof COMMUNITY_TIERS)[number];
export interface CommunityFamilyRule {
  state: "NY" | "VT";
  market: "individual";
  method: "community_family_tier";
  age_factor: "none";
  tobacco_factor: "none";
  plan_year: number;
  tiers: Record<CommunityTier, number>;
  denominator: number;
  dependent_age_exclusive: number;
  citation: string;
  references: string[];
  mapping: string;
}
export interface CommunityRate {
  state: "NY" | "VT";
  planYear: number;
  planKey: string;
  region: string;
  prices: Readonly<Record<CommunityTier, Cents>>;
  childOnly: boolean;
  provenance: { sourceUrl: string; sourceSha256: string; sourceRecord: string };
}
export type CommunityPremium = {
  ratingMethod: "community_family_tier";
  currency: "USD";
  period: "month";
  rate: CommunityRate;
  rule: CommunityFamilyRule | null;
} & (
  | {
      status: "rated";
      totalCents: Cents;
      tier: CommunityTier;
      priceBasis: "filed_tier";
      multiplier: { numerator: number; denominator: number };
    }
  | { status: "unsupported_rating_method"; totalCents: null; reason: string }
);

/** Gross monthly medical rates for a single contract. Eligibility is resolved upstream.
 * Only the evidenced parent/spouse/child subset is supported; never infer extensions. */
export function communityFamilyPremium(
  rule: CommunityFamilyRule | null,
  rate: CommunityRate,
  members: readonly HouseholdMember[],
  coverageStart: string,
): CommunityPremium {
  const { year } = dateParts(coverageStart);
  if (!members.length)
    throw new RangeError("At least one covered member is required");
  const trace = {
    ratingMethod: "community_family_tier" as const,
    currency: "USD" as const,
    period: "month" as const,
    rate,
    rule,
  };
  const unsupported = (reason: string): CommunityPremium => ({
    ...trace,
    status: "unsupported_rating_method",
    totalCents: null,
    reason,
  });
  if (
    !rule ||
    rule.method !== "community_family_tier" ||
    rule.market !== "individual" ||
    rule.state !== rate.state ||
    rule.plan_year !== year ||
    rate.planYear !== year ||
    rule.age_factor !== "none" ||
    rule.tobacco_factor !== "none"
  ) {
    return unsupported("NO_APPLICABLE_COMMUNITY_RULE");
  }
  if (rate.childOnly)
    return unsupported("CHILD_ONLY_POLICY_REQUIRES_SEPARATE_ADAPTER");
  const ids = new Set<string>();
  const aged = members.map((member) => {
    if (
      !member.id ||
      ids.has(member.id) ||
      typeof member.tobaccoUse !== "boolean"
    )
      throw new RangeError("Invalid covered member");
    ids.add(member.id);
    if (member.age !== undefined && member.dateOfBirth !== undefined)
      throw new RangeError("Provide age OR dateOfBirth");
    if (member.age === undefined && member.dateOfBirth === undefined)
      throw new RangeError("Member age is required");
    const age = member.age ?? ageOnDate(member.dateOfBirth!, coverageStart);
    validateAge(age);
    return { ...member, age };
  });
  if (
    aged.filter((m) => m.relationship === "subscriber").length !== 1 ||
    aged.filter((m) => m.relationship === "spouse").length > 1 ||
    aged.some(
      (m) => !["subscriber", "spouse", "child"].includes(m.relationship),
    )
  )
    return unsupported("UNSUPPORTED_HOUSEHOLD_RELATIONSHIPS");
  if (aged.some((m) => m.relationship !== "child" && m.age < 18))
    return unsupported("CHILD_ONLY_OR_MINOR_SUBSCRIBER_REQUIRES_EVIDENCE");
  if (
    aged.some(
      (m) =>
        m.relationship === "child" && m.age >= rule.dependent_age_exclusive,
    )
  ) {
    return unsupported("DEPENDENT_EXTENSION_REQUIRES_EVIDENCE");
  }
  const adults = aged.filter((m) => m.relationship !== "child").length;
  const children = aged.length - adults;
  let tier: CommunityTier;
  if (children) {
    if (adults === 1) {
      tier = "adult_children";
    } else {
      tier = "family";
    }
  } else if (adults === 1) {
    tier = "single";
  } else {
    tier = "couple";
  }
  // Filed tiers preserve the issuer's component and base-rate rounding. Re-multiplying
  // an already rounded single rate can change an approved premium by several cents.
  const price = rate.prices[tier];
  checkedCents(price);
  return {
    ...trace,
    status: "rated",
    tier,
    totalCents: price,
    priceBasis: "filed_tier",
    multiplier: { numerator: rule.tiers[tier], denominator: rule.denominator },
  };
}
