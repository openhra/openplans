import { partDDrug, partDStatus } from "../../src/services/medicare-part-d.js";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { SqlSession } from "../../src/db/database.js";
import {
  withDataPolicy,
  requireAnnualYear,
  servingPolicy,
} from "../../src/services/data-window.js";
import { ReadError } from "../../src/services/errors.js";
import { listCarriersNetworks } from "../../src/services/catalog.js";
import { ichraAffordability } from "../../src/services/ichra.js";
import type { IchraRequest } from "../../src/services/ichra.js";
import { activeRelease } from "../../src/services/medicare.js";
import { createApp } from "../../src/api/app.js";
import { createResponseCache } from "../../src/api/cache/index.js";
import { MemoryCache } from "../../src/api/cache/store.js";
import { loadConfig } from "../../src/config/index.js";
import { callTool } from "../../src/mcp/tools.js";
import { outputSchemas } from "../../src/mcp/schemas.js";
import { errorResult } from "../../src/mcp/tools.js";
import { replaceSyntax } from "../source-mutation.js";
import { importMutant, withMutantFile } from "../mutant-file.js";

// Synthetic published identities and admission manifests exercise policy; no premium or coverage values.
function database() {
  const reads: string[] = [];
  const state = { admitted: true, embeddedYear: 2027 };
  const db = {
    async query(sql: string, parameters?: unknown[]) {
      reads.push(sql);
      if (sql.includes("FROM annual_data_admission"))
        return {
          rows: state.admitted
            ? [
                {
                  domain: "individual",
                  coverage_year: 2027,
                  manifest: {
                    schema_version: 1,
                    releases: [
                      {
                        kind: "puf",
                        snapshot_id: "synthetic-puf-2027",
                        contract_year: state.embeddedYear,
                      },
                    ],
                  },
                },
              ]
            : [],
        };
      if (sql.includes("jsonb_to_recordset")) return { rows: [] };
      if (sql.includes("AS domain"))
        return {
          rows: [2024, 2025, 2026, 2027].map((year) => ({
            domain: "individual",
            year,
          })),
        };
      if (sql.includes("api_data_generation"))
        return { rows: [{ generation: "synthetic-generation" }] };
      if (sql.includes("FROM medicare_release r JOIN snapshot"))
        return {
          rows: [{ snapshot_id: "synthetic-wrong-year", contract_year: 2025 }],
        };
      if (sql.includes("SELECT r.issuer_id"))
        return {
          rows: [
            {
              issuer_id: "00000",
              state: "TX",
              plan_year: Number(parameters?.[2] ?? 2025),
              source_row: 2,
              snapshot_id: "synthetic-py2025",
            },
          ],
        };
      throw new Error(`Unexpected annual read: ${sql.slice(0, 70)}`);
    },
    async exec() {
      throw new Error("No writes expected");
    },
  } as unknown as SqlSession;
  return { db, reads, state };
}
const now = () => Date.parse("2026-11-19T00:00:00Z");
const bounded = <T>(run: () => T) =>
  withDataPolicy({ historyYears: 3 }, run, new Date(now()));
const employee = (planStart = "2026-01-01"): IchraRequest => ({
  planStart,
  monthsAvailable: 12,
  dateOfBirth: "1985-10-01",
  eligibleFrom: null,
  residence: { zip: "77002" },
  worksite: null,
  hraAnnualCents: 300000,
  income: [{ measure: "household", annualCents: 4000000 }],
  safeHarbors: { location: false, lookBack: true },
  lcspPremiumBasis: null,
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("shared annual read policy", () => {
  it("refuses excluded physical data before queries can evaluate coverage or fallback", async () => {
    const { db, reads } = database();
    await expect(
      bounded(() => requireAnnualYear(db, 2024)),
    ).rejects.toMatchObject({
      error: {
        code: "not_loaded",
        required_year: 2024,
        domain: "individual",
        allowed_years: [2025, 2026, 2027],
      },
    });
    expect(
      reads.every((sql) =>
        /annual_data_admission|AS domain|jsonb_to_recordset|api_data_generation/.test(
          sql,
        ),
      ),
    ).toBe(true);
  });
  it("derives ICHRA January 2024 for a 2025 offer before any rate query", async () => {
    const { db, reads } = database();
    await expect(
      bounded(() => ichraAffordability(db, employee("2025-01-01"))),
    ).rejects.toMatchObject({
      error: { code: "not_loaded", required_year: 2024 },
    });
    expect(reads.some((sql) => /FROM rate|rating_rule|zcta/.test(sql))).toBe(
      false,
    );
  });
  it("admits the 2025 look-back for 2026 and the 2026 look-back for later starts", async () => {
    // The source reader is intentionally absent; reaching geography proves the year guard admitted the derived year.
    for (const date of ["2026-01-01", "2027-01-01", "2026-07-01"]) {
      const { db } = database();
      await expect(
        bounded(() => ichraAffordability(db, employee(date))),
      ).rejects.toThrow("Unexpected annual read");
    }
  });
  it("the default serves PY2025 with its own year unchanged", async () => {
    const { db } = database();
    const answer = await bounded(() =>
      listCarriersNetworks(db, "carriers", { state: "TX", year: "2025" }),
    );
    expect(answer).toMatchObject({
      status: "available",
      carriers: [{ plan_year: 2025, snapshot_id: "synthetic-py2025" }],
    });
  });
  it("rejects mismatched admitted and selected Medicare contract years", async () => {
    const { db, state } = database();
    state.embeddedYear = 2026;
    await expect(bounded(() => servingPolicy(db))).rejects.toMatchObject({
      error: { code: "data_policy_unavailable" },
    });
    state.admitted = false;
    await expect(
      bounded(() => activeRelease(db, "landscape", 2026)),
    ).rejects.toMatchObject({
      error: {
        code: "not_loaded",
        required_year: 2026,
        reason: "contract_year_mismatch",
      },
    });
  });
  it("refuses a wrong embedded Part D contract year before reading its plan or costs", async () => {
    vi.stubEnv("OPENPLANS_MEDICARE_PART_D", "on");
    const { db } = database();
    const query = db.query.bind(db);
    const selected: SqlSession = {
      ...db,
      query: async <Row extends Record<string, unknown>>(
        sql: string,
        parameters?: unknown[],
      ) =>
        sql.includes("FROM partd_release") &&
        !sql.includes("jsonb_to_recordset")
          ? {
              rows: [
                {
                  snapshot_id: "synthetic-partd-wrong-year",
                  contract_year: 2025,
                  as_of: "2025-01-01",
                  kind: "quarterly",
                  tables: ["formulary"],
                },
              ] as unknown as Row[],
            }
          : query<Row>(sql, parameters),
    };
    for (const read of [
      () => partDStatus(selected, 2026),
      () =>
        partDDrug(
          selected,
          { contractId: "H0000", planId: "001", segmentId: "0" },
          2026,
          "123",
        ),
    ])
      await expect(bounded<Promise<unknown>>(read)).rejects.toMatchObject({
        error: {
          code: "not_loaded",
          required_year: 2026,
          domain: "medicare",
          reason: "contract_year_mismatch",
        },
      });
  });
  it.each([
    "/v1/plans?year=2024",
    "/compat/v1/plans/00000TX0000000?year=2024",
    "/v1/medicare/plans?year=2024",
    "/v1/data-availability?year=2024",
  ])("returns explicit not_loaded on HTTP %s", async (path) => {
    const { db } = database();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now());
    const response = await createApp(
      db,
      {},
      { config: loadConfig({}) },
    ).request(path);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_loaded");
    expect(JSON.stringify(body)).not.toContain("not_covered");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("keeps the required look-back year on the private batch surface", async () => {
    const { db } = database();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now());
    const token = "synthetic-window-token";
    const app = createApp(
      db,
      { premiumToken: token, tpa: { enabled: true, privateIngress: true } },
      { config: loadConfig({}) },
    );
    const response = await app.request("/v1/ichra/affordability/batch", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        rows: [
          {
            row: 1,
            input: {
              plan_start: "2025-01-01",
              employee: { date_of_birth: "1985-10-01" },
              residence: { zip: "77002" },
              hra: { self_only_annual_cents: 300000 },
              income: [{ measure: "household", annual_cents: 4000000 }],
              safe_harbors: { look_back: true },
            },
          },
        ],
      }),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: {
        code: "not_loaded",
        required_year: 2024,
        allowed_years: [2025, 2026, 2027],
      },
    });
  });
  it("gives MCP the same structured dependency error without entering its DTO cache", async () => {
    const { db } = database();
    const cache = {
      catalog: vi.fn(() => {
        throw new Error("Cache must not run");
      }),
    } as unknown as ReturnType<typeof createResponseCache>;
    const result = await callTool({ db, cache, now }, "search_plans", {
      year: 2024,
      location: { zip: "77002" },
    });
    const output = result.structuredContent;
    expect(outputSchemas.search_plans.safeParse(output).success).toBe(true);
    expect(output).toMatchObject({
      status: "error",
      data: null,
      error: {
        code: "not_loaded",
        required_year: 2024,
        domain: "individual",
        allowed_years: [2025, 2026, 2027],
      },
    });
    expect(cache.catalog).not.toHaveBeenCalled();
  });
  it("checks the year embedded in a fetch ID before a cached answer", async () => {
    const { db } = database();
    const cache = {
      catalog: vi.fn(() => {
        throw new Error("Cache must not run");
      }),
    } as unknown as ReturnType<typeof createResponseCache>;
    const result = await callTool({ db, cache, now }, "fetch", {
      id: "plan:2024:00000TX0000000",
    });
    expect(result.structuredContent).toMatchObject({
      error: { code: "not_loaded", required_year: 2024 },
    });
    expect(cache.catalog).not.toHaveBeenCalled();
  });
  it("negative control: mislabeled absence fails the same MCP contract", () => {
    const contract = (code: string) =>
      expect(
        errorResult(
          "search_plans",
          new ReadError({ code, required_year: 2024, domain: "individual" }),
          "g",
          new Date(now()).toISOString(),
        ).structuredContent,
      ).toMatchObject({
        error: { code: "not_loaded", required_year: 2024 },
        data: null,
      });
    contract("not_loaded");
    expect(() => contract("explicitly_not_covered")).toThrow();
  });
  it("expires a cached prior year at UTC rollover without deleting its rows", async () => {
    const { db } = database();
    const memory = new MemoryCache(4096);
    const read = vi.spyOn(memory, "get");
    const cache = createResponseCache(db, undefined, {
      config: loadConfig({}),
      store: memory,
    });
    const app = new Hono();
    app.use("*", cache.middleware);
    app.get("/v1/plans", (c) => c.json({ plans: [{ plan_year: 2025 }] }));
    app.onError((error, c) =>
      error instanceof ReadError
        ? c.json({ error: error.error }, 404)
        : c.json({ error: { code: "unexpected" } }, 500),
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-12-31T23:59:59.999Z"));
    expect((await app.request("/v1/plans?year=2025")).status).toBe(200);
    expect(
      (await app.request("/v1/plans?year=2025")).headers.get("x-cache"),
    ).toBe("hit");
    const before = read.mock.calls.length;
    vi.setSystemTime(new Date("2027-01-01T00:00:00.000Z"));
    const rejected = await app.request("/v1/plans?year=2025");
    expect(rejected.status).toBe(404);
    expect(await rejected.json()).toMatchObject({
      error: { code: "not_loaded", required_year: 2025, domain: "individual" },
    });
    expect(read.mock.calls.length).toBe(before);
    const policy = await servingPolicy(db);
    expect(policy.domains.individual.loaded_years).toContain(2025);
    expect(policy.domains.individual.allowed_years).toEqual([2026, 2027]);
  });
  it("negative control: removing pre-cache admission leaks an out-of-window cache hit", async () => {
    const original = new URL("../../src/api/cache/index.ts", import.meta.url);
    const text = await readFile(original, "utf8");
    async function contract(factory: typeof createResponseCache) {
      const { db } = database();
      const memory = new MemoryCache(1024);
      const read = vi.fn(async () =>
        JSON.stringify({
          body: JSON.stringify({ plans: [{ plan_year: 2024 }] }),
          headers: [["content-type", "application/json"]],
        }),
      );
      const cache = factory(db, undefined, {
        config: loadConfig({}),
        store: { ...memory, bytes: () => 0, get: read, set: async () => {} },
      });
      const app = new Hono();
      app.use("*", cache.middleware);
      app.get("/v1/plans", (c) => c.json({ plans: [] }));
      app.onError((error, c) =>
        error instanceof ReadError
          ? c.json({ error: error.error }, 404)
          : c.json({ error: { code: "unexpected" } }, 500),
      );
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now());
      const response = await app.request("/v1/plans?year=2024");
      expect(response.status).toBe(404);
      expect(read).not.toHaveBeenCalled();
    }
    await contract(createResponseCache);
    const mutant = replaceSyntax(
      text,
      'await guardAnnualInput(db, c.req.query(), c.req.path.startsWith("/v1/medicare/") ? "medicare" : "individual");',
      "await Promise.resolve();",
    );
    await withMutantFile(original, mutant, async (file) => {
      const module = await importMutant<{
        createResponseCache: typeof createResponseCache;
      }>(file, "createResponseCache");
      await expect(contract(module.createResponseCache)).rejects.toThrow();
    });
  });
});
