import type { PerMemberPolicy } from "./household.js";

export const CA_INDIVIDUAL_TOBACCO_POLICY = {
  id: "ca-2026-individual-medical-tobacco-1-to-1",
  state: "CA",
  planYear: 2026,
  market: "Individual",
  coverage: "medical",
  effectiveDate: "2026-01-01",
  expirationDate: "2026-12-31",
  policy: {
    maximumRatedChildren: 3,
    noPreferenceUsesIndividual: true,
  } satisfies PerMemberPolicy,
  provenance: {
    citation:
      "CA: CMS Market Rating Reforms, California row, Individual Market / Tobacco Rating Ratio = 1:1; PY2026 reviewed 2026-11-08. For filed No Preference rows use IndividualRate for either applicant tobacco flag. Charge only the three oldest covered children under 21.",
    reference:
      "https://www.cms.gov/cciio/programs-and-initiatives/health-insurance-market-reforms/state-rating",
    source_sha256:
      "b9605306aab2fda5f626295d89ed9d0f3803b3ff4627300c0907efa974b84122",
    source_locator: "California row / Individual Market / Tobacco Rating Ratio",
    reviewed_on: "2026-11-08",
  },
} as const;

interface MedicalPolicyScope {
  state: string;
  planYear: number;
  market: string;
  dentalOnly: boolean;
  coverageStartDate: string;
}

/** Authorization is limited to the reviewed market, coverage, year and interval. */
export function medicalTobaccoPolicy(scope: MedicalPolicyScope) {
  const rule = CA_INDIVIDUAL_TOBACCO_POLICY;
  return !scope.dentalOnly &&
    scope.state === rule.state &&
    scope.planYear === rule.planYear &&
    scope.market === rule.market &&
    scope.coverageStartDate >= rule.effectiveDate &&
    scope.coverageStartDate <= rule.expirationDate
    ? rule
    : null;
}
