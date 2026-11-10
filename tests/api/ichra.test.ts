import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app.js";
import { setup, TOKEN } from "../compat/v1/helpers.js";

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
  it("answers without a token by default, and refuses when switched off (503) or with a wrong token (401)", async () => {
    const open = await post(body(), { token: "", auth: "" });
    expect(open.response.status).toBe(200);
    expect(open.response.headers.get("cache-control")).toBe("no-store");
    const off = await post(body(), { token: "", open: false });
    expect(off.response.status).toBe(503);
    expect(off.json).toEqual({ error: { code: "AUTH_NOT_CONFIGURED" } });
    const wrong = await post(body(), { auth: "Bearer wrong" });
    expect(wrong.response.status).toBe(401);
    expect(wrong.json).toEqual({ error: { code: "UNAUTHORIZED" } });
    expect(wrong.response.headers.get("cache-control")).toBe("no-store");
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
