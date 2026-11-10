import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";
import { attributeCostSharing } from "../../../src/domain/csr/index.js";
import {
  mapVariantAccumulators,
  mapVariantBenefits,
  type NativeBenefit,
} from "../../../src/compat/v1/mapping.js";
import { mappingFixture } from "./mapping-fixture.js";
import { replaceSyntax } from "../../source-mutation.js";

const COST_CELLS = [
  "CopayInnTier1",
  "CopayInnTier2",
  "CopayOutofNet",
  "CoinsInnTier1",
  "CoinsInnTier2",
  "CoinsOutofNet",
];
const native = (values: Record<string, string>): NativeBenefit => ({
  published_plan_id: values.PlanId!,
  benefit_name: values.BenefitName!,
  cost_sharing_raw: Object.fromEntries(
    COST_CELLS.map((key) => [key, values[key] ?? ""]),
  ),
  raw: values,
});
const source = (kind: string, base: string) =>
  mappingFixture.sources.find((s) => s.kind === kind && s.base === base)!;
// Real rows of 87226TX0100013-01 from the pinned 2026 Benefits and Plan Attributes PUFs.
const txBenefits = source("benefits-and-cost-sharing", "87226TX0100013")
  .rows.map((row) => native(row.values))
  .filter((row) => row.published_plan_id === "87226TX0100013-01");
const txAttributes = source("plan-attributes", "87226TX0100013").rows[0]!
  .values;
const puf = JSON.parse(
  await readFile(
    new URL("./plan-puf-columns-public.json", import.meta.url),
    "utf8",
  ),
) as {
  benefits: {
    plans: {
      label: string;
      plan_id: string;
      rows: { values: Record<string, string> }[];
    }[];
  };
};
const pufPlan = (label: string) =>
  puf.benefits.plans.find((plan) => plan.label === label)!;

type Mapper = {
  mapVariantAccumulators: typeof mapVariantAccumulators;
  mapVariantBenefits: typeof mapVariantBenefits;
};
const compact = { compact: true };

/** Expected phrases restate the cited cells: copay "$15.00" / OON "Not Applicable" + "100.00%". */
function compactContract(m: Mapper) {
  const tx = m.mapVariantBenefits(txBenefits, "87226TX0100013-01", compact);
  assert.equal(
    tx.primary_care_physician,
    "In-Network: $15 / Out-of-Network: 100%",
  );
  assert.equal(
    tx.emergency_room,
    "In-Network: 20% after deductible / Out-of-Network: 20% after deductible",
  );
  assert.equal(tx.generic_drugs, "In-Network: $3 / Out-of-Network: 100%");
  const covered = pufPlan("covered-dental-infertility");
  assert.equal(
    m.mapVariantBenefits(
      covered.rows.map((row) => native(row.values)),
      covered.plan_id,
      compact,
    ).prenatal_care,
    "In-Network: $30 / Out-of-Network: 50% after deductible",
  );
  // Only an explicit IsCovered "Not Covered" cell renders "Not Covered".
  const nonpreferred = pufPlan("nonpreferred-generic");
  assert.equal(
    m.mapVariantBenefits(
      nonpreferred.rows.map((row) => native(row.values)),
      nonpreferred.plan_id,
      compact,
    ).nonpreferred_generic_drug_share,
    "In-Network: Not Covered / Out-of-Network: Not Covered",
  );
  const accumulators = m.mapVariantAccumulators(
    {
      status: "available",
      ...attributeCostSharing(txAttributes),
    } as Parameters<typeof mapVariantAccumulators>[0],
    compact,
  );
  assert.equal(
    accumulators.individual_medical_deductible,
    "In-Network: $1,450 / Out-of-Network: Not Applicable",
  );
  assert.equal(
    accumulators.family_medical_deductible,
    "In-Network: $2,900 / Out-of-Network: Not Applicable",
  );
  assert.equal(
    accumulators.individual_medical_moop,
    "In-Network: $7,500 / Out-of-Network: Not Applicable",
  );
}

it("renders compact phrases only from the cited public cells when opted in", () => {
  compactContract({ mapVariantAccumulators, mapVariantBenefits });
});

it("keeps the verbose publisher text by default", () => {
  const verbose = mapVariantBenefits(txBenefits, "87226TX0100013-01");
  expect(verbose.primary_care_physician).toMatch(
    /^In-Network: Copay: \$15\.00; Coinsurance: Not Applicable \/ Out-of-Network: Copay: Not Applicable; Coinsurance: 100\.00%/,
  );
});

it("never derives Not Covered from 100% coinsurance and never lets tier 2 replace tier 1", () => {
  const [pcp] = txBenefits.filter(
    (row) =>
      row.benefit_name === "Primary Care Visit to Treat an Injury or Illness",
  );
  const text = (cells: Record<string, string>, raw = {}) =>
    mapVariantBenefits(
      [
        {
          ...pcp!,
          cost_sharing_raw: { ...pcp!.cost_sharing_raw, ...cells },
          raw: { ...pcp!.raw, ...raw },
        },
      ],
      pcp!.published_plan_id,
      compact,
    ).primary_care_physician;
  expect(text({})).not.toContain("Not Covered");
  // Synthetic edge case: only tier 2 publishes an in-network cost.
  expect(
    text({ CopayInnTier1: "Not Applicable", CopayInnTier2: "$40.00" }),
  ).toBe("In-Network: Not Applicable / Out-of-Network: 100%");
  expect(
    text({
      CopayInnTier1: "$600.00 Copay with deductible",
      CoinsInnTier1: "40.00% Coinsurance after deductible",
      CopayOutofNet: "No Charge after deductible",
      CoinsOutofNet: "Not Applicable",
    }),
  ).toBe(
    "In-Network: $600 with deductible plus 40% after deductible / Out-of-Network: $0 after deductible",
  );
  expect(text({ CoinsInnTier1: "47.50%" })).toBe(
    "In-Network: $15 plus 47.5% / Out-of-Network: 100%",
  );
});

it("negative controls: Not Covered from 100%, tier 2 fallback or dropped deductible words fail the contract", async () => {
  const mapping = await readFile(
    new URL("../../../src/compat/v1/mapping.ts", import.meta.url),
    "utf8",
  );
  const directory = await mkdtemp(join(tmpdir(), "openplans-compact-"));
  try {
    for (const [name, before, after] of [
      [
        "hundred-percent-not-covered",
        '.replace(/^No Charge\\b/, "$0")',
        '.replace(/^No Charge\\b/, "$0").replace(/^100\\.00%$/, "Not Covered")',
      ],
      [
        "tier-2-fallback",
        'compactTier(benefit, "CopayInnTier1", "CoinsInnTier1")',
        'compactTier(benefit, "CopayInnTier2", "CoinsInnTier2")',
      ],
      [
        "drop-deductible-words",
        '.replace(/ (?:Copay|Coinsurance)\\b/g, "")',
        '.replace(/ (?:Copay|Coinsurance)\\b.*$/g, "")',
      ],
    ] as const) {
      const path = join(directory, name + ".cjs");
      await writeFile(
        path,
        ts.transpileModule(replaceSyntax(mapping, before, after), {
          compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
          },
        }).outputText,
      );
      const mutant = createRequire(import.meta.url)(path) as Mapper;
      expect(() => compactContract(mutant), name).toThrow();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
