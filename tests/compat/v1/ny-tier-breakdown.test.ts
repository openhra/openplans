import assert from "node:assert/strict";
import { expect, it } from "vitest";
import { mapQuote } from "../../../src/compat/v1/mapping.js";
import type { HouseholdMember } from "../../../src/domain/rating/types.js";

type Estimate = Parameters<typeof mapQuote>[0];
const members: HouseholdMember[] = [
  { id: "0", age: 35, relationship: "subscriber", tobaccoUse: true },
  { id: "1", age: 10, relationship: "child", tobaccoUse: false },
];
// Synthetic quote envelope tests mapping only, never a filed premium fixture.
const quote = {
  state: "NY",
  quote_method: "state_filed_tier",
  total_cents: 123456,
  coverage_start: "2026-01-01",
  members: [],
} as unknown as Estimate;
const expected = [
  {
    age: 35,
    child: false,
    smoker: true,
    premium: null,
    composite_rated: false,
    waived_for_total: null,
  },
  {
    age: 10,
    child: true,
    smoker: false,
    premium: null,
    composite_rated: false,
    waived_for_total: null,
  },
];
function breakdownContract(value: Record<string, unknown>) {
  assert.equal(value.premium, 1234.56);
  assert.deepEqual(value.premiums_by_applicant, expected);
}
it("keeps requested NY applicant identities while leaving unpublished tier allocations and waivers unknown", () => {
  breakdownContract(mapQuote(quote, members));
  expect(mapQuote(quote).premiums_by_applicant).toEqual([]);
  expect(
    mapQuote({ ...quote, state: "VT" } as Estimate, members)
      .premiums_by_applicant,
  ).toEqual([]);
});
it("preserves a published member price rather than substituting a request-derived allocation", () => {
  const published = {
    ...quote,
    members: [
      {
        age: 35,
        relationship: "subscriber",
        tobacco: true,
        premium_cents: 123456,
        charged: true,
      },
    ],
  } as unknown as Estimate;
  expect(mapQuote(published, members).premiums_by_applicant).toEqual([
    {
      age: 35,
      child: false,
      smoker: true,
      premium: 1234.56,
      composite_rated: false,
      waived_for_total: false,
    },
  ]);
});
it("negative controls reject missing applicants, invented zero prices, equal splits and invented waiver status", () => {
  const correct = mapQuote(quote, members);
  breakdownContract(correct);
  for (const premium of [0, 617.28]) {
    const mutant = structuredClone(correct);
    mutant.premiums_by_applicant = expected.map((member) => ({
      ...member,
      premium,
    }));
    expect(() => breakdownContract(mutant)).toThrow();
  }
  expect(() =>
    breakdownContract({ ...correct, premiums_by_applicant: [] }),
  ).toThrow();
  expect(() =>
    breakdownContract({
      ...correct,
      premiums_by_applicant: expected.map((member) => ({
        ...member,
        waived_for_total: false,
      })),
    }),
  ).toThrow();
});
