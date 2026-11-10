import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importMedicare } from "../../../src/ingest/medicare/command.js";
import { countyMap } from "../../../src/ingest/medicare/county-codes.js";
import { loadedDatabase } from "./helpers.js";
import type { Loaded, Mutate } from "./helpers.js";

/** Replaces one byte string in a fixture member (planted mutant). */
function edit(
  family: string,
  member: RegExp,
  from: string,
  to: string,
): Mutate {
  return (name, files) => {
    if (name !== family) return;
    const key = Object.keys(files).find((entry) => member.test(entry))!;
    const text = files[key]!.toString("latin1");
    if (!text.includes(from)) throw new Error(`mutant anchor missing: ${from}`);
    files[key] = Buffer.from(text.replace(from, to), "latin1");
  };
}
async function expectImportFails(mutate: Mutate, message: RegExp) {
  await expect(loadedDatabase(mutate)).rejects.toThrow(message);
}

describe("Medicare import from real CMS cuts (CY2026)", () => {
  let loaded: Loaded;
  beforeAll(async () => {
    loaded = await loadedDatabase();
  }, 120_000);
  afterAll(async () => loaded?.cleanup());

  it("loads every family as an ACTIVE release with counts", async () => {
    const { rows } = await loaded.db.query<{
      family: string;
      as_of_label: string;
      counts: Record<string, number>;
      validation_state: string;
    }>(
      `SELECT r.family,r.as_of_label,r.counts,s.validation_state FROM medicare_release r JOIN snapshot s USING(snapshot_id) ORDER BY r.family,r.as_of_label`,
    );
    expect(
      rows.map((row) => [row.family, row.as_of_label, row.validation_state]),
    ).toEqual([
      ["crosswalk", "2026", "ACTIVE"],
      ["landscape", "202609", "ACTIVE"],
      ["pbp", "2026", "ACTIVE"],
      ["service_area", "ma-2026-10", "ACTIVE"],
      ["service_area", "pdp-2026-10", "ACTIVE"],
      ["stars", "2026", "ACTIVE"],
    ]);
    const landscape = rows.find((row) => row.family === "landscape")!.counts;
    expect(landscape).toMatchObject({
      rows: 12,
      county_fips_unresolved: 0,
      county_fips_ambiguous: 0,
    });
    const pbp = rows.find((row) => row.family === "pbp")!.counts;
    // The employer contract rows planted in the PlanArea cut are never loaded.
    expect(pbp.plan_area_employer_group_skipped).toBe(3);
  });

  it("keeps published money and star cells exactly, including a negative basic premium", async () => {
    const { rows } = await loaded.db.query<{ cells: Record<string, string> }>(
      "SELECT cells FROM medicare_plan WHERE contract_id='S4802' AND plan_id='155'",
    );
    expect(rows[0]!.cells["Part D Basic Premium"]).toMatch(/^\(\$\d+\.\d\d\)$/);
    const h = await loaded.db.query<{ cells: Record<string, string> }>(
      "SELECT cells FROM medicare_plan WHERE contract_id='H0028' AND plan_id='042'",
    );
    expect(h.rows[0]!.cells).toMatchObject({
      "Annual Part D Deductible Amount": "$340.00",
      "In-Network Maximum Out-of-Pocket (MOOP) Amount": "$3,450.00",
      "Overall Star Rating": "3.5",
    });
  });

  it("maps SSA county codes many-to-many and ignores retired MA alternates", async () => {
    const map = await countyMap(loaded.db);
    const fips = (ssa: string) =>
      map.pairs
        .filter((p) => p.ssa === ssa)
        .map((p) => p.fips)
        .sort();
    expect(fips("05200")).toEqual(["06037"]);
    expect(fips("05210")).toEqual(["06037"]);
    expect(fips("10120")).toEqual(["12086"]); // MA file also lists the retired 12025
    expect(map.maAlternates).toContain("10120");
    expect(fips("48020").length).toBeGreaterThan(1); // USVI: one SSA unit, several FIPS
    expect(map.conflicted).toEqual([]);
  });

  it("re-importing the same bytes is a no-op", async () => {
    const again = await importMedicare(
      loaded.db,
      { year: 2026 },
      loaded.dataDir,
    );
    expect(new Set(again.map((report) => report.outcome))).toEqual(
      new Set(["noop"]),
    );
  });
});

describe("negative controls (each planted mutant must fail the import)", () => {
  it("a renamed Landscape column", () =>
    expectImportFails(
      edit("landscape", /\.csv$/, "Overall Star Rating", "Overall Stars"),
      /Landscape header/,
    ));
  it("one segment's cells differing across counties", () =>
    expectImportFails((family, files) => {
      if (family !== "landscape") return;
      const key = Object.keys(files)[0]!;
      const lines = files[key]!.toString("utf8").split("\r\n");
      const at = lines.findIndex(
        (line, i) => i > 0 && line.includes("H0028_042_0"),
      );
      lines[at] = lines[at]!.replace("Humana Gold Plus", "Humana Gold Minus");
      files[key] = Buffer.from(lines.join("\r\n"), "utf8");
    }, /differs across counties/));
  it("a repeated PlanArea column carrying two values", () =>
    expectImportFails((family, files) => {
      if (family !== "pbp") return;
      const lines = files["PlanArea.txt"]!.toString("latin1").split("\r\n");
      const cells = lines[1]!.split("\t");
      cells[2] = "9"; // first segment_id copy; the second copy stays as published
      lines[1] = cells.join("\t");
      files["PlanArea.txt"] = Buffer.from(lines.join("\r\n"), "latin1");
    }, /Repeated column segment_id differs/));
  it("a column the SAS layout does not declare", () =>
    expectImportFails(
      edit(
        "pbp",
        /^pbp_b7_health_prof\.txt$/,
        "pbp_b7a_copay_yn",
        "pbp_b7a_copay_renamed",
      ),
      /header differs from its SAS layout/,
    ));
  it("a non-numeric value in a numeric PBP field", () =>
    expectImportFails((family, files) => {
      if (family !== "pbp") return;
      const lines =
        files["pbp_Section_D.txt"]!.toString("latin1").split("\r\n");
      const head = lines[0]!.split("\t");
      const at = head.indexOf("pbp_d_out_pocket_amt");
      const row = lines.findIndex((line, i) => i > 0 && line.split("\t")[at]);
      const cells = lines[row]!.split("\t");
      cells[at] = "3,450";
      lines[row] = cells.join("\t");
      files["pbp_Section_D.txt"] = Buffer.from(lines.join("\r\n"), "latin1");
    }, /not numeric/));
  it("an invalid partial-county flag", () =>
    expectImportFails((family, files) => {
      if (family !== "pbp") return;
      const lines = files["PlanArea.txt"]!.toString("latin1").split("\r\n");
      const head = lines[0]!.split("\t");
      const cells = lines[1]!.split("\t");
      cells[head.indexOf("partial_flag")] = "Y";
      lines[1] = cells.join("\t");
      files["PlanArea.txt"] = Buffer.from(lines.join("\r\n"), "latin1");
    }, /partial_flag is not 0\/1/));
});
