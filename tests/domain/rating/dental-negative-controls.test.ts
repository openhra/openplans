import {
  mutateSource,
  sourceControls,
} from "../../../scripts/oracle/source-controls.mjs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";
import { syntheticRow } from "./helpers.js";

it("negative control: the independent dental oracle rejects the two-dependent → three-dependent source mutant", () => {
  const directory = mkdtempSync(join(tmpdir(), "openplans-dental-mutant-"));
  try {
    writeFileSync(join(directory, "package.json"), '{"type":"module"}');
    for (const name of ["types", "rate-row", "household", "dental"]) {
      let source = readFileSync(
        new URL(`../../../src/domain/rating/${name}.ts`, import.meta.url),
        "utf8",
      );
      if (name === "dental") {
        source = mutateSource(source, sourceControls.dental);
      }
      writeFileSync(
        join(directory, `${name}.js`),
        ts.transpileModule(source, {
          compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ES2022,
          },
        }).outputText,
      );
    }
    const logic = fileURLToPath(
      new URL("../../../scripts/oracle/dental-logic.mjs", import.meta.url),
    );
    writeFileSync(
      join(directory, "run.mjs"),
      `
import {readFileSync} from 'node:fs';
import {dentalPremium} from './dental.js';
import {checkDentalRow} from ${JSON.stringify(logic)};
const {expected,rows,rules}=JSON.parse(readFileSync(0,'utf8'));
process.stdout.write(JSON.stringify(checkDentalRow(expected,rows,rules,dentalPremium)));
`,
    );
    const row = syntheticRow({
      Age: "Family Option",
      Tobacco: "No Preference",
      IndividualRate: "10",
      IndividualTobaccoRate: "",
      Couple: "20",
      PrimarySubscriberAndOneDependent: "30",
      PrimarySubscriberAndTwoDependents: "40",
      PrimarySubscriberAndThreeOrMoreDependents: "50",
      CoupleAndOneDependent: "60",
      CoupleAndTwoDependents: "70",
      CoupleAndThreeOrMoreDependents: "80",
    });
    const expected = {
      source_row: 2,
      plan: row.planId,
      area: row.ratingAreaId,
      state: "TX",
      market: "Individual",
      age: "Family Option",
      tobacco: "No Preference",
      effective: row.effectiveDate,
      expiration: row.expirationDate,
      prices: {
        IndividualRate: row.individualRateCents,
        ...row.familyRatesCents,
      },
    };
    const rules = [
      {
        source_row: 2,
        raw: {
          AgeDeterminationRule: "Age on effective date",
          DependentMaximumAgRule: "25",
          MaximumUnderageDependent: "3",
          CohabitationRule: "Self,Yes;Spouse,No;Child,No",
        },
      },
    ];
    const result = spawnSync(process.execPath, [join(directory, "run.mjs")], {
      input: JSON.stringify({ expected, rows: [row], rules }),
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    const mutant = JSON.parse(result.stdout);
    expect(mutant.comparisons).toBe(20);
    expect(mutant.mismatches).toHaveLength(4);
    expect(mutant.mismatches.map((m: { column: string }) => m.column)).toEqual([
      "PrimarySubscriberAndTwoDependents",
      "PrimarySubscriberAndTwoDependents",
      "CoupleAndTwoDependents",
      "CoupleAndTwoDependents",
    ]);
    expect(mutant.mismatches[0]).toMatchObject({
      expected_cents: 4000,
      actual_cents: 5000,
    });
    // Same PASS predicate as the real-data runner must fail for the source mutant.
    expect(() => expect(mutant.mismatches).toHaveLength(0)).toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
