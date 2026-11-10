import { readFile, rm, writeFile } from "node:fs/promises";
import { Hono } from "hono";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createApp } from "../../src/api/app.js";
import type * as QuoteRoutes from "../../src/api/quotes.js";
import { InputError } from "../../src/api/validation.js";
import type { SqlSession } from "../../src/db/database.js";
import { createMcpHttp } from "../../src/mcp/http.js";
import { setup, BASE, searchBody } from "../compat/v1/helpers.js";
import { listedToolNames, post as mcpPost } from "../mcp/transport-helpers.js";
import { replaceSyntax } from "../source-mutation.js";

/**
 * Owner, 2026-11-09: every feature is on by default. Household quotes, the benchmark,
 * ICHRA checks and the compatibility API answer anonymous callers when no token or key is
 * set. They stay rate-limited, uncached and out of the logs.
 */
type Json = ReturnType<typeof JSON.parse>;
let h: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => h?.close());
beforeEach(() => {
  delete process.env.OPENPLANS_COMPAT_API_KEY;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const PLAN = "87226TX0100013";
// Synthetic sentinels; none may reach a log line.
const INCOME = 41234.56;
const premiumBody = {
  plan_ids: [PLAN],
  zip: "77002",
  county: "48201",
  coverage_start: "2026-01-01",
  members: [{ age: 43, tobacco: true, relationship: "subscriber" }],
  household_income_annual: INCOME,
  household_size: 1,
  tax_filing: "single",
};
const ichraBody = {
  plan_start: "2026-01-01",
  employee: { date_of_birth: "1983-03-04" },
  residence: { zip: "77002" },
  hra: { self_only_annual_cents: 300_000 },
  income: [{ measure: "household", annual_cents: 4_123_456 }],
};
const peer = (request: Request) =>
  request.headers.get("x-synthetic-peer") ?? undefined;

function send(
  app: { request: Hono["request"] },
  path: string,
  payload?: unknown,
  headers: Record<string, string> = {},
) {
  return app.request(path, {
    method: payload === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...headers },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
}
const routes = [
  ["/v1/premium-quotes", premiumBody],
  ["/v1/benchmark?zip=77002&county=48201&year=2026&ages=43", undefined],
  ["/v1/ichra/affordability", ichraBody],
] as const;

describe("household routes are open by default", () => {
  it("answer anonymously with no-store and no response cache", async () => {
    const app = createApp(h.db, {});
    for (const [path, payload] of routes) {
      const response = await send(app, path, payload);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("cache-control"), path).toBe("no-store");
      expect(response.headers.get("x-cache"), path).toBe("bypass");
    }
    const quoted = (await (
      await send(app, "/v1/premium-quotes", premiumBody)
    ).json()) as Json;
    expect(quoted.quotes[0]).toMatchObject({ status: "rated" });
    expect(quoted.quotes[0].subsidy).toBeDefined();
  });
  it("a set token restricts them; off with no token closes them", async () => {
    const token = createApp(h.db, { premiumToken: "synthetic-open-token" });
    const off = createApp(h.db, { publicHousehold: false });
    vi.stubEnv("OPENPLANS_PUBLIC_HOUSEHOLD", "off");
    const offByEnv = createApp(h.db, {});
    for (const [path, payload] of routes) {
      expect((await send(token, path, payload)).status, path).toBe(401);
      const authorized = await send(token, path, payload, {
        authorization: "Bearer synthetic-open-token",
      });
      expect(authorized.status, path).toBe(200);
      for (const closed of [off, offByEnv]) {
        const response = await send(closed, path, payload);
        expect(response.status, path).toBe(503);
        expect(await response.json()).toEqual({
          error: { code: "AUTH_NOT_CONFIGURED" },
        });
      }
    }
  });
  it("rejects a value other than on or off", async () => {
    vi.stubEnv("OPENPLANS_PUBLIC_HOUSEHOLD", "maybe");
    expect(() => createApp(h.db, {})).toThrow(/OPENPLANS_PUBLIC_HOUSEHOLD/);
  });
});

describe("one anonymous household bucket (negative control)", () => {
  async function verdict(module: typeof QuoteRoutes) {
    const app = new Hono();
    // Same mapping as the native router: validation errors are 400s, never logged.
    app.onError((error, c) =>
      c.json({}, error instanceof InputError ? 400 : 500),
    );
    app.route(
      "/v1",
      module.quoteRoutes(h.db, { peerAddress: peer, now: () => 0 }),
    );
    const statuses = [];
    for (let i = 0; i < 31; i++)
      statuses.push(
        (
          await send(
            app,
            "/v1/premium-quotes",
            {},
            {
              "x-synthetic-peer": "192.0.2.80",
            },
          )
        ).status,
      );
    expect(statuses.slice(0, 30).every((s) => s === 400)).toBe(true);
    expect(statuses[30]).toBe(429);
    const other = await send(
      app,
      "/v1/premium-quotes",
      {},
      {
        "x-synthetic-peer": "192.0.2.81",
      },
    );
    expect(other.status).toBe(400);
  }
  it("refuses the 31st request in a minute from one source and admits another", async () => {
    await verdict(await import("../../src/api/quotes.js"));
  });
  it("shares the bucket across premium quotes, ICHRA and the benchmark", async () => {
    const app = createApp(h.db, { peerAddress: peer, now: () => 0 });
    const source = { "x-synthetic-peer": "192.0.2.82" };
    for (let i = 0; i < 10; i++) {
      expect((await send(app, "/v1/premium-quotes", {}, source)).status).toBe(
        400,
      );
      expect(
        (await send(app, "/v1/ichra/affordability", {}, source)).status,
      ).toBe(400);
      expect((await send(app, "/v1/benchmark", undefined, source)).status).toBe(
        400,
      );
    }
    const limited = await send(app, "/v1/benchmark", undefined, source);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
  });
  it("does not meter callers with the operator token", async () => {
    const app = createApp(h.db, {
      premiumToken: "synthetic-open-token",
      peerAddress: peer,
      now: () => 0,
    });
    for (let i = 0; i < 35; i++) {
      const response = await send(
        app,
        "/v1/premium-quotes",
        {},
        {
          "x-synthetic-peer": "192.0.2.83",
          authorization: "Bearer synthetic-open-token",
        },
      );
      expect(response.status).toBe(400);
    }
  });
  it("negative control: an open path that skips the limiter fails", async () => {
    const source = new URL("../../src/api/quotes.ts", import.meta.url);
    const temporary = new URL(
      "../../src/api/.quotes-mutant-open-unmetered.ts",
      import.meta.url,
    );
    await writeFile(
      temporary,
      replaceSyntax(
        await readFile(source, "utf8"),
        "if (admission) return admission(c, next);",
        "if (admission) return next();",
      ),
    );
    try {
      const mutant = (await import(
        /* @vite-ignore */ temporary.href
      )) as typeof QuoteRoutes;
      await expect(verdict(mutant)).rejects.toThrow();
    } finally {
      await rm(temporary, { force: true });
    }
  });
});

describe("the compatibility API is open by default", () => {
  const search = `${BASE}/plans/medical/search`;
  it("answers anonymously with no key set, and restricts or closes when asked", async () => {
    const open = await send(createApp(h.db, {}), search, searchBody());
    expect(open.status).toBe(200);
    expect(open.headers.get("cache-control")).toBe("no-store");
    const off = await send(
      createApp(h.db, { publicCompat: false }),
      search,
      searchBody(),
    );
    expect(off.status).toBe(503);
    vi.stubEnv("OPENPLANS_PUBLIC_COMPAT", "off");
    expect((await send(createApp(h.db, {}), search, searchBody())).status).toBe(
      503,
    );
    vi.unstubAllEnvs();
    vi.stubEnv("OPENPLANS_COMPAT_API_KEY", "synthetic-compat-key");
    const keyed = createApp(h.db, {});
    expect((await send(keyed, search, searchBody())).status).toBe(401);
    expect(
      (
        await send(keyed, search, searchBody(), {
          "X-Api-Key": "synthetic-compat-key",
        })
      ).status,
    ).toBe(200);
  });
  it("rate-limits anonymous callers per source", async () => {
    const app = createApp(h.db, { peerAddress: peer, now: () => 0 });
    const statuses = [];
    for (let i = 0; i < 31; i++)
      statuses.push(
        (
          await send(app, `${BASE}/zip_counties?zip_prefix=1`, undefined, {
            "x-synthetic-peer": "192.0.2.84",
          })
        ).status,
      );
    expect(statuses.slice(0, 30).every((s) => s === 400)).toBe(true);
    expect(statuses[30]).toBe(429);
  });
});

describe("MCP household tools are open by default", () => {
  const quiet = () => {};
  const household = ["quote_premiums", "check_ichra_affordability"];
  it("lists them anonymously; a token or the off switch withholds them", async () => {
    const names = await listedToolNames(
      createMcpHttp(h.db, { env: {}, log: quiet }),
    );
    for (const tool of household) expect(names).toContain(tool);
    for (const env of [
      { OPENPLANS_MCP_TOKEN: "synthetic-mcp-token" },
      { OPENPLANS_PUBLIC_HOUSEHOLD: "off" },
    ]) {
      const app = createMcpHttp(h.db, { env, log: quiet });
      const listed = await listedToolNames(app);
      for (const tool of household) expect(listed).not.toContain(tool);
      const call = await app.fetch(
        mcpPost("tools/call", { name: "quote_premiums", arguments: {} }),
      );
      expect(call.status).toBe(401);
    }
  });
});

describe("no household request values in any log line", () => {
  const sentinels = [
    "41234.56",
    "4123456",
    "77002",
    "48201",
    "1983-03-04",
    '"age":43',
    "tobacco",
    "synthetic-invalid-value",
  ];
  function spyConsole() {
    return (["log", "error", "warn", "info", "debug", "trace"] as const).map(
      (method) => vi.spyOn(console, method).mockImplementation(() => {}),
    );
  }
  function text(a: unknown): string {
    if (a instanceof Error) return `${a.message} ${a.stack}`;
    if (typeof a === "string") return a;
    return JSON.stringify(a) ?? String(a);
  }
  function logged(spies: ReturnType<typeof spyConsole>) {
    return spies.flatMap((spy) =>
      spy.mock.calls.map((args) => args.map((a) => text(a)).join(" ")),
    );
  }
  it("logs nothing on success, refusal and internal error paths, MCP included", async () => {
    const spies = spyConsole();
    const app = createApp(h.db, {});
    for (const [path, payload] of routes)
      expect((await send(app, path, payload)).status, path).toBe(200);
    for (const [path, payload] of [
      [
        "/v1/premium-quotes",
        { ...premiumBody, tax_filing: "synthetic-invalid-value" },
      ],
      [
        "/v1/ichra/affordability",
        { ...ichraBody, nickname: "synthetic-invalid-value" },
      ],
    ] as const) {
      const refused = await send(app, path, payload);
      expect(refused.status, path).toBe(400);
    }
    expect(
      (
        await send(
          app,
          `${BASE}/plans/medical/search`,
          searchBody({
            applicants: [{ age: 43, smoker: true, child: false }],
            household_income: INCOME,
            household_size: 1,
          }),
        )
      ).status,
    ).toBe(200);
    const throwing: SqlSession = {
      query: async () => {
        throw new Error(
          "synthetic failure 77002 48201 age 43 41234.56 tobacco synthetic-invalid-value",
        );
      },
      exec: async () => {},
    };
    const broken = createApp(throwing, {});
    for (const [path, payload] of routes) {
      const failed = await send(broken, path, payload);
      expect(failed.status, path).toBeGreaterThanOrEqual(500);
      expect(await failed.text()).not.toMatch(/41234|77002/);
    }
    // The real MCP transport logs one entry per call through console.error.
    const mcp = createMcpHttp(h.db, { env: {} });
    const call = await mcp.fetch(
      mcpPost("tools/call", {
        name: "quote_premiums",
        arguments: {
          plan_refs: [PLAN],
          location: { zip: "77002", county: "48201" },
          coverage_start: "2026-01-01",
          members: [{ age: 43, tobacco: true, relationship: "subscriber" }],
          household: { income_annual: INCOME, size: 1, tax_filing: "single" },
        },
      }),
    );
    expect(call.status).toBe(200);
    await call.text();
    const lines = logged(spies);
    expect(lines.some((line) => line.includes('"tool":"quote_premiums"'))).toBe(
      true,
    );
    for (const sentinel of sentinels)
      expect(lines.filter((line) => line.includes(sentinel))).toEqual([]);
  });
});
