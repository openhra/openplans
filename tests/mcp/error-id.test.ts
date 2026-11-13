import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpHttp, requestId } from "../../src/mcp/http.js";
import { MEDICARE_ESTIMATE_TOOL } from "../../src/mcp/medicare-estimate.js";
import type { SqlSession } from "../../src/db/database.js";
import { importMutant, withMutantFile } from "../mutant-file.js";
import { replaceSyntax } from "../source-mutation.js";
import { post } from "./transport-helpers.js";

// JSON-RPC 2.0: an error response carries the request's id when it can be read, and null only
// when it cannot (an unread or unparseable body, a batch, a missing or malformed id).

type Factory = typeof createMcpHttp;
/** An id as sent, including malformed ones; undefined leaves it out. */
type Id = unknown;
const unused: SqlSession = {
  query: async () => {
    throw new Error("Unexpected SQL");
  },
  exec: async () => {},
};
const quiet = () => {};

/** The same request as `post`, with any id (a string, a number or none). */
function withId(request: Request, id: unknown, drop: string[] = []) {
  const headers = new Headers(request.headers);
  for (const name of drop) headers.delete(name);
  return (async () => {
    const body = JSON.parse(await request.text());
    if (id === undefined) delete body.id;
    else body.id = id;
    return new Request(request.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: request.signal,
    });
  })();
}
async function errorBody(response: Response) {
  const body = await response.json();
  expect(body.jsonrpc).toBe("2.0");
  expect(body.error).toBeDefined();
  return body as { id: unknown; error: { code: number; message: string } };
}
function pendingDatabase() {
  let started = 0;
  const db: SqlSession = {
    ...unused,
    async withRequest(signal, run) {
      return run({
        ...unused,
        query: async () => {
          started++;
          await new Promise((_, reject) => {
            const cancel = () => reject(new Error("synthetic query cancelled"));
            if (signal.aborted) cancel();
            else signal.addEventListener("abort", cancel, { once: true });
          });
          return { rows: [] };
        },
      });
    },
  };
  return { db, started: () => started };
}
const dataStatus = (id: Id, extra: Record<string, string> = {}) =>
  withId(
    post("tools/call", { name: "get_data_status", arguments: {} }, extra),
    id,
  );

/** Paths that read the request id; each runs against `factory` and returns the error body. */
const echoes: Record<
  string,
  (factory: Factory, id: Id) => Promise<{ status: number; body: unknown }>
> = {
  "missing MCP-Protocol-Version": async (factory, id) => {
    const app = factory(unused, { env: {}, log: quiet });
    const request = await withId(
      post("tools/call", { name: "get_data_status", arguments: {} }),
      id,
      ["mcp-protocol-version"],
    );
    const response = await app.fetch(request);
    return { status: response.status, body: await errorBody(response) };
  },
  "personalized access": async (factory, id) => {
    const app = factory(unused, {
      env: { OPENPLANS_MCP_TOKEN: "synthetic-mcp-token" },
      log: quiet,
    });
    const request = await withId(
      post("tools/call", { name: "quote_premiums", arguments: {} }),
      id,
    );
    const response = await app.fetch(request);
    return { status: response.status, body: await errorBody(response) };
  },
  "estimate access": async (factory, id) => {
    const app = factory(unused, {
      env: { OPENPLANS_MCP_TOKEN: "synthetic-mcp-token" },
      log: quiet,
    });
    const request = await withId(
      post("tools/call", { name: MEDICARE_ESTIMATE_TOOL, arguments: {} }),
      id,
    );
    const response = await app.fetch(request);
    return { status: response.status, body: await errorBody(response) };
  },
  "estimate without a configured token": async (factory, id) => {
    const app = factory(unused, { env: {}, log: quiet });
    const request = await withId(
      post("tools/call", { name: MEDICARE_ESTIMATE_TOOL, arguments: {} }),
      id,
    );
    const response = await app.fetch(request);
    return { status: response.status, body: await errorBody(response) };
  },
  "concurrency limit": async (factory, id) => {
    const pending = pendingDatabase();
    const app = factory(pending.db, { env: {}, log: quiet });
    const controllers = Array.from({ length: 4 }, () => new AbortController());
    const held = controllers.map((controller) =>
      app.fetch(
        new Request(
          post("tools/call", { name: "get_data_status", arguments: {} }),
          { signal: controller.signal },
        ),
      ),
    );
    try {
      while (pending.started() < 4) await setImmediate();
      const response = await app.fetch(await dataStatus(id));
      return { status: response.status, body: await errorBody(response) };
    } finally {
      controllers.forEach((controller) => controller.abort());
      await Promise.all(held);
    }
  },
  deadline: async (factory, id) => {
    vi.useFakeTimers();
    try {
      const pending = pendingDatabase();
      const app = factory(pending.db, { env: {}, log: quiet });
      const response = app.fetch(await dataStatus(id));
      while (!pending.started()) await setImmediate();
      await vi.advanceTimersByTimeAsync(15_001);
      const timedOut = await response;
      return { status: timedOut.status, body: await errorBody(timedOut) };
    } finally {
      vi.useRealTimers();
    }
  },
};
const expectedStatus: Record<string, number> = {
  "missing MCP-Protocol-Version": 400,
  "personalized access": 401,
  "estimate access": 401,
  "estimate without a configured token": 503,
  "concurrency limit": 429,
  deadline: 504,
};

describe("MCP error responses carry the request id", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  const estimate = (name: string) => {
    if (name.startsWith("estimate")) {
      vi.stubEnv("OPENPLANS_MEDICARE_PART_D", "on");
      vi.stubEnv("OPENPLANS_MEDICARE_DRUG_COST", "on");
    }
  };
  for (const name of Object.keys(echoes))
    it.each([7, 0, "synthetic-request-1"])(
      `${name}: echoes id %j`,
      async (id) => {
        estimate(name);
        const { status, body } = await echoes[name]!(createMcpHttp, id);
        expect(status).toBe(expectedStatus[name]);
        expect(body).toMatchObject({ id });
      },
    );
  // The SDK itself refuses a malformed id or a notification on the paths it handles first.
  for (const name of ["missing MCP-Protocol-Version", "concurrency limit"])
    it.each([undefined, { nested: 1 }, [1], true])(
      `${name}: an absent or malformed id %j answers null`,
      async (id) => {
        estimate(name);
        const { status, body } = await echoes[name]!(createMcpHttp, id);
        expect(status).toBe(expectedStatus[name]);
        expect(body).toMatchObject({ id: null });
      },
    );

  it("SDK header and version checks echo the id too", async () => {
    const app = createMcpHttp(unused, { env: {}, log: quiet });
    for (const extra of <Record<string, string>[]>[
      { "mcp-protocol-version": "2025-11-25" },
      { "mcp-protocol-version": "2099-01-01" },
      { "mcp-method": "wrong" },
      { "mcp-name": "wrong" },
    ]) {
      const response = await app.fetch(await dataStatus(9, extra));
      expect(response.status).toBe(400);
      const body = await errorBody(response);
      expect(body.error.code).toBe(-32020);
      expect(body.id).toBe(9);
    }
  });

  it("rejections before the body is read or parsed answer null", async () => {
    const raw = (body: string, headers: Record<string, string> = {}) =>
      new Request("http://127.0.0.1/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
      });
    const cases: [string, () => Promise<Response>, number][] = [
      [
        "parse error",
        async () =>
          createMcpHttp(unused, { env: {}, log: quiet }).fetch(
            raw('{"jsonrpc":"2.0","id":5,"method":'),
          ),
        400,
      ],
      [
        "batch",
        async () =>
          createMcpHttp(unused, { env: {}, log: quiet }).fetch(
            raw(
              JSON.stringify([
                { jsonrpc: "2.0", id: 5, method: "server/discover" },
              ]),
            ),
          ),
        400,
      ],
      [
        "content type",
        async () =>
          createMcpHttp(unused, { env: {}, log: quiet }).fetch(
            raw(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "x" }), {
              "content-type": "text/plain",
            }),
          ),
        415,
      ],
      [
        "size limit",
        async () =>
          createMcpHttp(unused, { env: {}, log: quiet }).fetch(
            post("server/discover", { padding: "x".repeat(64 * 1024) }, {}, 5),
          ),
        413,
      ],
      [
        "rate limit",
        async () => {
          const app = createMcpHttp(unused, { env: {}, log: quiet });
          for (let i = 0; i < 60; i++)
            await (await app.fetch(post("server/discover", {}, {}, i))).text();
          return app.fetch(post("server/discover", {}, {}, 5));
        },
        429,
      ],
      [
        "origin",
        async () =>
          createMcpHttp(unused, { env: {}, log: quiet }).fetch(
            post(
              "server/discover",
              {},
              { origin: "https://attacker.example" },
              5,
            ),
          ),
        403,
      ],
      [
        "host",
        async () =>
          createMcpHttp(unused, { env: {}, log: quiet }).fetch(
            post("server/discover", {}, { host: "attacker.example" }, 5),
          ),
        403,
      ],
    ];
    for (const [name, run, expected] of cases) {
      const response = await run();
      expect(response.status, name).toBe(expected);
      expect((await errorBody(response)).id, name).toBeNull();
    }
  });

  it("requestId reads only string and finite number ids", () => {
    expect(requestId({ id: 3 })).toBe(3);
    expect(requestId({ id: "a" })).toBe("a");
    for (const parsed of [
      null,
      [],
      [{ id: 3 }],
      "text",
      {},
      { id: null },
      { id: {} },
      { id: true },
      { id: Number.NaN },
    ])
      expect(requestId(parsed)).toBeNull();
  });
});

// Planted mutants. Copies of http.ts that always answer null must fail the echo assertions.
const mutants: [string, string, string][] = [
  [
    "failure ignores the id",
    '{ jsonrpc: "2.0", id, error: { code, message } }',
    '{ jsonrpc: "2.0", id: null, error: { code, message } }',
  ],
  ["the id is never read", "id = requestId(parsed);", "id = null;"],
];
describe.each(mutants)("negative control: %s", (_label, before, after) => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  it.each(Object.keys(echoes))("%s fails its assertion", async (name) => {
    const source = new URL("../../src/mcp/http.ts", import.meta.url);
    const original = await readFile(source, "utf8");
    if (name.startsWith("estimate")) {
      vi.stubEnv("OPENPLANS_MEDICARE_PART_D", "on");
      vi.stubEnv("OPENPLANS_MEDICARE_DRUG_COST", "on");
    }
    await withMutantFile(
      source,
      replaceSyntax(original, before, after),
      async (temporary) => {
        const module = await importMutant<{ createMcpHttp: Factory }>(
          temporary,
          "createMcpHttp",
        );
        const real = await echoes[name]!(createMcpHttp, 11);
        expect(real.body).toMatchObject({ id: 11 });
        const mutated = await echoes[name]!(module.createMcpHttp, 11);
        expect(mutated.status).toBe(expectedStatus[name]);
        await expect(async () => {
          expect(mutated.body).toMatchObject({ id: 11 });
        }).rejects.toThrow();
      },
    );
  });
});
