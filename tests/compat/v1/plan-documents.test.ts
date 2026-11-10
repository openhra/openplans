import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";
import { publishedPlanColumns } from "../../../src/api/plan-view.js";
import { mapPlanColumns } from "../../../src/compat/v1/mapping.js";
import { stateDetailColumns } from "../../../src/ingest/state/catalog.js";
import { replaceSyntax } from "../../source-mutation.js";

const fixture = JSON.parse(
  await readFile(
    new URL("./plan-columns-public.json", import.meta.url),
    "utf8",
  ),
) as { rows: { label: string; values: Record<string, string> }[] };
const values = (label: string) =>
  fixture.rows.find((row) => row.label === label)!.values;
type Mapper = { mapPlanColumns: typeof mapPlanColumns };
const documents = (m: Mapper, label: string) => {
  const raw = publishedPlanColumns(stateDetailColumns(values(label)));
  const mapped = m.mapPlanColumns(raw, raw.PlanId!, 2026, raw.StateCode!);
  return {
    benefits_summary_url: mapped.benefits_summary_url,
    plan_documents: mapped.plan_documents,
  };
};

/** Expected URLs are the cited Plan Attributes cells, unchanged. */
function publicContract(m: Mapper) {
  const row = values("federal-av-referral-yes");
  assert.deepEqual(documents(m, "federal-av-referral-yes"), {
    benefits_summary_url: row.URLForSummaryofBenefitsCoverage,
    plan_documents: [
      {
        type: "summary_of_benefits_and_coverage",
        url: row.URLForSummaryofBenefitsCoverage,
      },
      { type: "plan_brochure", url: row.PlanBrochure },
    ],
  });
  // The CA state file leaves both cells blank: no document is listed.
  assert.deepEqual(documents(m, "ca-av-referral-yes-hsa"), {
    benefits_summary_url: null,
    plan_documents: [],
  });
}

it("lists the issuer's own SBC and brochure links from the selected variant row", () => {
  publicContract({ mapPlanColumns });
  const raw = publishedPlanColumns(values("federal-av-referral-yes"));
  // Another variant's row lends no document.
  expect(mapPlanColumns(raw, "40702AZ0060034-02", 2026, "AZ")).toEqual({});
  for (const link of ["javascript:alert(1)", "ftp://example.org/sbc.pdf", ""]) {
    const mapped = mapPlanColumns(
      { ...raw, URLForSummaryofBenefitsCoverage: link, PlanBrochure: link },
      raw.PlanId!,
      2026,
      "AZ",
    );
    expect(mapped.benefits_summary_url).toBeNull();
    expect(mapped.plan_documents).toEqual([]);
  }
});

it("negative controls: a borrowed URL column, swapped types or a blank-cell document fail the public contract", async () => {
  const source = await readFile(
    new URL("../../../src/compat/v1/mapping.ts", import.meta.url),
    "utf8",
  );
  const directory = await mkdtemp(join(tmpdir(), "openplans-documents-"));
  try {
    for (const [name, before, after] of [
      [
        "formulary-url",
        "benefits_summary_url: url(raw.URLForSummaryofBenefitsCoverage)",
        "benefits_summary_url: url(raw.FormularyURL)",
      ],
      [
        "brochure-as-sbc",
        '["plan_brochure", url(raw.PlanBrochure)]',
        '["summary_of_benefits_and_coverage", url(raw.PlanBrochure)]',
      ],
      [
        "blank-listed",
        ".filter(([, link]) => link !== null)",
        ".filter(() => true)",
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
