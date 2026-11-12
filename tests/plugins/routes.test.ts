import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import type { Context } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/app.js";
import { createResponseCache, ttlTable } from "../../src/api/cache/index.js";
import { MemoryCache } from "../../src/api/cache/store.js";
import { loadConfig } from "../../src/config/index.js";
import type { SqlSession } from "../../src/db/database.js";
import { loadPlugins } from "../../src/plugins/index.js";
import type { PluginRegistries } from "../../src/plugins/index.js";
import {
  emptyRegistries,
  emptySeen,
  PluginRefusal,
  STATUS_PLUGIN,
  stagingRegistrar,
} from "../../src/plugins/registries.js";
import * as routesModule from "../../src/plugins/routes.js";
import { plantMutant } from "../../src/plugins/testing/index.js";

const fixtures = fileURLToPath(
  new URL("../fixtures/plugins/", import.meta.url),
);
const shipped = fileURLToPath(
  new URL("../../data/access/federal-publishers.json", import.meta.url),
);
const OPERATOR = "synthetic-operator-token";
const routesFile = new URL("../../src/plugins/routes.ts", import.meta.url);

// Synthetic database: every query answers one fixed row, which doubles as the cache generation.
const queries: string[] = [];
const fakeDb = {
  query: async (sql: string) => {
    queries.push(sql);
    return { rows: [{ generation: "synthetic-generation" }] };
  },
  exec: async () => {},
} as unknown as SqlSession;

class Exit extends Error {}
async function load(name: string) {
  const lines: string[] = [];
  let exit: number | undefined;
  const loaded = await loadPlugins(
    loadConfig(
      {},
      { version: 1, plugins: [{ package: `./synthetic-${name}/index.mjs` }] },
    ),
    "api",
    {
      env: {},
      baseDirectory: fixtures,
      manifestPaths: [shipped],
      writeLog: (line) => lines.push(line),
      exit: (code) => {
        exit = code;
        throw new Exit();
      },
    },
  ).catch((error: unknown) => {
    if (error instanceof Exit) return undefined;
    throw error;
  });
  return { loaded, lines, exit };
}

const registries = async () => (await load("routes")).loaded!.registries;
const config = (operator?: string) =>
  loadConfig(operator ? { OPENPLANS_OPERATOR_TOKEN: operator } : {});

async function app(operator?: string) {
  return createApp(
    fakeDb,
    { premiumToken: undefined, trustedProxies: [] },
    {
      store: new MemoryCache(1024 * 1024),
      config: config(operator),
      plugins: await registries(),
    },
  );
}

/** The same order as createApp: guards, cache, core routes, plugin handlers. */
function harness(
  module: typeof routesModule,
  plugins: Pick<PluginRegistries, "routes">,
  writeLog?: (line: string) => void,
) {
  const app = new Hono();
  const cache = createResponseCache(fakeDb, undefined, {
    store: new MemoryCache(1024 * 1024),
    config: config(),
    plugins,
  });
  const routes = module.pluginRoutes(plugins, {
    db: fakeDb,
    operatorToken: () => undefined,
    trustedProxies: [],
    writeLog,
  });
  routes.guard(app);
  app.use("*", cache.middleware);
  routes.mount(app);
  return app;
}

async function rateLimited(
  request: (path: string) => Response | Promise<Response>,
) {
  const statuses: number[] = [];
  let retryAfter: string | null = null;
  for (let i = 0; i < 4; i++) {
    const response = await request("/synthetic/public");
    statuses.push(response.status);
    if (response.status === 429)
      retryAfter = response.headers.get("retry-after");
  }
  return { statuses, retryAfter };
}

async function leakRejected(
  request: (path: string) => Response | Promise<Response>,
) {
  const response = await request("/synthetic/leak");
  return response.status === 500;
}

const calls = () =>
  ((
    globalThis as { syntheticRouteCalls?: Record<string, number> }
  ).syntheticRouteCalls ??= {});
beforeEach(() => {
  for (const key of Object.keys(calls())) delete calls()[key];
  queries.length = 0;
});
afterEach(() => vi.restoreAllMocks());

describe("plugin route wrapper", () => {
  it("rate-limits a public route at its declared limit, cache hits included", async () => {
    const api = await app();
    const { statuses, retryAfter } = await rateLimited((path) =>
      api.request(path),
    );
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect(Number(retryAfter)).toBeGreaterThan(0);
    const limited = await api.request("/synthetic/public");
    expect(limited.headers.get("cache-control")).toBe("no-store");
  });

  it("uses the default limits when a route declares none", async () => {
    expect(routesModule.DEFAULT_ROUTE_LIMITS).toEqual({
      perMinute: 60,
      activePerSource: 2,
      activeTotal: 8,
    });
    const api = await app();
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++)
      statuses.push((await api.request("/synthetic/page")).status);
    expect(statuses.slice(0, 60).every((status) => status === 200)).toBe(true);
    expect(statuses[60]).toBe(429);
  });

  it("hides operator routes without a configured token", async () => {
    const api = await app();
    expect((await api.request("/synthetic/operator")).status).toBe(404);
    const withHeader = await api.request("/synthetic/operator", {
      headers: { Authorization: `Bearer ${OPERATOR}` },
    });
    expect(withHeader.status).toBe(404);
    expect(calls()["/synthetic/operator"]).toBeUndefined();
  });

  it("answers 401 to a wrong token and 200 to the right one, never cached", async () => {
    const api = await app(OPERATOR);
    const wrong = await api.request("/synthetic/operator", {
      headers: { Authorization: "Bearer synthetic-wrong-token" },
    });
    expect(wrong.status).toBe(401);
    expect((await api.request("/synthetic/operator")).status).toBe(401);
    for (const expected of [1, 2]) {
      const right = await api.request("/synthetic/operator", {
        headers: { Authorization: `Bearer ${OPERATOR}` },
      });
      expect(right.status).toBe(200);
      expect(right.headers.get("x-cache")).toBe("bypass");
      expect(await right.json()).toEqual({ synthetic: true, calls: expected });
    }
  });

  it("caches a public route that declares cache: miss, then hit", async () => {
    const api = await app();
    const first = await api.request("/synthetic/public");
    expect(first.headers.get("x-cache")).toBe("miss");
    const second = await api.request("/synthetic/public");
    expect(second.headers.get("x-cache")).toBe("hit");
    expect(await second.json()).toEqual({ synthetic: true, calls: 1 });
    expect(calls()["/synthetic/public"]).toBe(1);
  });

  it("rejects a response carrying row provenance and logs the path only", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const api = await app();
    const response = await api.request("/synthetic/leak");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "plugin_response_rejected",
    });
    expect(response.headers.get("x-cache")).toBe("bypass");
    expect(log.mock.calls).toEqual([
      [
        JSON.stringify({
          event: "plugin_response_rejected",
          path: "/synthetic/leak",
        }),
      ],
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toContain(
      "synthetic-leak-value",
    );
  });

  it("rejects a response whose keys look like credentials", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const api = await app();
    const response = await api.request("/synthetic/secret");
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("synthetic-key-value");
    expect(JSON.stringify(log.mock.calls)).not.toContain("synthetic-key-value");
  });

  it("adds the HTML headers to HTML routes", async () => {
    const response = await (await app()).request("/synthetic/page");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<p>synthetic</p>");
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("gives handlers a bounded database and ends them at the deadline", async () => {
    const response = await (await app()).request("/synthetic/db");
    expect(response.status).toBe(200);
    expect(queries).toContain("SELECT 1 AS one");
    const api = new Hono();
    const routes = routesModule.pluginRoutes(await registries(), {
      db: fakeDb,
      operatorToken: () => undefined,
      trustedProxies: [],
      deadlineMs: 20,
    });
    routes.guard(api);
    routes.mount(api);
    const slow = await api.request("/synthetic/slow");
    expect(slow.status).toBe(503);
    expect(await slow.json()).toEqual({ error: "plugin_deadline_exceeded" });
  });

  it("refuses a route on a core path at load", async () => {
    const result = await load("core-route");
    expect(result.exit).toBe(1);
    expect(result.lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      { plugin: "@synthetic/core-route", code: "plugin_route_collision" },
    ]);
  });

  it("refuses core paths in hand-built registries too", () => {
    for (const path of ["/v1/plans", "/healthz", "/mcp", "/compat/v1/drugs"])
      expect(() =>
        routesModule.pluginRoutes(
          {
            routes: [
              {
                plugin: "@synthetic/hand-built",
                spec: {
                  method: "GET",
                  path: path as `/${string}`,
                  exposure: "public",
                  contentType: "application/json",
                  handler: (c) => c.json({}),
                },
              },
            ],
          },
          { db: fakeDb, operatorToken: () => undefined, trustedProxies: [] },
        ),
      ).toThrow(/reserved path/);
  });
});

describe("TTL table", () => {
  it("keeps the core entries and adds public plugin routes that declare cache", async () => {
    const core = ttlTable();
    expect([...core]).toEqual([
      ["GET /v1/plans", 60],
      ["GET /v1/providers", 60],
      ["GET /v1/drugs", 60],
      ["GET /compat/v1/drugs", 60],
      ["GET /v1/zip-counties", 300],
      ["GET /compat/v1/zip_counties", 300],
      ["GET /v1/benchmark", 30],
      ["POST /v1/quotes", 30],
      ["POST /v1/premium-quotes", 30],
      ["POST /compat/v1/plans/medical/search", 30],
      ["POST /compat/v1/plans/dental/search", 30],
      ["POST /compat/v1/providers/search", 60],
    ]);
    const table = ttlTable((await registries()).routes);
    expect([...table].slice(core.size)).toEqual([
      ["GET /synthetic/public", 60],
    ]);
  });
});

describe("core responses with plugins loaded", () => {
  it("are unchanged", async () => {
    const plain = createApp(
      fakeDb,
      { premiumToken: undefined, trustedProxies: [] },
      { store: new MemoryCache(1024 * 1024), config: config(OPERATOR) },
    );
    const loaded = await app(OPERATOR);
    for (const path of ["/healthz", "/v1/cache-stats", "/synthetic/none"]) {
      const [a, b] = await Promise.all([
        plain.request(path),
        loaded.request(path),
      ]);
      expect(b.status).toBe(a.status);
      expect([...b.headers]).toEqual([...a.headers]);
      expect(await b.text()).toBe(await a.text());
    }
  });
});

describe("planted mutants", () => {
  it("the real wrapper passes both checks in the harness", async () => {
    const plugins = await registries();
    const api = harness(routesModule, plugins, () => {});
    expect((await rateLimited((path) => api.request(path))).statuses).toEqual([
      200, 200, 200, 429,
    ]);
    expect(await leakRejected((path) => api.request(path))).toBe(true);
  });

  it("is caught when the wrapper skips sourceAdmission", async () => {
    const mutant = await plantMutant(
      routesFile,
      "exposure(spec), sourceAdmission(",
      "exposure(spec), ((_options: unknown): MiddlewareHandler => (_c, next) => next())(",
    );
    try {
      const module = (await import(mutant.path)) as typeof routesModule;
      const api = harness(module, await registries(), () => {});
      expect(
        (await rateLimited((path) => api.request(path))).statuses,
      ).not.toContain(429);
    } finally {
      await mutant.cleanup();
    }
  });

  it("is caught when the response-column guard is disabled", async () => {
    const mutant = await plantMutant(
      routesFile,
      "rowProvenanceLeaks(body, spec.path).length > 0 ||",
      "false ||",
    );
    try {
      const module = (await import(mutant.path)) as typeof routesModule;
      const api = harness(module, await registries(), () => {});
      expect(await leakRejected((path) => api.request(path))).toBe(false);
    } finally {
      await mutant.cleanup();
    }
  });
});

describe("reserved status paths and body caps", () => {
  const route = (
    plugin: string,
    path: string,
    handler: (c: Context) => Response | Promise<Response> = (c) => c.json({}),
    method: "GET" | "POST" = "GET",
  ) => ({
    plugin,
    spec: {
      method,
      path: path as `/${string}`,
      exposure: "public" as const,
      contentType: "application/json" as const,
      handler,
    },
  });
  const statusPaths = ["/status", "/status.json", "/status/operator.json"];

  it("refuses /status* at load for any plugin but the status plugin", () => {
    const register = (name: string, path: string) => {
      const registrar = stagingRegistrar(
        emptyRegistries(),
        {
          name,
          version: "0.0.1",
          apiVersion: "0.1",
          kinds: ["routes"],
        },
        "api",
        emptySeen(),
      );
      try {
        registrar.context.routes.add(route(name, path).spec);
        return "ok";
      } catch (error) {
        return error instanceof PluginRefusal ? error.code : "thrown";
      }
    };
    for (const path of statusPaths) {
      expect(register("@synthetic/status-squatter", path)).toBe(
        "plugin_route_collision",
      );
      expect(register(STATUS_PLUGIN, path)).toBe("ok");
    }
    expect(register("@synthetic/status-squatter", "/state")).toBe("ok");
  });

  it("refuses /status* in hand-built registries unless the status plugin owns it", () => {
    const options = {
      db: fakeDb,
      operatorToken: () => undefined,
      trustedProxies: [],
    };
    for (const path of statusPaths) {
      expect(() =>
        routesModule.pluginRoutes(
          { routes: [route("@synthetic/hand-built", path)] },
          options,
        ),
      ).toThrow(/reserved path/);
      expect(() =>
        routesModule.pluginRoutes(
          { routes: [route(STATUS_PLUGIN, path)] },
          options,
        ),
      ).not.toThrow();
    }
  });

  it("refuses a request body over the cap; a declared length stops it before the handler", async () => {
    let seen = 0;
    let read = 0;
    const app = harness(routesModule, {
      routes: [
        route(
          "@synthetic/hand-built",
          "/synthetic/echo",
          async (c) => {
            seen += 1;
            const bytes = (await c.req.text()).length;
            read += 1;
            return c.json({ bytes });
          },
          "POST",
        ),
      ],
    });
    const post = (bytes: number, declared: boolean) =>
      app.request("/synthetic/echo", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(declared ? { "content-length": String(bytes) } : {}),
        },
        body: "x".repeat(bytes),
      });
    const small = await post(1024, true);
    expect(small.status).toBe(200);
    expect(await small.json()).toEqual({ bytes: 1024 });
    const tooLarge = { error: { code: "REQUEST_TOO_LARGE", field: "body" } };
    const declared = await post(
      routesModule.PLUGIN_REQUEST_MAX_BYTES + 1,
      true,
    );
    expect(declared.status).toBe(400);
    expect(declared.headers.get("cache-control")).toBe("no-store");
    expect(await declared.json()).toEqual(tooLarge);
    expect(seen).toBe(1);
    // Without a length the handler starts, but its read stops at the cap.
    const streamed = await post(
      routesModule.PLUGIN_REQUEST_MAX_BYTES + 1,
      false,
    );
    expect(streamed.status).toBe(400);
    expect(await streamed.json()).toEqual(tooLarge);
    expect(read).toBe(1);
  });

  it("rejects a JSON response over the cap without parsing it", async () => {
    const lines: string[] = [];
    const sized = (bytes: number) => (c: Context) =>
      c.json({ pad: "x".repeat(bytes - 10) });
    const app = harness(
      routesModule,
      {
        routes: [
          route(
            "@synthetic/hand-built",
            "/synthetic/fits",
            sized(routesModule.PLUGIN_RESPONSE_MAX_BYTES),
          ),
          route(
            "@synthetic/hand-built",
            "/synthetic/large",
            sized(routesModule.PLUGIN_RESPONSE_MAX_BYTES + 1),
          ),
        ],
      },
      (line) => lines.push(line),
    );
    const fits = await app.request("/synthetic/fits");
    expect(fits.status).toBe(200);
    expect((await fits.text()).length).toBe(
      routesModule.PLUGIN_RESPONSE_MAX_BYTES,
    );
    const parse = vi.spyOn(JSON, "parse");
    const large = await app.request("/synthetic/large");
    expect(large.status).toBe(500);
    expect(await large.json()).toEqual({ error: "plugin_response_rejected" });
    // Only the client's read of the error body parsed anything.
    expect(parse).toHaveBeenCalledTimes(1);
    expect(lines).toEqual([
      JSON.stringify({
        event: "plugin_response_rejected",
        path: "/synthetic/large",
      }),
    ]);
  });
});
