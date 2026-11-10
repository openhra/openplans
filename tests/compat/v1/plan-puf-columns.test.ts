import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";
import { publishedPlanColumns } from "../../../src/api/plan-view.js";
import { attributeCostSharing } from "../../../src/domain/csr/index.js";
import {
  mapPlanColumns,
  mapVariantAccumulators,
  mapVariantBenefits,
  type NativeBenefit,
} from "../../../src/compat/v1/mapping.js";
import { replaceSyntax } from "../../source-mutation.js";

interface PublicRow {
  label?: string;
  source_row: number;
  values: Record<string, string>;
}
const fixture = JSON.parse(
  await readFile(
    new URL("./plan-puf-columns-public.json", import.meta.url),
    "utf8",
  ),
) as {
  kind: string;
  attributes: { sha256: string; rows: PublicRow[] };
  benefits: {
    sha256: string;
    plans: { label: string; plan_id: string; rows: PublicRow[] }[];
  };
};
const attributeRow = (label: string) =>
  fixture.attributes.rows.find((row) => row.label === label)!.values;
const benefitPlan = (label: string) =>
  fixture.benefits.plans.find((plan) => plan.label === label)!;

const COST_CELLS = [
  "CopayInnTier1",
  "CopayInnTier2",
  "CopayOutofNet",
  "CoinsInnTier1",
  "CoinsInnTier2",
  "CoinsOutofNet",
];
/** The same split the Benefits PUF import stores: cost cells beside the verbatim row. */
const nativeBenefits = (label: string): NativeBenefit[] =>
  benefitPlan(label).rows.map(({ values }) => ({
    published_plan_id: values.PlanId!,
    benefit_name: values.BenefitName!,
    cost_sharing_raw: Object.fromEntries(
      COST_CELLS.map((key) => [key, values[key] ?? ""]),
    ),
    raw: values,
  }));

type Mapper = {
  mapPlanColumns: typeof mapPlanColumns;
  mapVariantAccumulators: typeof mapVariantAccumulators;
  mapVariantBenefits: typeof mapVariantBenefits;
};
const planColumns = (m: Mapper, label: string) => {
  const raw = publishedPlanColumns(attributeRow(label));
  return m.mapPlanColumns(raw, raw.PlanId!, 2026, raw.StateCode!);
};
const deductibles = (m: Mapper, label: string) =>
  m.mapVariantAccumulators({
    status: "available",
    ...attributeCostSharing(attributeRow(label)),
  } as Parameters<typeof mapVariantAccumulators>[0]);
const benefits = (m: Mapper, label: string) =>
  m.mapVariantBenefits(nativeBenefits(label), benefitPlan(label).plan_id);

/** Expected values are the cited public cells, converted exactly. */
function publicContract(m: Mapper) {
  // DesignType "Design 1", EHBPercentTotalPremium "1", dates 1/1/2026 to 12/31/2026.
  assert.deepEqual(
    pick(planColumns(m, "standardized-integrated-full-ehb"), PLAN_KEYS),
    {
      standardized_plan: true,
      essential_health_benefits_percentage: 100,
      plan_calendar: "calendar_year",
    },
  );
  // DesignType "Not Applicable", EHBPercentTotalPremium "0.9609", blank expiration date.
  assert.deepEqual(
    pick(planColumns(m, "non-standard-separate-fractional-ehb"), PLAN_KEYS),
    {
      standardized_plan: false,
      essential_health_benefits_percentage: 96.09,
      plan_calendar: null,
    },
  );
  // A dental-only row leaves both cells blank.
  assert.deepEqual(
    pick(planColumns(m, "dental-only-blank-design"), PLAN_KEYS),
    {
      standardized_plan: null,
      essential_health_benefits_percentage: null,
      plan_calendar: "calendar_year",
    },
  );
  // Integrated deductibles read the TEHB cells: 50.00%, $7500 per person, $15000 per group.
  assert.deepEqual(
    pick(deductibles(m, "standardized-integrated-full-ehb"), DEDUCTIBLE_KEYS),
    { coinsurance: 50, embedded_deductible: "embedded" },
  );
  // Separate deductibles read the MEHB cells: 50.00%, $0 per person (no evidence).
  assert.deepEqual(
    pick(
      deductibles(m, "non-standard-separate-fractional-ehb"),
      DEDUCTIBLE_KEYS,
    ),
    { coinsurance: 50, embedded_deductible: null },
  );

  const standard = benefits(m, "standardized-integrated-full-ehb");
  assert.equal(standard.adult_dental, false);
  assert.equal(standard.infertility_treatment_rider, false);
  assert.equal(
    costs(standard.prenatal_care),
    "In-Network: Copay: Not Applicable; Coinsurance: 0.00% / Out-of-Network: Copay: Not Applicable; Coinsurance: 100.00%",
  );
  assert.equal(standard.postnatal_care, standard.prenatal_care);
  assert.equal(
    costs(standard.outpatient_ambulatory_care_center),
    "In-Network: Copay: Not Applicable; Coinsurance: 50.00% Coinsurance after deductible / Out-of-Network: Copay: Not Applicable; Coinsurance: 100.00%",
  );
  const covered = benefits(m, "covered-dental-infertility");
  assert.equal(covered.adult_dental, true);
  assert.equal(covered.infertility_treatment_rider, true);
  assert.equal(
    costs(covered.prenatal_care),
    "In-Network: Copay: $30.00; Coinsurance: Not Applicable / Out-of-Network: Copay: Not Applicable; Coinsurance: 50.00% Coinsurance after deductible",
  );
  // The issuer publishes a "Non-Preferred Generic" row and marks it not covered.
  const nonpreferred = benefits(m, "nonpreferred-generic");
  assert.match(
    String(nonpreferred.nonpreferred_generic_drug_share),
    /^Coverage: Not Covered/,
  );
  assert.equal(nonpreferred.nonpreferred_specialty_drug_share, undefined);
}
/** The cost summary before the verbatim row conditions. */
const costs = (text: unknown) => String(text).split(" | ")[0];
const PLAN_KEYS = [
  "standardized_plan",
  "essential_health_benefits_percentage",
  "plan_calendar",
] as const;
const DEDUCTIBLE_KEYS = ["coinsurance", "embedded_deductible"] as const;
const pick = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.fromEntries(keys.map((key) => [key, value[key]]));

it("uses real public rows from the pinned 2026 Plan Attributes and Benefits PUFs", () => {
  expect(fixture.kind).toBe("real-public-row-cut");
  for (const digest of [fixture.attributes.sha256, fixture.benefits.sha256])
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  for (const row of [
    ...fixture.attributes.rows,
    ...fixture.benefits.plans.flatMap((plan) => plan.rows),
  ])
    expect(row.source_row).toBeGreaterThan(1);
});

it("maps design, EHB share, plan year, coinsurance, embedded deductible and benefit rows from cited cells", () => {
  publicContract({
    mapPlanColumns,
    mapVariantAccumulators,
    mapVariantBenefits,
  });
});

it("keeps malformed, missing or conflicting cells unknown", () => {
  const raw = publishedPlanColumns(
    attributeRow("standardized-integrated-full-ehb"),
  );
  const columns = (cells: Record<string, string>) =>
    mapPlanColumns({ ...raw, ...cells }, raw.PlanId!, 2026, raw.StateCode!);
  for (const value of ["Design", "Standard", ""])
    expect(columns({ DesignType: value }).standardized_plan).toBeNull();
  for (const value of ["1.5", "-0.9", "197%", "abc", ""])
    expect(
      columns({ EHBPercentTotalPremium: value })
        .essential_health_benefits_percentage,
    ).toBeNull();
  expect(
    columns({ EHBPercentTotalPremium: "0.9921766408983248" })
      .essential_health_benefits_percentage,
  ).toBe(99.21766408983248);
  expect(
    columns({ PlanExpirationDate: "12/31/2027" }).plan_calendar,
  ).toBeNull();
  // Without the integration cell the applicable deductible scope is unknown.
  const sharing = attributeCostSharing({
    ...attributeRow("standardized-integrated-full-ehb"),
    MedicalDrugDeductiblesIntegrated: "",
  });
  const unknownScope = mapVariantAccumulators({
    status: "available",
    ...sharing,
  } as Parameters<typeof mapVariantAccumulators>[0]);
  expect(unknownScope.coinsurance).toBeUndefined();
  expect(unknownScope.embedded_deductible).toBeUndefined();
  // Equal per-person and per-group amounts do not establish an embedded deductible.
  const equal = mapVariantAccumulators({
    status: "available",
    ...attributeCostSharing({
      ...attributeRow("standardized-integrated-full-ehb"),
      TEHBDedInnTier1FamilyPerGroup: "$7500 per group",
    }),
  } as Parameters<typeof mapVariantAccumulators>[0]);
  expect(equal.embedded_deductible).toBeNull();
  // Two spellings of the same optional row that disagree stay unknown.
  const [row] = nativeBenefits("nonpreferred-generic").filter(
    (b) => b.benefit_name === "Non-Preferred Generic",
  );
  const conflicting = mapVariantBenefits(
    [
      row!,
      {
        ...row!,
        benefit_name: "Non-Preferred Generic Drugs",
        raw: { ...row!.raw, IsCovered: "Covered" },
      },
    ],
    row!.published_plan_id,
  );
  expect(conflicting).not.toHaveProperty("nonpreferred_generic_drug_share");
});

it("negative controls: wrong rows, wrong scopes and inverted cells fail the public contract", async () => {
  const source = await readFile(
    new URL("../../../src/compat/v1/mapping.ts", import.meta.url),
    "utf8",
  );
  const directory = await mkdtemp(join(tmpdir(), "openplans-puf-columns-"));
  try {
    for (const [name, before, after] of [
      [
        "prenatal-from-delivery-row",
        'prenatal_care: "Prenatal and Postnatal Care"',
        'prenatal_care: "Delivery and All Inpatient Services for Maternity Care"',
      ],
      [
        "adult-dental-from-child-row",
        'adult_dental: "Routine Dental Services (Adult)"',
        'adult_dental: "Dental Check-Up for Children"',
      ],
      [
        "standardized-from-unique-design",
        "standardizedDesign(raw.DesignType)",
        "standardizedDesign(raw.UniquePlanDesign)",
      ],
      [
        "ehb-unscaled",
        'const fraction = (match[2] ?? "").padEnd(2, "0")',
        'const fraction = match[2] ?? ""',
      ],
      [
        "coinsurance-wrong-scope",
        'integrated === "Yes" ? "TEHB" : "MEHB"',
        'integrated === "Yes" ? "MEHB" : "TEHB"',
      ],
      ["embedded-label-inverted", '? "embedded"', '? "non_embedded"'],
      [
        "outpatient-center-from-physician-row",
        `outpatient_ambulatory_care_center:
    "Outpatient Facility Fee (e.g., Ambulatory Surgery Center)"`,
        `outpatient_ambulatory_care_center:
    "Outpatient Surgery Physician/Surgical Services"`,
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
      const mutant = createRequire(import.meta.url)(path) as Mapper;
      expect(() => publicContract(mutant), name).toThrow();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
