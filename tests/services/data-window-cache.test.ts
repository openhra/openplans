import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SqlSession } from "../../src/db/database.js";
import { loadConfig } from "../../src/config/index.js";
import { createResponseCache } from "../../src/api/cache/index.js";
import { MemoryCache } from "../../src/api/cache/store.js";
import { ReadError } from "../../src/services/errors.js";
import { createStatusHost } from "../../src/plugins/status-host.js";
import { boundedDatabase } from "../../src/db/bounded.js";
import { scopeResponseGeneration } from "../../src/plugins/request-scope.js";
import * as policy from "../../src/services/data-window.js";
import { replaceSyntax } from "../source-mutation.js";
import { importMutant, withMutantFile } from "../mutant-file.js";

// Synthetic identities only; the real ledger trigger is exercised by data-window-admission.test.ts.
function database() {
  const state = {
    generation: 1,
    admitted: true,
    invalid: false,
    unavailable: false,
    loaded: [2025, 2026, 2027],
  };
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("api_data_generation")) {
      if (state.unavailable) throw new Error("synthetic generation failure");
      return { rows: [{ generation: `synthetic-${state.generation}` }] };
    }
    if (sql.includes("FROM annual_data_admission"))
      return {
        rows: state.admitted
          ? [
              {
                domain: "individual",
                coverage_year: 2027,
                manifest: {
                  schema_version: 1,
                  releases: Array.from({ length: 31 }, (_, i) => ({
                    kind: "puf",
                    snapshot_id: `synthetic-${i}`,
                    contract_year: 2027,
                  })),
                },
              },
            ]
          : [],
      };
    if (sql.includes("jsonb_to_recordset"))
      return {
        rows: state.invalid ? [{ snapshot_id: "synthetic-invalid" }] : [],
      };
    if (sql.includes("AS domain"))
      return {
        rows: state.loaded.map((year) => ({ domain: "individual", year })),
      };
    throw new Error("Unexpected policy query");
  });
  const db = { query, exec: async () => {} } as unknown as SqlSession;
  return { db, query, state };
}
const now = () => new Date("2026-11-19T00:00:00Z");
const bounded = <T>(run: () => T) =>
  policy.withDataPolicy({ historyYears: 3 }, run, now());
function appFor(
  db: SqlSession,
  config = loadConfig({}),
  store = new MemoryCache(64 * 1024),
) {
  const get = vi.spyOn(store, "get");
  const cache = createResponseCache(db, undefined, { config, store });
  const app = new Hono();
  app.use("*", cache.middleware);
  app.get("/v1/plans", async (c) => c.json(await policy.servingPolicy(db)));
  app.get("/v1/zip-counties", (c) => c.json({ synthetic: true }));
  app.onError((error, c) =>
    error instanceof ReadError
      ? c.json({ error: error.error }, 404)
      : c.json({ error: { code: "unexpected" } }, 500),
  );
  return { app, config, get };
}
afterEach(() => vi.useRealTimers());

describe("process serving-policy cache", () => {
  it("uses a resolved policy without a promise after the live generation check", async () => {
    const { db, query, state } = database();
    const first = await bounded(() => policy.servingPolicy(db));
    query.mockClear();
    await bounded(async () => {
      const generation = await policy.servingGeneration(db);
      const current = policy.policyForGeneration(db, generation);
      expect(current).toBe(first);
      expect(current).not.toBeInstanceOf(Promise);
      expect(await policy.servingPolicy(db)).toBe(first);
    });
    expect(query).toHaveBeenCalledTimes(1);
    state.admitted = false;
    state.generation++;
    await bounded(async () => {
      const current = policy.policyForGeneration(
        db,
        await policy.servingGeneration(db),
      );
      expect(current).toBeInstanceOf(Promise);
      expect((await current).domains.individual.allowed_years).not.toContain(
        2027,
      );
      expect(await policy.servingPolicy(db)).toBe(await current);
    });
  });
  it("keeps health checks independent of annual-policy storage and leaves data guarded", async () => {
    const { db, query, state } = database();
    const cache = createResponseCache(db, undefined, {
      config: loadConfig({}),
    });
    const app = new Hono();
    app.use("*", cache.middleware);
    for (const path of ["/healthz", "/readyz"])
      app.get(path, async (c) => {
        await db.query("SELECT 1");
        return c.json({ policyScope: policy.dataPolicyActive() });
      });
    app.get("/v1/plans", async (c) => {
      await policy.requireAnnualYear(db, 2027);
      return c.json({ synthetic: true });
    });
    app.onError((error, c) =>
      c.json({ refused: error instanceof ReadError }, 503),
    );
    // This fake reader has no health-check branch. Failed DB checks must still fail.
    expect((await app.request("/readyz")).status).toBe(503);
    query.mockImplementationOnce(async () => ({ rows: [] }));
    expect(await (await app.request("/readyz")).json()).toEqual({
      policyScope: false,
    });
    query.mockImplementationOnce(async () => ({ rows: [] }));
    expect(await (await app.request("/healthz")).json()).toEqual({
      policyScope: false,
    });
    expect((await app.request("/v1/plans?year=2027")).status).toBe(200);
    state.admitted = false;
    state.generation++;
    expect((await app.request("/v1/plans?year=2027")).status).toBe(503);
  });
  it("exposes a checked response generation only to eligible cache misses", async () => {
    const { db, state } = database();
    const create = (config = loadConfig({})) => {
      const cache = createResponseCache(db, undefined, {
        config,
        store: new MemoryCache(64 * 1024),
      });
      const app = new Hono();
      app.use("*", cache.middleware);
      app.get("/v1/zip-counties", (c) =>
        c.json({ observed: scopeResponseGeneration() ?? null }),
      );
      return app;
    };
    const app = create();
    expect(await (await app.request("/v1/zip-counties")).json()).toEqual({
      observed: "synthetic-1",
    });
    expect(
      await (
        await app.request("/v1/zip-counties?year=2025", {
          headers: { Authorization: "Bearer synthetic" },
        })
      ).json(),
    ).toEqual({ observed: null });
    expect(
      await (
        await create(loadConfig({ OPENPLANS_API_CACHE: "off" })).request(
          "/v1/zip-counties?year=2025",
        )
      ).json(),
    ).toEqual({ observed: null });
    state.unavailable = true;
    expect(await (await app.request("/v1/zip-counties")).json()).toEqual({
      observed: null,
    });
  });
  it("refreshes a cached policy response after revocation without a year parameter", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now());
    const { db, state, query } = database();
    const { app } = appFor(db);
    const read = () => app.request("/v1/plans");
    expect((await read()).headers.get("x-cache")).toBe("miss");
    expect((await read()).headers.get("x-cache")).toBe("hit");
    state.admitted = false;
    state.generation++;
    query.mockClear();
    const changed = await read();
    expect(changed.headers.get("x-cache")).toBe("miss");
    expect(await changed.json()).toMatchObject({
      domains: {
        individual: { allowed_years: [2025, 2026] },
      },
    });
    expect(
      query.mock.calls.filter(([sql]) => sql.includes("api_data_generation")),
    ).toHaveLength(1);
  });
  it("a startup warm-up leaves only the live generation check on the first data request", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now());
    const { db, query } = database();
    await bounded(() => policy.servingPolicy(db));
    query.mockClear();
    const { app } = appFor(db);
    expect((await app.request("/v1/zip-counties")).status).toBe(200);
    expect(query.mock.calls).toHaveLength(1);
    expect(query.mock.calls[0]![0]).toContain("api_data_generation");
  });
  it("shares status policy across bounded readers and refreshes after revocation", async () => {
    const { db, query, state } = database();
    const host = createStatusHost(
      loadConfig({}),
      { database: db },
      () => undefined,
    );
    const reader = () =>
      boundedDatabase(db, new AbortController().signal, { readOnly: true });
    const first = await host.dataPolicy!(reader());
    expect(await host.dataPolicy!(reader())).toBe(first);
    expect(
      query.mock.calls.filter(([sql]) =>
        sql.includes("FROM annual_data_admission"),
      ),
    ).toHaveLength(1);
    state.admitted = false;
    state.generation++;
    expect(
      (await host.dataPolicy!(reader())).domains.individual.allowed_years,
    ).not.toContain(2027);
    expect(
      query.mock.calls.filter(([sql]) =>
        sql.includes("FROM annual_data_admission"),
      ),
    ).toHaveLength(2);
    const transaction = database();
    expect(
      (
        await host.dataPolicy!(
          boundedDatabase(transaction.db, new AbortController().signal),
        )
      ).domains.individual.allowed_years,
    ).toContain(2027);
    const canceled = new AbortController();
    canceled.abort(new Error("synthetic canceled read"));
    await expect(
      host.dataPolicy!(boundedDatabase(db, canceled.signal)),
    ).rejects.toThrow("synthetic canceled read");
  });
  it("reuses the response cache generation when status derives through its bounded reader", async () => {
    const { db, query } = database();
    const root: SqlSession = {
      query: async (sql, ...args) =>
        /api_data_generation|annual_data_admission|jsonb_to_recordset|AS domain/.test(
          sql,
        )
          ? db.query(sql, ...args)
          : { rows: [] },
      exec: async () => {},
    };
    const host = createStatusHost(
      loadConfig({}),
      { database: root },
      () => undefined,
    );
    await bounded(async () => {
      const current = await policy.servingPolicy(root);
      const reader = boundedDatabase(root, new AbortController().signal, {
        readOnly: true,
      });
      expect(await host.dataAvailability!(reader)).toEqual([]);
      expect(await host.dataPolicy!(reader)).toBe(current);
    });
    expect(
      query.mock.calls.filter(([sql]) => sql.includes("api_data_generation")),
    ).toHaveLength(1);
  });
  it("batches 31 dependencies and reuses one generation query per warm request", async () => {
    const { db, query } = database();
    const first = await bounded(() => policy.servingPolicy(db));
    expect(query).toHaveBeenCalledTimes(4);
    query.mockClear();
    for (let i = 0; i < 3; i++) {
      await bounded(async () => {
        expect(await policy.servingPolicy(db)).toBe(first);
        await policy.requireAnnualYear(db, 2027);
        expect(await policy.servingGeneration(db)).toBe("synthetic-1");
      });
    }
    expect(query).toHaveBeenCalledTimes(3);
    expect(
      query.mock.calls.every(([sql]) => sql.includes("api_data_generation")),
    ).toBe(true);
  });
  it("shares concurrent policy construction across independent request scopes", async () => {
    const { db, query } = database();
    const answers = await Promise.all(
      Array.from({ length: 8 }, () => bounded(() => policy.servingPolicy(db))),
    );
    expect(new Set(answers).size).toBe(1);
    expect(
      query.mock.calls.filter(([sql]) => sql.includes("api_data_generation")),
    ).toHaveLength(8);
    expect(
      query.mock.calls.filter(([sql]) =>
        sql.includes("FROM annual_data_admission"),
      ),
    ).toHaveLength(1);
    expect(
      query.mock.calls.filter(([sql]) => sql.includes("jsonb_to_recordset")),
    ).toHaveLength(1);
  });
  it("keeps database identities separate across request scopes", async () => {
    const a = database(),
      b = database();
    b.state.admitted = false;
    expect(
      (await bounded(() => policy.servingPolicy(a.db))).domains.individual
        .allowed_years,
    ).toContain(2027);
    expect(
      (await bounded(() => policy.servingPolicy(b.db))).domains.individual
        .allowed_years,
    ).not.toContain(2027);
  });
  it("shares the transaction's guarded policy with a response-cache database wrapper", async () => {
    const { db } = database();
    const root: SqlSession = {
      query: async () => {
        throw new Error("Root queries would wait for the active transaction");
      },
      exec: async () => {},
    };
    const cache = createResponseCache(root, undefined, {
      config: loadConfig({}),
      store: new MemoryCache(64 * 1024),
    });
    await bounded(async () => {
      const current = await policy.servingPolicy(db);
      expect(await policy.servingPolicy(root)).toBe(current);
      const load = vi.fn(async () => ({ synthetic: true }));
      const request = {
        namespace: "synthetic-transaction",
        version: "1",
        generation: "synthetic-1",
        query: { year: 2027 },
        authorized: () => true,
        accept: (value: unknown): value is { synthetic: boolean } =>
          typeof value === "object" && value !== null && "synthetic" in value,
        ttlSeconds: 30,
      };
      await cache.catalog(request, load);
      await cache.catalog(request, load);
      expect(load).toHaveBeenCalledTimes(1);
    });
  });
  it("prevents callers from changing the policy shared with later requests", async () => {
    const { db } = database();
    const first = await bounded(() => policy.servingPolicy(db));
    expect(() => first.domains.individual.allowed_years.push(2024)).toThrow();
    expect(
      (await bounded(() => policy.servingPolicy(db))).domains.individual
        .allowed_years,
    ).not.toContain(2024);
  });
  it("does not reuse failed refreshes or hide generation failures behind a warm policy", async () => {
    const { db, state } = database();
    const first = await bounded(() => policy.servingPolicy(db));
    state.unavailable = true;
    await expect(bounded(() => policy.servingPolicy(db))).rejects.toThrow(
      "synthetic generation failure",
    );
    state.unavailable = false;
    state.generation++;
    state.invalid = true;
    await expect(bounded(() => policy.servingPolicy(db))).rejects.toMatchObject(
      { error: { code: "data_policy_unavailable" } },
    );
    state.invalid = false;
    expect(await bounded(() => policy.servingPolicy(db))).toEqual(first);
  });
  it("invalidates loaded inventories and receipt validation on generation changes", async () => {
    const { db, state } = database();
    const first = await bounded(() => policy.servingPolicy(db));
    state.loaded.push(2024);
    state.generation++;
    const second = await bounded(() => policy.servingPolicy(db));
    expect(second.domains.individual.excluded_loaded_years).toEqual([2024]);
    expect(second.generation).not.toBe(first.generation);
    state.invalid = true;
    state.generation++;
    await expect(bounded(() => policy.servingPolicy(db))).rejects.toMatchObject(
      { error: { code: "data_policy_unavailable" } },
    );
  });
  it("refreshes requests without a scope and observes config file changes", async () => {
    const { db, state } = database();
    const first = await policy.servingPolicy(db);
    state.admitted = false;
    state.generation++;
    const second = await policy.servingPolicy(db);
    expect(second.domains.individual.admitted_years).toEqual([]);
    expect(second.generation).not.toBe(first.generation);
    const directory = await mkdtemp(join(tmpdir(), "openplans-policy-config-"));
    const file = join(directory, "config.json");
    vi.stubEnv("OPENPLANS_CONFIG", file);
    try {
      await writeFile(
        file,
        JSON.stringify({ version: 1, data: { historyYears: 1 } }),
      );
      expect((await policy.servingPolicy(db)).history_years).toBe(1);
      await writeFile(
        file,
        JSON.stringify({ version: 1, data: { historyYears: 3 } }),
      );
      expect((await policy.servingPolicy(db)).history_years).toBe(3);
      await writeFile(file, "{");
      await expect(policy.servingPolicy(db)).rejects.toThrow();
    } finally {
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("rechecks generation once before a guarded response-cache hit", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now());
    const { db, query } = database();
    const { app } = appFor(db);
    expect(
      (await app.request("/v1/plans?year=2025")).headers.get("x-cache"),
    ).toBe("miss");
    query.mockClear();
    expect(
      (await app.request("/v1/plans?year=2025")).headers.get("x-cache"),
    ).toBe("hit");
    expect(query).toHaveBeenCalledTimes(1);
    query.mockClear();
    await app.request("/v1/zip-counties");
    query.mockClear();
    expect((await app.request("/v1/zip-counties")).headers.get("x-cache")).toBe(
      "hit",
    );
    expect(query).toHaveBeenCalledTimes(1);
  });
  it("changes response keys for config and UTC year changes without an explicit year input", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now());
    const { db } = database();
    const store = new MemoryCache(64 * 1024);
    const { app } = appFor(db, loadConfig({}), store);
    let get = () => app.request("/v1/plans");
    expect((await get()).headers.get("x-cache")).toBe("miss");
    expect((await get()).headers.get("x-cache")).toBe("hit");
    const current = appFor(
      db,
      loadConfig({}, { version: 1, data: { historyYears: 1 } }),
      store,
    ).app;
    get = () => current.request("/v1/plans");
    const changed = await get();
    expect(changed.headers.get("x-cache")).toBe("miss");
    expect(await changed.json()).toMatchObject({ history_years: 1 });
    expect((await get()).headers.get("x-cache")).toBe("hit");
    get = () => app.request("/v1/plans");
    vi.setSystemTime(new Date("2027-01-01T00:00:00Z"));
    const rollover = await get();
    expect(rollover.headers.get("x-cache")).toBe("miss");
    expect(await rollover.json()).toMatchObject({
      calendar_year: 2027,
      domains: { individual: { allowed_years: [2026, 2027] } },
    });
  });
  it("refuses a cached explicit year after a config narrows the window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now());
    const { db } = database();
    const store = new MemoryCache(64 * 1024);
    const { app, get } = appFor(
      db,
      loadConfig({}, { version: 1, data: { historyYears: 3 } }),
      store,
    );
    await app.request("/v1/plans?year=2025");
    expect(
      (await app.request("/v1/plans?year=2025")).headers.get("x-cache"),
    ).toBe("hit");
    const reads = get.mock.calls.length;
    const narrowed = appFor(
      db,
      loadConfig({}, { version: 1, data: { historyYears: 1 } }),
      store,
    ).app;
    const refused = await narrowed.request("/v1/plans?year=2025");
    expect(refused.status).toBe(404);
    expect(await refused.json()).toMatchObject({
      error: { code: "not_loaded", required_year: 2025 },
    });
    expect(get).toHaveBeenCalledTimes(reads);
  });
  it("negative control: wrapping a resolved policy restores an unnecessary promise", async () => {
    async function contract(
      module: Pick<
        typeof policy,
        | "withDataPolicy"
        | "servingPolicy"
        | "servingGeneration"
        | "policyForGeneration"
      >,
    ) {
      const { db } = database();
      await module.withDataPolicy(
        { historyYears: 3 },
        () => module.servingPolicy(db),
        now(),
      );
      await module.withDataPolicy(
        { historyYears: 3 },
        async () => {
          const result = module.policyForGeneration(
            db,
            await module.servingGeneration(db),
          );
          expect(
            result,
            "resolved policies must stay synchronous",
          ).not.toBeInstanceOf(Promise);
        },
        now(),
      );
    }
    await contract(policy);
    const original = new URL(
      "../../src/services/data-window.ts",
      import.meta.url,
    );
    const source = await readFile(original, "utf8");
    const mutant = replaceSyntax(
      source,
      "return cached.value ?? cached.policy;",
      "return cached.policy;",
    );
    await withMutantFile(original, mutant, async (file) => {
      const module = await importMutant<typeof policy>(file);
      await expect(contract(module)).rejects.toThrow(
        "resolved policies must stay synchronous",
      );
    });
  });
  it("negative control: a process cache without the generation key misses the next admission", async () => {
    async function contract(
      module: Pick<typeof policy, "withDataPolicy" | "servingPolicy">,
    ) {
      const { db, state } = database();
      state.admitted = false;
      const read = () =>
        module.withDataPolicy(
          { historyYears: 3 },
          () => module.servingPolicy(db),
          now(),
        );
      const before = await read();
      expect(before.domains.individual.allowed_years).not.toContain(2027);
      state.admitted = true;
      state.generation++;
      const after = await read();
      expect(
        after.domains.individual.allowed_years,
        "admission must refresh serving window",
      ).toContain(2027);
      expect(after.generation).not.toBe(before.generation);
    }
    await contract(policy);
    const original = new URL(
      "../../src/services/data-window.ts",
      import.meta.url,
    );
    const source = await readFile(original, "utf8");
    const mutant = replaceSyntax(
      source,
      "JSON.stringify([generation, now.getUTCFullYear(), config])",
      "JSON.stringify([now.getUTCFullYear(), config])",
    );
    await withMutantFile(original, mutant, async (file) => {
      const module = await importMutant<typeof policy>(file);
      await expect(contract(module)).rejects.toThrow(
        "admission must refresh serving window",
      );
    });
  });
});
