import { mappingFixture as fixture } from "./mapping-fixture.js";
import { expect, it } from "vitest";
import {
  mapPlanColumns,
  mapVariantAccumulators,
  mapVariantBenefits,
} from "../../../src/compat/v1/mapping.js";
import { stateDetailColumns } from "../../../src/ingest/state/catalog.js";
import { attributeCostSharing } from "../../../src/domain/csr/index.js";

// Document URLs, DesignType, EHBPercentTotalPremium and the plan dates of each cited row.
const designColumns: Record<string, Record<string, unknown>> = {
  "87226TX0100013": {
    benefits_summary_url:
      "https://api.centene.com/SBC/2026/87226TX0100013-01.pdf",
    plan_documents: [
      {
        type: "summary_of_benefits_and_coverage",
        url: "https://api.centene.com/SBC/2026/87226TX0100013-01.pdf",
      },
      { type: "plan_brochure", url: "https://amb.et/mktbrochure/TX" },
    ],
    standardized_plan: false,
    essential_health_benefits_percentage: 100,
    // The row leaves PlanExpirationDate blank.
    plan_calendar: null,
  },
  "11718TX0140016": {
    benefits_summary_url:
      "https://www.communityhealthchoice.org/wp-content/uploads/2025/08/11718TX0140016-01-2026.pdf",
    plan_documents: [
      {
        type: "summary_of_benefits_and_coverage",
        url: "https://www.communityhealthchoice.org/wp-content/uploads/2025/08/11718TX0140016-01-2026.pdf",
      },
      {
        type: "plan_brochure",
        url: "https://www.communityhealthchoice.org/wp-content/uploads/2025/08/plan-brochure-ultra-select-2026.pdf",
      },
    ],
    standardized_plan: false,
    essential_health_benefits_percentage: 100,
    plan_calendar: "calendar_year",
  },
  "11177NY0220001": {
    // The state file leaves both document URL cells blank.
    benefits_summary_url: null,
    plan_documents: [],
    // The state file prints PLAN DESIGN TYPE and EHB PERCENT PREMIUM ("99%").
    standardized_plan: false,
    essential_health_benefits_percentage: 99,
    plan_calendar: "calendar_year",
  },
  "13627VT0340003": {
    // The state file leaves both document URL cells blank.
    benefits_summary_url: null,
    plan_documents: [],
    // The state file prints PLAN DESIGN TYPE and EHB PERCENT PREMIUM ("99%").
    standardized_plan: false,
    essential_health_benefits_percentage: 99,
    plan_calendar: "calendar_year",
  },
};

it("converts only the selected public row's dates, formulary, HSA, referral, variant name, AV and plan type", () => {
  for (const source of fixture.sources.filter(
    (s) => s.kind === "plan-attributes",
  )) {
    const raw = stateDetailColumns(source.rows[0]!.values);
    const result = mapPlanColumns(raw, raw.PlanId!, 2026, raw.StateCode!);
    expect(result).toEqual({
      plan_type: raw.PlanType,
      hsa_eligible: source.base === "11718TX0140016",
      gated: raw.IsReferralRequiredForSpecialist === "Yes",
      sbc_name: raw.PlanVariantMarketingName,
      actuarial_value: raw.IssuerActuarialValue
        ? Number(raw.IssuerActuarialValue.replace("%", ""))
        : null,
      effective_date: "2026-01-01T00:00:00.000Z",
      expiration_date: raw.PlanExpirationDate
        ? "2026-12-31T00:00:00.000Z"
        : null,
      drug_formulary_url: raw.FormularyURL?.trim() || null,
      ...designColumns[source.base],
    });
    expect(
      mapPlanColumns(raw, `${source.base}-05`, 2026, raw.StateCode!),
    ).toEqual({});
    expect(mapPlanColumns(raw, raw.PlanId!, 2027, raw.StateCode!)).toEqual({});
    expect(mapPlanColumns(raw, raw.PlanId!, 2026, "XX")).toEqual({});
  }
});

it("does not turn empty, malformed, or conditional public cells into facts", () => {
  const source = fixture.sources[0]!;
  const raw: Record<string, string> = {
    ...source.rows[0]!.values,
    PlanEffectiveDate: "2/30/2026",
    IsHSAEligible: "",
    FormularyURL: "javascript:synthetic()",
  };
  expect(mapPlanColumns(raw, raw.PlanId!, 2026, "TX")).toMatchObject({
    effective_date: null,
    hsa_eligible: null,
    drug_formulary_url: null,
  });
  expect(
    mapPlanColumns({ ...raw, IsHSAEligible: "Yes" }, raw.PlanId!, 2026, "TX")
      .hsa_eligible,
  ).toBe(true);
});

it("retains state family cells and distinct medical/drug accumulator scopes", () => {
  const source = fixture.sources.find(
    (s) => s.kind === "plan-attributes" && s.base.includes("VT"),
  )!;
  const raw = stateDetailColumns(source.rows[0]!.values);
  const result = mapVariantAccumulators({
    status: "available",
    ...attributeCostSharing(raw),
  } as Parameters<typeof mapVariantAccumulators>[0]);
  expect(result.individual_medical_deductible).toContain(
    "In-Network Tier 1: $1,500",
  );
  expect(result.individual_drug_deductible).toContain(
    "In-Network Tier 1: $250",
  );
  expect(result.family_medical_deductible).toContain(
    "$1500 per person | $3000 per group",
  );
  expect(result.family_drug_deductible).toContain(
    "$250 per person | $500 per group",
  );
  const tx = fixture.sources[0]!.rows[0]!.values;
  const integrated = mapVariantAccumulators({
    status: "available",
    ...attributeCostSharing(tx),
  } as Parameters<typeof mapVariantAccumulators>[0]);
  expect(integrated.individual_drug_deductible).toEqual(
    integrated.individual_medical_deductible,
  );
  expect(integrated.individual_medical_deductible).toContain(
    "Medical and drug combined",
  );
});

it("reports only published service coverage when a state publication has no network cost cells", () => {
  const source = fixture.sources.find(
    (s) => s.kind === "benefits-and-cost-sharing" && s.base.includes("VT"),
  )!;
  const rows = source.rows.map((r) => {
    const raw = stateDetailColumns(r.values);
    return {
      published_plan_id: raw.PlanId!,
      benefit_name: raw["BENEFIT NAME"]!,
      raw,
      cost_sharing_raw: {},
    };
  });
  const mapped = mapVariantBenefits(rows, source.base + "-01");
  expect(mapped.emergency_room).toContain("Coverage: Covered");
  expect(mapped.emergency_room).toContain("excluded from in-network MOOP: No");
  expect(mapped.chiropractic_services).toBe(true);
  expect(mapVariantBenefits(rows, source.base + "-05")).toEqual({});
});

it("keeps a tier-2-only cost and rejects conflicting supplemental aliases", () => {
  // Synthetic edge case: only the second in-network tier has a published cost.
  const row = {
    published_plan_id: "11111NY0010001-01",
    benefit_name: "Specialist Visit",
    raw: { IsCovered: "Yes", Explanation: "Synthetic condition: tier 2 only." },
    cost_sharing_raw: { CopayInnTier2: "$40 after deductible" },
  };
  expect(mapVariantBenefits([row], row.published_plan_id).specialist).toBe(
    "In-Network: unknown / Out-of-Network: unknown / In-Network Tier 2: Copay: $40 after deductible | explanation: Synthetic condition: tier 2 only.",
  );
  expect(() =>
    stateDetailColumns({ "PLAN TYPE": "HMO", PlanType: "EPO" }),
  ).toThrow("Conflicting");
});
