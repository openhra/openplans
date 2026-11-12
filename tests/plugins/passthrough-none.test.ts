// The `none` cache level end to end (design 5.10.5): the full API and the MCP handler with a
// synthetic pass-through plugin at `none`. Synthetic plans, answers and host; an injected
// transport; no network.
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
import type * as AppModule from "../../src/api/app.js";
import type * as StoreModule from "../../src/api/cache/store.js";
import type * as ConfigModule from "../../src/config/index.js";
import type * as FetchModule from "../../src/fetch/index.js";
import type { Transport } from "../../src/fetch/index.js";
import type * as HttpModule from "../../src/mcp/http.js";
import type * as PluginsModule from "../../src/plugins/index.js";
import type * as PassThroughModule from "../../src/plugins/sources/passthrough.js";
import { plantMutant } from "../../src/plugins/testing/index.js";
import { post } from "../mcp/transport-helpers.js";
import { checkResponses } from "../response-columns.js";
import { fixture, setup } from "../ingest/qhp/formulary-helpers.js";
import {
  syntheticTransport,
  writeManifest,
} from "../fixtures/plugins/synthetic-passthrough/harness.js";

// Pacing is the limiter's job and has its own tests; these runs need no wall-clock waits.
vi.mock("../../src/fetch/limiter.js", () => ({
  leaseHost: async () => async () => {},
}));

const SOURCE = "synthetic-none";
const fixtures = fileURLToPath(
  new URL("../fixtures/plugins/", import.meta.url),
);
const src = (path: string) => new URL(`../../src/${path}`, import.meta.url);

let h: Awaited<ReturnType<typeof setup>>;
let plan: string;
let codes: [string, string];
let scratch: string;
let manifestPath: string;
let calls: URL[];

let transport: Transport;

interface Modules {
  app: typeof AppModule;
  http: typeof HttpModule;
  plugins: typeof PluginsModule;
  passthrough: typeof PassThroughModule;
  config: typeof ConfigModule;
  store: typeof StoreModule;
  fetch: typeof FetchModule;
}
/**
 * The modules under test, from a fresh module graph so a planted mutant can replace one of
 * them. The setup file's app.js wrapper keeps the graph it was first loaded with, so it is
 * registered again here, with the same response-column check.
 */
async function modules(): Promise<Modules> {
  vi.doMock("../../src/api/app.js", async (importOriginal) => {
    const module = await importOriginal<typeof AppModule>();
    return {
      ...module,
      createApp: (...parameters: Parameters<typeof AppModule.createApp>) =>
        checkResponses(module.createApp(...parameters)),
    };
  });
  return {
    app: await import("../../src/api/app.js"),
    http: await import("../../src/mcp/http.js"),
    plugins: await import("../../src/plugins/index.js"),
    passthrough: await import("../../src/plugins/sources/passthrough.js"),
    config: await import("../../src/config/index.js"),
    store: await import("../../src/api/cache/store.js"),
    fetch: await import("../../src/fetch/index.js"),
  };
}

/** What one run observed, for the six points of design 5.10.5. */
interface Observed {
  keys: Record<"response" | "catalog" | "passthrough", string[]>;
  bytes: number;
  snapshots: number;
  storageTables: string[];
  stored: number;
  attempts: Record<string, unknown>[];
  raw: string[];
  coverage: { status: number; xCache: string[]; results: unknown[] };
  route: { xCache: string[]; bodies: unknown[] };
  calls: number;
  mcp: { status: unknown[]; rxcuis: unknown[]; text: string };
}

const query = async <T>(sql: string, params: unknown[] = []) =>
  (await h.db.query<T & Record<string, unknown>>(sql, params)).rows;

async function rawEntries(): Promise<string[]> {
  try {
    return (await readdir(join(scratch, "raw"))).filter((name) =>
      name.startsWith(SOURCE),
    );
  } catch {
    return [];
  }
}

async function run(m: Modules): Promise<Observed> {
  const config = m.config.loadConfig(
    {},
    {
      version: 1,
      plugins: [{ package: "./synthetic-passthrough/index.mjs" }],
    },
  );
  const loaded = await m.plugins.loadPlugins(config, "api", {
    env: {},
    baseDirectory: fixtures,
    manifestPaths: [manifestPath],
    db: { reader: h.db, writer: h.db },
    writeLog: () => {},
    exit: (code) => {
      throw new Error(`exit ${code}`);
    },
  });
  const memory = new m.store.MemoryCache(8 * 1024 ** 2);
  // Host wiring for the test: the shared cache, the synthetic transport and admission. Only the
  // plugin's source runs; the CMS source stays out (no key, and it would answer first).
  m.passthrough.configurePassThrough({
    sources: () =>
      m.plugins
        .currentRegistries()
        .sources.map((entry) => entry.spec)
        .filter((spec) => spec.kind === "passthrough") as never,
    cacheStore: memory,
    fetchOptions: {
      transport,
      dataDir: scratch,
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
    },
    admission: () =>
      new m.fetch.AdmissionSession([manifestPath], {
        maxRequests: 100,
        maxTransferBytes: 1024 ** 2,
      }),
  });
  const app = m.app.createApp(
    h.db,
    { premiumToken: undefined },
    { store: memory, config, plugins: loaded.registries },
  );
  const body = JSON.stringify({ plan_ids: [plan], rxcuis: codes, year: 2026 });
  const coverage = {
    status: 0,
    xCache: [] as string[],
    results: [] as unknown[],
  };
  let firstAttempts: Record<string, unknown>[] = [];
  for (let i = 0; i < 2; i++) {
    const response = await app.request("/v1/drug-coverage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    coverage.status = response.status;
    coverage.xCache.push(response.headers.get("x-cache") ?? "");
    coverage.results.push(
      ((await response.json()) as { results: unknown }).results,
    );
    // Point 2 counts the rows of the first request alone.
    if (i === 0)
      firstAttempts = await query(
        "SELECT * FROM passthrough_attempt WHERE source_id=$1",
        [SOURCE],
      );
  }
  const route = { xCache: [] as string[], bodies: [] as unknown[] };
  for (let i = 0; i < 2; i++) {
    const response = await app.request(
      `/synthetic/passthrough/drug?plan=${plan}&rxcui=${codes[0]}`,
    );
    route.xCache.push(response.headers.get("x-cache") ?? "");
    route.bodies.push(await response.json());
  }
  const mcp = m.http.createMcpHttp(h.db, { env: {}, log: () => {} });
  const answer = await mcp.fetch(
    post("tools/call", {
      name: "check_drug_coverage",
      arguments: { plan_ids: [plan], rxcuis: codes, year: 2026 },
    }),
  );
  const text = await answer.text();
  const results = JSON.stringify(
    (
      JSON.parse(text.slice(text.indexOf("{"))) as {
        result?: { structuredContent?: { data?: { results?: unknown[] } } };
      }
    ).result?.structuredContent?.data?.results ?? [],
  );
  const mcpResults = JSON.parse(results) as {
    status?: unknown;
    rxcui?: unknown;
  }[];
  const keys = memory.keys();
  const observed: Observed = {
    keys: {
      response: keys.filter((k) => k.startsWith("openplans:response:v1:")),
      catalog: keys.filter((k) => k.startsWith("openplans:catalog:v1:")),
      passthrough: keys.filter((k) =>
        k.startsWith("openplans:passthrough:v1:"),
      ),
    },
    bytes: memory.bytes(),
    snapshots: Number(
      (
        await query<{ n: string }>(
          "SELECT count(*)::text AS n FROM snapshot WHERE source_id=$1",
          [SOURCE],
        )
      )[0]!.n,
    ),
    storageTables: (
      await query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND (table_name LIKE 'plg\\_%' OR table_name LIKE 'synthetic%')`,
      )
    ).map((row) => row.table_name),
    stored: Number(
      (
        await query<{ n: string }>(
          "SELECT count(*)::text AS n FROM passthrough_answer WHERE source_id=$1",
          [SOURCE],
        )
      )[0]!.n,
    ),
    attempts: firstAttempts,
    raw: await rawEntries(),
    coverage,
    route,
    calls: calls.length,
    mcp: {
      status: mcpResults.map((r) => r.status),
      rxcuis: mcpResults.map((r) => r.rxcui),
      text,
    },
  };
  return observed;
}

/** The six points, each by name. Returns the names of the points this run breaks. */
function broken(o: Observed): string[] {
  const failed: string[] = [];
  const check = (name: string, ok: boolean) => {
    if (!ok) failed.push(name);
  };
  check(
    "1: every cache namespace stays empty",
    o.keys.response.length === 0 &&
      o.keys.catalog.length === 0 &&
      o.keys.passthrough.length === 0 &&
      o.bytes === 0,
  );
  const [first] = o.attempts;
  const row = JSON.stringify(first ?? {});
  check(
    "2: no snapshot, no storage tables, one counts-only attempt row",
    o.snapshots === 0 &&
      o.storageTables.length === 0 &&
      o.stored === 0 &&
      o.attempts.length === 1 &&
      first?.pairs === 2 &&
      first?.outcome === "answered" &&
      first?.level === "none" &&
      !row.includes(plan) &&
      !codes.some((code) => row.includes(code)),
  );
  check("3: raw/<source> does not exist", o.raw.length === 0);
  check(
    "4: X-Cache bypass, and a second identical request calls again",
    o.coverage.status === 200 &&
      o.coverage.xCache.every((value) => value === "bypass") &&
      o.route.xCache.every((value) => value === "bypass") &&
      // Two coverage requests (one call each) and two route requests.
      o.calls === 4 &&
      JSON.stringify(o.coverage.results[0]) ===
        JSON.stringify(o.coverage.results[1]) &&
      (o.coverage.results[0] as { status: string }[]).every(
        (r) => r.status === "listed_covered",
      ),
  );
  check(
    "5: MCP answers unknown and the catalog stays empty",
    o.mcp.status.length === 2 &&
      o.mcp.status.every((status) => status === "unknown") &&
      o.keys.catalog.length === 0,
  );
  return failed;
}

beforeAll(async () => {
  h = await setup();
  plan = h.catalog.plans[0].base_plan_id;
  const drugs = (await fixture("drugs")) as { rxnorm_id: string }[];
  codes = [drugs[0]!.rxnorm_id, drugs[1]!.rxnorm_id];
  scratch = await mkdtemp(join(tmpdir(), "openplans-synthetic-none-"));
  manifestPath = await writeManifest(scratch);
}, 120_000);
afterAll(async () => {
  await h?.close();
  await rm(scratch, { recursive: true, force: true });
});
beforeEach(async () => {
  calls = [];
  transport = syntheticTransport(calls);
  vi.stubEnv("OPENPLANS_CMS_FALLBACK", "on");
  vi.stubEnv("CMS_API_KEY", "");
  vi.stubEnv("OPENPLANS_DATA_DIR", scratch);
  await h.db
    .exec(`DELETE FROM passthrough_attempt; DELETE FROM passthrough_budget;
    DELETE FROM passthrough_answer; DELETE FROM snapshot WHERE source_id='${SOURCE}'`);
  await rm(join(scratch, "raw"), { recursive: true, force: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("../../src/plugins/sources/passthrough.js");
  vi.doUnmock("../../src/api/cache/index.js");
  vi.doUnmock("../../src/api/app.js");
  vi.resetModules();
});

describe("pass-through `none` level (design 5.10.5)", () => {
  it("keeps nothing anywhere and calls every time", async () => {
    vi.resetModules();
    const o = await run(await modules());
    expect(broken(o)).toEqual([]);
    expect(o.coverage.results[0]).toEqual([
      expect.objectContaining({
        status: "listed_covered",
        synthetic_passthrough: expect.objectContaining({
          source_id: SOURCE,
          level: "none",
          served_from: "live",
          snapshot_id: null,
        }),
      }),
      expect.objectContaining({ status: "listed_covered" }),
    ]);
    // The MCP projection has no reason field; the answer is the loaded files' own unknown.
    expect(o.mcp.rxcuis).toEqual(codes);
    expect(o.mcp.text).not.toContain("synthetic_passthrough");
  });

  it.each([
    [
      "restrictCacheLevel called with stored",
      "sources/passthrough.ts",
      "restrictCacheLevel(levelUsed, ttl);",
      'restrictCacheLevel("stored", ttl);',
      [
        "1: every cache namespace stays empty",
        "4: X-Cache bypass, and a second identical request calls again",
      ],
    ],
    [
      "fetchTransient replaced by fetchToCache",
      "sources/passthrough.ts",
      "await fetchTransient(url, {",
      // The same result shape, read back from the cache file fetchToCache wrote.
      `await (async (o: Parameters<typeof fetchToCache>[1]) => {
        const r = await fetchToCache(url.href, { ...o, source: source.id });
        if (r.outcome === "not_modified") throw new Error("no body");
        return { status: r.metadata.status, body: await readFile(r.path), sha256: r.metadata.sha256 };
      })({`,
      ["3: raw/<source> does not exist"],
    ],
    [
      "the middleware's none/request branch removed",
      "cache/index.ts",
      "const ttl = scopeStoreTtl(seconds);",
      "const ttl = scopeStoreTtl(seconds) ?? seconds;",
      [
        "1: every cache namespace stays empty",
        "4: X-Cache bypass, and a second identical request calls again",
      ],
    ],
    [
      "a read-only none answer leaves the catalog free to store",
      "sources/passthrough.ts",
      "restrictCacheLevel(levelUsed);",
      "void levelUsed;",
      [
        "1: every cache namespace stays empty",
        "5: MCP answers unknown and the catalog stays empty",
      ],
    ],
  ] as const)(
    "a planted mutant fails a named point: %s",
    async (_name, file, before, after, points) => {
      const target =
        file === "cache/index.ts"
          ? src("api/cache/index.ts")
          : src("plugins/sources/passthrough.ts");
      const mutant = await plantMutant(target, before, after);
      try {
        const id =
          file === "cache/index.ts"
            ? "../../src/api/cache/index.js"
            : "../../src/plugins/sources/passthrough.js";
        // The copy replaces the module for every importer. Its exports are read when used, so
        // a module that imports it back (registries.ts imports passthrough.ts) loads first.
        const names = Object.keys(
          file === "cache/index.ts"
            ? await import("../../src/api/cache/index.js")
            : await import("../../src/plugins/sources/passthrough.js"),
        );
        let planted: Record<string, unknown> = {};
        vi.resetModules();
        vi.doMock(id, () =>
          Object.defineProperties(
            {},
            Object.fromEntries(
              names.map((name) => [
                name,
                { enumerable: true, get: () => planted[name] },
              ]),
            ),
          ),
        );
        planted = await import(/* @vite-ignore */ mutant.path);
        const failed = broken(await run(await modules()));
        // Exactly the named points: a mutant that broke everything would prove nothing.
        expect(failed).toEqual(points);
      } finally {
        await mutant.cleanup();
      }
    },
  );
});
