// Plugin routes and pass-through sources in the API host (design 5.10.3): a plugin with its own
// pass-through source gets a writer scoped to that source's storage, never a general one; each
// source spends its own per-request allowance and budget row, and the CMS source keeps its own.
// Synthetic plans, answers and host; an injected transport; no network. The CMS source is never
// configured here: no call to its API, and its key is never read.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
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
import type { PassThroughSource, Question } from "@openplans/plugin-sdk";
import { CMS_API_SOURCE } from "@openplans/source-cms-marketplace-api";
import { loadConfig } from "../../src/config/index.js";
import { AdmissionSession } from "../../src/fetch/index.js";
import type { Transport } from "../../src/fetch/index.js";
import type * as FallbackModule from "../../src/ingest/cms-api/fallback.js";
import { loadPlugins } from "../../src/plugins/loader.js";
import {
  activateRegistries,
  emptyRegistries,
  freezeRegistries,
} from "../../src/plugins/registries.js";
import type * as RoutesModule from "../../src/plugins/routes.js";
import type * as PassThroughModule from "../../src/plugins/sources/passthrough.js";
import type * as ScopedModule from "../../src/plugins/sources/scoped-writer.js";
import { plantMutant } from "../../src/plugins/testing/index.js";
import { fixture, setup } from "../ingest/qhp/formulary-helpers.js";
import { syntheticSource } from "../fixtures/plugins/synthetic-passthrough/index.mjs";
import {
  syntheticTransport,
  writeManifest,
} from "../fixtures/plugins/synthetic-passthrough/harness.js";

// Pacing is the limiter's job and has its own tests; these runs need no wall-clock waits.
vi.mock("../../src/fetch/limiter.js", () => ({
  leaseHost: async () => async () => {},
}));

type Source = PassThroughSource<Question, unknown>;
const fixtures = fileURLToPath(
  new URL("../fixtures/plugins/", import.meta.url),
);
const src = (path: string) => new URL(`../../src/${path}`, import.meta.url);
const SOURCE = "synthetic-route-writer";

let h: Awaited<ReturnType<typeof setup>>;
let plan: string;
let rxcui: string;
let scratch: string;
let manifestPath: string;
let calls: URL[];
let transport: Transport;

interface Modules {
  routes: typeof RoutesModule;
  passthrough: typeof PassThroughModule;
  fallback: typeof FallbackModule;
  scoped: typeof ScopedModule;
}
const original = async (): Promise<Modules> => ({
  routes: await import("../../src/plugins/routes.js"),
  passthrough: await import("../../src/plugins/sources/passthrough.js"),
  fallback: await import("../../src/ingest/cms-api/fallback.js"),
  scoped: await import("../../src/plugins/sources/scoped-writer.js"),
});

const fetchOptions = () => ({
  transport,
  dataDir: scratch,
  lookup: async () => [{ address: "8.8.8.8", family: 4 as const }],
});
const admission = () =>
  new AdmissionSession([manifestPath], {
    maxRequests: 100,
    maxTransferBytes: 1024 ** 2,
  });

const query = async <Row extends Record<string, unknown>>(
  sql: string,
  parameters?: unknown[],
) => (await h.db.query<Row>(sql, parameters)).rows;
const cmsBudget = async () =>
  JSON.stringify(await query("SELECT * FROM cms_api_budget"));

/** Loads both synthetic route-writer plugins and mounts their routes as the API host does. */
async function host(m: Modules, hostile = false) {
  const config = loadConfig(
    {},
    {
      version: 1,
      plugins: [
        {
          package: "./synthetic-route-writer/index.mjs",
          options: { hostile },
        },
        { package: "./synthetic-route-writer/other.mjs" },
      ],
    },
  );
  const loaded = await loadPlugins(config, "api", {
    env: {},
    baseDirectory: fixtures,
    manifestPaths: [manifestPath],
    writeLog: () => {},
    exit: (code) => {
      throw new Error(`exit ${code}`);
    },
  });
  m.passthrough.configurePassThrough({
    fetchOptions: fetchOptions(),
    admission,
  });
  const app = new Hono();
  const routes = m.routes.pluginRoutes(loaded.registries, {
    db: h.db,
    operatorToken: () => undefined,
    trustedProxies: [],
  });
  routes.guard(app);
  routes.mount(app);
  return {
    get: async (path: string) =>
      (await (await app.request(path)).json()) as Record<string, unknown>,
    teardown: loaded.teardown,
  };
}

const ALLOWED = ["own_insert", "read"];
const REFUSED = [
  "core_attempt",
  "core_delete",
  "cms_budget",
  "quoted_core",
  "schema_core",
  "ddl",
  "drop",
  "truncate",
  "several",
  "comment_split",
  "cte",
  "select_into",
  "setting",
  "session",
];

/** Each named point of the route writer. Returns the names of the points this run breaks. */
async function routeWriterBroken(m: Modules): Promise<string[]> {
  const failed: string[] = [];
  const check = async (name: string, ok: () => Promise<boolean>) => {
    let passed = false;
    try {
      passed = await ok();
    } catch {
      passed = false;
    }
    if (!passed) failed.push(name);
  };
  const before = await cmsBudget();
  await check(
    "W1: a plugin route's own source calls, records its attempt and keeps its own budget row",
    async () => {
      const api = await host(m);
      try {
        calls.length = 0;
        const out = await api.get(
          `/synthetic/route-writer/drug?plan=${plan}&rxcui=${rxcui}`,
        );
        const attempts = await query<{ outcome: string }>(
          "SELECT outcome FROM synthetic_route_attempt",
        );
        const budget = await query<{
          daily_requests: number;
          max_daily_requests: number;
        }>(
          "SELECT daily_requests,max_daily_requests FROM passthrough_budget WHERE source_id=$1",
          [SOURCE],
        );
        return (
          out.status === "listed_covered" &&
          calls.length === 1 &&
          attempts.length === 1 &&
          attempts[0]!.outcome === "answered" &&
          budget.length === 1 &&
          budget[0]!.daily_requests === 1 &&
          budget[0]!.max_daily_requests === 50
        );
      } finally {
        await api.teardown();
      }
    },
  );
  await check(
    "W2: a plugin without a pass-through source gets no writer",
    async () => {
      const api = await host(m);
      try {
        return (
          (await api.get("/synthetic/route-writer-other/try")).result ===
          "missing"
        );
      } finally {
        await api.teardown();
      }
    },
  );
  await check(
    "W3: any write outside the plugin's own tables is refused",
    async () => {
      const api = await host(m);
      try {
        const results: Record<string, unknown> = {};
        for (const statement of [...ALLOWED, ...REFUSED])
          results[statement] = (
            await api.get(`/synthetic/route-writer/try?statement=${statement}`)
          ).result;
        const tables = await query(
          "SELECT 1 FROM pg_tables WHERE tablename LIKE 'synthetic_route_%' AND tablename<>'synthetic_route_attempt'",
        );
        return (
          ALLOWED.every((s) => results[s] === "ran") &&
          REFUSED.every((s) => results[s] === "refused") &&
          tables.length === 0 &&
          (await cmsBudget()) === before
        );
      } finally {
        await api.teardown();
      }
    },
  );
  await check(
    "W4: a source's hooks cannot write a core table, even one it claims",
    async () => {
      const api = await host(m, true);
      try {
        const out = await api.get(
          `/synthetic/route-writer/drug?plan=${plan}&rxcui=${rxcui}`,
        );
        return (
          out.status === "unknown" &&
          out.reason === "passthrough_unavailable" &&
          (await cmsBudget()) === before
        );
      } finally {
        await api.teardown();
      }
    },
  );
  // A mutant may have run the refused statements; put the database back for the next run.
  await h.db
    .exec(`UPDATE cms_api_budget SET max_daily_requests=500 WHERE singleton;
    CREATE TABLE IF NOT EXISTS synthetic_route_attempt(outcome text NOT NULL);
    DROP TABLE IF EXISTS synthetic_route_extra, synthetic_route_copy;`);
  return failed;
}

/**
 * Allowance points: a plugin source first, then a stand-in under the CMS source's id (public,
 * synthetic host; it declares 5 calls per request so the host's allowance must win).
 */
async function allowanceBroken(m: Modules): Promise<string[]> {
  const failed: string[] = [];
  const own = {
    ...(syntheticSource("none") as Source),
    id: "synthetic-own-allowance",
    eligibility: {
      ...(syntheticSource("none") as Source).eligibility,
      accepts: (q: Question) => q.identity.startsWith("1"),
    },
    batch: { maxQuestionsPerCall: 1, maxCallsPerRequest: 2 },
  } as Source;
  const standIn = {
    ...(syntheticSource("none") as Source),
    id: CMS_API_SOURCE,
    eligibility: {
      ...(syntheticSource("none") as Source).eligibility,
      accepts: (q: Question) => q.identity.startsWith("3"),
    },
    batch: { maxQuestionsPerCall: 1, maxCallsPerRequest: 5 },
  } as Source;
  const local = (code: string) => ({
    status: "unknown",
    reason: "source_set_not_available",
    plan_id: "12345TX0010001",
    code,
    plan_year: 2026,
  });
  vi.stubEnv("OPENPLANS_CMS_FALLBACK", "on");
  const before = await cmsBudget();
  calls.length = 0;
  const core = m.passthrough.createPassThrough({
    sources: () => [own, standIn],
    fetchOptions: fetchOptions(),
    admission,
  });
  const scope = m.fallback.cmsFallbackContext(h.db, h.db)!;
  const out = await core.apply(
    "drug",
    ["11", "12", "13", "31", "32", "33", "34"].map(local),
    scope,
  );
  const called = (prefix: string) =>
    calls.filter((url) =>
      (url.searchParams.get("q") ?? "").split(":")[1]!.startsWith(prefix),
    ).length;
  const rows = await query<{
    source_id: string;
    daily_requests: number;
    max_daily_requests: number;
  }>(
    "SELECT source_id,daily_requests,max_daily_requests FROM passthrough_budget ORDER BY source_id",
  );
  const row = (id: string) => rows.find((r) => r.source_id === id);
  const check = (name: string, ok: boolean) => {
    if (!ok) failed.push(name);
  };
  check(
    "A1: a plugin source spends its own declared allowance",
    called("1") === 2 &&
      out.filter((a) => a.code.startsWith("1") && a.status === "listed_covered")
        .length === 2,
  );
  check(
    "A2: the CMS source keeps exactly 2 calls per request",
    called("3") === 2 &&
      out.filter((a) => a.code.startsWith("3") && a.status === "listed_covered")
        .length === 2 &&
      JSON.stringify(scope.allowances) ===
        JSON.stringify({ [CMS_API_SOURCE]: 2 }),
  );
  check(
    "A3: each source has its own budget row and the CMS row is untouched",
    row("synthetic-own-allowance")?.daily_requests === 2 &&
      row("synthetic-own-allowance")?.max_daily_requests === 50 &&
      row(CMS_API_SOURCE)?.daily_requests === 2 &&
      (await cmsBudget()) === before,
  );
  vi.unstubAllEnvs();
  return failed;
}

beforeAll(async () => {
  h = await setup();
  plan = h.catalog.plans[0].base_plan_id;
  const drugs = (await fixture("drugs")) as { rxnorm_id: string }[];
  rxcui = drugs[0]!.rxnorm_id;
  scratch = await mkdtemp(join(tmpdir(), "openplans-route-writer-"));
  manifestPath = await writeManifest(scratch);
  await h.db.exec(
    "CREATE TABLE synthetic_route_attempt(outcome text NOT NULL)",
  );
}, 120_000);
afterAll(async () => {
  await h?.close();
  await rm(scratch, { recursive: true, force: true });
});
beforeEach(async () => {
  calls = [];
  transport = syntheticTransport(calls);
  vi.stubEnv("OPENPLANS_DATA_DIR", scratch);
  await h.db
    .exec(`DELETE FROM passthrough_attempt; DELETE FROM passthrough_budget;
    DELETE FROM synthetic_route_attempt;`);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  const { configurePassThrough } =
    await import("../../src/plugins/sources/passthrough.js");
  configurePassThrough({});
  activateRegistries(freezeRegistries(emptyRegistries()));
});

/** Plants one mutant and returns the module set with that module replaced. */
async function withMutant(
  file: string,
  before: string,
  after: string,
  run: (m: Modules) => Promise<string[]>,
): Promise<string[]> {
  const mutant = await plantMutant(src(file), before, after);
  try {
    const planted = (await import(/* @vite-ignore */ mutant.path)) as never;
    const m = await original();
    const key = {
      "plugins/routes.ts": "routes",
      "plugins/sources/passthrough.ts": "passthrough",
      "ingest/cms-api/fallback.ts": "fallback",
    }[file] as keyof Modules;
    return await run({ ...m, [key]: planted });
  } finally {
    await mutant.cleanup();
  }
}

describe("plugin route writer", () => {
  it("every point holds", async () => {
    expect(await routeWriterBroken(await original())).toEqual([]);
  });

  it("a planted mutant fails a named point: a plugin given a general writer", async () => {
    expect(
      await withMutant(
        "plugins/routes.ts",
        'if (writer) c.set("pluginPassThroughWriter", writer);',
        'c.set("pluginPassThroughWriter", boundedDatabase(options.db, signal, { readOnly: false }));',
        routeWriterBroken,
      ),
    ).toEqual([
      "W2: a plugin without a pass-through source gets no writer",
      "W3: any write outside the plugin's own tables is refused",
      "W4: a source's hooks cannot write a core table, even one it claims",
    ]);
  });

  it("a planted mutant fails: a source's claim on a core table honoured", async () => {
    const mutant = await plantMutant(
      src("plugins/sources/scoped-writer.ts"),
      "&& !core.has(name)",
      "",
    );
    try {
      const planted = (await import(
        /* @vite-ignore */ mutant.path
      )) as typeof ScopedModule;
      expect(claimsHonoured(planted)).toEqual(["cms_api_budget", "snapshot"]);
    } finally {
      await mutant.cleanup();
    }
  });
});

/** The core tables a hostile storage declaration gets to write; none when the rule holds. */
function claimsHonoured(scoped: typeof ScopedModule): string[] {
  const source = {
    storage: {
      excludedTables: ["mine"],
      tables: ["mine", "cms_api_budget", "Snapshot", "bad name"],
    },
  } as unknown as Source;
  return scoped.ownTables(source).filter((name) => name !== "mine");
}

describe("per-source call allowance", () => {
  it("every point holds", async () => {
    expect(await allowanceBroken(await original())).toEqual([]);
  });

  it("a planted mutant fails a named point: a plugin source eating the CMS allowance", async () => {
    expect(
      await withMutant(
        "plugins/sources/passthrough.ts",
        "callsLeft.get(scope)!.set(source.id, remaining(scope, source) - 1);",
        "for (const s of deps.sources()) callsLeft.get(scope)!.set(s.id, remaining(scope, s) - 1);",
        allowanceBroken,
      ),
    ).toEqual([
      "A2: the CMS source keeps exactly 2 calls per request",
      "A3: each source has its own budget row and the CMS row is untouched",
    ]);
  });

  it("a planted mutant fails a named point: the CMS allowance changed", async () => {
    expect(
      await withMutant(
        "ingest/cms-api/fallback.ts",
        "export const CMS_CALLS_PER_REQUEST = 2;",
        "export const CMS_CALLS_PER_REQUEST = 3;",
        allowanceBroken,
      ),
    ).toEqual([
      "A2: the CMS source keeps exactly 2 calls per request",
      "A3: each source has its own budget row and the CMS row is untouched",
    ]);
  });
});

describe("scoped writer statements", () => {
  it("names the tables a statement writes, or refuses it", async () => {
    const { writeTargets } = await original().then((m) => m.scoped);
    expect(writeTargets("SELECT 1")).toEqual([]);
    expect(
      writeTargets(
        "INSERT INTO own_t(a) VALUES($1) ON CONFLICT (a) DO UPDATE SET a=EXCLUDED.a",
      ),
    ).toEqual(["own_t"]);
    expect(writeTargets("SELECT * FROM own_t FOR UPDATE")).toEqual([]);
    expect(writeTargets("UPDATE ONLY public.own_t SET a=1")).toEqual(["own_t"]);
    expect(
      writeTargets("DELETE FROM \"own_t\" WHERE a='; DROP TABLE x'"),
    ).toEqual(["own_t"]);
    expect(writeTargets("SELECT $$; DELETE FROM x$$")).toEqual([]);
    for (const refused of [
      "UPDATE other.own_t SET a=1",
      "SELECT pg_sleep(1)",
      "SELECT nextval('s')",
      "SELECT 1; SELECT 2",
      "SELECT 'unterminated",
      "BEGIN",
      "",
    ])
      expect(writeTargets(refused)).toBeNull();
  });

  it("never lets a source claim a core table", async () => {
    const { ownTables, coreTables } = await original().then((m) => m.scoped);
    expect(coreTables().has("cms_api_budget")).toBe(true);
    expect(coreTables().has("passthrough_attempt")).toBe(true);
    expect(claimsHonoured(await original().then((m) => m.scoped))).toEqual([]);
    expect(
      ownTables({
        storage: { excludedTables: ["mine", "Mine"] },
      } as unknown as Source),
    ).toEqual(["mine"]);
  });

  it("gives another plugin's source, or the CMS source, no writer", async () => {
    const { passThroughWriter, sourceWriter } = await original().then(
      (m) => m.scoped,
    );
    const own = syntheticSource("none") as Source;
    const other = { ...own } as Source;
    const handle = passThroughWriter([own], h.db, h.db)!;
    expect(sourceWriter(handle, other)).toBeUndefined();
    expect(sourceWriter(handle, own)).toBeDefined();
    expect(sourceWriter(h.db, other)).toBe(h.db);
    expect(passThroughWriter([], h.db, h.db)).toBeUndefined();
  });
});
