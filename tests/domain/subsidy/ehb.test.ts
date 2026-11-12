import { expect, it } from "vitest";
import { parseEhbFraction } from "../../../src/domain/subsidy/ehb.js";
import { allocatePremium } from "../../../src/domain/subsidy/dental.js";

it.each([
  ["99%", "0.99"],
  ["99", "0.99"],
  ["0.99", "0.99"],
  ["99.5 %", "0.995"],
  [99, "0.99"],
  [0.99, "0.99"],
  [" 00099.5000 % ", "0.995"],
  ["0", "0"],
  ["0%", "0"],
  ["1", "1"],
  ["1%", "0.01"],
  ["100", "1"],
  ["100.00%", "1"],
  ["0.99%", "0.0099"],
  ["93.9058323%", "0.939058323"],
  ["0.939058323", "0.939058323"],
  ["0.9921766408983248", "0.9921766408983248"],
  ["100.0000000000000001", null],
  ["-0.1", null],
  ["-1%", null],
  ["101%", null],
  ["101", null],
  ["", null],
  [" ", null],
  [null, null],
  [undefined, null],
  [NaN, null],
  [Infinity, null],
  [true, null],
  [{}, null],
  ["99%%", null],
  ["99 percent", null],
  ["1e2", null],
  ["0x63", null],
  ["99,5%", null],
  ["99junk", null],
  ["9 9%", null],
  [".99", null],
  ["99.", null],
])("normalizes published EHB share %j to %j", (input, expected) => {
  expect(parseEhbFraction(input)).toBe(expected);
});

it("leaves the cents allocator strict and rounds only the final cents", () => {
  for (const input of ["99%", "99", "99.5 %", "1.01", 0.99])
    expect(allocatePremium(100_000, input)).toBeNull();
  expect(allocatePremium(2000, parseEhbFraction("93.9058323%"))).toBe(1878);
  expect(allocatePremium(101, parseEhbFraction("99.5 %"))).toBe(100);
});
