import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import {
  attributeCostSharing,
  csrSuffix,
  publishedAmount,
  selectedVariant,
} from "../../../src/domain/csr/index.js";
import * as validation from "../../../src/api/validation.js";
import * as csr from "../../../src/domain/csr/index.js";
import * as hios from "../../../src/domain/hios/index.js";
import * as rating from "../../../src/domain/rating/index.js";
import * as household from "../../../src/domain/rating/household.js";
import * as rateRow from "../../../src/domain/rating/rate-row.js";

const body = (extra = {}) => ({
  plan_ids: ["11718TX0140019"],
  county: "48201",
  coverage_start: "2026-01-01",
  members: [{ age: 35, tobacco: false, relationship: "subscriber" }],
  ...extra,
});
function noIncomeSelection(parse: typeof validation.premiumRequest) {
  for (const income of [0, 15650, 31300, 100000]) {
    const request = parse(
      body({
        household_income_annual: income,
        household_size: 1,
        tax_filing: "single",
      }),
    );
    assert.equal(
      selectedVariant(request.ids[0]!.base, request.csrVariant),
      "11718TX0140019-01",
      "income must not select a variant",
    );
  }
}
describe("explicit CSR variant selection", () => {
  it("uses literal CMS suffixes, exact aliases and standard 01 by default", () => {
    for (const [input, suffix] of [
      ["csr73", "04"],
      ["csr87", "05"],
      ["csr94", "06"],
      ["03", "03"],
      ["zero", "02"],
      ["limited", "03"],
    ]) {
      expect(csrSuffix(input)).toBe(suffix);
    }
    expect(selectedVariant("11718TX0140019")).toBe("11718TX0140019-01");
    expect(() => selectedVariant("11718TX0140019", "06", "03")).toThrow();
    for (const bad of [
      94,
      "94",
      "99",
      null,
      "constructor",
      "toString",
      "csr95",
      { income: 15000 },
    ])
      expect(() => csrSuffix(bad)).toThrow();
    noIncomeSelection(validation.premiumRequest);
  });
  it("retains raw conditional/unknown amounts without turning them into zero", () => {
    expect(publishedAmount("$1,600 ")).toEqual({
      raw: "$1,600 ",
      cents: 160000,
      status: "available",
    });
    expect(publishedAmount("$3200 per group").cents).toBe(320000);
    for (const raw of [
      "",
      "Not Applicable",
      "$0 after deductible",
      "No Charge after deductible",
      "Unlimited",
    ]) {
      expect(publishedAmount(raw)).toMatchObject({
        raw,
        cents: null,
        status: "unknown",
      });
    }
    expect(
      attributeCostSharing({
        TEHBDedInnTier1Individual: "$0",
        TEHBDedInnTier1Coinsurance: "0.00%",
        TEHBInnTier1IndividualMOOP: "$1600",
      }),
    ).toMatchObject({
      deductibles: { TEHBDedInnTier1Individual: { cents: 0 } },
      moop: { TEHBInnTier1IndividualMOOP: { cents: 160000 } },
      coinsurance_raw: { TEHBDedInnTier1Coinsurance: "0.00%" },
    });
  });
  it("negative control: compiled income-to-CSR source mutant fails the same no-inference assertion", async () => {
    const source = await readFile(
      new URL("../../../src/api/validation.ts", import.meta.url),
      "utf8",
    );
    const needle = "const csr = csrVariant(body.csr_variant);";
    expect(source.split(needle)).toHaveLength(2);
    const mutant = source.replace(
      needle,
      "const csr = csrVariant(body.csr_variant ?? (typeof body.household_income_annual === 'number' ? 'csr94' : undefined));",
    );
    const output = ts.transpileModule(mutant, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
    const exports: Record<string, unknown> = {};
    const imports: Record<string, unknown> = {
      "../domain/csr/index.js": csr,
      "../domain/hios/index.js": hios,
      "../domain/rating/index.js": rating,
      "../domain/rating/household.js": household,
      "../domain/rating/rate-row.js": rateRow,
    };
    new Function("require", "exports", output)((path: string) => {
      if (!(path in imports)) throw new Error(path);
      return imports[path];
    }, exports);
    expect(() =>
      noIncomeSelection(
        exports.premiumRequest as typeof validation.premiumRequest,
      ),
    ).toThrow("income must not select a variant");
  });
});
