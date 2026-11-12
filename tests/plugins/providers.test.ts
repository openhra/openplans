import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import type * as cacheModule from "../../src/api/cache/index.js";
import { createResponseCache } from "../../src/api/cache/index.js";
import { RespCache } from "../../src/api/cache/resp.js";
import { MemoryCache } from "../../src/api/cache/store.js";
import { loadConfig } from "../../src/config/index.js";
import type { SqlSession } from "../../src/db/database.js";
import { currentRegistries, loadPlugins } from "../../src/plugins/index.js";
import type { LoadedPlugins } from "../../src/plugins/index.js";
import {
  CORE_PLUGIN_NAME,
  providerTables,
  selectCacheStore,
  selectDatabase,
  unknownProviders,
} from "../../src/plugins/providers.js";
import { plantMutant } from "../../src/plugins/testing/index.js";

const fixtures = fileURLToPath(
  new URL("../fixtures/plugins/", import.meta.url),
);
const shipped = fileURLToPath(
  new URL("../../data/access/federal-publishers.json", import.meta.url),
);
const cacheFile = new URL("../../src/api/cache/index.ts", import.meta.url);
const loaderFile = new URL("../../src/plugins/loader.ts", import.meta.url);
const synthetic = () =>
  (
    globalThis as {
      syntheticCacheStore?: { down: boolean; created: number };
    }
  ).syntheticCacheStore!;

const fakeDb = {
  query: async () => ({ rows: [{ generation: "synthetic-generation" }] }),
  exec: async () => {},
} as unknown as SqlSession;

class Exit extends Error {}
type Load = typeof loadPlugins;
async function load(
  settings: Record<string, unknown>,
  plugins: string[],
  loader: Load = loadPlugins,
) {
  const lines: string[] = [];
  let exit: number | undefined;
  const config = loadConfig(
    {},
    {
      version: 1,
      ...settings,
      plugins: plugins.map((name) => ({
        package: `./synthetic-${name}/index.mjs`,
      })),
    },
  );
  const loaded: LoadedPlugins | undefined = await loader(config, "api", {
    env: {},
    baseDirectory: fixtures,
    manifestPaths: [shipped],
    writeLog: (line) => lines.push(line),
    exit: (code) => {
      exit = code;
      throw new Exit();
    },
  }).catch((error: unknown) => {
    if (error instanceof Exit) return undefined;
    throw error;
  });
  return { config, loaded, lines, exit };
}

/** Miss then hit through the cache middleware on a public TTL route. */
async function missThenHit(cache: ReturnType<typeof createResponseCache>) {
  const app = new Hono();
  let calls = 0;
  app.use("*", cache.middleware);
  app.get("/v1/plans", (c) => c.json({ calls: ++calls }));
  const outcomes: (string | null)[] = [];
  for (let i = 0; i < 2; i++)
    outcomes.push((await app.request("/v1/plans")).headers.get("x-cache"));
  return { outcomes, calls };
}

afterEach(() => {
  const state = synthetic();
  if (state) state.down = false;
});

describe("cache store selection (design 5.7)", () => {
  it("keeps today's defaults: memory, valkey for a URL, off as a zero-byte store", () => {
    const tables = providerTables();
    expect(Object.keys(tables.cacheStores)).toEqual(["memory", "valkey"]);
    expect(Object.keys(tables.dbProviders)).toEqual(["pg"]);
    const memory = selectCacheStore(
      loadConfig({ OPENPLANS_API_CACHE_MB: "3" }),
    );
    expect(memory).toBeInstanceOf(MemoryCache);
    expect((memory as MemoryCache).maxBytes).toBe(3 * 1024 * 1024);
    expect(
      selectCacheStore(
        loadConfig({ OPENPLANS_CACHE_URL: "redis://127.0.0.1:1" }),
      ),
    ).toBeInstanceOf(RespCache);
    const off = createResponseCache(fakeDb, undefined, {
      config: loadConfig({ OPENPLANS_API_CACHE: "off" }),
    }).stats();
    expect(off).toMatchObject({ backend: "off", bytes: 0 });
  });

  it("keeps the OPENPLANS_CACHE_URL validation message", () => {
    const message =
      "Cache URL must be redis://host:port without credentials or a database";
    expect(() =>
      createResponseCache(fakeDb, undefined, {
        config: loadConfig({
          OPENPLANS_CACHE_URL: "redis://synthetic:synthetic@localhost",
        }),
      }),
    ).toThrow(message);
    expect(() =>
      selectCacheStore(
        loadConfig({}, { version: 1, cache: { provider: "valkey" } }),
      ),
    ).toThrow(message);
  });

  it("selects a plugin's store by config and reports it as external", async () => {
    const { config, loaded, exit } = await load(
      { cache: { provider: "synthetic" } },
      ["cache-store"],
    );
    expect(exit).toBeUndefined();
    expect(Object.keys(loaded!.registries.cacheStores)).toEqual(["synthetic"]);
    const before = synthetic().created;
    const cache = createResponseCache(fakeDb, undefined, {
      config,
      plugins: loaded!.registries,
    });
    expect(synthetic().created).toBe(before + 1);
    expect(await missThenHit(cache)).toEqual({
      outcomes: ["miss", "hit"],
      calls: 1,
    });
    expect(cache.stats()).toMatchObject({
      backend: "external",
      hits: 1,
      misses: 1,
      bytes_scope: "payload_bytes_transferred",
    });
    expect(cache.stats().bytes).toBeGreaterThan(0);
  });

  it("does not open a plugin store when the cache is off", async () => {
    const { loaded } = await load(
      { cache: { provider: "synthetic", enabled: false } },
      ["cache-store"],
    );
    const before = synthetic().created;
    const cache = createResponseCache(fakeDb, undefined, {
      config: loadConfig(
        { OPENPLANS_API_CACHE: "off" },
        { version: 1, cache: { provider: "synthetic" } },
      ),
      plugins: loaded!.registries,
    });
    expect(await missThenHit(cache)).toEqual({
      outcomes: ["bypass", "bypass"],
      calls: 2,
    });
    expect(synthetic().created).toBe(before);
    expect(cache.stats()).toMatchObject({ backend: "off", bytes: 0 });
  });

  it("bypasses a plugin store that fails, and serves the response", async () => {
    const { config, loaded } = await load(
      { cache: { provider: "synthetic" } },
      ["cache-store"],
    );
    const cache = createResponseCache(fakeDb, undefined, {
      config,
      plugins: loaded!.registries,
    });
    synthetic().down = true;
    expect(await missThenHit(cache)).toEqual({
      outcomes: ["bypass", "bypass"],
      calls: 2,
    });
  });

  it("refuses an unknown provider name without constructing anything", () => {
    expect(() =>
      selectCacheStore(
        loadConfig({}, { version: 1, cache: { provider: "synthetic" } }),
      ),
    ).toThrow(/^Unknown cache provider$/);
    expect(() =>
      loadConfig({}, { version: 1, cache: { provider: "Not A Name" } }),
    ).toThrow("Invalid OpenPlans configuration");
  });
});

describe("refusal at load", () => {
  for (const [settings, reason] of [
    [{ cache: { provider: "synthetic" } }, "cache.provider"],
    [{ db: { provider: "synthetic-db" } }, "db.provider"],
    // `pglite` is reserved for the developer runner and never offered to a loaded host.
    [{ db: { provider: "pglite" } }, "db.provider"],
  ] as const)
    it(`refuses ${reason} = ${Object.values(settings)[0]!.provider} when no plugin provides it`, async () => {
      const before = currentRegistries();
      const result = await load(settings, []);
      expect(result.exit).toBe(1);
      expect(result.lines.map((line) => JSON.parse(line))).toEqual([
        { plugin: CORE_PLUGIN_NAME, code: "plugin_provider_unknown", reason },
      ]);
      expect(currentRegistries()).toBe(before);
    });

  it("accepts the same names once a plugin provides them", async () => {
    const result = await load(
      { cache: { provider: "synthetic" }, db: { provider: "synthetic-db" } },
      ["cache-store", "db-provider"],
    );
    expect(result.exit).toBeUndefined();
    expect(
      unknownProviders(
        result.config,
        providerTables(result.loaded!.registries),
      ),
    ).toEqual([]);
  });

  it("refuses a plugin that takes a core provider name", async () => {
    const result = await load({}, ["provider-collision"]);
    expect(result.exit).toBe(1);
    expect(JSON.parse(result.lines[0]!)).toMatchObject({
      code: "plugin_provider_collision",
    });
  });
});

describe("database providers", () => {
  it("opens the pg provider by default without connecting", async () => {
    const db = selectDatabase(
      loadConfig({ DATABASE_URL: "postgres://127.0.0.1:1/synthetic" }),
    );
    expect(typeof db.transaction).toBe("function");
    expect(typeof db.withSession).toBe("function");
    expect(typeof db.withRequest).toBe("function");
    await db.close();
  });

  it("selects a plugin's provider by config and passes the connection string", async () => {
    const { config, loaded } = await load(
      {
        db: {
          provider: "synthetic-db",
          connectionString: "synthetic://connection",
        },
      },
      ["db-provider"],
    );
    const db = selectDatabase(config, providerTables(loaded!.registries));
    expect(db).toMatchObject({
      synthetic: true,
      connectionString: "synthetic://connection",
    });
  });

  it("registers pglite only where the developer runner adds it", () => {
    expect(() =>
      selectDatabase(loadConfig({}), providerTables(), "pglite"),
    ).toThrow(/^Unknown database provider$/);
    const developer = providerTables(undefined, {
      dbProviders: {
        pglite: () =>
          ({ pglite: true }) as unknown as ReturnType<typeof selectDatabase>,
      },
    });
    expect(selectDatabase(loadConfig({}), developer, "pglite")).toEqual({
      pglite: true,
    });
  });
});

describe("planted mutants", () => {
  it("is caught when createResponseCache ignores the plugin registry", async () => {
    const { config, loaded } = await load(
      { cache: { provider: "synthetic" } },
      ["cache-store"],
    );
    const options = { config, plugins: loaded!.registries };
    expect(
      createResponseCache(fakeDb, undefined, options).stats().backend,
    ).toBe("external");
    const mutant = await plantMutant(
      cacheFile,
      "selectCacheStore(config, providerTables(options.plugins))",
      "selectCacheStore(config)",
    );
    try {
      const module = (await import(mutant.path)) as typeof cacheModule;
      expect(() =>
        module.createResponseCache(fakeDb, undefined, options),
      ).toThrow("Unknown cache provider");
    } finally {
      await mutant.cleanup();
    }
  });

  it("is caught when an off cache still opens the configured store", async () => {
    const { loaded } = await load({ cache: { provider: "synthetic" } }, [
      "cache-store",
    ]);
    const options = {
      config: loadConfig(
        { OPENPLANS_API_CACHE: "off" },
        { version: 1, cache: { provider: "synthetic" } },
      ),
      plugins: loaded!.registries,
    };
    const mutant = await plantMutant(
      cacheFile,
      "const store = disabled",
      "const store = false",
    );
    try {
      const module = (await import(mutant.path)) as typeof cacheModule;
      const before = synthetic().created;
      module.createResponseCache(fakeDb, undefined, options);
      expect(synthetic().created).toBe(before + 1);
    } finally {
      await mutant.cleanup();
    }
  });

  it("is caught when the loader skips the provider check", async () => {
    const mutant = await plantMutant(
      loaderFile,
      "if (missing) refuse(",
      "if (false) refuse(",
    );
    try {
      const module = (await import(mutant.path)) as {
        loadPlugins: Load;
      };
      const result = await load(
        { cache: { provider: "synthetic" } },
        [],
        module.loadPlugins,
      );
      expect(result.exit).toBeUndefined();
      expect(result.lines).toEqual([]);
    } finally {
      await mutant.cleanup();
    }
  });
});
