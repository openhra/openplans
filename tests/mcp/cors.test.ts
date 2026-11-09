import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createMcpHttp } from "../../src/mcp/http.js";
import type { SqlSession } from "../../src/db/database.js";
import { post } from "./transport-helpers.js";
import {
  allowedOrigin,
  corsRequest,
  expectCorsHeaders,
} from "./cors-helpers.js";

const unused: SqlSession = {
  query: async () => {
    throw new Error("Unexpected SQL");
  },
  exec: async () => {},
};
const setup = (env: Record<string, string> = {}) =>
  createMcpHttp(unused, {
    env: {
      OPENPLANS_MCP_ALLOWED_ORIGINS: `${allowedOrigin},https://second.example`,
      ...env,
    },
    log: () => {},
  });

describe("MCP response CORS", () => {
  it.each([allowedOrigin, "https://second.example"])(
    "reflects the exact allowed origin on JSON: %s",
    async (origin) => {
      const response = await setup().fetch(
        post("server/discover", {}, { origin }),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(
        "application/json",
      );
      expectCorsHeaders(response, origin);
      expect((await response.json()).result).toBeDefined();
    },
  );

  it("covers request-scoped SSE including a streamed tool error", async () => {
    const response = await setup().fetch(await corsRequest("SSE"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expectCorsHeaders(response);
    const body = await response.text();
    expect(body).toContain("notifications/progress");
    expect(body).toContain('"isError":true');
  });

  it("covers bodyless notification acknowledgements", async () => {
    const request = post(
      "notifications/initialized",
      {},
      { origin: allowedOrigin },
    );
    const message = JSON.parse(await request.text());
    delete message.id;
    const response = await setup().fetch(
      new Request(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(message),
      }),
    );
    expect(response.status).toBe(202);
    expectCorsHeaders(response);
    expect(await response.text()).toBe("");
  });

  it.each([
    [
      "parse error",
      400,
      () =>
        new Request("http://127.0.0.1/mcp", {
          method: "POST",
          headers: {
            origin: allowedOrigin,
            "content-type": "application/json",
          },
          body: "{",
        }),
    ],
    [
      "SDK metadata error",
      400,
      () =>
        post(
          "server/discover",
          {},
          { origin: allowedOrigin, "mcp-method": "wrong" },
        ),
    ],
    [
      "authentication challenge",
      401,
      () =>
        post(
          "tools/call",
          { name: "quote_premiums", arguments: {} },
          { origin: allowedOrigin },
        ),
    ],
    [
      "Host denial",
      403,
      () =>
        post(
          "server/discover",
          {},
          { origin: allowedOrigin, host: "hostile.example" },
        ),
    ],
    [
      "method denial",
      405,
      () =>
        new Request("http://127.0.0.1/mcp", {
          headers: { origin: allowedOrigin },
        }),
    ],
    [
      "body limit",
      413,
      () =>
        post(
          "server/discover",
          { padding: "x".repeat(64 * 1024) },
          { origin: allowedOrigin },
        ),
    ],
    [
      "media type error",
      415,
      () =>
        post(
          "server/discover",
          {},
          { origin: allowedOrigin, "content-type": "text/plain" },
        ),
    ],
  ] as const)("covers %s", async (_name, status, request) => {
    const response = await setup().fetch(request());
    expect(response.status).toBe(status);
    expectCorsHeaders(response);
    if (status === 401)
      expect(response.headers.get("www-authenticate")).toContain("Bearer");
    expect((await response.json()).error).toBeDefined();
  });

  it("covers rate errors and retains Retry-After", async () => {
    const app = setup();
    for (let i = 0; i < 60; i++)
      await (await app.fetch(await corsRequest("JSON"))).text();
    const response = await app.fetch(await corsRequest("JSON"));
    expect(response.status).toBe(429);
    expectCorsHeaders(response);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    await response.text();
  });

  it("covers internal request failures", async () => {
    const app = createMcpHttp(unused, {
      env: { OPENPLANS_MCP_ALLOWED_ORIGINS: allowedOrigin },
      peerAddress: () => {
        throw new Error("Synthetic adapter failure");
      },
      log: () => {},
    });
    const response = await app.fetch(await corsRequest("JSON"));
    expect(response.status).toBe(500);
    expectCorsHeaders(response);
    expect((await response.json()).error.message).toBe("Request failed");
  });

  it("covers preflight and disabled-route responses", async () => {
    const preflight = await setup().fetch(
      new Request("http://127.0.0.1/mcp", {
        method: "OPTIONS",
        headers: { origin: allowedOrigin },
      }),
    );
    expect(preflight.status).toBe(204);
    expectCorsHeaders(preflight);
    expect(preflight.headers.get("access-control-allow-methods")).toBe("POST");
    const disabled = await setup({ OPENPLANS_MCP: "off" }).fetch(
      await corsRequest("JSON"),
    );
    expect(disabled.status).toBe(404);
    expectCorsHeaders(disabled);
    await disabled.text();
  });

  it("retains other Vary values when mounted in a host app", async () => {
    const app = new Hono();
    app.use("/mcp", async (c, next) => {
      c.res.headers.set("Vary", "Accept-Encoding");
      await next();
    });
    app.route("/", setup());
    const response = await app.fetch(await corsRequest("JSON"));
    expectCorsHeaders(response);
    expect(response.headers.get("vary")).toBe("Accept-Encoding, Origin");
    await response.text();
  });

  it.each([
    undefined,
    "null",
    "https://allowed.example.evil",
    "http://allowed.example",
    "https://allowed.example:444",
  ])(
    "adds no CORS headers for absent or disallowed Origin: %s",
    async (origin) => {
      for (const method of ["POST", "OPTIONS"]) {
        const request =
          method === "POST"
            ? post(
                "server/discover",
                {},
                origin === undefined ? {} : { origin },
              )
            : new Request("http://127.0.0.1/mcp", {
                method,
                headers: origin === undefined ? {} : { origin },
              });
        const response = await setup().fetch(request);
        const allowedStatus = method === "POST" ? 200 : 204;
        const expectedStatus = origin === undefined ? allowedStatus : 403;
        expect(response.status).toBe(expectedStatus);
        expect(response.headers.has("access-control-allow-origin")).toBe(false);
        expect(response.headers.has("access-control-expose-headers")).toBe(
          false,
        );
        expect(response.headers.has("vary")).toBe(false);
        await response.text();
      }
    },
  );
});
