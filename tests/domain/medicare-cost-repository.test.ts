// Field decoding of the Part D benefit bundle. Rows are synthetic, shaped like the published files.
import { describe, expect, it } from "vitest";
import {
  bundleProvenanceProblems,
  decodeBound,
  decodeChannel,
  decodeDrug,
  decodeInsulin,
  decodeMoney,
  decodePlanRows,
  decodeRate,
  decodeTierCosts,
  sharedRowGroup,
  yearRules,
} from "../../src/domain/medicare/part-d-cost/repository.js";
import type {
  BenefitBundle,
  StoredRow,
} from "../../src/domain/medicare/part-d-cost/repository.js";
import { spufChannels, spufCodes } from "../../src/ingest/medicare/spuf.js";

const snapshot = "synthetic-snapshot";
const rules2026 = yearRules(2026);
const channels = ["PREF", "NONPREF", "MAIL_PREF", "MAIL_NONPREF"];

/** A Beneficiary Cost row with every channel set to the same type, amount and bounds. */
function cost(
  sourceRow: number,
  level: string,
  tier: string,
  supply: string,
  type: string,
  amount: string,
  extra: Record<string, string> = {},
): StoredRow {
  const cells: Record<string, string> = {
    CONTRACT_ID: "H9000",
    PLAN_ID: "001",
    SEGMENT_ID: "000",
    COVERAGE_LEVEL: level,
    TIER: tier,
    DAYS_SUPPLY: supply,
    TIER_SPECIALTY_YN: "N",
    DED_APPLIES_YN: "Y",
  };
  for (const suffix of channels) {
    cells[`COST_TYPE_${suffix}`] = type;
    cells[`COST_AMT_${suffix}`] = amount;
    cells[`COST_MIN_AMT_${suffix}`] = "0";
    cells[`COST_MAX_AMT_${suffix}`] = "0";
  }
  return { cells: { ...cells, ...extra }, source_row: sourceRow };
}
function insulinRow(
  sourceRow: number,
  tier: string,
  supply: string,
  copay: string,
  coin: string,
  extra: Record<string, string> = {},
): StoredRow {
  const cells: Record<string, string> = { TIER: tier, DAYS_SUPPLY: supply };
  for (const suffix of channels) {
    cells[`COPAY_AMT_${suffix}_INSLN`] = copay;
    cells[`COIN_AMT_${suffix}_INSLN`] = coin;
  }
  return { cells: { ...cells, ...extra }, source_row: sourceRow };
}

describe("Part D benefit field decoding", () => {
  it("keeps zero and blank apart in money, rate and bound cells", () => {
    expect(decodeMoney("0")).toEqual({ status: "value", cents: 0, raw: "0" });
    expect(decodeMoney("")).toEqual({ status: "not_reported", raw: "" });
    expect(decodeMoney("  ")).toEqual({ status: "not_reported", raw: "" });
    expect(decodeMoney("2.65")).toMatchObject({ cents: 265 });
    expect(decodeMoney("615")).toMatchObject({ cents: 61500 });
    expect(decodeMoney("1.234")).toMatchObject({ status: "unknown" });
    expect(decodeMoney("-5")).toMatchObject({ status: "unknown" });
    // Zero decodes as an amount; bounds.ts reads a zero bound as no bound (R1).
    expect(decodeBound("0")).toEqual({ status: "value", cents: 0, raw: "0" });
    expect(decodeBound("")).toEqual({ status: "not_reported", raw: "" });
    expect(decodeBound("12.65")).toMatchObject({
      status: "value",
      cents: 1265,
    });
  });

  it("reads coinsurance as a fraction of one: .25 is 25%", () => {
    expect(decodeRate(".25")).toEqual({
      status: "value",
      rate: "0.25",
      basis_points: 2500,
      raw: ".25",
    });
    expect(decodeRate("0.25")).toMatchObject({
      rate: "0.25",
      basis_points: 2500,
    });
    expect(decodeRate("0.5")).toMatchObject({
      rate: "0.5",
      basis_points: 5000,
    });
    expect(decodeRate("1")).toMatchObject({ rate: "1", basis_points: 10000 });
    expect(decodeRate("0")).toMatchObject({ status: "value", basis_points: 0 });
    expect(decodeRate("")).toEqual({ status: "not_reported", raw: "" });
    expect(decodeRate("25")).toMatchObject({ reason: "rate_above_one" });
    expect(decodeRate("0.125")).toMatchObject({
      reason: "rate_finer_than_basis_point",
    });
  });

  it("decodes each cost type and keeps a bounded copay's filed amount", () => {
    const pref = spufChannels[0];
    const copay = cost(2, "1", "1", "1", "1", "10").cells;
    expect(decodeChannel(copay, pref)).toMatchObject({
      status: "copay",
      amount: { status: "value", cents: 1000 },
      reason: null,
    });
    const zero = cost(2, "1", "1", "1", "1", "0").cells;
    expect(decodeChannel(zero, pref).amount).toMatchObject({
      status: "value",
      cents: 0,
    });
    const offered = cost(2, "1", "1", "1", "0", "0").cells;
    expect(decodeChannel(offered, pref)).toMatchObject({
      status: "not_offered",
      amount: null,
    });
    const coins = cost(2, "1", "1", "1", "2", "0.25").cells;
    expect(decodeChannel(coins, pref).amount).toMatchObject({
      basis_points: 2500,
    });
    const bounded = cost(2, "1", "1", "1", "1", "0", {
      COST_MIN_AMT_PREF: "1.6",
      COST_MAX_AMT_PREF: "5.1",
    }).cells;
    expect(decodeChannel(bounded, pref)).toMatchObject({
      status: "copay",
      amount: { status: "value", cents: 0, raw: "0" },
      minimum: { cents: 160 },
      maximum: { cents: 510 },
      reason: null,
    });
    const strange = cost(2, "1", "1", "1", "7", "0").cells;
    expect(decodeChannel(strange, pref)).toMatchObject({
      status: "unknown",
      reason: "unknown_cost_type",
    });
    const blankAmount = cost(2, "1", "1", "1", "1", "").cells;
    expect(decodeChannel(blankAmount, pref).amount).toEqual({
      status: "not_reported",
      raw: "",
    });
  });

  it("maps supply codes 1/2/3/4 to 30/90/other/60 days and phases 0/1/3", () => {
    const rows = [
      cost(2, "0", "1", "1", "1", "0"),
      cost(3, "1", "1", "2", "1", "0"),
      cost(4, "1", "1", "3", "1", "0"),
      cost(5, "3", "1", "4", "1", "0"),
    ];
    const { tiers, conflicts } = decodeTierCosts(snapshot, rows, rules2026);
    expect(conflicts).toEqual([]);
    expect(tiers.map((t) => [t.phase, t.supply])).toEqual([
      ["catastrophic", "60_days"],
      ["initial_coverage", "90_days"],
      ["initial_coverage", "other"],
      ["pre_deductible", "30_days"],
    ]);
  });

  it("turns unknown codes, the retired gap phase and conflicting duplicates into conflicts", () => {
    const rows = [
      cost(2, "2", "1", "1", "2", "0.25"),
      cost(3, "9", "1", "1", "1", "0"),
      cost(4, "1", "1", "5", "1", "0"),
      cost(5, "1", "x", "1", "1", "0"),
      cost(6, "1", "2", "1", "1", "10"),
      cost(7, "1", "2", "1", "1", "12"),
      cost(8, "1", "3", "1", "1", "40"),
      cost(9, "1", "3", "1", "1", "40"),
    ];
    const { tiers, conflicts } = decodeTierCosts(snapshot, rows, rules2026);
    expect(conflicts.map((c) => c.code).sort()).toEqual([
      "duplicate_cost_rows_disagree",
      "retired_coverage_gap_phase",
      "unknown_coverage_level",
      "unknown_days_supply",
      "unknown_tier",
    ]);
    expect(
      conflicts
        .find((c) => c.code === "duplicate_cost_rows_disagree")!
        .evidence.map((e) => e.source_row),
    ).toEqual([6, 7]);
    expect(tiers).toHaveLength(1);
    expect(tiers[0]!.evidence.map((e) => e.source_row)).toEqual([8, 9]);
  });

  it("flags catastrophic cost sharing that the year's rules forbid, and keeps zero rows", () => {
    const stale = cost(2, "3", "5", "1", "1", "10");
    const zero = cost(3, "3", "1", "1", "1", "0");
    const notOffered = cost(4, "3", "2", "1", "0", "0");
    const { tiers, conflicts } = decodeTierCosts(
      snapshot,
      [stale, zero, notOffered],
      rules2026,
    );
    expect(conflicts.map((c) => c.code)).toEqual([
      "catastrophic_cost_sharing_conflicts_with_rules",
    ]);
    expect(tiers.map((t) => t.tier)).toEqual([1, 2]);
    // The set-aside row's filed amounts stay in the conflict as evidence.
    expect(conflicts[0]!.filed).toEqual(
      spufChannels.map((channel) => ({ channel: channel.channel, raw: "10" })),
    );
    expect(conflicts[0]!.evidence.map((e) => e.source_row)).toEqual([2]);
  });

  it("keeps a blank insulin tier as null and derives not offered only from benefit rows", () => {
    const tierRows = [
      cost(2, "1", "3", "1", "0", "0", {
        COST_TYPE_NONPREF: "1",
        COST_AMT_NONPREF: "47",
      }),
    ];
    const blankPref = insulinRow(2, "3", "1", "35.00", "0.25", {
      COPAY_AMT_PREF_INSLN: "",
      COIN_AMT_PREF_INSLN: "",
      COPAY_AMT_MAIL_PREF_INSLN: "",
      COIN_AMT_MAIL_PREF_INSLN: "",
    });
    const standard = insulinRow(3, ".", "2", "105.00", "0.25", {
      COPAY_AMT_PREF_INSLN: "",
      COIN_AMT_PREF_INSLN: "",
    });
    const { insulin, conflicts } = decodeInsulin(
      snapshot,
      [blankPref, standard],
      tierRows,
    );
    expect(conflicts).toEqual([]);
    const [tiered, untiered] = insulin;
    expect(tiered!.tier).toBe(3);
    expect(tiered!.channels.map((c) => c.status)).toEqual([
      "not_offered",
      "filed",
      "not_offered",
      "filed",
    ]);
    expect(tiered!.channels[0]!.derived_from[0]!.source_row).toBe(2);
    expect(tiered!.channels[1]).toMatchObject({
      copay: { cents: 3500 },
      coinsurance: { basis_points: 2500 },
    });
    expect(untiered!.tier).toBeNull();
    expect(untiered!.supply).toBe("90_days");
    // No benefit row for a blank tier: the blank channel stays unknown.
    expect(untiered!.channels[0]).toMatchObject({
      status: "unknown",
      reason: "blank_insulin_cost",
    });
  });

  it("keeps an insulin zero as a filed zero, and reports duplicates", () => {
    const { insulin, conflicts } = decodeInsulin(
      snapshot,
      [
        insulinRow(2, "1", "1", "0.00", "0.00"),
        insulinRow(3, "1", "1", "0.00", "0.00"),
      ],
      [],
    );
    expect(insulin[0]!.channels[0]).toMatchObject({
      status: "filed",
      copay: { cents: 0 },
      coinsurance: { basis_points: 0 },
    });
    expect(conflicts.map((c) => c.code)).toEqual(["duplicate_insulin_rows"]);
  });

  it("groups county rows only when every row files the same value in every cited field", () => {
    const row = (sourceRow: number, cells: Record<string, string>) => ({
      cells,
      source_row: sourceRow,
    });
    const fields = ["DEDUCTIBLE", "SNP"];
    const agree = [
      row(9, { DEDUCTIBLE: "615", SNP: "0" }),
      row(4, { DEDUCTIBLE: "615", SNP: "0" }),
      row(6, { DEDUCTIBLE: "615", SNP: "0" }),
    ];
    expect(sharedRowGroup(snapshot, "plan", agree, fields)).toEqual({
      snapshot_id: snapshot,
      table: "plan",
      fields,
      source_rows: [4, 6, 9],
      values: { DEDUCTIBLE: "615", SNP: "0" },
    });
    // One differing cell, a missing cell, raw spacing or a single row: cited row by row.
    expect(
      sharedRowGroup(
        snapshot,
        "plan",
        [...agree, row(10, { DEDUCTIBLE: "600", SNP: "0" })],
        fields,
      ),
    ).toBeNull();
    expect(
      sharedRowGroup(
        snapshot,
        "plan",
        [...agree, row(10, { DEDUCTIBLE: "615" })],
        fields,
      ),
    ).toBeNull();
    expect(
      sharedRowGroup(
        snapshot,
        "plan",
        [...agree, row(10, { DEDUCTIBLE: "615 ", SNP: "0" })],
        fields,
      ),
    ).toBeNull();
    expect(sharedRowGroup(snapshot, "plan", agree.slice(0, 1), fields)).toBe(
      null,
    );
  });

  it("requires county rows to agree and the deductible to fit the year's standard", () => {
    const plan = (row: number, deductible: string, formulary = "00000001") => ({
      cells: { DEDUCTIBLE: deductible },
      source_row: row,
      formulary_id: formulary,
      suppressed: false,
    });
    const same = decodePlanRows(
      snapshot,
      [plan(3, "615"), plan(2, "615")],
      rules2026,
    );
    expect(same.deductible).toMatchObject({ status: "value", cents: 61500 });
    expect(same.evidence.map((e) => e.source_row)).toEqual([2, 3]);
    expect(same.conflicts).toEqual([]);
    const split = decodePlanRows(
      snapshot,
      [plan(2, "615"), plan(3, "600")],
      rules2026,
    );
    expect(split.deductible).toMatchObject({
      status: "unknown",
      reason: "plan_rows_disagree",
    });
    const over = decodePlanRows(snapshot, [plan(2, "700")], rules2026);
    expect(over.deductible).toMatchObject({
      status: "unknown",
      reason: "plan_deductible_exceeds_standard",
    });
    expect(
      decodePlanRows(snapshot, [plan(2, "700")], yearRules(2027)).deductible,
    ).toMatchObject({
      status: "value",
      cents: 70000,
    });
    const zero = decodePlanRows(snapshot, [plan(2, "0")], rules2026);
    expect(zero.deductible).toMatchObject({ status: "value", cents: 0 });
    const two = decodePlanRows(
      snapshot,
      [plan(2, "615", "1"), plan(3, "615", "2")],
      rules2026,
    );
    expect(two.formularies).toEqual(["1", "2"]);
  });

  it("reads the SNP code of the county rows and keeps disagreement unknown", () => {
    const plan = (row: number, snp: string) => ({
      cells: { DEDUCTIBLE: "615", SNP: snp },
      source_row: row,
      formulary_id: "00000001",
      suppressed: false,
    });
    const dual = decodePlanRows(
      snapshot,
      [plan(3, "2"), plan(2, "2")],
      rules2026,
    );
    expect(dual.special_needs_plan).toMatchObject({
      status: "value",
      code: "2",
      snp: true,
    });
    expect(
      dual.special_needs_plan.evidence.map((e) => [e.source_row, e.fields]),
    ).toEqual([
      [2, ["SNP"]],
      [3, ["SNP"]],
    ]);
    expect(
      decodePlanRows(snapshot, [plan(2, "0")], rules2026).special_needs_plan,
    ).toMatchObject({ status: "value", snp: false });
    const split = decodePlanRows(
      snapshot,
      [plan(2, "0"), plan(3, "2")],
      rules2026,
    );
    expect(split.special_needs_plan).toMatchObject({
      status: "unknown",
      reason: "plan_rows_disagree",
    });
    expect(split.conflicts.map((c) => c.detail)).toEqual(['SNP "0", "2"']);
    expect(
      decodePlanRows(snapshot, [plan(2, "7")], rules2026).special_needs_plan,
    ).toMatchObject({ status: "unknown", reason: "unknown_snp_code" });
    expect(
      decodePlanRows(snapshot, [plan(2, "")], rules2026).special_needs_plan,
    ).toMatchObject({ status: "unknown", reason: "snp_not_reported" });
  });

  it("keeps every proxy NDC, never picks one, and checks the formulary year", () => {
    const row = (
      sourceRow: number,
      ndc: string,
      year = "2026",
      tier: number | null = 3,
    ) => ({
      ndc,
      tier,
      source_row: sourceRow,
      cells: {
        CONTRACT_YEAR: year,
        PRIOR_AUTHORIZATION_YN: "Y",
        STEP_THERAPY_YN: "N",
        QUANTITY_LIMIT_YN: "",
        SELECTED_DRUG_YN: "Y",
      },
    });
    const single = decodeDrug(
      snapshot,
      2026,
      "1",
      [row(2, "00000000001")],
      [],
      [],
    );
    expect(single).toMatchObject({ status: "listed", product: "single" });
    expect(single.packages[0]).toMatchObject({
      prior_authorization: true,
      step_therapy: false,
      quantity_limit: "unknown",
      selected_drug: true,
    });
    const two = decodeDrug(
      snapshot,
      2026,
      "1",
      [row(3, "00000000002"), row(2, "00000000001")],
      [],
      [],
    );
    expect(two).toMatchObject({
      status: "listed",
      product: "ambiguous",
      reason: "ambiguous_drug_product",
    });
    expect(two.packages.map((p) => p.proxy_ndc)).toEqual([
      "00000000001",
      "00000000002",
    ]);
    expect(
      decodeDrug(snapshot, 2027, "1", [row(2, "00000000001")], [], []),
    ).toMatchObject({
      status: "unknown",
      reason: "formulary_year_mismatch",
    });
    expect(decodeDrug(snapshot, 2026, "1", [], [], [])).toMatchObject({
      status: "not_listed",
      product: "none",
    });
    const supplemental = decodeDrug(
      snapshot,
      2026,
      "1",
      [],
      [{ cells: { TIER: "6" }, source_row: 4 }],
      [{ cells: { DISEASE: "Synthetic" }, source_row: 5 }],
    );
    expect(supplemental.status).toBe("not_listed");
    expect(supplemental.supplemental).toMatchObject([{ tier: 6 }]);
    expect(supplemental.indications).toMatchObject([{ disease: "Synthetic" }]);
  });

  it("loads the reviewed rules for 2026 and 2027 only", () => {
    expect(rules2026).toMatchObject({
      status: "value",
      standard_deductible: { cents: 61500 },
      out_of_pocket_threshold: { cents: 210000 },
      catastrophic_cost_sharing: { basis_points: 0 },
    });
    expect(yearRules(2027)).toMatchObject({
      standard_deductible: { cents: 70000 },
      out_of_pocket_threshold: { cents: 240000 },
    });
    expect(yearRules(2028)).toEqual({
      status: "unknown",
      contract_year: 2028,
      reason: "rules_not_loaded",
    });
    if (rules2026.status !== "value") throw new Error("2026 rules not loaded");
    expect(rules2026.documents.map((d) => d.id).sort()).toEqual(["C4", "C5"]);
  });

  describe("planted mutants", () => {
    const rows = [
      cost(2, "0", "1", "1", "1", "0"),
      cost(3, "1", "1", "2", "2", ".25"),
      cost(4, "1", "1", "4", "1", "10"),
    ];
    // The layout's reading, written out independently of the decoder.
    const expected = [
      [4, "initial_coverage", "60_days"],
      [3, "initial_coverage", "90_days"],
      [2, "pre_deductible", "30_days"],
    ];
    const read = (codes: typeof spufCodes) =>
      decodeTierCosts(snapshot, rows, rules2026, codes)
        .tiers.map((t) => [t.evidence[0]!.source_row, t.phase, t.supply])
        .sort((a, b) => `${a[1]}${a[2]}`.localeCompare(`${b[1]}${b[2]}`));

    it("the layout reading passes", () => {
      expect(read(spufCodes)).toEqual(expected);
    });
    it("swapped 60- and 90-day codes fail", () => {
      const swapped = {
        ...spufCodes,
        daysSupply: { ...spufCodes.daysSupply, "2": "60_days", "4": "90_days" },
      } as unknown as typeof spufCodes;
      expect(read(swapped)).not.toEqual(expected);
    });
    it("a dropped source row fails the provenance check", () => {
      const bundle: BenefitBundle = {
        status: "available",
        bundle_version: "1",
        plan_key: "H9000-001-0",
        contract_year: 2026,
        release: {
          snapshot_id: snapshot,
          kind: "quarterly",
          contract_year: 2026,
          as_of: "2026-10-07",
          sha256: "0".repeat(64),
          url: "https://data.cms.gov/synthetic.zip",
        },
        formulary_id: "00000001",
        deductible: { status: "value", cents: 0, raw: "0" },
        deductible_evidence: [
          {
            snapshot_id: snapshot,
            table: "plan",
            source_row: 2,
            fields: ["DEDUCTIBLE"],
          },
        ],
        special_needs_plan: {
          status: "value",
          code: "0",
          snp: false,
          evidence: [
            {
              snapshot_id: snapshot,
              table: "plan",
              source_row: 2,
              fields: ["SNP"],
            },
          ],
        },
        ...decodeTierCosts(snapshot, rows, rules2026),
        insulin: [],
        drugs: [],
        rules: rules2026,
        gaps: [],
      };
      expect(bundleProvenanceProblems(bundle)).toEqual([]);
      const dropped = structuredClone(bundle);
      if (dropped.status !== "available") throw new Error("unreachable");
      dropped.tiers[1]!.evidence = [];
      expect(bundleProvenanceProblems(dropped)).toEqual([
        "tier 1 initial_coverage 90_days: no source row",
      ]);
      const moved = structuredClone(bundle);
      if (moved.status !== "available") throw new Error("unreachable");
      moved.tiers[0]!.evidence[0]!.snapshot_id = "other-release";
      expect(bundleProvenanceProblems(moved).join()).toMatch(/another release/);
      const wrongTable = structuredClone(bundle);
      if (wrongTable.status !== "available") throw new Error("unreachable");
      wrongTable.deductible_evidence[0]!.table = "formulary";
      expect(bundleProvenanceProblems(wrongTable).join()).toMatch(/not plan/);
      const noSnp = structuredClone(bundle);
      if (noSnp.status !== "available") throw new Error("unreachable");
      noSnp.special_needs_plan.evidence = [];
      expect(bundleProvenanceProblems(noSnp)).toEqual([
        "special needs plan: no source row",
      ]);
    });
  });
});
