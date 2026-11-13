import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import * as v from "../../src/api/validation.js";
import { replaceSyntax } from "../source-mutation.js";
import { importMutant, withMutantFile } from "../mutant-file.js";

type Validator = typeof v.publicQuoteRequest;
// Synthetic request values only; no real person's data.
const base = () => ({
  year: 2026,
  zip: "77002",
  county: "48201",
  members: [{ age: 35 }] as Record<string, unknown>[],
});
const npis = (n: number) =>
  Array.from({ length: n }, (_, i) => `123456789${i}`);
const rxcuis = (n: number) => Array.from({ length: n }, (_, i) => `86097${i}`);
const plans = (n: number) =>
  Array.from(
    { length: n },
    (_, i) => `87226TX01000${String(i).padStart(2, "0")}`,
  );

/** Every refusal in plan §3.3, with the field it names. */
const refusals: [string, Record<string, unknown>, string, string][] = [
  [
    "income",
    { household_income_annual: 40000 },
    "INCOME_NOT_ACCEPTED",
    "household_income_annual",
  ],
  [
    "household size",
    { household_size: 2 },
    "INCOME_NOT_ACCEPTED",
    "household_size",
  ],
  ["tax filing", { tax_filing: "single" }, "INCOME_NOT_ACCEPTED", "tax_filing"],
  ["name", { name: "x" }, "UNKNOWN_FIELD", "name"],
  ["email", { email: "x" }, "UNKNOWN_FIELD", "email"],
  [
    "coverage_start",
    { coverage_start: "2026-03-01" },
    "UNKNOWN_FIELD",
    "coverage_start",
  ],
  [
    "member dob",
    { members: [{ age: 35, dob: "1990-01-02" }] },
    "DOB_NOT_ACCEPTED",
    "members.0.dob",
  ],
  [
    "member name",
    { members: [{ age: 35, first_name: "x" }] },
    "UNKNOWN_FIELD",
    "members.0.first_name",
  ],
  [
    "member income",
    { members: [{ age: 35, household_income_annual: 1 }] },
    "INCOME_NOT_ACCEPTED",
    "members.0.household_income_annual",
  ],
  [
    "member tobacco not boolean",
    { members: [{ age: 35, tobacco: "yes" }] },
    "INVALID_INPUT",
    "members.0.tobacco",
  ],
  ["member age missing", { members: [{}] }, "INVALID_INPUT", "members.0.age"],
  [
    "member age fraction",
    { members: [{ age: 35.5 }] },
    "INVALID_INPUT",
    "members.0.age",
  ],
  [
    "member age above 120",
    { members: [{ age: 121 }] },
    "INVALID_INPUT",
    "members.0.age",
  ],
  [
    "relationship",
    { members: [{ age: 35, relationship: "boss" }] },
    "INVALID_INPUT",
    "members.0.relationship",
  ],
  [
    "11 members",
    { members: Array.from({ length: 11 }, () => ({ age: 30 })) },
    "TOO_MANY_MEMBERS",
    "members",
  ],
  ["no members", { members: [] }, "INVALID_INPUT", "members"],
  ["11 plans", { plan_ids: plans(11) }, "TOO_MANY_PLANS", "plan_ids"],
  ["6 NPIs", { npis: npis(6) }, "TOO_MANY_PROVIDERS", "npis"],
  ["6 RxCUIs", { rxcuis: rxcuis(6) }, "TOO_MANY_DRUGS", "rxcuis"],
  [
    "duplicate plan",
    { plan_ids: [plans(1)[0], plans(1)[0]] },
    "DUPLICATE_PLAN_ID",
    "plan_ids",
  ],
  [
    "duplicate NPI",
    { npis: ["1234567893", "1234567893"] },
    "DUPLICATE_NPI",
    "npis",
  ],
  [
    "duplicate RxCUI",
    { rxcuis: ["860975", "860975"] },
    "DUPLICATE_RXCUI",
    "rxcuis",
  ],
  ["bad NPI", { npis: ["3234567893"] }, "INVALID_INPUT", "npi"],
  ["missing year", { year: undefined }, "YEAR_REQUIRED", "year"],
  ["string year", { year: "2026" }, "INVALID_INPUT", "year"],
  [
    "missing location",
    { zip: undefined, county: undefined },
    "LOCATION_REQUIRED",
    "location",
  ],
  ["bad ZIP", { zip: "7700" }, "INVALID_INPUT", "zip"],
  ["coverage", { coverage: "vision" }, "INVALID_INPUT", "coverage"],
  ["page with plans", { plan_ids: plans(1), page: 2 }, "INVALID_INPUT", "page"],
  ["metal", { metal: "plastic" }, "INVALID_INPUT", "metal"],
];

describe("public quote request allow-list", () => {
  it.each(refusals)("refuses %s", (_name, extra, code, field) => {
    expect(() => v.publicQuoteRequest({ ...base(), ...extra })).toThrow(
      expect.objectContaining({ code, field }),
    );
  });

  it("refuses income before an unknown name and never echoes a value", () => {
    expect(() =>
      v.publicQuoteRequest({
        ...base(),
        name: "x",
        household_income_annual: 1,
      }),
    ).toThrow(expect.objectContaining({ code: "INCOME_NOT_ACCEPTED" }));
    expect(() =>
      v.publicQuoteRequest({ ...base(), ["k".repeat(5000)]: 1 }),
    ).toThrow(
      expect.objectContaining({
        code: "UNKNOWN_FIELD",
        field: "k".repeat(100),
      }),
    );
  });

  it("builds a non-subsidy premium request with January 1 and synthesized relationships", () => {
    const request = v.publicQuoteRequest({
      ...base(),
      members: [
        { age: 40 },
        { age: 38, relationship: "spouse" },
        { age: 10 },
        { age: 22, tobacco: true },
      ],
      npis: npis(5),
      rxcuis: rxcuis(5),
    });
    expect(request.premium.subsidy).toBeUndefined();
    expect(request.premium.coverage).toBe("2026-01-01");
    expect(request.premium.members).toEqual([
      { id: "0", age: 40, tobaccoUse: false, relationship: "subscriber" },
      { id: "1", age: 38, tobaccoUse: false, relationship: "spouse" },
      { id: "2", age: 10, tobaccoUse: false, relationship: "child" },
      { id: "3", age: 22, tobaccoUse: true, relationship: "other" },
    ]);
    expect(request).toMatchObject({
      explicitPlans: false,
      page: 1,
      coverage: "medical",
    });
    expect(
      v.publicQuoteRequest({ ...base(), plan_ids: ["NY:synthetic-key"] })
        .premium.ids,
    ).toEqual([
      { base: "NY:synthetic-key", full: "NY:synthetic-key", variant: null },
    ]);
  });

  it("accepts the documented caps exactly", () => {
    expect(() =>
      v.publicQuoteRequest({
        ...base(),
        members: Array.from({ length: 10 }, () => ({ age: 30 })),
        plan_ids: plans(10),
        npis: npis(5),
        rxcuis: rxcuis(5),
      }),
    ).not.toThrow();
  });

  // Negative controls 1-3: a disposable validator copy without each refusal must fail these assertions.
  it.each([
    [
      "unknown keys ignored",
      'refuseFields(body, PUBLIC_QUOTE_FIELDS, "");',
      "void 0;",
      { household_income_annual: 40000 },
      "INCOME_NOT_ACCEPTED",
    ],
    [
      "member keys ignored",
      "refuseFields(member, PUBLIC_MEMBER_FIELDS, `${field}.`);",
      "void 0;",
      { members: [{ age: 35, dob: "1990-01-02" }] },
      "DOB_NOT_ACCEPTED",
    ],
    [
      "member cap removed",
      "body.members.length > PUBLIC_QUOTE_LIMITS.members",
      "false",
      { members: Array.from({ length: 11 }, () => ({ age: 30 })) },
      "TOO_MANY_MEMBERS",
    ],
    [
      "provider cap raised",
      "PUBLIC_QUOTE_LIMITS.providers,",
      "6,",
      { npis: npis(6) },
      "TOO_MANY_PROVIDERS",
    ],
  ] as const)(
    "negative control: %s fails the refusal assertion",
    async (_kind, before, after, extra, code) => {
      const source = new URL("../../src/api/validation.ts", import.meta.url);
      await withMutantFile(
        source,
        replaceSyntax(await readFile(source, "utf8"), before, after),
        async (temporary) => {
          const mutant = await importMutant<{
            publicQuoteRequest: Validator;
          }>(temporary, "publicQuoteRequest");
          const assertion = () =>
            expect(() =>
              mutant.publicQuoteRequest({ ...base(), ...extra }),
            ).toThrow(expect.objectContaining({ code }));
          expect(assertion).toThrow();
          expect(() => v.publicQuoteRequest({ ...base(), ...extra })).toThrow(
            expect.objectContaining({ code }),
          );
        },
      );
    },
  );
});
