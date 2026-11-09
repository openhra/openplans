import { Hono } from "hono";
import { setImmediate } from "node:timers/promises";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createResponseCache,
  canonical,
} from "../../../src/api/cache/index.js";
import { MemoryCache } from "../../../src/api/cache/store.js";
import type { CacheStore } from "../../../src/api/cache/store.js";
import type { SqlSession } from "../../../src/db/database.js";

// Synthetic catalog values and credential sentinels; no publisher/household evidence.
const fakeDb = {
  query: async () => ({ rows: [{ generation: "synthetic-generation" }] }),
} as unknown as SqlSession;
function harness(
  store: CacheStore = new MemoryCache(1024 * 1024),
  premiumToken = "synthetic-token",
) {
  const cache = createResponseCache(fakeDb, premiumToken, { store });
  const app = new Hono();
  app.use("*", cache.middleware);
  let calls = 0,
    fail = false;
  for (const method of ["get", "post"] as const) {
    for (const route of [
      "/v1/plans",
      "/v1/zip-counties",
      "/v1/premium-quotes",
      "/v1/drugs",
      "/v1/providers",
      "/v1/benchmark",
      "/compat/v1/plans/medical/search",
      "/compat/v1/providers/search",
      "/compat/v1/zip_counties",
    ]) {
      app[method](route, (c) => {
        calls++;
        c.header("Cache-Control", "no-store");
        c.header("x-openplans-gaps", "synthetic_gap");
        c.header("Access-Control-Allow-Origin", "*");
        return fail
          ? c.json({ error: "synthetic_failure" }, 503)
          : c.json({ synthetic: true, calls });
      });
    }
  }
  app.get("/healthz", (c) => c.json(cache.stats()));
  return {
    app,
    cache,
    calls: () => calls,
    fail: (value: boolean) => {
      fail = value;
    },
  };
}
afterEach(() => vi.unstubAllEnvs());

describe("response middleware policy and canonical keys", () => {
  it("keeps response bodies readable after garbage collection on cache misses and bypasses", async () => {
    // Obtain a collector for this test without requiring flags on the test runner.
    let collect: () => void;
    setFlagsFromString("--expose_gc");
    try {
      collect = runInNewContext("gc");
    } finally {
      setFlagsFromString("--no-expose_gc");
    }
    const responses: { response: Response; body: unknown; outcome: string }[] =
      [];
    for (const mode of [
      "miss",
      "credential",
      "oversized",
      "oversized-entry",
      "write-error",
    ]) {
      let body;
      if (mode === "credential") {
        body = { api_key: "synthetic-secret" };
      } else if (mode === "oversized") {
        body = { padding: "x".repeat(2 * 1024 * 1024) };
      } else if (mode === "oversized-entry") {
        body = { padding: "\n".repeat(700_000) };
      } else {
        body = { synthetic: true };
      }
      const store: CacheStore = {
        bytes: () => 0,
        get: async () => null,
        set: async () => {
          if (mode === "write-error")
            throw new Error("synthetic write failure");
        },
      };
      const app = new Hono(),
        cache = createResponseCache(fakeDb, undefined, { store });
      app.use("*", cache.middleware);
      app.get("/v1/plans", (c) => c.json(body));
      responses.push({
        response: await app.request("/v1/plans"),
        body,
        outcome: mode === "miss" ? "miss" : "bypass",
      });
    }
    // Let finalizers run after the middleware's original response leaves scope.
    for (let i = 0; i < 10; i++) {
      collect();
      await setImmediate();
    }
    for (const { response, body, outcome } of responses) {
      expect(response.headers.get("X-Cache")).toBe(outcome);
      expect(response.bodyUsed).toBe(false);
      expect(await response.json()).toEqual(body);
    }
  });

  it("canonicalizes object/query keys but preserves array and repeated query-value order", async () => {
    expect(canonical({ b: 2, a: [2, 1] })).toBe(canonical({ a: [2, 1], b: 2 }));
    expect(canonical([1, 2])).not.toBe(canonical([2, 1]));
    const h = harness();
    expect(
      (await h.app.request("/v1/plans?year=2026&county=48201")).headers.get(
        "X-Cache",
      ),
    ).toBe("miss");
    expect(
      (await h.app.request("/v1/plans?county=48201&year=2026")).headers.get(
        "X-Cache",
      ),
    ).toBe("hit");
    expect(
      (await h.app.request("/v1/plans?a=1&a=2")).headers.get("X-Cache"),
    ).toBe("miss");
    expect(
      (await h.app.request("/v1/plans?a=2&a=1")).headers.get("X-Cache"),
    ).toBe("miss");
    expect(h.calls()).toBe(3);
  });
  it("shares entries across different valid API keys and never stores a credential", async () => {
    const stored: [string, string][] = [],
      memory = new MemoryCache(1024 * 1024);
    const store: CacheStore = {
      get: (key) => memory.get(key),
      bytes: () => memory.bytes(),
      set: async (key, value, ttl) => {
        stored.push([key, value]);
        await memory.set(key, value, ttl);
      },
    };
    const a = "synthetic-secret-key-A",
      b = "synthetic-secret-key-B";
    vi.stubEnv("OPENPLANS_COMPAT_API_KEY", a);
    const first = harness(store),
      request = (key: string, body = '{"b":2,"a":1}') => ({
        method: "POST",
        headers: { "X-Api-Key": key, "Content-Type": "application/json" },
        body,
      });
    expect(
      (
        await first.app.request("/compat/v1/plans/medical/search", request(a))
      ).headers.get("X-Cache"),
    ).toBe("miss");
    vi.stubEnv("OPENPLANS_COMPAT_API_KEY", b);
    const second = harness(store);
    const hit = await second.app.request(
      "/compat/v1/plans/medical/search",
      request(b, '{"a":1,"b":2}'),
    );
    expect(hit.headers.get("X-Cache")).toBe("hit");
    expect(hit.headers.get("cache-control")).toBe("no-store");
    expect(hit.headers.get("x-openplans-gaps")).toBe("synthetic_gap");
    expect(hit.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(second.calls()).toBe(0);
    expect(JSON.stringify(stored)).not.toContain(a);
    expect(JSON.stringify(stored)).not.toContain(b);
    expect(stored).toHaveLength(1);
    expect(stored[0]![0]).toMatch(/^openplans:response:v1:[a-f0-9]{64}$/);
    // Stale/incorrect keys must execute downstream auth, never retrieve the populated entry.
    expect(
      (
        await second.app.request("/compat/v1/plans/medical/search", request(a))
      ).headers.get("X-Cache"),
    ).toBe("bypass");
  });
  it("bypasses credential-bearing bodies, queries, cookies and unexpected auth headers", async () => {
    const h = harness();
    for (const url of [
      "/v1/plans?api_key=synthetic-key",
      "/v1/plans?nested_token=synthetic-key",
    ]) {
      expect((await h.app.request(url)).headers.get("X-Cache")).toBe("bypass");
    }
    for (const headers of [
      { Cookie: "session=synthetic" },
      { Authorization: "Bearer synthetic" },
      { "X-Api-Key": "synthetic" },
    ] as Record<string, string>[]) {
      expect(
        (await h.app.request("/v1/plans", { headers })).headers.get("X-Cache"),
      ).toBe("bypass");
    }
    const request = {
      method: "POST",
      headers: { authorization: "Bearer synthetic-token" },
      body: JSON.stringify({ nested: { api_key: "synthetic" } }),
    };
    expect(
      (await h.app.request("/v1/premium-quotes", request)).headers.get(
        "X-Cache",
      ),
    ).toBe("bypass");
    expect(h.cache.stats().bytes).toBe(0);
  });
  it("never caches errors, health, unsupported methods or oversized request bodies", async () => {
    const h = harness();
    h.fail(true);
    for (let i = 0; i < 2; i++)
      expect((await h.app.request("/v1/plans")).headers.get("X-Cache")).toBe(
        "bypass",
      );
    expect(h.calls()).toBe(2);
    h.fail(false);
    expect((await h.app.request("/v1/plans")).headers.get("X-Cache")).toBe(
      "miss",
    );
    expect((await h.app.request("/healthz")).headers.get("X-Cache")).toBe(
      "bypass",
    );
    expect(
      (await h.app.request("/v1/plans", { method: "POST" })).headers.get(
        "X-Cache",
      ),
    ).toBe("bypass");
    const response = await h.app.request("/v1/premium-quotes", {
      method: "POST",
      headers: { Authorization: "Bearer synthetic-token" },
      body: JSON.stringify({ padding: "x".repeat(65_536) }),
    });
    expect(response.headers.get("X-Cache")).toBe("bypass");
  });
  it("authenticates native personalized requests before hits, retains no-store, and disables both backends", async () => {
    const h = harness();
    const request = {
      method: "POST",
      headers: { Authorization: "Bearer synthetic-token" },
      body: "{}",
    };
    expect(
      (await h.app.request("/v1/premium-quotes", request)).headers.get(
        "X-Cache",
      ),
    ).toBe("miss");
    expect(
      (await h.app.request("/v1/premium-quotes", request)).headers.get(
        "X-Cache",
      ),
    ).toBe("hit");
    expect(
      (
        await h.app.request("/v1/premium-quotes", {
          ...request,
          headers: { Authorization: "Bearer wrong" },
        })
      ).headers.get("X-Cache"),
    ).toBe("bypass");
    vi.stubEnv("OPENPLANS_API_CACHE", "off");
    const off = harness();
    expect((await off.app.request("/v1/plans")).headers.get("X-Cache")).toBe(
      "bypass",
    );
    expect(off.cache.stats().bytes).toBe(0);
  });
  it("cache read/write failures bypass to the application without caching an error", async () => {
    for (const phase of ["get", "set"]) {
      const store: CacheStore = {
        bytes: () => 0,
        get: async () => {
          if (phase === "get") throw Error("down");
          return null;
        },
        set: async () => {
          throw Error("down");
        },
      };
      const h = harness(store);
      const response = await h.app.request("/v1/plans");
      expect(response.status).toBe(200);
      expect(response.headers.get("X-Cache")).toBe("bypass");
      expect(h.calls()).toBe(1);
    }
  });
  it("rejects malformed backend entries and never caches credential-bearing responses or cookies", async () => {
    const store: CacheStore = {
      bytes: () => 0,
      get: async () =>
        '{"body":"stale","headers":[["set-cookie","synthetic"]]}',
      set: async () => {},
    };
    const h = harness(store);
    expect((await h.app.request("/v1/plans")).headers.get("X-Cache")).toBe(
      "bypass",
    );
    for (const response of [
      () => Response.json({ api_key: "synthetic" }),
      () =>
        Response.json(
          { synthetic: true },
          { headers: { "Set-Cookie": "session=synthetic" } },
        ),
    ]) {
      const app = new Hono(),
        cache = createResponseCache(fakeDb, undefined, {
          store: new MemoryCache(1024),
        });
      app.use("*", cache.middleware);
      app.get("/v1/plans", () => response());
      expect((await app.request("/v1/plans")).headers.get("X-Cache")).toBe(
        "bypass",
      );
      expect(cache.stats().bytes).toBe(0);
    }
  });
  it("caches public professional degrees on provider responses while rejecting nested API credentials", async () => {
    for (const body of [
      { providers: [{ credential: "MD", credentials: ["MD"] }] },
      { providers: [{ credentials: { api_key: "synthetic-secret" } }] },
    ]) {
      const app = new Hono(),
        cache = createResponseCache(fakeDb, undefined, {
          store: new MemoryCache(1024),
        });
      app.use("*", cache.middleware);
      app.get("/v1/providers", (c) => c.json(body));
      const expected =
        typeof body.providers[0]!.credentials === "object" &&
        !Array.isArray(body.providers[0]!.credentials)
          ? "bypass"
          : "miss";
      expect((await app.request("/v1/providers")).headers.get("X-Cache")).toBe(
        expected,
      );
      expect((await app.request("/v1/providers")).headers.get("X-Cache")).toBe(
        expected === "miss" ? "hit" : "bypass",
      );
    }
  });
  it("caches public quotes for 30 s by body hash, keeps the quote tier header, and authenticates premium quotes", async () => {
    const memory = new MemoryCache(1024 * 1024),
      ttls: number[] = [];
    const store: CacheStore = {
      get: (key) => memory.get(key),
      bytes: () => memory.bytes(),
      set: async (key, value, ttl) => {
        ttls.push(ttl);
        await memory.set(key, value, ttl);
      },
    };
    const cache = createResponseCache(fakeDb, "synthetic-token", { store });
    const app = new Hono();
    app.use("*", cache.middleware);
    let calls = 0;
    app.post("/v1/quotes", (c) => {
      calls++;
      c.header("Cache-Control", "no-store");
      c.header("X-Quote-Tier", "public");
      return c.json({ quotes: [{ drugs: [{ prior_authorization: null }] }] });
    });
    app.post("/v1/premium-quotes", (c) => {
      calls++;
      c.header("Cache-Control", "no-store");
      return c.json({ synthetic: true });
    });
    const quote = (body: string) =>
      app.request("/v1/quotes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
    expect((await quote('{"a":1,"b":2}')).headers.get("X-Cache")).toBe("miss");
    const hit = await quote('{"b":2,"a":1}');
    expect(hit.headers.get("X-Cache")).toBe("hit");
    expect(hit.headers.get("x-quote-tier")).toBe("public");
    expect(hit.headers.get("cache-control")).toBe("no-store");
    expect(calls).toBe(1);
    expect(ttls).toEqual([30]);
    const personalized = (authorization: string) =>
      app.request("/v1/premium-quotes", {
        method: "POST",
        headers: { authorization },
        body: "{}",
      });
    expect((await personalized("Bearer wrong")).headers.get("X-Cache")).toBe(
      "bypass",
    );
    expect(
      (await personalized("Bearer synthetic-token")).headers.get("X-Cache"),
    ).toBe("miss");
    const cached = await personalized("Bearer synthetic-token");
    expect(cached.headers.get("X-Cache")).toBe("hit");
    expect(cached.headers.get("deprecation")).toBeNull();
    expect(ttls).toEqual([30, 30]);
  });
});
