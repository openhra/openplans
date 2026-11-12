import { Hono } from "hono";
import { readFile, rm, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { CacheLevel } from "@openplans/plugin-sdk";
import { createResponseCache } from "../../../src/api/cache/index.js";
import type { CacheOutcome } from "../../../src/api/cache/index.js";
import { MemoryCache } from "../../../src/api/cache/store.js";
import type { CacheStore } from "../../../src/api/cache/store.js";
import type { SqlSession } from "../../../src/db/database.js";
import {
  restrictCacheLevel,
  runWithScope,
  scopeCacheLevel,
} from "../../../src/plugins/request-scope.js";
import { replaceSyntax } from "../../source-mutation.js";

// Synthetic route and DTO values only. A route stands in for a pass-through answer by calling
// restrictCacheLevel the way the pass-through core will (design 5.10.5).
const fakeDb = {
  query: async () => ({ rows: [{ generation: "synthetic-generation" }] }),
} as unknown as SqlSession;
type Restriction = { level: CacheLevel; ttl?: number } | null;

function recordingStore() {
  const memory = new MemoryCache(1024 * 1024),
    writes: { key: string; ttl: number }[] = [];
  const store: CacheStore = {
    bytes: () => memory.bytes(),
    get: (key) => memory.get(key),
    set: async (key, value, ttl) => {
      writes.push({ key, ttl });
      await memory.set(key, value, ttl);
    },
  };
  return { store, writes, bytes: () => memory.bytes() };
}

function routeHarness(
  restriction: Restriction,
  factory: typeof createResponseCache = createResponseCache,
) {
  const recorded = recordingStore();
  const cache = factory(fakeDb, undefined, { store: recorded.store });
  const app = new Hono();
  app.use("*", cache.middleware);
  let calls = 0;
  // GET /v1/plans has a 60 s route TTL.
  app.get("/v1/plans", async (c) => {
    calls++;
    // An async hop first: the level must survive awaits inside the handler.
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (restriction) restrictCacheLevel(restriction.level, restriction.ttl);
    return c.json({ synthetic: true, calls });
  });
  return { app, cache, calls: () => calls, ...recorded };
}
const get = (app: Hono) =>
  app.fetch(new Request("http://127.0.0.1/v1/plans?year=2026"));

async function routeContract(
  restriction: Restriction,
  factory?: typeof createResponseCache,
) {
  const h = routeHarness(restriction, factory);
  const first = await get(h.app),
    second = await get(h.app);
  await first.text();
  await second.text();
  return {
    outcomes: [first.headers.get("X-Cache"), second.headers.get("X-Cache")],
    calls: h.calls(),
    writes: h.writes,
    bytes: h.bytes(),
  };
}

describe("response cache honours the request's cache level", () => {
  it.each(["none", "request"] as const)(
    "%s: never stores, answers bypass, and a second request runs the route again",
    async (level) => {
      const result = await routeContract({ level });
      expect(result.outcomes).toEqual(["bypass", "bypass"]);
      expect(result.calls).toBe(2);
      expect(result.writes).toEqual([]);
      expect(result.bytes).toBe(0);
    },
  );
  it.each([
    [10, 10],
    [600, 60],
    [undefined, 60],
  ])(
    "memory with source TTL %s stores for min(route, source) = %s s",
    async (ttl, expected) => {
      const result = await routeContract({ level: "memory", ttl });
      expect(result.outcomes).toEqual(["miss", "hit"]);
      expect(result.calls).toBe(1);
      expect(result.writes.map((w) => w.ttl)).toEqual([expected]);
    },
  );
  it.each([{ level: "stored" as const }, null])(
    "%o keeps today's behaviour: the route TTL, miss then hit",
    async (restriction) => {
      const result = await routeContract(restriction);
      expect(result.outcomes).toEqual(["miss", "hit"]);
      expect(result.calls).toBe(1);
      expect(result.writes.map((w) => w.ttl)).toEqual([60]);
    },
  );
  it("takes the strictest level when one response mixes sources", async () => {
    const h = routeHarness(null);
    const app = new Hono();
    app.use("*", h.cache.middleware);
    app.get("/v1/plans", (c) => {
      restrictCacheLevel("stored");
      restrictCacheLevel("memory", 5);
      restrictCacheLevel("none");
      restrictCacheLevel("stored");
      return c.json({ synthetic: true });
    });
    const response = await get(app);
    expect(response.headers.get("X-Cache")).toBe("bypass");
    expect(h.writes).toEqual([]);
  });
  it("keeps requests apart: a none request does not restrict a concurrent one", async () => {
    const recorded = recordingStore();
    const cache = createResponseCache(fakeDb, undefined, {
      store: recorded.store,
    });
    const app = new Hono();
    app.use("*", cache.middleware);
    app.get("/v1/plans", async (c) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (c.req.query("level") === "none") restrictCacheLevel("none");
      return c.json({ level: scopeCacheLevel() });
    });
    const [restricted, plain] = await Promise.all([
      app.fetch(new Request("http://127.0.0.1/v1/plans?level=none")),
      app.fetch(new Request("http://127.0.0.1/v1/plans?level=stored")),
    ]);
    expect(await restricted.json()).toEqual({ level: "none" });
    expect(await plain.json()).toEqual({ level: null });
    expect(restricted.headers.get("X-Cache")).toBe("bypass");
    expect(plain.headers.get("X-Cache")).toBe("miss");
    expect(recorded.writes).toHaveLength(1);
  });
});

function catalogHarness(factory: typeof createResponseCache) {
  const recorded = recordingStore(),
    outcomes: CacheOutcome[] = [];
  const cache = factory(fakeDb, undefined, { store: recorded.store });
  let loads = 0;
  const read = (restriction: Restriction) =>
    cache.catalog(
      {
        namespace: "synthetic-public-dto",
        version: "synthetic-app-v1",
        generation: "synthetic-generation-1",
        query: { county: "48201", year: 2026 },
        authorized: () => true,
        accept: (value): value is Record<string, unknown> =>
          value !== null && typeof value === "object",
        ttlSeconds: 60,
        outcome: (outcome) => outcomes.push(outcome),
      },
      async () => {
        loads++;
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (restriction) restrictCacheLevel(restriction.level, restriction.ttl);
        return { public_label: "Synthetic public DTO" };
      },
    );
  return { read, outcomes, loads: () => loads, ...recorded };
}
async function catalogContract(
  restriction: Restriction,
  factory: typeof createResponseCache = createResponseCache,
) {
  const h = catalogHarness(factory);
  await h.read(restriction);
  await h.read(restriction);
  return {
    outcomes: h.outcomes,
    loads: h.loads(),
    ttls: h.writes.map((w) => w.ttl),
    bytes: h.bytes(),
  };
}

describe("catalog() runs load() inside the scope and applies the same rule", () => {
  it.each(["none", "request"] as const)(
    "%s: never stores and loads every time",
    async (level) => {
      expect(await catalogContract({ level })).toEqual({
        outcomes: ["bypass", "bypass"],
        loads: 2,
        ttls: [],
        bytes: 0,
      });
    },
  );
  it.each([
    [10, 10],
    [600, 60],
  ])("memory with source TTL %s stores for %s s", async (ttl, expected) => {
    expect(await catalogContract({ level: "memory", ttl })).toMatchObject({
      outcomes: ["miss", "hit"],
      loads: 1,
      ttls: [expected],
    });
  });
  it.each([{ level: "stored" as const }, null])(
    "%o keeps today's TTL",
    async (restriction) => {
      expect(await catalogContract(restriction)).toMatchObject({
        outcomes: ["miss", "hit"],
        loads: 1,
        ttls: [60],
      });
    },
  );
  it("passes the level from load() up to the enclosing request scope", async () => {
    const h = catalogHarness(createResponseCache);
    const level = await runWithScope(async (scope) => {
      await h.read({ level: "request" });
      return [scopeCacheLevel(), scope.level()];
    });
    expect(level).toEqual(["request", "request"]);
  });
  it("never stores inside a request that is already at none", async () => {
    const h = catalogHarness(createResponseCache);
    await runWithScope(async () => {
      restrictCacheLevel("none");
      await h.read(null);
    });
    expect(h.writes).toEqual([]);
    expect(h.outcomes).toEqual(["bypass"]);
  });
});

// Planted mutants. Each copy of src/api/cache/index.ts drops one guard; the contract that passes
// for the real module must fail for the copy.
const mutants = [
  {
    kind: "middleware-ignores-level",
    before: "const ttl = scopeStoreTtl(seconds);",
    after: "const ttl = seconds;",
    contract: async (factory: typeof createResponseCache) => {
      const result = await routeContract({ level: "none" }, factory);
      expect(result.writes).toEqual([]);
      expect(result.outcomes).toEqual(["bypass", "bypass"]);
    },
  },
  {
    kind: "middleware-without-scope",
    before: "runWithScope(() => respond(c, next))",
    after: "respond(c, next)",
    contract: async (factory: typeof createResponseCache) => {
      const result = await routeContract({ level: "none" }, factory);
      expect(result.writes).toEqual([]);
    },
  },
  {
    kind: "catalog-stores-before-checking",
    before:
      "if (ttl === null || Buffer.byteLength(serialized) > MAX_ENTRY_BYTES) {",
    after:
      "await store.set(key, serialized, request.ttlSeconds); if (ttl === null || Buffer.byteLength(serialized) > MAX_ENTRY_BYTES) {",
    contract: async (factory: typeof createResponseCache) => {
      const result = await catalogContract({ level: "none" }, factory);
      expect(result.ttls).toEqual([]);
      expect(result.bytes).toBe(0);
    },
  },
  {
    kind: "catalog-load-outside-scope",
    before: "[value, scopeStoreTtl(request.ttlSeconds)] as const",
    after: "[value, request.ttlSeconds] as const",
    contract: async (factory: typeof createResponseCache) => {
      const result = await catalogContract({ level: "none" }, factory);
      expect(result.ttls).toEqual([]);
    },
  },
] as const;

describe("planted mutants", () => {
  it.each(mutants)(
    "negative control: $kind lets a none answer into the cache and is caught",
    async ({ kind, before, after, contract }) => {
      const source = new URL(
        "../../../src/api/cache/index.ts",
        import.meta.url,
      );
      const temporary = new URL(
        `../../../src/api/cache/.scope-mutant-${kind}.ts`,
        import.meta.url,
      );
      const original = await readFile(source, "utf8");
      await writeFile(temporary, replaceSyntax(original, before, after));
      try {
        const mutant = (await import(/* @vite-ignore */ temporary.href)) as {
          createResponseCache: typeof createResponseCache;
        };
        await expect(contract(createResponseCache)).resolves.toBeUndefined();
        await expect(contract(mutant.createResponseCache)).rejects.toThrow();
      } finally {
        await rm(temporary, { force: true });
      }
    },
  );
});
