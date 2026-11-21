import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SqlSession } from "../../../src/db/database.js";
import { MemoryCache } from "../../../src/api/cache/store.js";
import { plantMutant } from "../../../src/plugins/testing/index.js";
import type * as Config from "../../../src/config/index.js";

// Counts every configuration load. Parsing the configuration file costs about 0.27 ms on one CPU,
// so a load per request doubled the warm cache-hit latency (v0.4.18 startup A/B).
const loads = vi.hoisted(() => ({ count: 0 }));
vi.mock("../../../src/config/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof Config>();
  return {
    ...actual,
    loadConfig: (...args: Parameters<typeof actual.loadConfig>) => {
      loads.count++;
      return actual.loadConfig(...args);
    },
  };
});

const { createResponseCache } = await import("../../../src/api/cache/index.js");

afterEach(() => vi.unstubAllEnvs());

// Synthetic generation rows only.
const fakeDb = {
  query: async (sql: string) => ({
    rows:
      sql.includes("FROM annual_data_admission") || sql.includes("AS domain")
        ? []
        : [{ generation: "synthetic-generation" }],
  }),
} as unknown as SqlSession;

const WARM_REQUESTS = 25;

/** Loads while building the cache and serving one miss, then `WARM_REQUESTS` hits. */
async function countLoads(factory: typeof createResponseCache) {
  vi.stubEnv("OPENPLANS_RXNAV_IDENTITY", "on");
  vi.stubEnv("OPENPLANS_CMS_FALLBACK", "on");
  loads.count = 0;
  const cache = factory(fakeDb, "synthetic-token", {
    store: new MemoryCache(1024 * 1024),
  });
  const app = new Hono();
  app.use("*", cache.middleware);
  app.get("/v1/zip-counties", (c) => c.json({ synthetic: true }));
  const first = await app.request("/v1/zip-counties?zip=00000");
  expect(first.headers.get("X-Cache")).toBe("miss");
  const built = loads.count;
  const outcomes = new Set<string | null>();
  let catalogLoads = 0;
  for (let i = 0; i < WARM_REQUESTS; i++) {
    const response = await app.request("/v1/zip-counties?zip=00000");
    outcomes.add(response.headers.get("X-Cache"));
    await cache.catalog(
      {
        namespace: "synthetic",
        version: "1",
        generation: "synthetic-generation",
        query: { zip: "00000" },
        authorized: () => true,
        accept: (value): value is { synthetic: true } =>
          typeof value === "object" && value !== null,
        ttlSeconds: 60,
      },
      async () => {
        catalogLoads++;
        return { synthetic: true as const };
      },
    );
  }
  return { built, warm: loads.count - built, outcomes, catalogLoads };
}

describe("the response cache reads the configuration once per process", () => {
  it(`loads it at most once across ${WARM_REQUESTS} warm hits and catalog reads`, async () => {
    const result = await countLoads(createResponseCache);
    expect(result.outcomes).toEqual(new Set(["hit"]));
    expect(result.catalogLoads).toBe(1);
    expect(result.built).toBeLessThanOrEqual(1);
    expect(result.warm).toBe(0);
  });

  it("kills: the pass-through switches read per key", async () => {
    const mutant = await plantMutant(
      new URL("../../../src/api/cache/index.ts", import.meta.url),
      "...switchParts",
      "...passThroughSwitchParts(loadConfig())",
    );
    try {
      const module = (await import(/* @vite-ignore */ mutant.path)) as {
        createResponseCache: typeof createResponseCache;
      };
      const result = await countLoads(module.createResponseCache);
      // Still correct answers, but every warm key re-parses the configuration.
      expect(result.outcomes).toEqual(new Set(["hit"]));
      expect(result.warm).toBeGreaterThanOrEqual(2 * WARM_REQUESTS);
    } finally {
      await mutant.cleanup();
    }
  });
});
