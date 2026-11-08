/** CMS CSV fields remain strings, including blanks and the non-numeric age bands. */
export interface CmsRateRow {
  readonly BusinessYear: string;
  readonly StateCode: string;
  readonly IssuerId: string;
  readonly SourceName: string;
  readonly ImportDate: string;
  readonly RateEffectiveDate: string;
  readonly RateExpirationDate: string;
  readonly PlanId: string;
  readonly RatingAreaId: string;
  readonly Tobacco: string;
  readonly Age: string;
  readonly IndividualRate: string;
  readonly IndividualTobaccoRate: string;
  readonly Couple: string;
  readonly PrimarySubscriberAndOneDependent: string;
  readonly PrimarySubscriberAndTwoDependents: string;
  readonly PrimarySubscriberAndThreeOrMoreDependents: string;
  readonly CoupleAndOneDependent: string;
  readonly CoupleAndTwoDependents: string;
  readonly CoupleAndThreeOrMoreDependents: string;
}

declare const centsBrand: unique symbol;
export type Cents = number & { readonly [centsBrand]: true };
export type AgeBand = '0-14' | number | '64 and over' | 'Family Option';
export type Tobacco = 'No Preference' | 'Tobacco User/Non-Tobacco User' | '';
export type RatingMethod = 'per_member' | 'family_tier' | 'composite' | 'community_family_tier';
export type Relationship = 'subscriber' | 'spouse' | 'child' | 'other';

export interface RateProvenance {
  readonly snapshotId: string;
  readonly sourceFile: string;
  /** One-based CSV record number, including the header. */
  readonly sourceRowNumber: number;
}

export const FAMILY_RATE_FIELDS = [
  'Couple', 'PrimarySubscriberAndOneDependent', 'PrimarySubscriberAndTwoDependents',
  'PrimarySubscriberAndThreeOrMoreDependents', 'CoupleAndOneDependent',
  'CoupleAndTwoDependents', 'CoupleAndThreeOrMoreDependents',
] as const;

export interface RateRow {
  readonly businessYear: number;
  readonly stateCode: string;
  readonly planId: string;
  readonly ratingAreaId: string;
  readonly age: AgeBand;
  readonly tobacco: Tobacco;
  readonly effectiveDate: string;
  readonly expirationDate: string;
  readonly individualRateCents: Cents | null;
  readonly individualTobaccoRateCents: Cents | null;
  readonly familyRatesCents: Readonly<Record<typeof FAMILY_RATE_FIELDS[number], Cents | null>>;
  readonly ratingMethod: RatingMethod;
  readonly provenance: RateProvenance;
  readonly raw: Readonly<CmsRateRow>;
}

export type HouseholdMember = {
  readonly id: string;
  readonly relationship: Relationship;
  readonly tobaccoUse: boolean;
} & (
  | { /** Completed years on coverageStartDate, NOT age today. */ readonly age: number; readonly dateOfBirth?: never }
  | { readonly dateOfBirth: string; readonly age?: never }
);

export interface Household {
  readonly members: readonly HouseholdMember[];
  readonly coverageStartDate: string;
  /** Resolve from the applicable business/state rules before calling this engine. */
  readonly ratingMethod: RatingMethod;
}

export type RateSelection =
  | { readonly status: 'selected'; readonly row: RateRow }
  | { readonly status: 'missing'; readonly rows: readonly RateRow[] }
  | { readonly status: 'ambiguous'; readonly rows: readonly RateRow[] }
  | { readonly status: 'unsupported_rating_method'; readonly rows: readonly RateRow[] };

export type PremiumFailure = 'unknown' | 'missing' | 'ambiguous' | 'unsupported_rating_method';
export interface MemberPremium {
  readonly memberId: string;
  readonly age: number;
  readonly relationship: Relationship;
  readonly tobaccoUse: boolean;
  readonly charged: boolean;
  readonly status: 'rated' | 'not_charged' | PremiumFailure;
  readonly premiumCents: Cents | null;
  readonly rateRows: readonly RateRow[];
}

export interface PremiumIssue {
  readonly memberId: string | null;
  readonly status: PremiumFailure;
  readonly reason: string;
  readonly rateRows: readonly RateRow[];
}

interface PremiumTrace {
  readonly planId: string;
  readonly ratingAreaId: string;
  readonly coverageStartDate: string;
  readonly ratingMethod: RatingMethod;
  readonly currency: 'USD';
  readonly period: 'month';
  readonly members: readonly MemberPremium[];
  readonly rowsUsed: readonly RateRow[];
}

export type HouseholdPremium = PremiumTrace & (
  | { readonly status: 'rated'; readonly totalCents: Cents; readonly issues: readonly [] }
  | { readonly status: PremiumFailure; readonly totalCents: null; readonly issues: readonly PremiumIssue[] }
);
