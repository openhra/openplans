import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createApp } from "../../src/api/app.js";
import type { SqlSession } from "../../src/db/database.js";
import type * as QuoteCoverage from "../../src/services/quote-coverage.js";
import type * as QuoteRoutes from "../../src/api/quotes.js";
import { importMutant, withMutantFile } from "../mutant-file.js";
import { replaceSyntax } from "../source-mutation.js";
import {
  PLAN,
  README_CENTS,
  TOKEN,
  postJson,
  quoteBody,
  quoteFixture,
} from "./quote-fixture.js";

interface CoverageItem {
  status: string;
  evidence: unknown[];
}
interface QuoteMember {
  premium_cents: number;
  rate_rows: { individual_tobacco_rate_cents: number }[];
}
interface PlanCoverage {
  providers: CoverageItem[];
  drugs: CoverageItem[];
}
interface PublicQuote extends PlanCoverage {
  plan_id: string;
  members: QuoteMember[];
}
interface CoverageEnvelope {
  quotes: PlanCoverage[];
  data_availability: unknown;
}
interface QuoteResponse extends CoverageEnvelope {
  quotes: PublicQuote[];
  members: { tobacco: boolean }[];
}

let fixture: Awaited<ReturnType<typeof quoteFixture>>;
beforeAll(async () => {
  fixture = await quoteFixture();
});
afterAll(async () => fixture?.close());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const app = (options: Parameters<typeof createApp>[1] = {}) =>
  createApp(fixture.db, { premiumToken: TOKEN, ...options });
async function quote(payload: unknown, options = {}) {
  const response = await postJson(app(options), "/v1/quotes", payload);
  return { response, json: (await response.json()) as QuoteResponse };
}
const premiumBody = {
  plan_ids: [PLAN],
  county: "48201",
  coverage_start: "2026-01-01",
  members: [{ age: 35, tobacco: false, relationship: "subscriber" }],
};

describe("POST /v1/quotes public tier", () => {
  it("quotes 87226TX0100013 for age 35 in 77002/48201 at the README premium, anonymously", async () => {
    const { response, json } = await quote(quoteBody());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-quote-tier")).toBe("public");
    expect(json).toMatchObject({
      schema_version: "1",
      tier: "public_quote",
      bindable_quote: false,
      year: 2026,
      coverage_start: "2026-01-01",
      coverage: "medical",
      location: { status: "available", zip: "77002", county: "48201" },
      members: [
        { member_id: "0", age: 35, relationship: "subscriber", tobacco: false },
      ],
      tobacco_rating: "requested_flags",
      subsidy: { status: "not_evaluated", reason: "PUBLIC_QUOTE_TIER" },
      csr_eligibility_status: "not_evaluated",
      data_availability: {
        catalog: "available",
        providers: "unknown",
        drugs: "unknown",
      },
      page: 1,
      total: 1,
      next_page: null,
    });
    expect(json.quotes[0]).toMatchObject({
      plan_id: PLAN,
      status: "rated",
      total_cents: README_CENTS,
      rating_area_id: "Rating Area 10",
      providers: [],
      drugs: [],
    });
    expect(json.quotes[0]).not.toHaveProperty("subsidy");
    expect(JSON.stringify(json)).not.toMatch(/income|household/i);
  });

  it("rates an optional tobacco flag from the same rate row", async () => {
    const { json } = await quote(
      quoteBody({ members: [{ age: 35, tobacco: true }] }),
    );
    const member = json.quotes[0]!.members[0]!;
    expect(json.members[0]!.tobacco).toBe(true);
    expect(member.premium_cents).toBe(
      member.rate_rows[0]!.individual_tobacco_rate_cents,
    );
    expect(member.premium_cents).not.toBe(README_CENTS);
  });

  it("enumerates the location catalog by base ID, ten per page", async () => {
    const { json } = await quote({
      year: 2026,
      zip: "77002",
      members: [{ age: 35 }],
    });
    const ids = json.quotes.map((q: { plan_id: string }) => q.plan_id);
    expect(ids).toEqual([...ids].sort());
    expect(ids).toContain(PLAN);
    expect(json).toMatchObject({
      page_size: 10,
      total: ids.length,
      next_page: null,
    });
    const page2 = await quote({
      year: 2026,
      zip: "77002",
      members: [{ age: 35 }],
      page: 2,
    });
    expect(page2.json.quotes).toEqual([]);
    const silver = await quote({
      year: 2026,
      zip: "77002",
      members: [{ age: 35 }],
      metal: "platinum",
    });
    expect(
      silver.json.quotes.every((q: { plan_id: string }) =>
        ids.includes(q.plan_id),
      ),
    ).toBe(true);
  });

  it("returns an empty envelope for an unknown ZIP and 404 for an unknown plan", async () => {
    const unknown = await quote(quoteBody({ zip: "77001", county: undefined }));
    expect(unknown.response.status).toBe(200);
    expect(unknown.json).toMatchObject({
      location: { status: "unknown" },
      quotes: [],
      total: 0,
    });
    const missing = await quote(quoteBody({ plan_ids: ["99999TX0100001"] }));
    expect(missing.response.status).toBe(404);
    expect(missing.json).toMatchObject({ error: { code: "PLAN_NOT_FOUND" } });
  });

  it("refuses income, dates of birth, names and oversized households with named fields", async () => {
    for (const [extra, code, field] of [
      [
        { household_income_annual: 40000 },
        "INCOME_NOT_ACCEPTED",
        "household_income_annual",
      ],
      [
        { members: [{ age: 35, dob: "1990-01-02" }] },
        "DOB_NOT_ACCEPTED",
        "members.0.dob",
      ],
      [{ name: "x" }, "UNKNOWN_FIELD", "name"],
      [
        { members: Array.from({ length: 11 }, () => ({ age: 30 })) },
        "TOO_MANY_MEMBERS",
        "members",
      ],
    ] as const) {
      const { response, json } = await quote(quoteBody(extra));
      expect(response.status).toBe(400);
      expect(json).toEqual({ error: { code, field } });
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect((await quote("{not json")).json).toEqual({
      error: { code: "INVALID_JSON", field: "body" },
    });
  });

  it("returns 503 QUOTING_DISABLED when the tier is off by option or by OPENPLANS_PUBLIC_QUOTING=off", async () => {
    const off = await quote(quoteBody(), { publicQuoting: false });
    expect(off.response.status).toBe(503);
    expect(off.json).toEqual({ error: { code: "QUOTING_DISABLED" } });
    vi.stubEnv("OPENPLANS_PUBLIC_QUOTING", "off");
    expect(
      (await postJson(createApp(fixture.db, {}), "/v1/quotes", quoteBody()))
        .status,
    ).toBe(503);
    vi.stubEnv("OPENPLANS_PUBLIC_QUOTING", "");
    expect(
      (await postJson(createApp(fixture.db, {}), "/v1/quotes", quoteBody()))
        .status,
    ).toBe(200);
    vi.stubEnv("OPENPLANS_PUBLIC_QUOTING", "maybe");
    expect(() => createApp(fixture.db, {})).toThrow(/OPENPLANS_PUBLIC_QUOTING/);
  });
});

describe("coverage honesty with no provider or formulary feeds (negative control 6)", () => {
  const coverageBody = quoteBody({
    npis: ["1234567893", "1003000126"],
    rxcuis: ["860975"],
  });
  function expectHonest(json: CoverageEnvelope) {
    const items = json.quotes.flatMap((q: PlanCoverage) => [
      ...q.providers,
      ...q.drugs,
    ]);
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(item.status).toBe("unknown");
      expect(item.evidence).toEqual([]);
    }
    expect(json.data_availability).toMatchObject({
      providers: "unknown",
      drugs: "unknown",
    });
  }
  it("reports unknown per plan, with the shared participation and coverage objects", async () => {
    const { json } = await quote(coverageBody);
    expectHonest(json);
    expect(json.quotes[0]!.providers[0]).toMatchObject({
      identity: "1234567893",
      reason: "source_set_not_available",
      requested_plan_id: PLAN,
    });
    const single = await app().request(
      `/v1/plans/${PLAN}/providers/1234567893?year=2026`,
    );
    expect(json.quotes[0]!.providers[0]).toEqual(await single.json());
    const drug = await app().request(
      `/v1/plans/${PLAN}/drugs/860975?year=2026`,
    );
    expect(json.quotes[0]!.drugs[0]).toEqual(await drug.json());
  });
  it("negative control: a service copy that turns missing evidence into out_of_network fails", async () => {
    const source = new URL(
      "../../src/services/quote-coverage.ts",
      import.meta.url,
    );
    await withMutantFile(
      source,
      replaceSyntax(
        await readFile(source, "utf8"),
        "providers.push(await providerParticipation(db, requestedId, code, year));",
        'providers.push({ ...(await providerParticipation(db, requestedId, code, year)), status: "out_of_network" as "unknown" });',
      ),
      async (temporary) => {
        const mutant = await importMutant<typeof QuoteCoverage>(
          temporary,
          "readQuoteCoverage",
        );
        const coverage = await mutant.readQuoteCoverage(
          fixture.db,
          PLAN,
          ["1234567893", "1003000126"],
          ["860975"],
          2026,
        );
        expect(() =>
          expectHonest({
            quotes: [coverage],
            data_availability: { providers: "unknown", drugs: "unknown" },
          }),
        ).toThrow();
      },
    );
  });
});

describe("personalized premium quotes; the old premium-estimates name is gone (negative control 8)", () => {
  const headers = { authorization: `Bearer ${TOKEN}` };
  it("returns the README premium under quotes, with no deprecation headers", async () => {
    const current = await postJson(
      app(),
      "/v1/premium-quotes",
      premiumBody,
      headers,
    );
    expect(current.status).toBe(200);
    for (const header of ["deprecation", "sunset", "link"])
      expect(current.headers.get(header)).toBeNull();
    const currentJson = (await current.json()) as { quotes: unknown[] };
    expect(currentJson.quotes[0]).toMatchObject({
      status: "rated",
      total_cents: README_CENTS,
    });
    expect(currentJson).not.toHaveProperty("estimates");
  });
  it("keeps 503 AUTH_NOT_CONFIGURED when switched off and 401 UNAUTHORIZED with a token", async () => {
    const path = "/v1/premium-quotes";
    const unconfigured = await postJson(
      createApp(fixture.db, { publicHousehold: false }),
      path,
      premiumBody,
      headers,
    );
    expect(unconfigured.status).toBe(503);
    expect(await unconfigured.json()).toEqual({
      error: { code: "AUTH_NOT_CONFIGURED" },
    });
    const wrong = await postJson(app(), path, premiumBody, {
      authorization: "Bearer wrong",
    });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: { code: "UNAUTHORIZED" } });
    // The public body has no personalized meaning on this route.
    expect((await postJson(app(), path, quoteBody())).status).toBe(401);
  });

  /** The removed name must answer exactly like a route that never existed. */
  async function expectRemoved(routes: typeof QuoteRoutes) {
    const mounted = new Hono();
    mounted.route(
      "/v1",
      routes.quoteRoutes(fixture.db, { premiumToken: TOKEN }),
    );
    const unknown = await postJson(
      mounted,
      "/v1/no-such-route",
      premiumBody,
      headers,
    );
    for (const options of [{ premiumToken: TOKEN }, {}]) {
      const full = createApp(fixture.db, options);
      for (const auth of [headers, {}]) {
        const removed = await postJson(
          full,
          "/v1/premium-estimates",
          premiumBody,
          auth,
        );
        const never = await postJson(
          full,
          "/v1/no-such-route",
          premiumBody,
          auth,
        );
        expect(removed.status).toBe(404);
        expect(await removed.text()).toBe(await never.text());
        for (const header of ["deprecation", "sunset", "link"])
          expect(removed.headers.get(header)).toBeNull();
      }
    }
    const removed = await postJson(
      mounted,
      "/v1/premium-estimates",
      premiumBody,
      headers,
    );
    expect(removed.status).toBe(unknown.status);
    expect(removed.status).toBe(404);
    expect(await removed.text()).toBe(await unknown.text());
    for (const header of ["deprecation", "sunset", "link"])
      expect(removed.headers.get(header)).toBeNull();
  }
  it("POST /v1/premium-estimates is the normal 404 for an unknown route, with or without a token", async () => {
    await expectRemoved(await import("../../src/api/quotes.js"));
  });
  it("negative control: a quotes.ts copy that re-adds the old route fails", async () => {
    const source = new URL("../../src/api/quotes.ts", import.meta.url);
    await withMutantFile(
      source,
      replaceSyntax(
        await readFile(source, "utf8"),
        'app.use("/premium-quotes", household);',
        'app.use("/premium-quotes", household); app.use("/premium-estimates", household); app.post("/premium-estimates", async (c) => c.json(await estimatePremiums(db, await jsonBody(c))));',
      ),
      async (temporary) => {
        const mutant = await importMutant<typeof QuoteRoutes>(
          temporary,
          "quoteRoutes",
        );
        await expect(expectRemoved(mutant)).rejects.toThrow();
      },
    );
  });
});

describe("public quote rate limit (negative control 5)", () => {
  const peer = (request: Request) =>
    request.headers.get("x-synthetic-peer") ?? undefined;
  async function verdict(module: typeof QuoteRoutes) {
    const limited = new Hono();
    limited.use(
      "/v1/quotes",
      ...module.publicQuoteAdmission({
        publicQuoting: true,
        peerAddress: peer,
        now: () => 1_000,
      }),
    );
    limited.post("/v1/quotes", (c) => c.json({ ok: true }));
    const send = (source: string) =>
      limited.request("/v1/quotes", {
        method: "POST",
        headers: { "x-synthetic-peer": source },
      });
    for (let i = 0; i < 30; i++)
      expect((await send("198.51.100.1")).status).toBe(200);
    const refused = await send("198.51.100.1");
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: { code: "RATE_LIMITED" } });
    expect(refused.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(Number(refused.headers.get("retry-after"))).toBe(60);
    expect((await send("198.51.100.2")).status).toBe(200);
  }
  it("refuses the 31st request in a minute from one source and admits another source", async () => {
    await verdict(await import("../../src/api/quotes.js"));
  });
  it("counts cached and refused quotes through the real app", async () => {
    const limited = app({ peerAddress: peer, now: () => 1_000 });
    const statuses = [];
    for (let i = 0; i < 31; i++)
      statuses.push(
        (
          await postJson(limited, "/v1/quotes", quoteBody(), {
            "x-synthetic-peer": "203.0.113.9",
          })
        ).status,
      );
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
  });
  it("limits concurrent quotes per source", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { publicQuoteAdmission } = await import("../../src/api/quotes.js");
    const limited = new Hono();
    limited.use(
      "/v1/quotes",
      ...publicQuoteAdmission({ publicQuoting: true, peerAddress: peer }),
    );
    limited.post("/v1/quotes", async (c) => {
      await gate;
      return c.json({ ok: true });
    });
    const send = () =>
      limited.request("/v1/quotes", {
        method: "POST",
        headers: { "x-synthetic-peer": "192.0.2.7" },
      });
    const first = [send(), send()];
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await send()).status).toBe(429);
    release();
    expect((await Promise.all(first)).map((r) => r.status)).toEqual([200, 200]);
  });
  it("negative control: a limiter copy with perMinute = Infinity fails", async () => {
    const source = new URL("../../src/api/quotes.ts", import.meta.url);
    await withMutantFile(
      source,
      replaceSyntax(
        await readFile(source, "utf8"),
        "perMinute: 30,",
        "perMinute: Infinity,",
      ),
      async (temporary) => {
        const mutant = await importMutant<typeof QuoteRoutes>(
          temporary,
          "publicQuoteAdmission",
        );
        await expect(verdict(mutant)).rejects.toThrow();
      },
    );
  });
});

describe("no request values in any log line (negative control 4)", () => {
  // Sentinels: ZIP 77002, county 48201, age 43, an invalid field value.
  const sentinels = ["77002", "48201", "43", "synthetic-invalid-value"];
  function spyConsole() {
    return (["log", "error", "warn", "info", "debug", "trace"] as const).map(
      (method) => vi.spyOn(console, method).mockImplementation(() => {}),
    );
  }
  function logged(spies: ReturnType<typeof spyConsole>) {
    return spies.flatMap((spy) =>
      spy.mock.calls.map((args) =>
        args
          .map((a) =>
            a instanceof Error
              ? `${a.message} ${a.stack}`
              : (JSON.stringify(a) ?? String(a)),
          )
          .join(" "),
      ),
    );
  }
  const body = quoteBody({ members: [{ age: 43, tobacco: true }] });
  it("logs only class and stack hash on internal errors, without request values", async () => {
    const spies = spyConsole();
    const ok = await postJson(app(), "/v1/quotes", body);
    expect(ok.status).toBe(200);
    const refused = await postJson(app(), "/v1/quotes", {
      ...body,
      members: [{ age: 43, nickname: "synthetic-invalid-value" }],
    });
    expect(refused.status).toBe(400);
    expect(logged(spies)).toEqual([]);
    const throwing: SqlSession = {
      query: async () => {
        throw new Error(
          "synthetic failure 77002 48201 age 43 synthetic-invalid-value",
        );
      },
      exec: async () => {},
    };
    const failed = await postJson(
      createApp(throwing, { publicQuoting: true }),
      "/v1/quotes",
      body,
    );
    expect(failed.status).toBe(500);
    expect(await failed.text()).not.toMatch(/77002|synthetic-invalid-value/);
    expect(spies[1]).toHaveBeenCalledTimes(1);
    const entry = JSON.parse(spies[1]!.mock.calls[0]![0]);
    expect(entry).toEqual({
      event: "api_internal_error",
      error_class: "Error",
      stack_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(logged(spies.filter((_spy, index) => index !== 1))).toEqual([]);
    // Short numeric sentinels can occur by chance inside a SHA-256 digest.
    const metadata = JSON.stringify({ ...entry, stack_hash: undefined });
    for (const sentinel of sentinels) expect(metadata).not.toContain(sentinel);
  });
  it("negative control: an error handler that logs the error is caught by the spy", async () => {
    const spies = spyConsole();
    const leaky = new Hono();
    leaky.onError((error, c) => {
      console.error(error);
      return c.json({ error: { code: "INTERNAL_ERROR" } }, 500);
    });
    leaky.post("/v1/quotes", () => {
      throw new Error("synthetic failure 77002 age 43");
    });
    await leaky.request("/v1/quotes", { method: "POST" });
    expect(logged(spies).some((line) => line.includes("77002"))).toBe(true);
  });
});
