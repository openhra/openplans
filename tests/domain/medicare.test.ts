import { describe, expect, it } from "vitest";
import {
  contractKind,
  formatPlanKey,
  isEmployerGroupPlan,
  parseMoney,
  parsePlanKey,
  parseStars,
  planKeyFromParts,
} from "../../src/domain/medicare/index.js";

describe("Medicare money cells (as published in Landscape and PBP)", () => {
  it.each([
    ["$1,234.00 ", { status: "value", cents: 123400 }],
    ["$2,100.00 ", { status: "value", cents: 210000 }],
    ["$0.00 ", { status: "value", cents: 0 }],
    ["($3.90)", { status: "value", cents: -390 }],
    ["3450", { status: "value", cents: 345000 }],
    ["12.5", { status: "value", cents: 1250 }],
    ["Not Applicable", { status: "not_applicable" }],
    ["", { status: "unknown" }],
    ["($3.90", { status: "unknown" }],
    ["-($1.00)", { status: "unknown" }],
    ["$1,23.00", { status: "unknown" }],
    ["free", { status: "unknown" }],
  ])("%j", (input, expected) => expect(parseMoney(input)).toEqual(expected));
  it("negative control: a parenthesized amount is never positive", () =>
    expect(parseMoney("($3.00)")).not.toEqual({ status: "value", cents: 300 }));
});

describe("star cells", () => {
  it.each([
    ["3.5", { status: "rated", stars: 3.5 }],
    ["4", { status: "rated", stars: 4 }],
    ["Plan Too New To Be Measured", { status: "too_new", stars: null }],
    ["Not Enough Data Available", { status: "not_enough_data", stars: null }],
    ["Not Applicable", { status: "not_applicable", stars: null }],
    ["3.7", { status: "unknown", stars: null }],
    ["6", { status: "unknown", stars: null }],
  ])("%j", (input, expected) => expect(parseStars(input)).toEqual(expected));
});

describe("plan keys", () => {
  it("parses native and Landscape spellings and normalizes segments", () => {
    expect(parsePlanKey("H0028-042-0")).toEqual({
      contractId: "H0028",
      planId: "042",
      segmentId: "0",
    });
    expect(parsePlanKey("H0028_042_000")).toEqual({
      contractId: "H0028",
      planId: "042",
      segmentId: "0",
    });
    expect(formatPlanKey(parsePlanKey("S4802_096_0")!)).toBe("S4802-096-0");
    for (const bad of [
      "H028-042-0",
      "X0028-042-0",
      "H0028-42-0",
      "H0028-042",
      "H0028-042-0;",
      42,
    ])
      expect(parsePlanKey(bad)).toBeNull();
  });
  it("pads plan IDs, rejects malformed parts, classifies contracts and EGHP plans", () => {
    expect(planKeyFromParts("R4182", "1", "0")).toEqual({
      contractId: "R4182",
      planId: "001",
      segmentId: "0",
    });
    expect(() => planKeyFromParts("90091", "001", "0")).toThrow("contract");
    expect(() => planKeyFromParts("H0028", "1234", "0")).toThrow("plan");
    expect(contractKind("S4802")).toBe("pdp");
    expect(contractKind("R4182")).toBe("regional_ppo");
    expect(isEmployerGroupPlan("801")).toBe(true);
    expect(isEmployerGroupPlan("799")).toBe(false);
  });
});
