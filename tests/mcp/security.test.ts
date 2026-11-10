import { describe, expect, it, vi } from "vitest";
import { setImmediate } from "node:timers/promises";
import { createMcpHttp } from "../../src/mcp/http.js";
import { boundedDatabase, dependencies } from "../../src/mcp/policy.js";
import type { SqlSession } from "../../src/db/database.js";
import { cursorCodec } from "../../src/mcp/cursor.js";
import { listedToolNames, metadata, post } from "./transport-helpers.js";
import { expectCorsHeaders } from "./cors-helpers.js";

const quiet = () => {};
const unused: SqlSession = {
  query: async () => {
    throw new Error("Unexpected SQL");
  },
  exec: async () => {},
};
const setup = (env: Record<string, string> = {}) =>
  createMcpHttp(unused, { env, log: quiet });
async function status(app: ReturnType<typeof setup>, request: Request) {
  const response = await app.fetch(request);
  await response.text();
  return response.status;
}

describe("MCP boundary security", () => {
  it("rejects hostile Host without Origin and exact Origin mismatches", async () => {
    const app = setup({
      OPENPLANS_MCP_ALLOWED_HOSTS: "127.0.0.1,public.example",
      OPENPLANS_MCP_ALLOWED_ORIGINS: "https://public.example",
    });
    for (const origin of [
      "null",
      "https://public.example.evil",
      "http://public.example",
      "https://public.example:444",
    ]) {
      expect(await status(app, post("server/discover", {}, { origin }))).toBe(
        403,
      );
    }
    expect(
      await status(
        app,
        post("server/discover", {}, { host: "public.example.evil" }),
      ),
    ).toBe(403);
    expect(
      await status(
        app,
        post("server/discover", {}, { host: "public.example:444" }),
      ),
    ).toBe(403);
    expect(
      await status(
        app,
        post("server/discover", {}, { origin: "https://public.example" }),
      ),
    ).toBe(200);
    expect(await status(app, post("server/discover"))).toBe(200);
  });
  it("allows CORS preflight only for the configured origin", async () => {
    const response = await setup().fetch(
      new Request("http://127.0.0.1/mcp", {
        method: "OPTIONS",
        headers: { origin: "http://localhost:3000" },
      }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:3000",
    );
    expect(response.headers.get("access-control-allow-methods")).toBe("POST");
  });
  it.each(["GET", "DELETE"])("%s returns 405", async (method) => {
    expect(
      await status(setup(), new Request("http://127.0.0.1/mcp", { method })),
    ).toBe(405);
  });
  it("off removes the route and leaves other routes to their host", async () => {
    expect(await status(setup({ OPENPLANS_MCP: "off" }), post())).toBe(404);
  });
  it.each(["mcp-protocol-version", "mcp-method", "mcp-name"])(
    "missing or mismatched %s fails with HeaderMismatch",
    async (header) => {
      for (const name of ["get_data_status", "quote_premiums"])
        for (const missing of [true, false]) {
          const request = post("tools/call", { name, arguments: {} });
          if (missing) request.headers.delete(header);
          else
            request.headers.set(
              header,
              header === "mcp-protocol-version" ? "2025-11-25" : "wrong",
            );
          const response = await setup().fetch(request);
          expect(response.status).toBe(400);
          expect((await response.json()).error.code).toBe(-32020);
        }
    },
  );
  it("unsupported revision returns supported protocol versions", async () => {
    const request = post();
    const body = JSON.parse(await request.text());
    body.params._meta["io.modelcontextprotocol/protocolVersion"] = "2099-01-01";
    const headers = new Headers(request.headers);
    headers.set("mcp-protocol-version", "2099-01-01");
    const response = await setup().fetch(
      new Request(request.url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
    );
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain("2026-07-28");
  });
  it("bounds actual bytes without relying on Content-Length", async () => {
    const request = post("server/discover", { padding: "x".repeat(64 * 1024) });
    expect(request.headers.has("content-length")).toBe(false);
    expect(await status(setup(), request)).toBe(413);
    const smaller = post("server/discover", { padding: "x".repeat(63 * 1024) });
    expect(await status(setup(), smaller)).toBe(200);
  });
  it.each([
    undefined,
    "Bearer wrong",
    "Bearer rest-only",
    "Bearer compat-only",
  ])(
    "household quotes require the dedicated token: %s",
    async (authorization) => {
      for (const name of ["quote_premiums"]) {
        const request = post(
          "tools/call",
          { name, arguments: {} },
          authorization ? { authorization } : {},
        );
        const response = await setup({
          OPENPLANS_MCP_TOKEN: "synthetic-mcp-token",
        }).fetch(request);
        expect(response.status, name).toBe(401);
        expect(response.headers.get("www-authenticate")).toContain("Bearer");
      }
    },
  );
  it("valid MCP token exposes household quotes; with no token they are open unless switched off", async () => {
    const app = setup({ OPENPLANS_MCP_TOKEN: "synthetic-mcp-token" });
    const listed = await listedToolNames(app, {
      authorization: "Bearer synthetic-mcp-token",
    });
    for (const name of [
      "quote_premiums",
      "quote_plans",
      "check_ichra_affordability",
    ])
      expect(listed).toContain(name);
    expect(listed).not.toContain("estimate_premiums");
    expect(
      await status(
        setup({ OPENPLANS_PUBLIC_HOUSEHOLD: "off" }),
        post(
          "tools/call",
          { name: "quote_premiums", arguments: {} },
          { authorization: "Bearer synthetic-mcp-token" },
        ),
      ),
    ).toBe(401);
    expect(
      await status(
        setup(),
        post("tools/call", { name: "quote_premiums", arguments: {} }),
      ),
    ).toBe(200);
  });
  it.each([false, true])(
    "limits requests per source (authenticated=%s)",
    async (auth) => {
      const app = setup({ OPENPLANS_MCP_TOKEN: "synthetic-token" });
      for (let i = 0; i < (auth ? 120 : 60); i++)
        expect(
          await status(
            app,
            post(
              "server/discover",
              {},
              auth ? { authorization: "Bearer synthetic-token" } : {},
            ),
          ),
        ).toBe(200);
      const response = await app.fetch(
        post(
          "server/discover",
          {},
          auth ? { authorization: "Bearer synthetic-token" } : {},
        ),
      );
      expect(response.status).toBe(429);
      expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    },
  );
  it("ignores spoofed forwarding from untrusted peers; trusted peer uses last hop", async () => {
    for (const trusted of [false, true]) {
      const app = createMcpHttp(unused, {
        env: { OPENPLANS_TRUST_PROXY: trusted ? "127.0.0.2" : "" },
        peerAddress: () => "127.0.0.2",
        log: quiet,
      });
      for (let i = 0; i < 61; i++) {
        expect(
          await status(
            app,
            post(
              "server/discover",
              {},
              { "x-forwarded-for": `198.51.100.${i}, 192.0.2.1` },
            ),
          ),
        ).toBe(i < 60 ? 200 : 429);
      }
      expect(
        await status(
          app,
          post("server/discover", {}, { "x-forwarded-for": "192.0.2.2" }),
        ),
      ).toBe(trusted ? 200 : 429);
    }
  });
  it("rate windows expire and logs never include arbitrary names, args, credentials or addresses", async () => {
    const logs: unknown[] = [];
    let time = 0;
    const app = createMcpHttp(unused, {
      env: {},
      now: () => time,
      peerAddress: () => "192.0.2.7",
      log: (entry) => logs.push(entry),
    });
    for (let i = 0; i < 61; i++) await status(app, post());
    time = 60_001;
    expect(await status(app, post())).toBe(200);
    await status(
      app,
      post(
        "tools/call",
        {
          name: "synthetic-secret-name",
          arguments: { income: "synthetic-private-value" },
        },
        { authorization: "Bearer synthetic-secret-token" },
      ),
    );
    expect(JSON.stringify(logs)).not.toMatch(
      /synthetic-secret|synthetic-private|192\.0\.2/,
    );
    expect(Object.keys(logs[0] as object).sort()).toEqual([
      "bytes",
      "cache",
      "status",
      "timing_ms",
      "tool",
    ]);
  });
  it("shares env cursor secrets across factories and isolates principals", () => {
    const binding = {
      tool: "search",
      filters: {},
      generation: "synthetic",
      scope: "anonymous",
    };
    const a = dependencies(
      unused,
      { OPENPLANS_MCP_CURSOR_SECRET: "synthetic-key" },
      false,
    );
    const b = dependencies(
      unused,
      { OPENPLANS_MCP_CURSOR_SECRET: "synthetic-key" },
      false,
    );
    const token = cursorCodec(a.cursorSecret).issue(binding, 2);
    expect(cursorCodec(b.cursorSecret).read(token, binding)).toBe(2);
    expect(() =>
      cursorCodec(b.cursorSecret).read(token, {
        ...binding,
        scope: "personalized",
      }),
    ).toThrow("INVALID_CURSOR");
  });
});

function pendingDatabase() {
  let started = 0,
    cancelled = 0;
  const db: SqlSession = {
    ...unused,
    async withRequest(signal, run) {
      return run({
        ...unused,
        query: async () => {
          started++;
          await new Promise((_, reject) => {
            const cancel = () => {
              cancelled++;
              reject(new Error("synthetic query cancelled"));
            };
            if (signal.aborted) cancel();
            else signal.addEventListener("abort", cancel, { once: true });
          });
          return { rows: [] };
        },
      });
    },
  };
  return { db, started: () => started, cancelled: () => cancelled };
}
it("disconnect stops SQL and releases concurrency; a fifth heavy call receives 429", async () => {
  const pending = pendingDatabase();
  const app = createMcpHttp(pending.db, { env: {}, log: quiet });
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const requests = controllers.map((controller) =>
    app.fetch(
      new Request(
        post("tools/call", { name: "get_data_status", arguments: {} }),
        { signal: controller.signal },
      ),
    ),
  );
  while (pending.started() < 4) await setImmediate();
  expect(
    await status(
      app,
      post("tools/call", { name: "get_data_status", arguments: {} }),
    ),
  ).toBe(429);
  controllers.forEach((controller) => controller.abort());
  await Promise.all(requests);
  expect(pending.cancelled()).toBe(4);
  expect(await status(app, post())).toBe(200);
});
it("closing a request-scoped SSE stream cancels its SQL", async () => {
  const pending = pendingDatabase(),
    app = createMcpHttp(pending.db, { env: {}, log: quiet });
  const request = post(
    "tools/call",
    { name: "get_data_status", arguments: {} },
    { origin: "http://localhost:3000" },
  );
  const body = JSON.parse(await request.text());
  body.params._meta = { ...metadata, progressToken: "synthetic-progress" };
  const response = await app.fetch(
    new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(body),
    }),
  );
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expectCorsHeaders(response, "http://localhost:3000");
  expect(response.headers.get("x-accel-buffering")).toBe("no");
  while (!pending.started()) await setImmediate();
  await response.body!.cancel();
  expect(pending.cancelled()).toBe(1);
});
it("15-second overall deadline cancels SQL and forbids subsequent queries", async () => {
  vi.useFakeTimers();
  try {
    const pending = pendingDatabase(),
      app = createMcpHttp(pending.db, { env: {}, log: quiet });
    const response = app.fetch(
      post(
        "tools/call",
        { name: "get_data_status", arguments: {} },
        { origin: "http://localhost:3000" },
      ),
    );
    while (!pending.started()) await setImmediate();
    await vi.advanceTimersByTimeAsync(15_001);
    const timedOut = await response;
    expect(timedOut.status).toBe(504);
    expectCorsHeaders(timedOut, "http://localhost:3000");
    await timedOut.text();
    expect(pending.cancelled()).toBe(1);
    const controller = new AbortController();
    controller.abort();
    await expect(
      boundedDatabase(unused, controller.signal).query("SELECT 1"),
    ).rejects.toThrow();
  } finally {
    vi.useRealTimers();
  }
});

it("refuses subscription streams even though the SDK has a listen router", async () => {
  const response = await setup().fetch(
    post("subscriptions/listen", { notifications: {} }),
  );
  expect(response.headers.get("content-type")).toContain("application/json");
  expect((await response.json()).error.message).toBe(
    "Subscription limit reached",
  );
});
