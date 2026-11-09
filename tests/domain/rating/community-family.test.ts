import { expect, it } from "vitest";
import {
  communityFamilyPremium,
  householdPremium,
  selectRateRow,
} from "../../../src/domain/rating/index.js";
import {
  assertNyParent,
  assertNyUnsupported,
  couple,
  family,
  nyRate,
  nyRule,
  parent,
  publishedRate,
  single,
  vtRate,
  vtRule,
} from "./community-helpers.js";
import { syntheticRow } from "./helpers.js";

it("NY: hand-computed single, couple, parent and family of four, independent of age and tobacco", () => {
  expect(
    communityFamilyPremium(nyRule, nyRate, single, "2026-01-01"),
  ).toMatchObject({ status: "rated", tier: "single", totalCents: 127_098 });
  expect(
    communityFamilyPremium(nyRule, nyRate, couple, "2026-01-01"),
  ).toMatchObject({ status: "rated", tier: "couple", totalCents: 254_196 });
  assertNyParent(communityFamilyPremium(nyRule, nyRate, parent, "2026-01-01"));
  // $1,270.98 x 2.85 = $3,622.293 -> $3,622.29.
  expect(
    communityFamilyPremium(nyRule, nyRate, family, "2026-01-01"),
  ).toMatchObject({ status: "rated", tier: "family", totalCents: 362_229 });
  const changed = family.map((m) => ({
    ...m,
    age: m.relationship === "child" ? 25 : 64,
    tobaccoUse: true,
  }));
  expect(
    communityFamilyPremium(nyRule, nyRate, changed, "2026-01-01"),
  ).toMatchObject({ status: "rated", totalCents: 362_229 });
});

it("VT: the four published Gold tier prices match hand arithmetic for Burlington (statewide)", () => {
  // $1,345.45 x [1, 2, 1.93, 2.81], with one rounding per contract.
  for (const [members, total] of [
    [single, 134_545],
    [couple, 269_090],
    [parent, 259_672],
    [family, 378_071],
  ] as const) {
    expect(
      communityFamilyPremium(vtRule, vtRate, members, "2026-01-01"),
    ).toMatchObject({
      status: "rated",
      totalCents: total,
      priceBasis: "filed_tier",
    });
  }
  expect(
    communityFamilyPremium(
      vtRule,
      vtRate,
      family.map((m) => ({ ...m, tobaccoUse: true })),
      "2026-01-01",
    ),
  ).toMatchObject({ totalCents: 378_071 });
  expect(
    communityFamilyPremium(
      vtRule,
      vtRate,
      [
        ...family,
        { id: "c3", relationship: "child", age: 3, tobaccoUse: false },
      ],
      "2026-01-01",
    ),
  ).toMatchObject({ totalCents: 378_071 });
});

it("rejects absent/year-mismatched rules, child-only policies, extra adults and unproved dependent extensions", () => {
  const cases = [
    communityFamilyPremium(null, nyRate, family, "2026-01-01"),
    communityFamilyPremium(nyRule, nyRate, family, "2027-01-01"),
    communityFamilyPremium(vtRule, nyRate, family, "2026-01-01"),
    communityFamilyPremium(
      nyRule,
      { ...nyRate, childOnly: true },
      parent,
      "2026-01-01",
    ),
    communityFamilyPremium(
      nyRule,
      nyRate,
      [
        ...parent,
        { id: "other", relationship: "other", age: 30, tobaccoUse: false },
      ],
      "2026-01-01",
    ),
    communityFamilyPremium(
      vtRule,
      vtRate,
      parent.map((m) => (m.relationship === "child" ? { ...m, age: 26 } : m)),
      "2026-01-01",
    ),
    communityFamilyPremium(
      nyRule,
      nyRate,
      [{ ...single[0]!, age: 15 }],
      "2026-01-01",
    ),
  ];
  for (const result of cases) assertNyUnsupported(result);
  expect(() =>
    communityFamilyPremium(nyRule, nyRate, [], "2026-01-01"),
  ).toThrow();
  expect(() =>
    communityFamilyPremium(
      nyRule,
      nyRate,
      [single[0]!, single[0]!],
      "2026-01-01",
    ),
  ).toThrow();
  expect(() =>
    communityFamilyPremium(nyRule, nyRate, single, "2026-02-30"),
  ).toThrow();
});

it("uses filed NY tier prices rather than multiplying an already rounded single premium", () => {
  const bronze = publishedRate("NY", "11177NY0010001");
  const result = communityFamilyPremium(nyRule, bronze, couple, "2026-01-01");
  expect(result).toMatchObject({
    status: "rated",
    totalCents: 156_901,
    priceBasis: "filed_tier",
  });
  expect(result.totalCents).not.toBe(bronze.prices.single * 2);
});

it("a mislabeled NY/VT per-age row can never enter the federal path", () => {
  for (const state of ["NY", "VT"]) {
    const row = syntheticRow({ StateCode: state, PlanId: "11177NY0010001" });
    assertNyUnsupported(
      householdPremium([row], row.planId, row.ratingAreaId, {
        ratingMethod: "per_member",
        members: single.map((m) => ({ ...m, age: 35 })),
        coverageStartDate: "2026-01-01",
      }),
    );
    expect(
      selectRateRow(
        [row],
        row.planId,
        row.ratingAreaId,
        35,
        false,
        "2026-01-01",
      ).status,
    ).toBe("unsupported_rating_method");
  }
});

it("keeps the nominal state multipliers as cited data alongside filed tier prices", () => {
  expect(nyRule.tiers).toEqual({
    single: 100,
    couple: 200,
    adult_children: 170,
    family: 285,
  });
  expect(vtRule.tiers).toEqual({
    single: 100,
    couple: 200,
    adult_children: 193,
    family: 281,
  });
});
