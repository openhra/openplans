import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { normalizeEhbColumns } from "../../src/ingest/ehb.js";
import { parseImportRow } from "../../src/ingest/puf/import-parse.js";
import { normalizeSbeRow } from "../../src/ingest/sbe/normalize.js";
import { stateDetailColumns } from "../../src/ingest/state/catalog.js";
import { allocatePremium } from "../../src/domain/subsidy/dental.js";
import { rebaseImports, replaceSyntax } from "../source-mutation.js";

// SYNTHETIC schema-only PUF and state rows; no real plan or premium claims.
const values = {
  BusinessYear: "2026",
  StateCode: "NY",
  IssuerId: "99999",
  StandardComponentId: "99999NY0010001",
  PlanId: "99999NY0010001-01",
  MarketCoverage: "Individual",
  MetalLevel: "Silver",
  DentalOnlyPlan: "No",
  QHPNonQHPTypeId: "On the Exchange",
  EHBPercentTotalPremium: "99%",
  EHBPediatricDentalApportionmentQuantity: "99.5 %",
};

it("stores fractions for federal and state plan attributes without mutating the source row", () => {
  for (const row of [
    { rowNumber: 2, recordNumber: 2, fields: [], values },
    normalizeSbeRow("plan-attributes", {
      rowNumber: 2,
      recordNumber: 2,
      fields: [],
      values: {
        ...values,
        "EHB PERCENT PREMIUM": "99%",
      },
    }),
  ]) {
    const stored = JSON.parse(
      String(parseImportRow("plan-attributes", row, "synthetic").at(-1)),
    );
    expect(stored.EHBPercentTotalPremium).toBe("0.99");
    expect(stored.EHBPediatricDentalApportionmentQuantity).toBe("0.995");
    expect(allocatePremium(100_000, stored.EHBPercentTotalPremium)).toBe(
      99_000,
    );
  }
  expect(values.EHBPercentTotalPremium).toBe("99%");
});

it("normalizes cached state aliases, agrees across equivalent spellings and refuses conflicting or invalid shares", () => {
  expect(stateDetailColumns({ "EHB Percent Premium": "99%" })).toMatchObject({
    "EHB Percent Premium": "99%",
    EHBPercentTotalPremium: "0.99",
  });
  expect(
    normalizeEhbColumns({
      EHBPercentTotalPremium: "0.99",
      "EHB Percent Premium": "99%",
    }).EHBPercentTotalPremium,
  ).toBe("0.99");
  for (const cells of [
    { EHBPercentTotalPremium: "0.99", "EHB Percent Premium": "98%" },
    { EHBPercentTotalPremium: "", "EHB Percent Premium": "99%" },
    { EHBPercentTotalPremium: "101%" },
    { EHBPercentTotalPremium: "not available" },
  ] as Record<string, string>[]) {
    expect(stateDetailColumns(cells).EHBPercentTotalPremium).toBe("");
    expect(
      allocatePremium(
        100_000,
        stateDetailColumns(cells).EHBPercentTotalPremium,
      ),
    ).toBeNull();
  }
  expect(normalizeEhbColumns({})).toEqual({});
});

it("planted old-behavior mutants fail the same stored-fraction and cached-state allocation assertions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openplans-ehb-mutant-"));
  try {
    for (const [name, relative, before, after] of [
      ["ingest", "ingest/puf/import-parse.js", "normalizeEhbColumns(r)", "r"],
      [
        "catalog",
        "ingest/state/catalog.js",
        "return normalizeEhbColumns(result);",
        'return { ...result, EHBPercentTotalPremium: raw["EHB Percent Premium"] };',
      ],
    ]) {
      const original = new URL(`../../dist/${relative}`, import.meta.url);
      const path = join(directory, `${name}.mjs`);
      await writeFile(
        path,
        rebaseImports(
          replaceSyntax(
            (await readFile(original, "utf8")).replaceAll(
              "import.meta.url",
              JSON.stringify(original.href),
            ),
            before!,
            after!,
          ),
          original,
        ),
      );
      const mutant = await import(pathToFileURL(path).href);
      if (name === "ingest") {
        const check = (parse: typeof parseImportRow) =>
          assert.equal(
            JSON.parse(
              String(
                parse(
                  "plan-attributes",
                  { rowNumber: 2, recordNumber: 2, fields: [], values },
                  "synthetic",
                ).at(-1),
              ),
            ).EHBPercentTotalPremium,
            "0.99",
          );
        check(parseImportRow);
        expect(() => check(mutant.parseImportRow)).toThrow(
          assert.AssertionError,
        );
      } else {
        const check = (columns: typeof stateDetailColumns) =>
          assert.equal(
            allocatePremium(
              100_000,
              columns({ "EHB Percent Premium": "99%" }).EHBPercentTotalPremium,
            ),
            99_000,
          );
        check(stateDetailColumns);
        expect(() => check(mutant.stateDetailColumns)).toThrow(
          assert.AssertionError,
        );
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
