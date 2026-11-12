import { createHash } from "node:crypto";
import type * as Crypto from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createApp } from "../../src/api/app.js";
import { MemoryCache } from "../../src/api/cache/store.js";
import type { SqlSession } from "../../src/db/database.js";
import { createMcpHttp } from "../../src/mcp/http.js";
import { inputSchemas, toolNames } from "../../src/mcp/schemas.js";
import { post } from "../mcp/transport-helpers.js";
import { CURSOR_SECRET, digestFixture, FIXED_TIME, TOKEN } from "./fixture.js";

// Only import identities are synthetic; bytes returned by the app are never rewritten.
vi.mock("node:crypto", async (importOriginal) => {
  const original = await importOriginal<typeof Crypto>();
  let sequence = 0;
  return {
    ...original,
    randomUUID: () =>
      `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
  };
});

type HttpEntry = {
  id: string;
  method: string;
  path: string;
  status: number;
  source: string;
  body?: unknown;
  headers?: Record<string, string>;
  token?: boolean;
  auth?: "granted" | "wrong";
  unavailable?: boolean;
  warm?: boolean;
  env?: Record<string, string>;
};
type McpEntry = {
  id: string;
  method: string;
  params: Record<string, unknown>;
  grant: boolean;
  legacy?: boolean;
};
type Digest = {
  status: number;
  body_sha256: string;
  headers: Record<string, string | null>;
};
type Digests = Record<string, Digest>;
const fixtures = new URL("../fixtures/plugins/", import.meta.url);
const corpus = JSON.parse(
  await readFile(new URL("corpus.json", fixtures), "utf8"),
) as {
  http: HttpEntry[];
  mcp: McpEntry[];
};
const record = process.env.OPENPLANS_RECORD_DIGESTS === "1";
const headerNames = [
  "content-type",
  "cache-control",
  "x-cache",
  "x-openplans-gaps",
  "x-quote-tier",
];
let fixture: Awaited<ReturnType<typeof digestFixture>>;
/**
 * The corpus replays twice: with the CMS Marketplace API fallback off (the default) and on.
 * The "on" replay has no API key, so no request leaves the process and no key is read.
 */
const modes = ["off", "on"] as const;
type Mode = (typeof modes)[number];
const files: Record<Mode, { http: string; mcp: string }> = {
  off: { http: "response-digests.json", mcp: "mcp-digests.json" },
  on: {
    http: "response-digests-cms-on.json",
    mcp: "mcp-digests-cms-on.json",
  },
};
const expectedHttp = {} as Record<Mode, Digests>,
  expectedMcp = {} as Record<Mode, Digests>;
const actualHttp: Record<Mode, Digests> = { off: {}, on: {} },
  actualMcp: Record<Mode, Digests> = { off: {}, on: {} };
let mode: Mode = "off";

async function digest(response: Response): Promise<Digest> {
  return {
    status: response.status,
    body_sha256: createHash("sha256")
      .update(Buffer.from(await response.arrayBuffer()))
      .digest("hex"),
    headers: Object.fromEntries(
      headerNames.map((name) => [name, response.headers.get(name)]),
    ),
  };
}
function environment() {
  // Host configuration must never enter the corpus. Values are restored after each test.
  for (const name of Object.keys(process.env))
    if (name.startsWith("OPENPLANS_") && name !== "OPENPLANS_RECORD_DIGESTS")
      vi.stubEnv(name, undefined);
  vi.stubEnv("OPENPLANS_CMS_FALLBACK", mode);
  if (mode === "on") {
    vi.stubEnv("OPENPLANS_CMS_FALLBACK_QUOTES", "on");
    vi.stubEnv("CMS_API_KEY", undefined);
  }
  vi.stubEnv("OPENPLANS_API_CACHE", "on");
  vi.stubEnv("OPENPLANS_MCP_CURSOR_SECRET", CURSOR_SECRET);
}
function session(unavailable = false): SqlSession {
  // Each replay owns a cache and limiter; entry order cannot affect another response.
  if (unavailable)
    return {
      query: async () => {
        throw new Error("Synthetic database outage");
      },
      exec: async () => {
        throw new Error("Synthetic database outage");
      },
    };
  return { query: fixture.db.query, exec: fixture.db.exec };
}
function httpApp(entry: HttpEntry) {
  for (const [name, value] of Object.entries(entry.env ?? {}))
    vi.stubEnv(name, value);
  if (entry.token) vi.stubEnv("OPENPLANS_API_TOKEN", TOKEN);
  // Use the default options deliberately: exercise OPENPLANS_API_TOKEN itself.
  return createApp(session(entry.unavailable), undefined, {
    store: new MemoryCache(64 * 1024 * 1024, () => Date.parse(FIXED_TIME)),
  });
}
function request(entry: HttpEntry): RequestInit {
  const headers = new Headers(entry.headers);
  if (entry.auth)
    headers.set(
      "authorization",
      `Bearer ${entry.auth === "granted" ? TOKEN : "synthetic-wrong-token"}`,
    );
  let body: string | undefined;
  if (entry.body !== undefined) {
    headers.set("content-type", "application/json");
    body =
      typeof entry.body === "string" ? entry.body : JSON.stringify(entry.body);
  }
  return { method: entry.method, headers, body };
}

beforeAll(async () => {
  environment();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(FIXED_TIME));
  fixture = await digestFixture();
  if (!record)
    for (const each of modes) {
      expectedHttp[each] = JSON.parse(
        await readFile(new URL(files[each].http, fixtures), "utf8"),
      );
      expectedMcp[each] = JSON.parse(
        await readFile(new URL(files[each].mcp, fixtures), "utf8"),
      );
    }
});
beforeEach(environment);
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  await fixture?.close();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

for (const each of modes)
  describe(`byte-identical HTTP, CMS fallback ${each}`, () => {
    beforeAll(() => {
      mode = each;
    });
    for (const entry of corpus.http)
      it(`${entry.id} ${entry.method} ${entry.path}`, async () => {
        const app = httpApp(entry);
        if (entry.warm)
          await (await app.request(entry.path, request(entry))).arrayBuffer();
        const actual = await digest(
          await app.request(entry.path, request(entry)),
        );
        expect(actual.status, entry.id).toBe(entry.status);
        if (!record)
          expect(actual, entry.id).toEqual(expectedHttp[each][entry.id]);
        actualHttp[each][entry.id] = actual;
      });
  });

for (const each of modes)
  describe(`byte-identical MCP, CMS fallback ${each}`, () => {
    beforeAll(() => {
      mode = each;
    });
    for (const entry of corpus.mcp)
      it(`${entry.id} ${entry.method}`, async () => {
        const app = createMcpHttp(session(), {
          env: {
            OPENPLANS_MCP_TOKEN: TOKEN,
            OPENPLANS_MCP_CURSOR_SECRET: CURSOR_SECRET,
          },
          now: () => Date.parse(FIXED_TIME),
          log: () => {},
        });
        const headers: Record<string, string> = {};
        if (entry.grant) headers.authorization = `Bearer ${TOKEN}`;
        const initial = post(entry.method, entry.params, headers);
        let input = initial;
        if (entry.legacy) {
          const body = JSON.parse(await initial.text());
          delete body.params._meta;
          initial.headers.set("MCP-Protocol-Version", "2025-11-25");
          input = new Request(initial.url, {
            method: "POST",
            headers: initial.headers,
            body: JSON.stringify(body),
          });
        }
        const response = await app.fetch(input);
        // Parse a clone only for coverage checks. The digest always hashes the original bytes.
        const text = await response.clone().text();
        const messages = text.startsWith("{")
          ? [JSON.parse(text)]
          : text
              .split("\n")
              .filter((line) => line.startsWith("data: "))
              .map((line) => JSON.parse(line.slice(6)));
        const body = messages.find(
          (message) => "result" in message || "error" in message,
        );
        expect(body, entry.id).toBeDefined();
        expect(response.status, entry.id).toBe(
          entry.id === "call-denied" ? 401 : 200,
        );
        if (entry.method === "tools/call" && entry.id !== "call-denied") {
          expect(body.error, entry.id).toBeUndefined();
          expect(
            body.result.isError,
            `${entry.id}: ${JSON.stringify(body.result.structuredContent?.error)}`,
          ).not.toBe(true);
          const tool = entry.params.name as keyof typeof inputSchemas;
          expect(
            inputSchemas[tool].safeParse(entry.params.arguments).success,
            entry.id,
          ).toBe(true);
        }
        if (entry.method === "tools/list") {
          const expected = entry.grant
            ? toolNames
            : toolNames.filter(
                (name) =>
                  !["quote_premiums", "check_ichra_affordability"].includes(
                    name,
                  ),
              );
          expect(
            body.result.tools.map((tool: { name: string }) => tool.name),
          ).toEqual(expected);
          expect(body.result.nextCursor).toBeUndefined();
        }
        const actual = await digest(response);
        if (!record)
          expect(actual, entry.id).toEqual(expectedMcp[each][entry.id]);
        actualMcp[each][entry.id] = actual;
      });
  });

it("covers every mounted route and MCP tool with unique, traceable requests", async () => {
  const ids = [...corpus.http, ...corpus.mcp].map((entry) => entry.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const entry of corpus.http)
    await readFile(new URL(`../../${entry.source}`, import.meta.url));
  const app = httpApp(corpus.http[0]!);
  const routes = app.routes.filter(
    ({ method, path }) =>
      path !== "/mcp" &&
      (method !== "ALL" ||
        (path.endsWith("/*") && path.includes("/compat/v1/plans/"))),
  );
  for (const route of routes) {
    const pattern = new RegExp(
      `^${route.path.replace(/:[^/]+/g, "[^/]+").replace(/\*/g, ".*")}$`,
    );
    for (const token of [false, true]) {
      expect(
        corpus.http.some(
          (entry) =>
            Boolean(entry.token) === token &&
            (route.method === "ALL" || route.method === entry.method) &&
            pattern.test(entry.path.split("?")[0]!),
        ),
        `${route.method} ${route.path}, API token configured=${token}`,
      ).toBe(true);
    }
  }
  const called = corpus.mcp
    .filter((entry) => entry.method === "tools/call" && entry.grant)
    .map((entry) => entry.params.name)
    .sort();
  expect(called).toEqual(toolNames);
  for (const each of modes) {
    expect(Object.keys(actualHttp[each])).toEqual(
      corpus.http.map((entry) => entry.id),
    );
    expect(Object.keys(actualMcp[each])).toEqual(
      corpus.mcp.map((entry) => entry.id),
    );
    if (record) {
      await writeFile(
        new URL(files[each].http, fixtures),
        JSON.stringify(actualHttp[each], null, 2) + "\n",
      );
      await writeFile(
        new URL(files[each].mcp, fixtures),
        JSON.stringify(actualMcp[each], null, 2) + "\n",
      );
    } else {
      expect(Object.keys(expectedHttp[each])).toEqual(
        Object.keys(actualHttp[each]),
      );
      expect(Object.keys(expectedMcp[each])).toEqual(
        Object.keys(actualMcp[each]),
      );
    }
  }
});
