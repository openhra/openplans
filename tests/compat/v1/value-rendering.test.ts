import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";
import { attributeCostSharing } from "../../../src/domain/csr/index.js";
import {
  mapQuote,
  mapVariantAccumulators,
  mapVariantBenefits,
} from "../../../src/compat/v1/mapping.js";
import type { NativeBenefit } from "../../../src/compat/v1/mapping.js";
import { replaceSyntax } from "../../source-mutation.js";
import { mappingFixture } from "./mapping-fixture.js";

// Synthetic rows distinguish independent payment bases and incomplete cells.
const variant = "11111TX0010001-01";
const conditionalBenefit: NativeBenefit = {
  published_plan_id: variant,
  benefit_name: "Specialist Visit",
  cost_sharing_raw: {
    CopayInnTier1: "$35 Copay per Visit before deductible",
    CoinsInnTier1: "20% Coinsurance after deductible",
    CopayInnTier2: "$50 Copay per Visit after deductible",
    CoinsInnTier2: "30% Coinsurance after deductible",
    CopayOutofNet: "Not Applicable",
    CoinsOutofNet: "100%",
  },
  raw: {
    IsCovered: "Covered",
    QuantLimitOnSvc: "Yes",
    LimitQty: "12",
    LimitUnit: "Visit(s) per Year",
    Explanation: "Synthetic condition: referral required for follow-up visits.",
    Exclusions: "Synthetic exclusion: nonparticipating facilities.",
    IsSubjectedToDedTier1: "No",
    IsSubjectedToDedTier2: "Yes",
    IsExclFromInnMOOP: "No",
    IsExclFromOonMOOP: "Yes",
    MinimumStay: "2 days",
  },
};
type Mappers = {
  mapVariantBenefits: typeof mapVariantBenefits;
  mapVariantAccumulators: typeof mapVariantAccumulators;
};
function costBasisContract(mapper: Mappers) {
  const result = String(
    mapper.mapVariantBenefits([conditionalBenefit], variant).specialist,
  );
  assert.match(result, /Copay: \$35 Copay per Visit before deductible/);
  assert.match(result, /Coinsurance: 20% Coinsurance after deductible/);
  assert.match(
    result,
    /In-Network Tier 2: Copay: \$50 Copay per Visit after deductible; Coinsurance: 30% Coinsurance after deductible/,
  );
  assert.match(
    result,
    /Out-of-Network: Copay: Not Applicable; Coinsurance: 100%/,
  );
}
function conditionContract(mapper: Mappers) {
  const result = String(
    mapper.mapVariantBenefits([conditionalBenefit], variant).specialist,
  );
  for (const condition of [
    "referral required for follow-up visits",
    "nonparticipating facilities",
    "limit: 12 Visit(s) per Year",
    "subject to tier 1 deductible: No",
    "subject to tier 2 deductible: Yes",
    "excluded from in-network MOOP: No",
    "excluded from out-of-network MOOP: Yes",
    "minimum stay: 2 days",
  ])
    assert.ok(result.includes(condition), condition);
}
function unknownCoverageContract(mapper: Mappers) {
  const result = mapper.mapVariantBenefits(
    [
      {
        ...conditionalBenefit,
        cost_sharing_raw: {},
        raw: {
          Explanation: "Synthetic condition: prior authorization required.",
        },
      },
    ],
    variant,
  ).specialist;
  assert.equal(
    result,
    "Coverage: unknown | explanation: Synthetic condition: prior authorization required.",
  );
}
function spacedHeaderContract(mapper: Mappers) {
  const result = mapper.mapVariantBenefits(
    [
      {
        ...conditionalBenefit,
        cost_sharing_raw: {},
        raw: {
          "IS COVERED": "Yes",
          "QUANTITY LIMIT ON SVC": "Yes",
          "LIMIT QUANTITY": "6",
          "LIMIT UNIT": "Visits per Year",
          "IS EXCLUDED FROM INN MOOP": "Yes",
        },
      },
    ],
    variant,
  ).specialist;
  assert.equal(
    result,
    "Coverage: Covered | limit: 6 Visits per Year | excluded from in-network MOOP: Yes",
  );
}
it("preserves payment basis, network tiers and published conditions", () => {
  const mapper = { mapVariantBenefits, mapVariantAccumulators };
  costBasisContract(mapper);
  conditionContract(mapper);
});
it("retains conditions with unknown coverage without inventing coverage", () => {
  unknownCoverageContract({ mapVariantBenefits, mapVariantAccumulators });
  spacedHeaderContract({ mapVariantBenefits, mapVariantAccumulators });
  const row: NativeBenefit = {
    ...conditionalBenefit,
    cost_sharing_raw: {},
    raw: {
      Explanation: "Synthetic condition: prior authorization required.",
      QuantLimitOnSvc: "",
      LimitQty: "4",
      LimitUnit: "Visits per Year",
    },
  };
  expect(mapVariantBenefits([row], variant).specialist).toBe(
    "Coverage: unknown | published limit: 4 Visits per Year; applicability: unknown | explanation: Synthetic condition: prior authorization required.",
  );
  expect(
    mapVariantBenefits([{ ...row, raw: {} }], variant).specialist,
  ).toBeNull();
  expect(
    mapVariantBenefits(
      [{ ...row, raw: { IsCovered: "No", Explanation: row.raw.Explanation! } }],
      variant,
    ).specialist,
  ).toBe(
    "Coverage: Not Covered | explanation: Synthetic condition: prior authorization required.",
  );
  expect(
    mapVariantBenefits(
      [{ ...row, raw: { IsCovered: " Covered ", QuantLimitOnSvc: " Yes " } }],
      variant,
    ).specialist,
  ).toBe("Coverage: Covered | limit: applies; quantity unknown");
});
it("keeps selected public cost cells verbatim, including 100% and Not Applicable", () => {
  let checked = 0;
  for (const source of mappingFixture.sources.filter(
    (item) => item.kind === "benefits-and-cost-sharing",
  )) {
    for (const { values } of source.rows) {
      if (!values.PlanId || !values.BenefitName) continue;
      const row: NativeBenefit = {
        published_plan_id: values.PlanId,
        benefit_name: values.BenefitName,
        raw: values,
        cost_sharing_raw: values,
      };
      const mapped = mapVariantBenefits([row], row.published_plan_id);
      if (["No", "Not Covered"].includes(values.IsCovered ?? "")) continue;
      const result = Object.values(mapped).find(
        (value): value is string => typeof value === "string",
      );
      if (result === undefined) continue;
      for (const key of [
        "CopayInnTier1",
        "CopayInnTier2",
        "CopayOutofNet",
        "CoinsInnTier1",
        "CoinsInnTier2",
        "CoinsOutofNet",
      ])
        if (values[key]?.trim()) {
          expect(result).toContain(values[key]!.trim());
          checked++;
        }
    }
  }
  expect(checked).toBeGreaterThan(0);
});
it("reads CA coverage and conditions from the published spaced headers without inventing network prices", async () => {
  const source = JSON.parse(
    await readFile(
      new URL("./benefit-ca-public.json", import.meta.url),
      "utf8",
    ),
  ) as { rows: { source_row: number; values: Record<string, string> }[] };
  const rows: NativeBenefit[] = source.rows.map(({ values }) => ({
    published_plan_id: values["PLAN ID"]!,
    benefit_name: values["BENEFIT NAME"]!,
    cost_sharing_raw: {},
    raw: values,
  }));
  const mapped = mapVariantBenefits(rows, "18126CA0010001-01");
  expect(mapped.chiropractic_services).toBe(false);
  expect(mapped.primary_care_physician).toContain("Coverage: Covered");
  expect(mapped.primary_care_physician).toContain(
    rows.find((row) => row.benefit_name.startsWith("Primary Care"))!.raw
      .EXPLANATION,
  );
  expect(mapped.child_dental).toContain("excluded from in-network MOOP: No");
  expect(mapped.child_dental).not.toContain("In-Network:");
  expect(mapVariantBenefits(rows, "18126CA0010001-05")).toEqual({});
  // A conflicting alias is a synthetic publication error, never a choice between two facts.
  const conflict = { ...rows[0]!, raw: { ...rows[0]!.raw, IsCovered: "No" } };
  expect(
    mapVariantBenefits([conflict], "18126CA0010001-01").primary_care_physician,
  ).toBeNull();
});
function accumulatorContract(mapper: Mappers) {
  const raw = {
    MedicalDrugDeductiblesIntegrated: "No",
    MedicalDrugMaximumOutofPocketIntegrated: "Yes",
    MEHBDedInnTier1Individual: "$1,500",
    DEHBDedInnTier1Individual: "$250",
    MEHBDedInnTier1FamilyPerPerson: "$1,500 per person",
    MEHBDedInnTier1FamilyPerGroup: "$3,000 per group",
    DEHBDedInnTier1FamilyPerPerson: "$250 per person",
    DEHBDedInnTier1FamilyPerGroup: "$500 per group",
    TEHBInnTier1IndividualMOOP: "$9,000",
    TEHBInnTier1FamilyPerPersonMOOP: "$9,000 per person",
    TEHBInnTier1FamilyPerGroupMOOP: "$18,000 per group",
    TEHBOutOfNetIndividualMOOP: "Not Applicable",
    TEHBCombInnOonIndividualMOOP: "$12,000",
  };
  const result = mapper.mapVariantAccumulators({
    status: "available",
    ...attributeCostSharing(raw),
  } as Parameters<typeof mapVariantAccumulators>[0]);
  assert.equal(
    result.individual_medical_deductible,
    "In-Network Tier 1: $1,500",
  );
  assert.equal(result.individual_drug_deductible, "In-Network Tier 1: $250");
  assert.match(String(result.family_medical_deductible), /\$3,000 per group/);
  assert.match(String(result.family_drug_deductible), /\$500 per group/);
  assert.equal(result.individual_medical_moop, result.individual_drug_moop);
  assert.match(
    String(result.individual_drug_moop),
    /^Medical and drug combined/,
  );
  assert.match(
    String(result.individual_medical_moop),
    /Out-of-Network: Not Applicable/,
  );
  assert.match(
    String(result.individual_medical_moop),
    /Combined in\/out of network: \$12,000/,
  );
  assert.match(String(result.family_medical_moop), /\$18,000 per group/);
}
it("keeps per-person/group limits, separate deductibles and integrated MOOP distinct", () => {
  accumulatorContract({ mapVariantBenefits, mapVariantAccumulators });
});
it("does not allocate household tiers or replace unknown applicant prices with zero", () => {
  type Estimate = Parameters<typeof mapQuote>[0];
  // Synthetic envelopes check conversion only, not filed premiums.
  const result = mapQuote({
    total_cents: 123456,
    quote_method: "state_filed_tier",
    members: [],
  } as unknown as Estimate);
  expect(result.premium).toBe(1234.56);
  expect(result.premiums_by_applicant).toEqual([]);
  const members = [
    {
      age: 40,
      relationship: "subscriber",
      tobacco: true,
      premium_cents: 59396,
      charged: true,
    },
    {
      age: 5,
      relationship: "child",
      tobacco: false,
      premium_cents: null,
      charged: true,
    },
    {
      age: 2,
      relationship: "child",
      tobacco: false,
      premium_cents: 0,
      charged: false,
    },
  ];
  const perMember = mapQuote({ members } as unknown as Estimate);
  expect(perMember.premium).toBeNull();
  expect(perMember.premiums_by_applicant).toEqual([
    {
      age: 40,
      child: false,
      smoker: true,
      premium: 593.96,
      composite_rated: false,
      waived_for_total: false,
    },
    {
      age: 5,
      child: true,
      smoker: false,
      premium: null,
      composite_rated: false,
      waived_for_total: false,
    },
    {
      age: 2,
      child: true,
      smoker: false,
      premium: 0,
      composite_rated: false,
      waived_for_total: true,
    },
  ]);
});
it("negative controls reject lost conditions and wrong payment or accumulator bases", async () => {
  const source = await readFile(
    new URL("../../../src/compat/v1/mapping.ts", import.meta.url),
    "utf8",
  );
  const directory = await mkdtemp(join(tmpdir(), "openplans-value-mutants-"));
  try {
    for (const [name, before, after, contract] of [
      [
        "condition",
        '["Explanation", "explanation"]',
        '["AbsentExplanation", "explanation"]',
        conditionContract,
      ],
      [
        "unknown-coverage-condition",
        "!conditions.length",
        "true",
        unknownCoverageContract,
      ],
      [
        "spaced-header",
        "benefitHeaders.get(compactHeader(header))",
        "benefitHeaders.get(header)",
        spacedHeaderContract,
      ],
      [
        "copay-basis",
        'tier("CopayInnTier1", "CoinsInnTier1")',
        'tier("CoinsInnTier1", "CopayInnTier1")',
        costBasisContract,
      ],
      [
        "coinsurance-basis",
        'tier("CopayInnTier2", "CoinsInnTier2")',
        'tier("CopayInnTier2", "CoinsOutofNet")',
        costBasisContract,
      ],
      [
        "accumulator-scope",
        '["drug", integrated ? "TEHB" : "DEHB"]',
        '["drug", integrated ? "TEHB" : "MEHB"]',
        accumulatorContract,
      ],
    ] as const) {
      const path = join(directory, name + ".cjs");
      await writeFile(
        path,
        ts.transpileModule(replaceSyntax(source, before, after), {
          compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
          },
        }).outputText,
      );
      const mutant = createRequire(import.meta.url)(path) as Mappers;
      expect(() => contract(mutant), name).toThrow();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
