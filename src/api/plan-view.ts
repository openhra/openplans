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
] as const;

export type PublishedPlanAttributes = Partial<
  Record<(typeof PLAN_COLUMN_KEYS)[number], string>
>;

// A symbol keeps conversion cells out of native JSON responses.
export const FEDERAL_PLAN_ATTRIBUTES = Symbol.for(
  "openplans.federal_plan_attributes",
);
