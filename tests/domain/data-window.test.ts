import { describe, expect, it } from "vitest";
import {
  resolveAnnualPolicy,
  admissionSchema,
} from "../../src/domain/data-window.js";
import type { AnnualAdmission } from "../../src/domain/data-window.js";
import { loadConfig } from "../../src/config/index.js";
import type { HistoryYears } from "@openplans/plugin-sdk";
import { dataPolicySchema } from "@openplans/plugin-sdk";

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
  history: HistoryYears = 3,
) => resolveAnnualPolicy(history, admissions, loaded, new Date(date));

describe("annual window", () => {
  it("defaults to three and accepts only integer settings from one to three", () => {
    expect(loadConfig({}).data.historyYears).toBe(3);
    for (const historyYears of [1, 2, 3])
      expect(
        loadConfig({}, { version: 1, data: { historyYears } }).data
          .historyYears,
      ).toBe(historyYears);
    for (const historyYears of [0, 4, 100, 1.5, "3", "all", "ALL", null, true])
      expect(() =>
        loadConfig({}, { version: 1, data: { historyYears } }),
      ).toThrow("data.historyYears must be an integer from 1 to 3");
  });
  it.each([
    [1, [2026], [2026]],
    [2, [2025, 2026], [2026, 2027]],
    [3, [2025, 2026], [2025, 2026, 2027]],
  ] as const)(
    "resolves setting %i before and after domain admission",
    (history, before, after) => {
      expect(
        at("2026-10-01Z", [], history).domains.individual.allowed_years,
      ).toEqual(before);
      const admitted = at(
        "2026-10-01Z",
        [admission("individual", 2027)],
        history,
      );
      expect(admitted.domains.individual.allowed_years).toEqual(after);
      expect(admitted.domains.medicare.allowed_years).toEqual(before);
      expect(dataPolicySchema.safeParse(admitted).success).toBe(true);
    },
  );
  it.each([
    [1, [2026]],
    [2, [2026, 2027]],
    [3, [2025, 2026, 2027]],
  ] as const)(
    "bounds build setting %i while allowing preparation before serving admission",
    (history, expected) => {
      const policy = resolveAnnualPolicy(
        history,
        [],
        loaded,
        new Date("2026-10-01Z"),
        "build",
      );
      expect(policy.domains.individual.allowed_years).toEqual(expected);
      expect(policy.domains.medicare.allowed_years).toEqual(expected);
      expect(policy.domains.individual.admitted_years).toEqual([]);
    },
  );
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
  it("binds policy generation to the bounded setting and UTC year", () => {
    const admissions = [admission("individual", 2027)];
    const bounded = at("2026-11-19Z", admissions);
    const current = at("2026-11-19Z", admissions, 1);
    expect(bounded.domains.individual.allowed_years).toEqual([
      2025, 2026, 2027,
    ]);
    expect(current.domains.individual.allowed_years).toEqual([2026]);
    expect(current.generation).not.toBe(bounded.generation);
    expect(at("2027-01-01Z", admissions).generation).not.toBe(
      bounded.generation,
    );
  });
  it("negative control: policy responses cannot advertise a fourth allowed year", () => {
    const policy = at("2026-11-19Z", [admission("individual", 2027)]);
    expect(dataPolicySchema.safeParse(policy).success).toBe(true);
    expect(
      dataPolicySchema.safeParse({
        ...policy,
        domains: {
          ...policy.domains,
          individual: {
            ...policy.domains.individual,
            allowed_years: [2024, 2025, 2026, 2027],
          },
        },
      }).success,
    ).toBe(false);
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
