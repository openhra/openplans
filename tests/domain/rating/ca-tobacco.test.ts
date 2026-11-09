import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  householdPremium,
  parseRateRow,
} from "../../../src/domain/rating/index.js";
import {
  CA_INDIVIDUAL_TOBACCO_POLICY,
  medicalTobaccoPolicy,
} from "../../../src/domain/rating/medical-policy.js";
import {
  assertCaFamily,
  caExamples,
  caFamily,
  caFamilyPremium,
  caFixture,
  caHousehold,
  caRows,
} from "./ca-helpers.js";

const policy = CA_INDIVIDUAL_TOBACCO_POLICY;
const publication = (
  name: string,
): { sourceSha256: string; cells: Record<string, string>; rowHtml: string } =>
  JSON.parse(
    readFileSync(
      new URL(`../../fixtures/rating/ca-2026/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
const full = publication("full"),
  geography = publication("geography");

describe("CA PY2026 filed IndividualRate tobacco policy", () => {
  it("pins the CMS 1:1 rule and authorizes only the reviewed scope and inclusive interval", () => {
    expect(publication("tobacco-rule").sourceSha256).toBe(
      policy.provenance.source_sha256,
    );
    expect(publication("tobacco-rule").rowHtml).toContain(
      "<td>California</td>",
    );
    const scope = {
      state: "CA",
      planYear: 2026,
      market: "Individual",
      dentalOnly: false,
      coverageStartDate: "2026-01-01",
    };
    for (const coverageStartDate of ["2026-01-01", "2026-12-31"])
      expect(medicalTobaccoPolicy({ ...scope, coverageStartDate })).toBe(
        policy,
      );
    for (const change of [
      { state: "TX" },
      { planYear: 2027 },
      { market: "SHOP (Small Group)" },
      { dentalOnly: true },
      { coverageStartDate: "2025-12-31" },
      { coverageStartDate: "2027-01-01" },
    ])
      expect(medicalTobaccoPolicy({ ...scope, ...change })).toBeNull();
  });

  it.each(caExamples)(
    "uses both tobacco flags with original public row identity in $area",
    (example) => {
      for (const tobacco of [false, true]) {
        const result = householdPremium(
          caRows,
          example.plan,
          example.area,
          caHousehold(tobacco),
          policy.policy,
        );
        expect(result).toMatchObject({
          status: "rated",
          totalCents: example.cents,
          members: [{ tobaccoUse: tobacco, premiumCents: example.cents }],
        });
        expect(result.rowsUsed[0]!.provenance).toEqual({
          snapshotId: `sha256:${caFixture.sourceSha256}`,
          sourceFile: caFixture.sourceFile,
          sourceRowNumber: example.row,
        });
        expect(result.rowsUsed[0]!.individualTobaccoRateCents).toBeNull();
      }
      expect(full.cells[`A${example.cell}`]).toBe(example.plan);
      expect(full.cells[`B${example.cell}`]).toBe(example.area);
      expect(full.cells[`C${example.cell}`]).toBe("40");
      expect(Math.round(Number(full.cells[`D${example.cell}`]) * 100)).toBe(
        example.cents,
      );
      expect(geography.cells[`B${example.geo}`]).toBe(
        example.area.replace("Rating Area ", ""),
      );
      expect(geography.cells[`D${example.geo}`]).toBe(example.county.slice(2));
      expect(geography.cells[`E${example.geo}`]).toBe(example.zip);
    },
  );

  it("distinguishes a blank IndividualRate from an explicit zero under the policy", () => {
    const row = caRows[0]!;
    for (const [IndividualRate, totalCents, status] of [
      ["", null, "unknown"],
      ["0.00", 0, "rated"],
    ] as const) {
      const mutant = parseRateRow(
        { ...row.raw, IndividualRate },
        row.provenance,
      );
      expect(
        householdPremium(
          [mutant],
          row.planId,
          row.ratingAreaId,
          caHousehold(true),
          policy.policy,
        ),
      ).toMatchObject({ status, totalCents });
    }
  });

  it("keeps full family gross, the filed 0-14 band and the three-child cap", () => {
    const result = caFamilyPremium();
    assertCaFamily(result);
    expect(result.members[2]!.rateRows[0]!.age).toBe("0-14");
    const four = caFamilyPremium({
      ...caFamily,
      members: [
        ...caFamily.members.slice(0, 2),
        ...[8, 7, 5, 4].map((age) => ({
          id: String(age),
          age,
          relationship: "child" as const,
          tobaccoUse: true,
        })),
      ],
    });
    expect(four.totalCents).toBe(665689);
    expect(four.members.map((m) => m.premiumCents)).toEqual([
      172528, 169140, 108007, 108007, 108007, 0,
    ]);
    expect(four.members[5]).toMatchObject({ charged: false, tobaccoUse: true });
  });

  it("rejects a disabled policy, one-cent rate mutation, alternate benefit basis, wrong area and dropped child", () => {
    const example = caExamples[0]!,
      row = caRows[0]!;
    const disabled = householdPremium(
      caRows,
      example.plan,
      example.area,
      caHousehold(true),
    );
    expect(disabled).toMatchObject({ status: "unknown", totalCents: null });
    expect(() =>
      assert.equal(disabled.totalCents, example.cents, "filed smoker gross"),
    ).toThrow("filed smoker gross");
    for (const IndividualRate of [
      "593.97",
      Number(publication("without-non-ehb").cells.D11305).toFixed(2),
    ]) {
      const mutant = parseRateRow(
        { ...row.raw, IndividualRate },
        row.provenance,
      );
      const result = householdPremium(
        [mutant],
        example.plan,
        example.area,
        caHousehold(true),
        policy.policy,
      );
      expect(() =>
        assert.equal(result.totalCents, example.cents, "filed smoker gross"),
      ).toThrow("filed smoker gross");
    }
    expect(() =>
      assert.equal(
        householdPremium(
          caRows,
          example.plan,
          "Rating Area 7",
          caHousehold(true),
          policy.policy,
        ).totalCents,
        example.cents,
        "filed area gross",
      ),
    ).toThrow("filed area gross");
    expect(() =>
      assertCaFamily(
        caFamilyPremium({ ...caFamily, members: caFamily.members.slice(0, 2) }),
      ),
    ).toThrow("filed family gross");
  });

  it("keeps a synthetic non-CA dual-tobacco blank unknown even under an explicit No Preference policy", () => {
    const row = caRows[0]!;
    const dual = parseRateRow(
      {
        ...row.raw,
        StateCode: "TX",
        PlanId: "18126TX0010001",
        Tobacco: "Tobacco User/Non-Tobacco User",
      },
      row.provenance,
    );
    expect(
      householdPremium(
        [dual],
        dual.planId,
        dual.ratingAreaId,
        caHousehold(true),
        policy.policy,
      ),
    ).toMatchObject({
      status: "unknown",
      totalCents: null,
      issues: [{ reason: "missing_individual_tobacco_rate" }],
    });
  });
});
