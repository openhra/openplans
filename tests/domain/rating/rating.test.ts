import { describe, expect, it } from "vitest";
import {
  ageOnDate,
  householdPremium,
  parseCents,
  parseRateRow,
  selectRateRow,
} from "../../../src/domain/rating/index.js";
import type {
  Household,
  HouseholdMember,
  RatingMethod,
} from "../../../src/domain/rating/index.js";
import {
  AREA,
  DATE,
  PLAN,
  assertFourChildPremium,
  fixture,
  fourChildren,
  rowFor,
  rows,
  syntheticRow,
} from "./helpers.js";

const single = (
  member: HouseholdMember = {
    id: "subscriber",
    age: 35,
    relationship: "subscriber",
    tobaccoUse: false,
  },
): Household => ({
  members: [member],
  coverageStartDate: DATE,
  ratingMethod: "per_member",
});

describe("CMS row adapter and integer cents", () => {
  it("preserves original rows, all age bands, intervals, family columns and source record identity", () => {
    expect(rows).toHaveLength(204);
    expect(fixture.planIds).toHaveLength(4);
    expect(new Set(rows.map((row) => row.age)).size).toBe(51);
    for (const [index, row] of rows.entries()) {
      expect(row.raw).toEqual(fixture.rows[index]!.raw);
      expect(row.provenance).toEqual({
        snapshotId: `sha256:${fixture.sourceSha256}`,
        sourceFile: "rate-puf.csv",
        sourceRowNumber: fixture.rows[index]!.sourceRowNumber,
      });
      expect(row.effectiveDate).toBe(DATE);
      expect(row.expirationDate).toBe("2026-12-31");
      expect(Object.values(row.familyRatesCents)).toEqual(Array(7).fill(null));
    }
  });

  it("parses decimal text exactly, including trailing tenths and zero, without rounding", () => {
    expect(parseCents("0")).toBe(0);
    expect(parseCents("0.01")).toBe(1);
    expect(parseCents("0.29")).toBe(29);
    expect(parseCents("690.7")).toBe(69_070);
    expect(parseCents("725.49")).toBe(72_549);
    for (const value of [
      "",
      "-1",
      "NaN",
      "1e3",
      "1.001",
      " 1.00",
      "1,000",
      "9007199254740991",
    ]) {
      expect(() => parseCents(value)).toThrow(RangeError);
    }
  });

  it("preserves blanks as null and explicit zero as a price", () => {
    const blank = syntheticRow({
      IndividualRate: "",
      IndividualTobaccoRate: "",
    });
    expect(blank.individualRateCents).toBeNull();
    expect(blank.individualTobaccoRateCents).toBeNull();
    expect(syntheticRow({ IndividualRate: "0.0" }).individualRateCents).toBe(0);
  });

  it("rejects malformed CMS dimensions and provenance instead of coercing them", () => {
    for (const override of [
      { Age: "14" },
      { Age: "64" },
      { Age: "35 years" },
      { Tobacco: "false" },
      { RateEffectiveDate: "2026-02-29" },
      { RateExpirationDate: "2025-12-31" },
      { PlanId: "" },
      { BusinessYear: "26" },
      { IndividualRate: "1.001" },
    ])
      expect(() => syntheticRow(override)).toThrow(RangeError);
    expect(() =>
      parseRateRow(rowFor(35).raw, {
        snapshotId: "",
        sourceFile: "x",
        sourceRowNumber: 2,
      }),
    ).toThrow();
  });

  it("does not retain mutable references to the CSV input or provenance", () => {
    const raw = { ...rowFor(35).raw };
    const provenance = {
      snapshotId: "synthetic",
      sourceFile: "x",
      sourceRowNumber: 2,
    };
    const parsed = parseRateRow(raw, provenance);
    raw.IndividualRate = "0";
    provenance.snapshotId = "changed";
    expect(parsed.raw.IndividualRate).toBe("725.49");
    expect(parsed.provenance.snapshotId).toBe("synthetic");
  });
});

describe("exact rate row selection", () => {
  it.each([
    [0, "0-14"],
    [14, "0-14"],
    [15, 15],
    [35, 35],
    [63, 63],
    [64, "64 and over"],
    [95, "64 and over"],
  ] as const)("maps age %s to the published band %s", (age, band) => {
    expect(selectRateRow(rows, PLAN, AREA, age, false, DATE)).toEqual({
      status: "selected",
      row: rowFor(band),
    });
  });

  it("uses the inclusive effective and expiration interval", () => {
    const row = syntheticRow({
      RateEffectiveDate: "2026-03-01",
      RateExpirationDate: "2026-06-30",
    });
    for (const date of ["2026-03-01", "2026-06-30"])
      expect(selectRateRow([row], PLAN, AREA, 35, false, date).status).toBe(
        "selected",
      );
    for (const date of ["2026-02-28", "2026-07-01"])
      expect(selectRateRow([row], PLAN, AREA, 35, false, date).status).toBe(
        "missing",
      );
  });

  it("never substitutes another plan, variant, area, age or business year", () => {
    for (const [plan, area, age, date] of [
      ["missing", AREA, 35, DATE],
      [PLAN + "-01", AREA, 35, DATE],
      [PLAN, "10", 35, DATE],
      [PLAN, AREA, 35, "2027-01-01"],
    ] as const)
      expect(selectRateRow(rows, plan, area, age, false, date).status).toBe(
        "missing",
      );
    expect(
      selectRateRow([rowFor(35)], PLAN, AREA, 36, false, DATE).status,
    ).toBe("missing");
    const wrongYear = syntheticRow({ BusinessYear: "2025" });
    expect(selectRateRow([wrongYear], PLAN, AREA, 35, false, DATE).status).toBe(
      "missing",
    );
  });

  it("rejects overlapping conflicts and identical duplicates as ambiguous", () => {
    const row = rowFor(35);
    for (const second of [row, syntheticRow({ IndividualRate: "0" })]) {
      const result = selectRateRow([row, second], PLAN, AREA, 35, false, DATE);
      expect(result).toEqual({ status: "ambiguous", rows: [row, second] });
    }
  });

  it("negative control: two rows with a gap yield missing rather than the nearest interval", () => {
    const gap = [
      syntheticRow({ RateExpirationDate: "2026-03-31" }),
      syntheticRow({ RateEffectiveDate: "2026-05-01" }),
    ];
    expect(selectRateRow(gap, PLAN, AREA, 35, false, "2026-04-01")).toEqual({
      status: "missing",
      rows: [],
    });
    expect(selectRateRow(gap, PLAN, AREA, 35, false, "2026-03-31").status).toBe(
      "selected",
    );
    expect(selectRateRow(gap, PLAN, AREA, 35, false, "2026-05-01").status).toBe(
      "selected",
    );
    expect(
      householdPremium(gap, PLAN, AREA, {
        ...single(),
        coverageStartDate: "2026-04-01",
      }),
    ).toMatchObject({ status: "missing", totalCents: null });
  });

  it("selects the dual tobacco category for both inputs; blank classification is not evidence", () => {
    for (const tobacco of [true, false]) {
      expect(
        selectRateRow([rowFor(35)], PLAN, AREA, 35, tobacco, DATE).status,
      ).toBe("selected");
      expect(
        selectRateRow(
          [syntheticRow({ Tobacco: "" })],
          PLAN,
          AREA,
          35,
          tobacco,
          DATE,
        ).status,
      ).toBe("missing");
    }
  });

  it("rejects fractional ages and invalid dates", () => {
    for (const age of [-1, 2.5, NaN])
      expect(() => selectRateRow(rows, PLAN, AREA, age, false, DATE)).toThrow();
    expect(() =>
      selectRateRow(rows, PLAN, AREA, 35, false, "2026-2-1"),
    ).toThrow();
  });
});

describe("household premiums (synthetic households, real source rates)", () => {
  it("prices one member, with period, currency, calculation inputs and exact source rows", () => {
    const result = householdPremium(rows, PLAN, AREA, single());
    expect(result).toMatchObject({
      status: "rated",
      totalCents: 72_549,
      currency: "USD",
      period: "month",
      coverageStartDate: DATE,
      planId: PLAN,
      ratingAreaId: AREA,
      ratingMethod: "per_member",
      issues: [],
    });
    expect(result.rowsUsed).toEqual([rowFor(35)]);
    expect(result.members[0]!.rateRows[0]).toBe(rowFor(35));
  });

  it("2 adults + 4 children charge only the three oldest children under 21", () => {
    assertFourChildPremium(householdPremium(rows, PLAN, AREA, fourChildren));
  });

  it("charges a 21-year-old child outside the three-child limit", () => {
    const household: Household = {
      ...fourChildren,
      members: fourChildren.members.map((member) =>
        member.id === "eldest"
          ? {
              id: member.id,
              relationship: member.relationship,
              tobaccoUse: false,
              age: 21,
            }
          : member,
      ),
    };
    const result = householdPremium(rows, PLAN, AREA, household);
    expect(result.status).toBe("rated");
    expect(result.totalCents).toBe(356_870);
    expect(result.members.every((member) => member.charged)).toBe(true);
  });

  it("uses age at coverage start when a child turns 21 the following day", () => {
    const household: Household = {
      ...fourChildren,
      members: fourChildren.members.map((member) =>
        member.id === "eldest"
          ? {
              id: member.id,
              relationship: member.relationship,
              tobaccoUse: false,
              dateOfBirth: "2005-01-02",
            }
          : member,
      ),
    };
    assertFourChildPremium(householdPremium(rows, PLAN, AREA, household));
    const nextDay = householdPremium(rows, PLAN, AREA, {
      ...household,
      coverageStartDate: "2026-01-02",
    });
    expect(nextDay.totalCents).toBe(356_870);
    expect(
      nextDay.members.find((member) => member.memberId === "eldest")!.age,
    ).toBe(21);
  });

  it("keeps subscribers under 21 outside the dependent-child limit", () => {
    const result = householdPremium(rows, PLAN, AREA, {
      ...fourChildren,
      members: fourChildren.members.map((member) =>
        member.id === "adult1"
          ? {
              id: member.id,
              relationship: "subscriber",
              tobaccoUse: false,
              age: 19,
            }
          : member,
      ),
    });
    expect(result.status).toBe("rated");
    expect(result.members.filter((member) => member.charged)).toHaveLength(5);
    expect(
      result.members.find((member) => member.memberId === "adult1")!.charged,
    ).toBe(true);
  });

  it("handles equal-age children deterministically and preserves input order in the result", () => {
    const members: HouseholdMember[] = [
      {
        id: "a",
        relationship: "child",
        tobaccoUse: false,
        dateOfBirth: "2010-06-01",
      },
      {
        id: "b",
        relationship: "child",
        tobaccoUse: false,
        dateOfBirth: "2010-03-01",
      },
      {
        id: "c",
        relationship: "child",
        tobaccoUse: false,
        dateOfBirth: "2010-01-01",
      },
      {
        id: "d",
        relationship: "child",
        tobaccoUse: false,
        dateOfBirth: "2010-02-01",
      },
    ];
    const result = householdPremium(rows, PLAN, AREA, {
      ...single(),
      members,
      coverageStartDate: "2026-12-01",
    });
    expect(result.members.map((member) => member.memberId)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(
      result.members
        .filter((member) => member.charged)
        .map((member) => member.memberId),
    ).toEqual(["b", "c", "d"]);
  });

  it("does not require a rate for an uncharged fourth child", () => {
    const withoutYoungestBand = rows.filter((row) => row.age !== "0-14");
    assertFourChildPremium(
      householdPremium(withoutYoungestBand, PLAN, AREA, fourChildren),
    );
  });

  it("uses the complete tobacco price, without adding another surcharge", () => {
    const result = householdPremium(
      rows,
      PLAN,
      AREA,
      single({
        id: "t",
        age: 35,
        relationship: "subscriber",
        tobaccoUse: true,
      }),
    );
    expect(result).toMatchObject({ status: "rated", totalCents: 79_079 });
  });

  it("negative control: removing the tobacco rate produces unknown, never the base rate", () => {
    const tobaccoHousehold = single({
      id: "t",
      age: 35,
      relationship: "subscriber",
      tobaccoUse: true,
    });
    expect(
      householdPremium([rowFor(35)], PLAN, AREA, tobaccoHousehold).totalCents,
    ).toBe(79_079);
    const dropped = syntheticRow({ IndividualTobaccoRate: "" });
    const result = householdPremium([dropped], PLAN, AREA, tobaccoHousehold);
    expect(result).toMatchObject({
      status: "unknown",
      totalCents: null,
      issues: [{ reason: "missing_individual_tobacco_rate" }],
    });
    expect(result.members[0]).toMatchObject({
      status: "unknown",
      premiumCents: null,
      rateRows: [dropped],
    });
    expect(householdPremium([dropped], PLAN, AREA, single()).totalCents).toBe(
      72_549,
    );
  });

  it("does not infer a tobacco price from No Preference or from explicit zero", () => {
    const tobaccoHousehold = single({
      id: "t",
      age: 35,
      relationship: "subscriber",
      tobaccoUse: true,
    });
    expect(
      householdPremium(
        [syntheticRow({ Tobacco: "No Preference", IndividualTobaccoRate: "" })],
        PLAN,
        AREA,
        tobaccoHousehold,
      ).status,
    ).toBe("unknown");
    expect(
      householdPremium(
        [syntheticRow({ IndividualTobaccoRate: "0.0" })],
        PLAN,
        AREA,
        tobaccoHousehold,
      ).totalCents,
    ).toBe(0);
  });

  it("retains all failures and provenance without returning a partial household total", () => {
    const ambiguous = syntheticRow({ IndividualRate: "0" });
    const result = householdPremium(
      [rowFor(35), ambiguous],
      PLAN,
      AREA,
      fourChildren,
    );
    expect(result).toMatchObject({ status: "ambiguous", totalCents: null });
    expect(result.issues.some((issue) => issue.status === "ambiguous")).toBe(
      true,
    );
    expect(result.issues.some((issue) => issue.status === "missing")).toBe(
      true,
    );
    expect(result.rowsUsed).toEqual([rowFor(35), ambiguous]);
    expect(
      householdPremium(
        [syntheticRow({ IndividualRate: "" })],
        PLAN,
        AREA,
        single(),
      ).status,
    ).toBe("unknown");
  });

  it.each(["family_tier", "composite"] as RatingMethod[])(
    "rejects the explicitly declared %s method",
    (ratingMethod) => {
      const result = householdPremium(rows, PLAN, AREA, {
        ...single(),
        ratingMethod,
      });
      expect(result).toMatchObject({
        status: "unsupported_rating_method",
        totalCents: null,
      });
    },
  );

  it.each([
    { Age: "Family Option" },
    { Couple: "0.0" },
    { CoupleAndThreeOrMoreDependents: "100.01" },
  ])("rejects family-option and state family-tier columns: %s", (override) => {
    const row = syntheticRow(override);
    expect(selectRateRow([row], PLAN, AREA, 35, false, DATE)).toEqual({
      status: "unsupported_rating_method",
      rows: [row],
    });
    expect(householdPremium([row], PLAN, AREA, single())).toMatchObject({
      status: "unsupported_rating_method",
      totalCents: null,
      rowsUsed: [row],
    });
    expect(
      householdPremium([rowFor(35), row], PLAN, AREA, single()).status,
    ).toBe("unsupported_rating_method");
  });

  it("honors composite business rules on parsed rows, but ignores unrelated or expired unsupported rows", () => {
    const composite = parseRateRow(
      rowFor(35).raw,
      rowFor(35).provenance,
      "composite",
    );
    expect(householdPremium([composite], PLAN, AREA, single()).status).toBe(
      "unsupported_rating_method",
    );
    const unrelated = [
      syntheticRow({ Age: "Family Option", PlanId: "other" }),
      syntheticRow({ Age: "Family Option", RateEffectiveDate: "2026-02-01" }),
    ];
    expect(
      householdPremium([...rows, ...unrelated], PLAN, AREA, single())
        .totalCents,
    ).toBe(72_549);
  });

  it("leaves rows and households unchanged", () => {
    const before = JSON.stringify({ rows, fourChildren });
    householdPremium(rows, PLAN, AREA, fourChildren);
    expect(JSON.stringify({ rows, fourChildren })).toBe(before);
  });

  it("rejects empty households, duplicate member IDs, missing tobacco input and ambiguous age inputs", () => {
    expect(() =>
      householdPremium(rows, PLAN, AREA, { ...single(), members: [] }),
    ).toThrow();
    const member = single().members[0]!;
    expect(() =>
      householdPremium(rows, PLAN, AREA, {
        ...single(),
        members: [member, member],
      }),
    ).toThrow();
    const bothAges = {
      ...member,
      dateOfBirth: "1990-01-01",
    } as unknown as HouseholdMember;
    expect(() =>
      householdPremium(rows, PLAN, AREA, single(bothAges)),
    ).toThrow();
    const missingTobacco = {
      ...member,
      tobaccoUse: undefined,
    } as unknown as HouseholdMember;
    expect(() =>
      householdPremium(rows, PLAN, AREA, single(missingTobacco)),
    ).toThrow();
  });
});

describe("coverage-start age calculation", () => {
  it("uses the actual birthday, with no timezone or current-date dependence", () => {
    expect(ageOnDate("2005-01-02", "2026-01-01")).toBe(20);
    expect(ageOnDate("2005-01-01", "2026-01-01")).toBe(21);
    expect(ageOnDate("2026-01-01", "2026-01-01")).toBe(0);
    expect(ageOnDate("2004-02-29", "2025-02-28")).toBe(20);
    expect(ageOnDate("2004-02-29", "2025-03-01")).toBe(21);
    expect(() => ageOnDate("2026-01-02", DATE)).toThrow();
    expect(() => ageOnDate("2005-02-29", DATE)).toThrow();
  });
});
