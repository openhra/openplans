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
import { startTelemetry, activeRecorder } from "../../src/telemetry/index.js";
import { loadConfig } from "../../src/config/index.js";
import { loadPlugins } from "../../src/plugins/loader.js";
import { currentRegistries } from "../../src/plugins/registries.js";
import { createApp } from "../../src/api/app.js";
import { MemoryCache } from "../../src/api/cache/store.js";
import type { SqlSession } from "../../src/db/database.js";
import { createMcpHttp } from "../../src/mcp/http.js";
import { inputSchemas, toolNames } from "../../src/mcp/schemas.js";
import { applicationVersion } from "../../src/mcp/version.js";
import { post } from "../mcp/transport-helpers.js";
import { CURSOR_SECRET, digestFixture, FIXED_TIME, TOKEN } from "./fixture.js";
import {
  responseDigest as digest,
  type ResponseDigest as Digest,
} from "./admin-support/digests.js";

// Import identities are synthetic; only separately asserted release metadata is normalized.
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
type Digests = Record<string, Digest>;
const fixtures = new URL("../fixtures/plugins/", import.meta.url);
const corpus = JSON.parse(
  await readFile(new URL("corpus.json", fixtures), "utf8"),
) as {
  http: HttpEntry[];
  mcp: McpEntry[];
};
const record = process.env.OPENPLANS_RECORD_DIGESTS === "1";
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

function environment() {
  // Reset application configuration but keep the database harness. Restore values after each test.
  for (const name of Object.keys(process.env))
    if (
      name.startsWith("OPENPLANS_") &&
      ![
        "OPENPLANS_RECORD_DIGESTS",
        "OPENPLANS_TEST_DB",
        "OPENPLANS_POSTGRES_TEST_URL",
        "OPENPLANS_POSTGIS_CONTAINER",
        "OPENPLANS_POSTGIS_REQUIRED",
      ].includes(name)
    )
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
    plugins: currentRegistries(),
    store: new MemoryCache(64 * 1024 * 1024, () => Date.parse(FIXED_TIME)),
  });
}
interface RpcBody {
  error?: unknown;
  result: {
    isError?: boolean;
    structuredContent?: { error?: unknown };
    tools: { name: string }[];
    nextCursor?: string;
  };
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
      ) as Digests;
      expectedMcp[each] = JSON.parse(
        await readFile(new URL(files[each].mcp, fixtures), "utf8"),
      ) as Digests;
    }
});
beforeEach(environment);
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  await fixture?.close();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const pluginModes = [
  "absent",
  "disabled",
  "no-source",
  "admin-disabled",
  "admin-disabled-metrics-on",
  "compare-disabled",
] as const;
async function offMode(pluginMode: (typeof pluginModes)[number]) {
  const plugins = [];
  if (pluginMode === "compare-disabled") {
    plugins.push({ package: "@openplans/plugin-compare", enabled: false });
  } else if (
    pluginMode === "admin-disabled" ||
    pluginMode === "admin-disabled-metrics-on"
  ) {
    plugins.push({ package: "@openplans/plugin-admin", enabled: false });
  } else if (pluginMode !== "absent") {
    plugins.push({
      package: "@openplans/plugin-msot",
      enabled: pluginMode !== "disabled",
    });
  }
  const loaded = await loadPlugins(
    loadConfig({}, { version: 1, plugins }),
    "api",
    {
      env: {},
    },
  );
  const openDatabase = vi.fn(() => {
    throw new Error("Disabled telemetry must not open storage");
  });
  expect(
    startTelemetry({
      plugins: loaded.plugins.map((plugin) => ({ name: plugin.name })),
      env:
        pluginMode === "admin-disabled-metrics-on"
          ? { OPENPLANS_METRICS: "on" }
          : {},
      openDatabase,
    }),
  ).toBeUndefined();
  expect(activeRecorder()).toBeUndefined();
  expect(openDatabase).not.toHaveBeenCalled();
}
for (const pluginMode of pluginModes)
  for (const each of modes)
    describe(`byte-identical HTTP, CMS fallback ${each}, plugins ${pluginMode}`, () => {
      beforeAll(async () => {
        mode = each;
        await offMode(pluginMode);
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

for (const pluginMode of pluginModes)
  for (const each of modes)
    describe(`byte-identical MCP, CMS fallback ${each}, plugins ${pluginMode}`, () => {
      beforeAll(async () => {
        mode = each;
        await offMode(pluginMode);
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
            const body = JSON.parse(await initial.text()) as {
              params: { _meta?: unknown };
            };
            delete body.params._meta;
            initial.headers.set("MCP-Protocol-Version", "2025-11-25");
            input = new Request(initial.url, {
              method: "POST",
              headers: initial.headers,
              body: JSON.stringify(body),
            });
          }
          const warmRequest = input.clone();
          const response = await app.fetch(input);
          // Parse a clone for coverage checks; digest() also asserts release metadata.
          const text = await response.clone().text();
          const messages = text.startsWith("{")
            ? [JSON.parse(text) as RpcBody]
            : text
                .split("\n")
                .filter((line) => line.startsWith("data: "))
                .map((line) => JSON.parse(line.slice(6)) as RpcBody);
          const body = messages.find(
            (message) => "result" in message || "error" in message,
          );
          expect(body, entry.id).toBeDefined();
          expect(response.status, entry.id).toBe(
            entry.id === "call-denied" ? 401 : 200,
          );
          if (entry.method === "tools/call" && entry.id !== "call-denied") {
            expect(body!.error, entry.id).toBeUndefined();
            expect(
              body!.result.isError,
              `${entry.id}: ${JSON.stringify(body!.result.structuredContent?.error)}`,
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
              body!.result.tools.map((tool: { name: string }) => tool.name),
            ).toEqual(expected);
            expect(body!.result.nextCursor).toBeUndefined();
          }
          const actual = await digest(response);
          const bumped = text.replaceAll(
            `"version":${JSON.stringify(applicationVersion)}`,
            '"version":"999.0.0-synthetic"',
          );
          expect(
            await digest(
              new Response(bumped, {
                status: response.status,
                headers: response.headers,
              }),
              "999.0.0-synthetic",
            ),
            `${entry.id}: version bump`,
          ).toEqual(actual);
          if (!record)
            expect(actual, entry.id).toEqual(expectedMcp[each][entry.id]);
          actualMcp[each][entry.id] = actual;
          const warm = await digest(await app.fetch(warmRequest));
          if (!record)
            expect(warm, `${entry.id}: warm MCP`).toEqual(
              expectedMcp[each][entry.id],
            );
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
    if (
      route.method === "POST" &&
      route.path === "/v1/ichra/affordability/batch"
    ) {
      // This default-off route is additive; all historical digests remain frozen.
      const source = "tests/api/ichra-batch.test.ts";
      await readFile(new URL(`../../${source}`, import.meta.url));
      for (const token of [false, true]) {
        const entry: HttpEntry = {
          id: "census-default-off",
          method: "POST",
          path: route.path,
          status: 404,
          source,
          token,
          body: { rows: [] },
        };
        const denied = await httpApp(entry).request(entry.path, request(entry));
        expect(denied.status).toBe(404);
        expect(denied.headers.get("cache-control")).toBe("no-store");
        expect(denied.headers.get("x-cache")).toBe("bypass");
        expect(await denied.text()).toBe("404 Not Found");
      }
      continue;
    }
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

it("rejects one_byte_response_mutant by its recorded HTTP case name", async () => {
  const entry = corpus.http[0]!;
  const response = await httpApp(entry).request(entry.path, request(entry));
  const bytes = Buffer.from(await response.arrayBuffer());
  const mutated = await digest(
    new Response(Buffer.concat([bytes, Buffer.from(" ")]), {
      status: response.status,
      headers: response.headers,
    }),
  );
  expect(() =>
    expect(mutated, `one_byte_response_mutant:${entry.id}`).toEqual(
      record ? actualHttp[mode][entry.id] : expectedHttp[mode][entry.id],
    ),
  ).toThrow(`one_byte_response_mutant:${entry.id}`);
});

it("keeps the recorded MCP digest on a version bump and rejects a response field mutant", async () => {
  const entry = corpus.mcp.find((entry) => entry.id === "tools-list-granted")!;
  const app = createMcpHttp(session(), {
    env: {
      OPENPLANS_MCP_TOKEN: TOKEN,
      OPENPLANS_MCP_CURSOR_SECRET: CURSOR_SECRET,
    },
    now: () => Date.parse(FIXED_TIME),
    log: () => {},
  });
  const original = await app.fetch(
    post(entry.method, entry.params, { authorization: `Bearer ${TOKEN}` }),
  );
  const text = await original.text();
  const expected = record
    ? actualMcp[mode][entry.id]
    : expectedMcp[mode][entry.id];
  expect(text).toContain(`"version":${JSON.stringify(applicationVersion)}`);
  const bumped = text.replaceAll(
    `"version":${JSON.stringify(applicationVersion)}`,
    '"version":"999.0.0-synthetic"',
  );
  expect(
    await digest(
      new Response(bumped, { headers: original.headers }),
      "999.0.0-synthetic",
    ),
  ).toEqual(expected);
  const mutant = await digest(
    new Response(text.replace('"name":"openplans"', '"name":"mutant"'), {
      headers: original.headers,
    }),
  );
  expect(() =>
    expect(mutant, "mcp_response_field_mutant").toEqual(expected),
  ).toThrow("mcp_response_field_mutant");
});
