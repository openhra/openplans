import { rebaseImports } from "../../source-mutation.js";
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
import { describe, expect, it } from "vitest";
import {
  estimateAptc,
  parameterErrors,
} from "../../../src/domain/subsidy/index.js";
import {
  alaskaExample,
  assertAlaskaExample,
  parameters2026,
  parameters2027,
} from "./helpers.js";

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };

const root = fileURLToPath(new URL("../../../", import.meta.url));
function check(directory?: string) {
  return spawnSync(
    process.execPath,
    ["scripts/subsidy/check.mjs", ...(directory ? [directory] : [])],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
    },
  );
}

describe("offline parameter validation", () => {
  it("canonical year files and generated pure-domain registry pass the real checker (included by normal CI)", () => {
    for (const parameters of [parameters2026, parameters2027])
      expect(parameterErrors(parameters)).toEqual([]);
    const child = check();
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toContain(
      "subsidy parameters: PASS (2026.json: confirmed, 2027.json: confirmed)",
    );
  });
  it("negative control: parameter file without citations fails the real CLI checker", () => {
    const directory = mkdtempSync(join(tmpdir(), "openplans-subsidy-uncited-"));
    try {
      const mutant = JSON.parse(JSON.stringify(parameters2026), (key, value) =>
        key === "citations" ? [] : value,
      );
      writeFileSync(join(directory, "2026.json"), JSON.stringify(mutant));
      const child = check(directory);
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(1);
      expect(child.stderr).toContain("primary-source citations required");
      expect(estimateAptc(alaskaExample, mutant).status).toBe(
        "parameters_unconfirmed",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("negative control: a valid cited year marked unconfirmed returns no numbers", () => {
    const unconfirmed = {
      ...parameters2026,
      status: "unconfirmed",
      statusReason: "SYNTHETIC negative-control legislative uncertainty",
    };
    expect(parameterErrors(unconfirmed)).toEqual([]);
    expect(estimateAptc(alaskaExample, unconfirmed)).toEqual({
      status: "parameters_unconfirmed",
      reason: "parameters_unconfirmed",
      fplPercent: null,
      applicablePercentage: null,
      expectedContributionCents: null,
      annualExpectedContributionCents: null,
      estimatedMonthlyCreditCents: null,
      quote_method: "puf_calculation",
      bindable_quote: false,
    });
  });
  it.each([
    (p: Mutable<typeof parameters2026>) => {
      p.fpl.alaska.annualDollarsBySize.citations[0]!.url =
        "https://example.com/secondary";
    },
    (p: Mutable<typeof parameters2026>) => {
      p.fpl.alaska.annualDollarsBySize.citations[0]!.retrievedOn = "2026-02-30";
    },
    (p: Mutable<typeof parameters2026>) => {
      p.fpl.alaska.annualDollarsBySize.value = [1];
    },
    (p: Mutable<typeof parameters2026>) => {
      p.applicablePercentageBands.value[1]!.lowerFplPercent = 134;
    },
    (p: Mutable<typeof parameters2026>) => {
      p.fplGuidelineYear.value = 2026;
    },
  ])("rejects invalid evidence/table mutant %#", (mutate) => {
    // JSON clone is deliberately mutable test input; production parameters are readonly.
    const mutant = JSON.parse(JSON.stringify(parameters2026));
    mutate(mutant);
    expect(parameterErrors(mutant).length).toBeGreaterThan(0);
  });
});

it("negative control: compiled source mutant using contiguous FPL for Alaska fails the same AK worked assertion", () => {
  const directory = mkdtempSync(
    join(tmpdir(), "openplans-subsidy-alaska-mutant-"),
  );
  try {
    writeFileSync(join(directory, "package.json"), '{"type":"module"}\n');
    let source = readFileSync(
      new URL("../../../src/domain/subsidy/aptc.ts", import.meta.url),
      "utf8",
    );
    source = mutateSource(source, sourceControls.alaskaFpl);
    // Isolate the changed engine; all other code remains the exact built implementation.
    source = rebaseImports(
      source,
      new URL("../../../dist/domain/subsidy/aptc.js", import.meta.url),
    );
    const output = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ES2022,
      },
    }).outputText;
    writeFileSync(join(directory, "aptc.js"), output);
    writeFileSync(
      join(directory, "run.mjs"),
      `
import { estimateAptc } from './aptc.js';
import { readFileSync } from 'node:fs';
process.stdout.write(JSON.stringify(estimateAptc(JSON.parse(readFileSync(0, 'utf8')))));
`,
    );
    const child = spawnSync(process.execPath, [join(directory, "run.mjs")], {
      input: JSON.stringify(alaskaExample),
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    const mutant = JSON.parse(child.stdout);
    expect(mutant.fplPercent).toBe(249); // 39,100 / wrong $15,650 table.
    expect(() => assertAlaskaExample(mutant)).toThrow(/249.*200/s);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
