import { describe, expect, it } from "vitest";
import {
  resolveAnnualPolicy,
  admissionSchema,
} from "../../src/domain/data-window.js";
import type { AnnualAdmission } from "../../src/domain/data-window.js";
import { loadConfig } from "../../src/config/index.js";

// Synthetic admission identities; no rates or coverage are invented.
const admission = (
  domain: "individual" | "medicare",
  year: number,
): AnnualAdmission => ({
  domain,
  coverage_year: year,
  manifest: {
    schema_version: 1,
    releases: [
      {
        kind: domain === "individual" ? "puf" : "medicare",
        snapshot_id: `synthetic-${domain}-${year}`,
        contract_year: year,
      },
    ],
  },
});
const loaded = { individual: [2024, 2025, 2026, 2027], medicare: [2025, 2026] };
const at = (
  date: string,
  admissions: AnnualAdmission[] = [],
  history: 3 | "all" = 3,
) => resolveAnnualPolicy(history, admissions, loaded, new Date(date));

describe("annual window", () => {
  it("defaults to a ceiling of three years and permits explicit self-hosted history", () => {
    expect(loadConfig({}).data.historyYears).toBe(3);
    expect(
      loadConfig({}, { version: 1, data: { historyYears: "all" } }).data
        .historyYears,
    ).toBe("all");
    for (const historyYears of [0, 1, 2, 4, "3", "ALL", null])
      expect(() =>
        loadConfig({}, { version: 1, data: { historyYears } }),
      ).toThrow();
  });
  it("requires admission rather than downloaded or published next-year rows", () => {
    const policy = at("2026-10-01T00:00:00Z");
    expect(policy.domains.individual.allowed_years).toEqual([2025, 2026]);
    expect(policy.domains.individual.excluded_loaded_years).toEqual([
      2024, 2027,
    ]);
  });
  it("adds next year across the individual domain and keeps the prior year while Medicare waits", () => {
    const policy = at("2026-10-01T00:00:00Z", [admission("individual", 2027)]);
    expect(policy.domains.individual.allowed_years).toEqual([2025, 2026, 2027]);
    expect(policy.domains.medicare.allowed_years).toEqual([2025, 2026]);
    expect(policy.domains.individual.excluded_loaded_years).toEqual([2024]);
    expect(policy.domains.individual.allowed_years).toHaveLength(3);
  });
  it.each([
    ["2026-12-31T23:59:59.999Z", [], [2025, 2026]],
    ["2027-01-01T00:00:00.000Z", [], [2026, 2027]],
    [
      "2026-12-31T23:59:59.999Z",
      [admission("individual", 2027)],
      [2025, 2026, 2027],
    ],
    ["2027-01-01T00:00:00.000Z", [admission("individual", 2027)], [2026, 2027]],
    ["2026-12-31T23:59:59-05:00", [], [2026, 2027]],
  ] as const)("resolves UTC boundary %s", (date, admissions, expected) => {
    expect(at(date, [...admissions]).domains.individual.allowed_years).toEqual(
      expected,
    );
  });
  it("never selects an invented C+2 anchor or shifts backward to fill a gap", () => {
    expect(
      at("2026-10-01Z", [admission("individual", 2028)]).domains.individual
        .allowed_years,
    ).toEqual([2025, 2026]);
    const policy = resolveAnnualPolicy(
      3,
      [admission("medicare", 2027)],
      loaded,
      new Date("2026-10-01Z"),
    );
    expect(policy.domains.medicare.allowed_years).toEqual([2025, 2026, 2027]);
    expect(policy.domains.medicare.missing_allowed_years).toEqual([2027]);
  });
  it("keeps PY2025 by default while self-hosted full history also permits PY2024", () => {
    const admissions = [admission("individual", 2027)];
    const bounded = at("2026-11-19Z", admissions);
    const full = at("2026-11-19Z", admissions, "all");
    expect(bounded.domains.individual.allowed_years).toEqual([
      2025, 2026, 2027,
    ]);
    expect(full.domains.individual.allowed_years).toEqual([
      2024, 2025, 2026, 2027,
    ]);
    expect(full.generation).not.toBe(bounded.generation);
    expect(at("2027-01-01Z", admissions).generation).not.toBe(
      bounded.generation,
    );
  });
  it("never permits a fourth year and excludes PY2025 when PY2028 is admitted in 2027", () => {
    const today = at("2026-11-19Z", [admission("individual", 2027)]);
    expect(today.domains.individual.allowed_years).not.toContain(2024);
    const next = at("2027-10-01Z", [
      admission("individual", 2027),
      admission("individual", 2028),
    ]);
    expect(next.domains.individual.allowed_years).toEqual([2026, 2027, 2028]);
    expect(next.domains.individual.excluded_loaded_years).toEqual([2024, 2025]);
  });
  it("refuses a Part D release that tries to advance without its Medicare catalog", () => {
    const row = admission("medicare", 2027);
    row.manifest.releases[0]!.kind = "partd";
    expect(() => admissionSchema.parse(row)).toThrow();
  });
  it("rejects wrong embedded contract year and domain in the admission manifest", () => {
    const mutant = admission("medicare", 2027);
    mutant.manifest.releases[0]!.contract_year = 2026;
    expect(() => admissionSchema.parse(mutant)).toThrow();
    expect(() => at("2026-11-19Z", [mutant])).toThrow();
    const wrongDomain = admission("individual", 2027);
    wrongDomain.manifest.releases[0]!.kind = "partd";
    expect(() => admissionSchema.parse(wrongDomain)).toThrow();
  });
});
