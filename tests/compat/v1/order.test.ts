import assert from "node:assert/strict";
import { expect, it } from "vitest";
import { orderPlans, pageWindow } from "../../../src/compat/v1/search.js";

// Synthetic records exercise page boundaries without asserting a published plan ranking.
const rows = Array.from({ length: 151 }, (_, index) => {
  let premium: number | null = null;
  if (index < 60) premium = 1;
  else if (index < 120) premium = 2;
  return { id: `synthetic-${String(index).padStart(3, "0")}`, premium };
});
const ids = (plans: Record<string, unknown>[]) => plans.map((plan) => plan.id);
const pages = (plans: Record<string, unknown>[]) =>
  [1, 2, 3, 4, 5].map((page) => {
    const { start, size } = pageWindow(page, 100, 50);
    return plans.slice(start, start + size);
  });

it("keeps capped pages stable across input permutations and premium ties spanning pages", () => {
  const permutations = [
    rows,
    [...rows].reverse(),
    [...rows.slice(73), ...rows.slice(0, 73)],
  ];
  for (const input of permutations) {
    for (const sort of [undefined, "premium", "-premium"]) {
      const ordered = orderPlans(structuredClone(input), sort);
      const expected =
        sort === "-premium"
          ? [...rows.slice(60, 120), ...rows.slice(0, 60), ...rows.slice(120)]
          : rows;
      const result = pages(ordered);
      expect(result.map((page) => page.length)).toEqual([50, 50, 50, 1, 0]);
      expect(ids(result.flat())).toEqual(ids(expected));
      expect(new Set(ids(result.flat())).size).toBe(rows.length);
    }
  }
});

it("rejects slicing before sorting, descending ties and unknowns before known premiums", () => {
  const expected = ids(rows);
  const check = (actual: Record<string, unknown>[]) =>
    assert.deepEqual(ids(actual), expected);
  check(pages(orderPlans(structuredClone(rows).reverse(), "premium")).flat());

  const slicedFirst = pages(structuredClone(rows).reverse()).flatMap((page) =>
    orderPlans(page, "premium"),
  );
  const reversedTies = [
    ...rows.slice(0, 60).reverse(),
    ...rows.slice(60, 120).reverse(),
    ...rows.slice(120).reverse(),
  ];
  const unknownsFirst = [...rows.slice(120), ...rows.slice(0, 120)];
  for (const mutant of [slicedFirst, reversedTies, unknownsFirst]) {
    expect(() => check(mutant)).toThrow();
  }
});
