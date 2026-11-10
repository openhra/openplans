import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";
import { attributeCostSharing } from "../../../src/domain/csr/index.js";
import { stateDetailColumns } from "../../../src/ingest/state/catalog.js";
import {
  mapVariantAccumulators,
  mapVariantBenefits,
  type NativeBenefit,
} from "../../../src/compat/v1/mapping.js";
import { mappingFixture } from "./mapping-fixture.js";
import { replaceSyntax } from "../../source-mutation.js";

interface PublicRow {
  label?: string;
  source_row: number;
  values: Record<string, string>;
}
const federal = JSON.parse(
  await readFile(
    new URL("./plan-puf-columns-public.json", import.meta.url),
    "utf8",
  ),
) as {
  attributes: { rows: PublicRow[] };
  benefits: { plans: { label: string; plan_id: string; rows: PublicRow[] }[] };
};
const COST_CELLS = [
  "CopayInnTier1",
  "CopayInnTier2",
  "CopayOutofNet",
  "CoinsInnTier1",
  "CoinsInnTier2",
  "CoinsOutofNet",
];
const nativeBenefits = (label: string): NativeBenefit[] =>
  federal.benefits.plans
    .find((plan) => plan.label === label)!
    .rows.map(({ values }) => ({
      published_plan_id: values.PlanId!,
      benefit_name: values.BenefitName!,
      cost_sharing_raw: Object.fromEntries(
        COST_CELLS.map((key) => [key, values[key] ?? ""]),
      ),
      raw: values,
    }));
const planId = (label: string) =>
  federal.benefits.plans.find((plan) => plan.label === label)!.plan_id;

type Mapper = {
  mapVariantAccumulators: typeof mapVariantAccumulators;
  mapVariantBenefits: typeof mapVariantBenefits;
};
const accumulators = (m: Mapper, raw: Record<string, string>) =>
  m.mapVariantAccumulators({
    status: "available",
    ...attributeCostSharing(raw),
  } as Parameters<typeof mapVariantAccumulators>[0]);
const federalRow = (label: string) =>
  federal.attributes.rows.find((row) => row.label === label)!.values;
const stateRow = (base: string) =>
  stateDetailColumns(
    mappingFixture.sources.find(
      (source) => source.kind === "plan-attributes" && source.base === base,
    )!.rows[0]!.values,
  );
const pick = (value: Record<string, unknown>) => ({
  coinsurance: value.coinsurance,
  plan_coinsurance: value.plan_coinsurance,
  embedded_deductible: value.embedded_deductible,
});

/** Expected values are the cited public cells. */
function publicContract(m: Mapper) {
  // Federal integrated row: TEHB tier 1 coinsurance 50.00%, $7500 / $15000 family cells.
  assert.deepEqual(
    pick(accumulators(m, federalRow("standardized-integrated-full-ehb"))),
    {
      coinsurance: 50,
      plan_coinsurance: "In-Network: 50.00%",
      embedded_deductible: "embedded",
    },
  );
  // VT state row: MEHB 30.00% and the combined "$1500 per person | $3000 per group" cell.
  assert.deepEqual(pick(accumulators(m, stateRow("13627VT0340003"))), {
    coinsurance: 30,
    plan_coinsurance: "In-Network: 30.00%",
    embedded_deductible: "embedded",
  });
  // Office visits with a 50% out-of-network coinsurance show out-of-network coverage.
  assert.equal(
    m.mapVariantBenefits(
      nativeBenefits("covered-dental-infertility"),
      planId("covered-dental-infertility"),
    ).out_of_network_coverage,
    true,
  );
  // 100% visit coinsurance is not evidence either way, and the ER row never counts.
  for (const label of [
    "standardized-integrated-full-ehb",
    "nonpreferred-generic",
  ])
    assert.equal(
      m.mapVariantBenefits(nativeBenefits(label), planId(label))
        .out_of_network_coverage,
      undefined,
    );
}

it("maps tier coinsurance, state family cells and out-of-network visit coverage from cited cells", () => {
  publicContract({ mapVariantAccumulators, mapVariantBenefits });
});

it("keeps $0, equal or malformed family cells and unpublished tier cells unknown", () => {
  const ny = stateRow("11177NY0220001");
  // NY: MEHB $775 per person | $1550 per group, 20.00% tier 1, no tier 2.
  expect(
    pick(accumulators({ mapVariantAccumulators, mapVariantBenefits }, ny)),
  ).toEqual({
    coinsurance: 20,
    plan_coinsurance: "In-Network: 20.00%",
    embedded_deductible: "embedded",
  });
  for (const family of [
    "$0 per person | $0 per group",
    "$1550 per person | $1550 per group",
    "per person not applicable | per group not applicable",
  ])
    expect(
      mapVariantAccumulators({
        status: "available",
        ...attributeCostSharing({ ...ny, MEHBDedInnTier1Family: family }),
      } as Parameters<typeof mapVariantAccumulators>[0]).embedded_deductible,
    ).toBeNull();
  const tiered = mapVariantAccumulators({
    status: "available",
    ...attributeCostSharing({ ...ny, MEHBDedInnTier2Coinsurance: "40.00%" }),
  } as Parameters<typeof mapVariantAccumulators>[0]);
  expect(tiered.plan_coinsurance).toBe(
    "In-Network: 20.00% / In-Network-Tier-2: 40.00%",
  );
  // A tier 2 cell never stands in for a missing tier 1 cell.
  const tier2Only = mapVariantAccumulators({
    status: "available",
    ...attributeCostSharing({
      ...ny,
      MEHBDedInnTier1Coinsurance: "",
      MEHBDedInnTier2Coinsurance: "40.00%",
    }),
  } as Parameters<typeof mapVariantAccumulators>[0]);
  expect(tier2Only.plan_coinsurance).toBeNull();
  expect(tier2Only.coinsurance).toBeNull();
});

it("negative controls: a 100% cell read as coverage, ER rows or a false default fail the contract", async () => {
  const source = await readFile(
    new URL("../../../src/compat/v1/mapping.ts", import.meta.url),
    "utf8",
  );
  const directory = await mkdtemp(join(tmpdir(), "openplans-columns-2-"));
  try {
    for (const [name, before, after] of [
      [
        "hundred-percent-counts",
        "if (share !== null && Number(share[1]) >= 100) return false;",
        "",
      ],
      [
        "emergency-row-counts",
        '"Specialist Visit",\n];',
        '"Specialist Visit",\n  "Emergency Room Services",\n];',
      ],
      [
        "false-default",
        "if (outOfNetwork) mapped.out_of_network_coverage = outOfNetwork;",
        "mapped.out_of_network_coverage = outOfNetwork ?? false;",
      ],
      [
        "family-group-as-person",
        'dollarCents(cell("PerPerson") ?? combined[1])',
        'dollarCents(cell("PerGroup") ?? combined[2])',
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
