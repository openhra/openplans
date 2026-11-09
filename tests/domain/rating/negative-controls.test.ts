import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";
import type { HouseholdPremium } from "../../../src/domain/rating/index.js";
import {
  AREA,
  PLAN,
  assertFourChildPremium,
  fourChildren,
  rows,
} from "./helpers.js";

it("negative control: the four-children assertion rejects a source mutant charging every child", () => {
  const directory = mkdtempSync(join(tmpdir(), "openplans-rating-mutant-"));
  try {
    writeFileSync(join(directory, "package.json"), '{"type":"module"}\n');
    for (const name of ["types", "rate-row", "household"]) {
      let source = readFileSync(
        new URL(`../../../src/domain/rating/${name}.ts`, import.meta.url),
        "utf8",
      );
      if (name === "household") {
        const needle = ".slice(0, policy.maximumRatedChildren)";
        // If the implementation changes, repair the mutant rather than silently losing the control.
        expect(source.split(needle)).toHaveLength(2);
        source = source.replace(needle, ".slice(0)");
      }
      const output = ts.transpileModule(source, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ES2022,
        },
      }).outputText;
      writeFileSync(join(directory, `${name}.js`), output);
    }
    writeFileSync(
      join(directory, "run.mjs"),
      `
import { readFileSync } from 'node:fs';
import { householdPremium } from './household.js';
const input = JSON.parse(readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(householdPremium(input.rows, input.plan, input.area, input.household)));
`,
    );
    const child = spawnSync(process.execPath, [join(directory, "run.mjs")], {
      input: JSON.stringify({
        rows,
        plan: PLAN,
        area: AREA,
        household: fourChildren,
      }),
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    const mutant: HouseholdPremium = JSON.parse(child.stdout);
    expect(mutant.status).toBe("rated");
    expect(mutant.totalCents).toBe(355_088);
    expect(mutant.members.filter((member) => member.charged)).toHaveLength(6);
    // The exact positive test assertion must fail on the compiled mutated engine.
    expect(() => assertFourChildPremium(mutant)).toThrow(/309670/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
