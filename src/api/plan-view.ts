export const PLAN_COLUMN_KEYS = [
  "BusinessYear",
  "StateCode",
  "StandardComponentId",
  "PlanId",
  "PlanType",
  "IsHSAEligible",
  "PlanEffectiveDate",
  "PlanExpirationDate",
  "FormularyURL",
  "IsReferralRequiredForSpecialist",
  "PlanVariantMarketingName",
  "IssuerActuarialValue",
  "DesignType",
  "EHBPercentTotalPremium",
  "URLForSummaryofBenefitsCoverage",
  "PlanBrochure",
] as const;

export type PublishedPlanAttributes = Partial<
  Record<(typeof PLAN_COLUMN_KEYS)[number], string>
>;

/** Keep only the converted plan columns from a header-normalized published row. */
export function publishedPlanColumns(
  raw: Record<string, string>,
): PublishedPlanAttributes {
  return Object.fromEntries(
    PLAN_COLUMN_KEYS.filter((key) => raw[key] !== undefined).map((key) => [
      key,
      raw[key],
    ]),
  );
}

// A symbol keeps conversion cells out of native JSON responses.
export const FEDERAL_PLAN_ATTRIBUTES = Symbol.for(
  "openplans.federal_plan_attributes",
);
