import { expect, it } from "vitest";
import { catastrophicEligibility } from "../../../src/domain/eligibility/catastrophic.js";
import type { HouseholdMember } from "../../../src/domain/rating/types.js";

const member = (
  id: string,
  age: number,
  relationship: HouseholdMember["relationship"] = "subscriber",
): HouseholdMember => ({ id, age, relationship, tobaccoUse: false });

it("applies the 45 CFR 156.155(a) age limit at the start of the plan year", () => {
  const jan1 = "2026-01-01";
  expect(catastrophicEligibility([member("a", 29)], jan1, 2026, false)).toBe(
    "eligible",
  );
  expect(catastrophicEligibility([member("a", 30)], jan1, 2026, false)).toBe(
    "requires_exemption",
  );
  // Mixed household: one member aged 30 makes the household need an exemption.
  expect(
    catastrophicEligibility(
      [member("a", 25), member("b", 30, "spouse")],
      jan1,
      2026,
      false,
    ),
  ).toBe("requires_exemption");
  // A stated hardship or affordability exemption keeps the plan for any age.
  expect(catastrophicEligibility([member("a", 64)], jan1, 2026, true)).toBe(
    "eligible",
  );
});

it("never excludes a member who may still have been 29 when the plan year began", () => {
  // Age 30 stated for a July start can be age 29 on January 1.
  expect(
    catastrophicEligibility([member("a", 30)], "2026-07-01", 2026, false),
  ).toBe("eligible");
  expect(
    catastrophicEligibility([member("a", 31)], "2026-07-01", 2026, false),
  ).toBe("requires_exemption");
  const born = (dateOfBirth: string): HouseholdMember => ({
    id: "d",
    dateOfBirth,
    relationship: "subscriber",
    tobaccoUse: false,
  });
  // Turns 30 on 1996-01-02: still 29 on 2026-01-01.
  expect(
    catastrophicEligibility([born("1996-01-02")], "2026-03-01", 2026, false),
  ).toBe("eligible");
  expect(
    catastrophicEligibility([born("1996-01-01")], "2026-03-01", 2026, false),
  ).toBe("requires_exemption");
});
