import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app.js";
import { setup, TOKEN } from "../compat/v1/helpers.js";
import { rebaseImports, replaceSyntax } from "../source-mutation.js";

// SYNTHETIC employees over the real, unmodified CMS TX PY2026 Harris cut (20 silver plans).
let h: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => {
  await h?.close();
});

const body = (extra: Record<string, unknown> = {}) => ({
  plan_start: "2026-01-01",
  employee: { date_of_birth: "1985-10-01" },
  residence: { zip: "77002" },
  hra: { self_only_annual_cents: 300_000 },
  income: [
    { measure: "household", annual_cents: 4_118_000 },
    { measure: "rate_of_pay_hourly", hourly_cents: 2_000 },
  ],
  ...extra,
});
async function post(
  payload: unknown,
  {
    token = TOKEN as string | undefined,
    auth = `Bearer ${TOKEN}`,
    open = undefined as boolean | undefined,
  } = {},
) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  const response = await createApp(h.db, {
    premiumToken: token,
    publicHousehold: open,
  }).request("/v1/ichra/affordability", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(text)),
      authorization: auth,
    },
    body: text,
  });
  return {
    response,
    json: (await response.json()) as ReturnType<typeof JSON.parse>,
  };
}

describe("POST /v1/ichra/affordability", () => {
  it("answers behind the premium token, never cached, never a bindable quote", async () => {
    const { response, json } = await post(body());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(json.status).toBe("calculated");
    expect(json.bindable_quote).toBe(false);
    expect(json.quote_method).toBe("puf_calculation");
    expect(json.basis_sensitive).toBe(true);
    expect(
      json.verdicts.map((v: { affordable: boolean }) => v.affordable),
    ).toEqual([false, false]);
    // Golden response: any change to the contract or a figure shows up as a snapshot diff.
    // Import snapshot IDs carry a random UUID per test database.
    const stable = JSON.parse(
      JSON.stringify(json).replace(
        /puf-2026-TX-[0-9a-f-]{36}/g,
        "puf-2026-TX-<import>",
      ),
    );
    expect(stable).toMatchSnapshot();
  });
  it("selects the EHB-portion basis on request", async () => {
    const { json } = await post(body({ lcsp_premium_basis: "ehb_portion" }));
    expect(json.lcsp.basis_used).toBe("ehb_portion");
    expect(json.verdicts[0].affordable).toBe(true);
  });
  it("returns the annual rate basis and filed dates for a July plan start", async () => {
    const { response, json } = await post(body({ plan_start: "2026-07-01" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(json.status).toBe("calculated");
    for (const evidence of [json.lcsp, json.employer_lcsp]) {
      expect(evidence.coverage_month).toBe("2026-07-01");
      expect(evidence.monthly_cents).toBe(59_205);
      expect(evidence.provenance.rate_rows_by_plan[0].rate_basis).toMatchObject(
        {
          basis: "calendar_year_individual_rate",
          coverage_month: "2026-07-01",
          citation: {
            fields: ["RateEffectiveDate", "RateExpirationDate"],
            dates: [
              { effective_date: "2026-01-01", expiration_date: "2026-12-31" },
            ],
          },
        },
      );
    }
  });
  it.each([
    [
      "bad plan start",
      body({ plan_start: "2026-02-30" }),
      "plan_start",
      "INVALID_DATE",
    ],
    [
      "birth after plan start",
      body({ employee: { date_of_birth: "2027-01-01" } }),
      "employee.date_of_birth",
      "INVALID_DATE",
    ],
    ["unknown top-level field", body({ ssn: "x" }), "ssn", "UNKNOWN_FIELD"],
    [
      "unknown income field",
      body({ income: [{ measure: "household", annual_cents: 1, bonus: 2 }] }),
      "income.0.bonus",
      "UNKNOWN_FIELD",
    ],
    [
      "location safe harbor without a worksite",
      body({ safe_harbors: { location: true } }),
      "safe_harbors.location",
      "SAFE_HARBOR_INPUT_MISSING",
    ],
    [
      "duplicate measure",
      body({
        income: [{ measure: "fpl" }, { measure: "fpl" }],
      }),
      "income",
      "DUPLICATE_MEASURE",
    ],
    [
      "fractional cents",
      body({ hra: { self_only_annual_cents: 1.5 } }),
      "hra.self_only_annual_cents",
      "INVALID_INPUT",
    ],
    ["no income", body({ income: [] }), "income", "INVALID_INPUT"],
    ...(
      [
        [
          "zero months offered",
          { w2_months_offered: 0, w2_months_employed: 6 },
          "w2_months_offered",
          "INVALID_INPUT",
        ],
        [
          "13 months employed",
          { w2_months_offered: 6, w2_months_employed: 13 },
          "w2_months_employed",
          "INVALID_INPUT",
        ],
        [
          "a fractional month count",
          { w2_months_offered: 5.5, w2_months_employed: 6 },
          "w2_months_offered",
          "INVALID_INPUT",
        ],
        [
          "a month count sent as text",
          { w2_months_offered: "6", w2_months_employed: 6 },
          "w2_months_offered",
          "INVALID_INPUT",
        ],
        [
          "more months offered than employed",
          { w2_months_offered: 7, w2_months_employed: 6 },
          "w2_months_offered",
          "W2_MONTHS_OFFERED_EXCEED_EMPLOYED",
        ],
        [
          "months offered without months employed",
          { w2_months_offered: 6 },
          "w2_months_employed",
          "W2_MONTHS_INCOMPLETE",
        ],
        [
          "months employed without months offered",
          { w2_months_employed: 6 },
          "w2_months_offered",
          "W2_MONTHS_INCOMPLETE",
        ],
      ] as const
    ).map(
      ([name, months, field, code]) =>
        [
          name,
          body({
            income: [{ measure: "w2", annual_cents: 4_118_000, ...months }],
          }),
          `income.0.${field}`,
          code,
        ] as [string, ReturnType<typeof body>, string, string],
    ),
    [
      "month counts on another measure",
      body({
        income: [
          { measure: "household", annual_cents: 1, w2_months_offered: 6 },
        ],
      }),
      "income.0.w2_months_offered",
      "UNKNOWN_FIELD",
    ],
    [
      "a lowest hourly rate of zero",
      body({
        income: [
          {
            measure: "rate_of_pay_hourly",
            hourly_cents: 2_000,
            lowest_hourly_cents: 0,
          },
        ],
      }),
      "income.0.lowest_hourly_cents",
      "INVALID_INPUT",
    ],
    [
      "a negative lowest hourly rate",
      body({
        income: [
          {
            measure: "rate_of_pay_hourly",
            hourly_cents: 2_000,
            lowest_hourly_cents: -1,
          },
        ],
      }),
      "income.0.lowest_hourly_cents",
      "INVALID_INPUT",
    ],
    [
      "a salary reduction flag that is not a boolean",
      body({
        income: [
          {
            measure: "rate_of_pay_salary",
            monthly_cents: 400_000,
            salary_reduced: "yes",
          },
        ],
      }),
      "income.0.salary_reduced",
      "INVALID_INPUT",
    ],
    [
      "bad basis",
      body({ lcsp_premium_basis: "net" }),
      "lcsp_premium_basis",
      "INVALID_INPUT",
    ],
  ])(
    "400 for %s, naming the field and never echoing values",
    async (_name, payload, field, code) => {
      const { response, json } = await post(payload);
      expect(response.status).toBe(400);
      expect(json).toEqual({ error: { code, field } });
      expect(JSON.stringify(json)).not.toContain("4118000");
    },
  );
  it("400 for malformed JSON and for bodies over 64 KiB", async () => {
    const malformed = await post("{");
    expect(malformed.json).toEqual({
      error: { code: "INVALID_JSON", field: "body" },
    });
    const large = await post(
      body({ residence: { zip: "77002", county: "x".repeat(70_000) } }),
    );
    expect(large.response.status).toBe(400);
    expect(large.json).toEqual({
      error: { code: "REQUEST_TOO_LARGE", field: "body" },
    });
  });
  it("takes the partial-year, lowest-rate and salary-reduction fields", async () => {
    // SYNTHETIC inputs. W-2: $30,000 x 9.96% / 10 months employed = $298.80, and
    // (59,205 x 6 - 175,950) / 6 = 29,880 cents, so equal and affordable.
    // Hourly: 130 x $18.00 x 9.96% = $233.064 against the same $298.80: not affordable.
    const { response, json } = await post(
      body({
        months_available: 6,
        hra: { self_only_annual_cents: 175_950 },
        income: [
          {
            measure: "w2",
            annual_cents: 3_000_000,
            w2_months_offered: 6,
            w2_months_employed: 10,
          },
          {
            measure: "rate_of_pay_hourly",
            hourly_cents: 2_000,
            lowest_hourly_cents: 1_800,
          },
          {
            measure: "rate_of_pay_salary",
            monthly_cents: 400_000,
            salary_reduced: true,
          },
        ],
      }),
    );
    expect(response.status).toBe(200);
    const [w2, hourly, salary] = json.verdicts;
    expect(w2).toMatchObject({
      status: "calculated",
      required_hra_contribution_cents: { numerator: 29_880, denominator: 1 },
      threshold_cents: { numerator: 29_880, denominator: 1 },
      affordable: true,
    });
    expect(hourly).toMatchObject({
      threshold_cents: { numerator: 116_532, denominator: 5, display: 23_306 },
      affordable: false,
    });
    expect(salary).toMatchObject({
      status: "unknown",
      reason: "rate_of_pay_salary_reduced",
      affordable: null,
    });
    const cited = Object.fromEntries(
      json.rules.map((r: { id: string; citations: { section: string }[] }) => [
        r.id,
        r.citations.map((c) => c.section).join(" "),
      ]),
    );
    expect(cited.w2_safe_harbor).toContain("(e)(2)(ii)");
    expect(cited.rate_of_pay_safe_harbor).toContain("(e)(2)(iii)");
  });
  it("planted defect: a reversed month comparison lets 7 months offered of 6 employed through", () => {
    const original = new URL("../../dist/api/validation.js", import.meta.url);
    const directory = mkdtempSync(join(tmpdir(), "openplans-w2-months-"));
    try {
      const source = replaceSyntax(
        readFileSync(original, "utf8"),
        "monthsOffered > monthsEmployed",
        "monthsOffered < monthsEmployed",
      );
      const path = join(directory, "validation.mjs");
      writeFileSync(path, rebaseImports(source, original));
      const output = execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { ichraRequest } from ${JSON.stringify(pathToFileURL(path).href)};
import { readFileSync } from "node:fs";
console.log(JSON.stringify(ichraRequest(JSON.parse(readFileSync(0, "utf8"))).w2PartialYear));`,
        ],
        {
          input: JSON.stringify(
            body({
              income: [
                {
                  measure: "w2",
                  annual_cents: 3_000_000,
                  w2_months_offered: 7,
                  w2_months_employed: 6,
                },
              ],
            }),
          ),
          encoding: "utf8",
        },
      );
      expect(JSON.parse(output)).toEqual({
        monthsOffered: 7,
        monthsEmployed: 6,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("a refusal carries a status and no verdicts", async () => {
    const { response, json } = await post(body({ plan_start: "2027-01-01" }));
    expect(response.status).toBe(200);
    expect(json).toMatchObject({
      status: "unknown",
      reason: "catalog_not_loaded",
      verdicts: [],
      bindable_quote: false,
    });
  });
});
