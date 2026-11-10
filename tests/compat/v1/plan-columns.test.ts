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

interface PublicRow {
  label: string;
  url: string;
  sha256: string;
  source_row: number;
  values: Record<string, string>;
}
const fixture = JSON.parse(
  await readFile(
    new URL("./plan-columns-public.json", import.meta.url),
    "utf8",
  ),
) as { kind: string; rows: PublicRow[] };
const rows = new Map(fixture.rows.map((row) => [row.label, row]));
const columns = (label: string) =>
  publishedPlanColumns(stateDetailColumns(rows.get(label)!.values));

type Mapper = { mapPlanColumns: typeof mapPlanColumns };
function mapped(m: Mapper, label: string) {
  const raw = columns(label);
  return m.mapPlanColumns(raw, raw.PlanId!, 2026, raw.StateCode!);
}

/** Expected values are the cited public cells, converted exactly. */
function publicContract(m: Mapper) {
  assert.deepEqual(pick(mapped(m, "federal-av-referral-yes")), {
    gated: true,
    sbc_name: rows.get("federal-av-referral-yes")!.values
      .PlanVariantMarketingName,
    actuarial_value: 63.35,
  });
  assert.deepEqual(pick(mapped(m, "federal-blank-av-referral-no")), {
    gated: false,
    sbc_name: "Gold 22 Health",
    actuarial_value: null,
  });
  // A CSR variant row publishes its own variant name.
  assert.equal(
    mapped(m, "federal-variant-name-differs").sbc_name,
    "BlueSelect Bronze 24L01-01U",
  );
  assert.deepEqual(mapped(m, "ca-av-referral-yes-hsa"), {
    plan_type: "HMO",
    hsa_eligible: true,
    gated: true,
    sbc_name: "Bronze 60 HMO",
    actuarial_value: 63.7,
    effective_date: "2026-01-01T00:00:00.000Z",
    expiration_date: "2026-12-31T00:00:00.000Z",
    // The CA state file leaves FORMULARY URL and both document URL cells blank.
    drug_formulary_url: null,
    benefits_summary_url: null,
    plan_documents: [],
    // CA spells the design and EHB columns PLAN DESIGN TYPE and EHB PERCENT PREMIUM.
    standardized_plan: false,
    essential_health_benefits_percentage: 100,
    plan_calendar: "calendar_year",
  });
  assert.deepEqual(pick(mapped(m, "ca-blank-av-blank-referral")), {
    gated: null,
    sbc_name: "Family Dental PPO",
    actuarial_value: null,
  });
}
const pick = (value: Record<string, unknown>) => ({
  gated: value.gated,
  sbc_name: value.sbc_name,
  actuarial_value: value.actuarial_value,
});

it("uses real public rows from the pinned federal and CA publications", () => {
  expect(fixture.kind).toBe("real-public-row-cut");
  for (const row of fixture.rows) {
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row.source_row).toBeGreaterThan(1);
  }
});

it("maps the referral, variant-name and issuer AV columns from the selected row", () => {
  publicContract({ mapPlanColumns });
});

it("reads CA spaced headers only after header normalization", () => {
  const spaced = rows.get("ca-av-referral-yes-hsa")!.values;
  expect(publishedPlanColumns(spaced)).toEqual({});
  expect(columns("ca-av-referral-yes-hsa")).toMatchObject({
    PlanId: "27603CA1150039-01",
    IsReferralRequiredForSpecialist: "Yes",
    PlanVariantMarketingName: "Bronze 60 HMO",
    IssuerActuarialValue: "63.70%",
  });
});

it("keeps malformed or non-percentage AV and referral cells unknown", () => {
  const raw = columns("federal-av-referral-yes");
  for (const [cell, value] of [
    ["IssuerActuarialValue", "0.6335"],
    ["IssuerActuarialValue", "Not Applicable"],
    ["IssuerActuarialValue", "%"],
    ["IsReferralRequiredForSpecialist", "Maybe"],
    ["IsReferralRequiredForSpecialist", ""],
  ] as const) {
    const result = mapPlanColumns(
      { ...raw, [cell]: value },
      raw.PlanId!,
      2026,
      "AZ",
    );
    expect(
      cell === "IssuerActuarialValue" ? result.actuarial_value : result.gated,
    ).toBeNull();
  }
  // Another variant's row never supplies these columns.
  expect(mapPlanColumns(raw, "40702AZ0060034-02", 2026, "AZ")).toEqual({});
});

it("negative controls: borrowed, inverted or calculator-derived columns fail the public contract", async () => {
  const source = await readFile(
    new URL("../../../src/compat/v1/mapping.ts", import.meta.url),
    "utf8",
  );
  const directory = await mkdtemp(join(tmpdir(), "openplans-plan-columns-"));
  try {
    for (const [name, before, after] of [
      [
        "pregnancy-notice",
        "yesNo(raw.IsReferralRequiredForSpecialist)",
        "yesNo(raw.IsNoticeRequiredForPregnancy)",
      ],
      ["inverted", "{ Yes: true, No: false }", "{ Yes: false, No: true }"],
      [
        "calculator-av",
        "percent(raw.IssuerActuarialValue)",
        "percent(raw.AVCalculatorOutputNumber)",
      ],
      [
        "marketing-name",
        "raw.PlanVariantMarketingName?.trim()",
        "raw.PlanMarketingName?.trim()",
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
