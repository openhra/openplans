import { mappingFixture as fixture } from "./mapping-fixture.js";
import assert from "node:assert/strict";
import { replaceSyntax } from "../../source-mutation.js";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";
import {
  mapPlanColumns,
  mapVariantBenefits,
} from "../../../src/compat/v1/mapping.js";

const original = fixture.sources.find(
  (s) => s.kind === "plan-attributes" && s.base === "87226TX0100013",
)!.rows[0]!.values;
const other = fixture.sources.find(
  (s) => s.kind === "plan-attributes" && s.base === "11718TX0140016",
)!.rows[0]!.values;
const service = fixture.sources
  .find(
    (s) =>
      s.kind === "benefits-and-cost-sharing" && s.base === "87226TX0100013",
  )!
  .rows.find(
    (r) =>
      r.values.BenefitName ===
      "Primary Care Visit to Treat an Injury or Illness",
  )!.values;
const benefit = {
  published_plan_id: service.PlanId!,
  benefit_name: service.BenefitName!,
  cost_sharing_raw: service,
  raw: service,
};

type Mappers = {
  mapPlanColumns: typeof mapPlanColumns;
  mapVariantBenefits: typeof mapVariantBenefits;
};
function wrongVariant(m: Mappers) {
  assert.deepEqual(
    m.mapVariantBenefits([benefit], original.StandardComponentId + "-05"),
    {},
  );
}
function retainedCondition(m: Mappers) {
  // Synthetic conditional service row; values deliberately distinguish the mutant.
  const row = {
    ...benefit,
    raw: {
      ...benefit.raw,
      Explanation: "Synthetic condition: only after a qualifying visit.",
    },
  };
  assert.match(
    String(
      m.mapVariantBenefits([row], original.PlanId!).primary_care_physician,
    ),
    /only after a qualifying visit/,
  );
}
function wrongPlanUrl(m: Mappers) {
  assert.equal(
    m.mapPlanColumns(original, original.PlanId!, 2026, "TX").drug_formulary_url,
    original.FormularyURL,
  );
  // Plant another plan's public URL and identity into a row claiming the requested variant.
  const crossed = { ...other, PlanId: original.PlanId! };
  assert.deepEqual(m.mapPlanColumns(crossed, original.PlanId!, 2026, "TX"), {});
}

it("negative controls: wrong variant, dropped condition and another plan's URL each fail the production assertions", async () => {
  const correct = { mapPlanColumns, mapVariantBenefits };
  for (const contract of [wrongVariant, retainedCondition, wrongPlanUrl])
    contract(correct);
  const source = await readFile(
    new URL("../../../src/compat/v1/mapping.ts", import.meta.url),
    "utf8",
  );
  const directory = await mkdtemp(join(tmpdir(), "openplans-benefit-mutants-"));
  try {
    for (const [name, before, after, contract] of [
      ["variant", "row.published_plan_id === variant", "true", wrongVariant],
      [
        "condition",
        '["Explanation", "explanation"]',
        '["UnpublishedExplanation", "explanation"]',
        retainedCondition,
      ],
      [
        "crossed-url",
        "raw.StandardComponentId !== variant.slice(0, 14)",
        "false",
        wrongPlanUrl,
      ],
    ] as const) {
      const mutant = replaceSyntax(source, before, after);
      const path = join(directory, name + ".cjs");
      await writeFile(
        path,
        ts.transpileModule(mutant, {
          compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
          },
        }).outputText,
      );
      const loaded = createRequire(import.meta.url)(path) as Mappers;
      expect(() => contract(loaded), name).toThrow();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
