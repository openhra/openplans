import { expect, it } from "vitest";
import { offerStatistics } from "../../../src/domain/comparison/statistics.js";

const prices = (...cents: number[]) =>
  cents.map((monthly_cents, index) => ({
    plan_id: `SYNTHETIC:${index}`,
    monthly_cents,
  }));

it("keeps exact fractional cents, half-up display, nearest ranks and a true zero", () => {
  expect(offerStatistics(prices(102, 100))).toMatchObject({
    median: { numerator: 101, denominator: 1, display_cents: 101 },
    mean: { numerator: 101, denominator: 1, display_cents: 101 },
    p25_cents: 100,
    p75_cents: 102,
    small_offer_set: true,
  });
  expect(offerStatistics(prices(100, 101))).toMatchObject({
    median: { numerator: 201, denominator: 2, display_cents: 101 },
    mean: { numerator: 201, denominator: 2, display_cents: 101 },
  });
  expect(offerStatistics(prices(0, 1, 3))).toMatchObject({
    median: { numerator: 1, denominator: 1 },
    mean: { numerator: 4, denominator: 3, display_cents: 1 },
    lowest_cents: 0,
    p25_cents: 0,
    p75_cents: 3,
  });
  expect(offerStatistics(prices(8, 2, 6, 4))).toMatchObject({
    median: { numerator: 5, denominator: 1 },
    p25_cents: 2,
    p75_cents: 6,
    small_offer_set: false,
  });
  expect(offerStatistics([])).toMatchObject({
    median: null,
    mean: null,
    lowest_cents: null,
  });
});

it("rejects a duplicate base, CSR variant and invalid cents instead of changing the denominator", () => {
  const plan = { plan_id: "99999TX0010001", monthly_cents: 100 };
  expect(() => offerStatistics([plan, plan])).toThrow(
    "distinct_base_plans_required",
  );
  expect(() =>
    offerStatistics([plan, { ...plan, plan_id: `${plan.plan_id}-04` }]),
  ).toThrow("distinct_base_plans_required");
  for (const monthly_cents of [-1, 0.5, NaN, Number.MAX_SAFE_INTEGER + 1])
    expect(() => offerStatistics([{ ...plan, monthly_cents }])).toThrow(
      "integer_cents_required",
    );
});

it("a first-page-only statistic fails the full 51-offer median and mean", () => {
  const all = prices(...Array.from({ length: 51 }, (_, index) => index));
  const full = offerStatistics(all);
  expect(full).toMatchObject({
    median: { numerator: 25, denominator: 1 },
    mean: { numerator: 25, denominator: 1 },
  });
  expect(() =>
    expect(offerStatistics(all.slice(0, 50))).toEqual(full),
  ).toThrow();
});
