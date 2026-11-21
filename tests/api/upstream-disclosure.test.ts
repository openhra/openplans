// Upstream disclosure and opt-out (D-PRX-5): the `x-openplans-upstream` header on REST answers,
// core routes and a plugin route alike, and `passthrough=off` as a query parameter and a body
// field. The full API runs with a synthetic pass-through plugin at `stored`. The MCP `_meta` and
// the compat API are covered with the CMS source in tests/compat/v1/quote-fallback.test.ts, since
// the MCP projection reads only that source's evidence. Synthetic plans, answers and host; an
// injected transport; no network.
import { mkdtemp, rm } from "node:fs/promises";
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
import type * as PluginsModule from "../../src/plugins/index.js";
import type * as PassThroughModule from "../../src/plugins/sources/passthrough.js";
import { plantMutant } from "../../src/plugins/testing/index.js";
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

const SOURCE = "synthetic-stored";
const HEADER = "x-openplans-upstream";
/** Twelve digits: a valid RxCUI the synthetic source does not accept, so nothing is asked. */
const LOCAL_ONLY = "123456789012";
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
  plugins: typeof PluginsModule;
  passthrough: typeof PassThroughModule;
  config: typeof ConfigModule;
  store: typeof StoreModule;
  fetch: typeof FetchModule;
}
/** A fresh module graph, so a planted mutant replaces one module for every importer. */
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
    plugins: await import("../../src/plugins/index.js"),
    passthrough: await import("../../src/plugins/sources/passthrough.js"),
    config: await import("../../src/config/index.js"),
    store: await import("../../src/api/cache/store.js"),
    fetch: await import("../../src/fetch/index.js"),
  };
}

interface Answered {
  status: number;
  header: string | null;
  xCache: string | null;
  results: { status?: string; reason?: string | null }[];
  calls: number;
}
interface Observed {
  local: Answered;
  queryOff: Answered;
  bodyOff: Answered;
  live: Answered;
  replay: Answered;
  invalid: { query: number; body: number };
  route: { header: string | null; xCache: string | null }[];
}

async function run(m: Modules): Promise<Observed> {
  const config = m.config.loadConfig(
    {},
    {
      version: 1,
      public: { quoting: false, household: false, compat: false },
      plugins: {
        entries: [
          {
            package: "./synthetic-passthrough/index.mjs",
            options: { level: "stored" },
          },
        ],
      },
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
  // Only the plugin's source runs; the CMS source stays out (no key).
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
  async function coverage(
    rxcuis: string[],
    query = "",
    extra: Record<string, unknown> = {},
  ): Promise<Answered> {
    const before = calls.length;
    const response = await app.request(`/v1/drug-coverage${query}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan_ids: [plan], rxcuis, year: 2026, ...extra }),
    });
    const body = (await response.json()) as { results?: Answered["results"] };
    return {
      status: response.status,
      header: response.headers.get(HEADER),
      xCache: response.headers.get("x-cache"),
      results: body.results ?? [],
      calls: calls.length - before,
    };
  }
  const local = await coverage([LOCAL_ONLY]);
  const queryOff = await coverage(codes, "?passthrough=off");
  const bodyOff = await coverage(codes, "", { passthrough: "off" });
  const invalid = {
    query: (await coverage(codes, "?passthrough=maybe")).status,
    body: (await coverage(codes, "", { passthrough: false })).status,
  };
  const live = await coverage(codes);
  const replay = await coverage(codes);
  // A cached plugin route that asks the source through `ctx.sources.passThrough`.
  const route = [];
  for (let i = 0; i < 2; i++) {
    const response = await app.request(
      `/synthetic/passthrough/drug?plan=${plan}&rxcui=${codes[0]}`,
    );
    route.push({
      header: response.headers.get(HEADER),
      xCache: response.headers.get("x-cache"),
    });
  }
  return { local, queryOff, bodyOff, live, replay, invalid, route };
}

const declined = (a: Answered) =>
  a.status === 200 &&
  a.header === null &&
  a.calls === 0 &&
  a.results.length === 2 &&
  a.results.every(
    (r) => r.status === "unknown" && r.reason === "passthrough_declined",
  );

/** The named points. Returns the names of the points a run breaks. */
function broken(o: Observed): string[] {
  const failed: string[] = [];
  const check = (name: string, ok: boolean) => {
    if (!ok) failed.push(name);
  };
  check(
    "a purely local answer has no header",
    o.local.status === 200 &&
      o.local.calls === 0 &&
      o.local.header === null &&
      o.local.results.length === 1 &&
      o.local.results[0]!.reason !== "passthrough_declined",
  );
  check("query passthrough=off keeps the question local", declined(o.queryOff));
  check("body passthrough=off keeps the question local", declined(o.bodyOff));
  check(
    "any other passthrough value is refused",
    o.invalid.query === 400 && o.invalid.body === 400,
  );
  check(
    "an answer from a pass-through call names its source",
    o.live.status === 200 &&
      o.live.header === SOURCE &&
      o.live.results.some((r) => r.status === "listed_covered"),
  );
  check(
    "an answer served from the source's store names it",
    o.replay.header === SOURCE &&
      o.replay.calls === 0 &&
      o.replay.results.some((r) => r.status === "listed_covered"),
  );
  check(
    "a plugin route and its cached replay name the source",
    o.route.length === 2 &&
      o.route[1]!.xCache === "hit" &&
      o.route.every((r) => r.header === SOURCE),
  );
  return failed;
}

beforeAll(async () => {
  h = await setup();
  plan = h.catalog.plans[0].base_plan_id;
  const drugs = (await fixture("drugs")) as { rxnorm_id: string }[];
  codes = [drugs[0]!.rxnorm_id, drugs[1]!.rxnorm_id];
  scratch = await mkdtemp(join(tmpdir(), "openplans-upstream-disclosure-"));
  manifestPath = await writeManifest(scratch);
  await h.db
    .exec(`INSERT INTO record_policy(name,default_ttl,stale_window,description) VALUES
    ('synthetic_answer','7 days','30 days','Synthetic pass-through answers'),
    ('synthetic_no_data','1 day','0','Synthetic pass-through no-data answers')`);
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
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("../../src/services/upstream-disclosure.js");
  vi.doUnmock("../../src/api/upstream.js");
  vi.doUnmock("../../src/api/app.js");
  vi.resetModules();
});

describe("upstream disclosure (D-PRX-5)", () => {
  it("names pass-through sources and honours passthrough=off", async () => {
    vi.resetModules();
    const o = await run(await modules());
    expect(broken(o)).toEqual([]);
    expect(o.live.calls).toBeGreaterThan(0);
  });

  it.each([
    [
      "the header missing after a pass-through call",
      "api/upstream.ts",
      'c.res.headers.set(UPSTREAM_HEADER, sources.join(","));',
      "void sources;",
      [
        "an answer from a pass-through call names its source",
        "an answer served from the source's store names it",
        "a plugin route and its cached replay name the source",
      ],
    ],
    [
      "served sources never recorded",
      "services/upstream-disclosure.ts",
      "recordUpstream(ids);",
      "void ids;",
      // The core also records a live call when it starts, so only stored answers and plugin
      // routes depend on this point.
      [
        "an answer served from the source's store names it",
        "a plugin route and its cached replay name the source",
      ],
    ],
    [
      "passthrough=off ignored",
      "services/upstream-disclosure.ts",
      "if (declinedInScope()) return declineAnswers(kind, answers);",
      "if (false) return declineAnswers(kind, answers);",
      [
        "query passthrough=off keeps the question local",
        "body passthrough=off keeps the question local",
      ],
    ],
    [
      "the header present on a purely local answer",
      "services/upstream-disclosure.ts",
      "if (filled === answers) return filled;",
      `if (filled === answers) {
        recordUpstream(
          passThroughSourcesOf(currentRegistries().sources).map((s) => s.id),
        );
        return filled;
      }`,
      ["a purely local answer has no header"],
    ],
  ] as const)(
    "a planted mutant fails a named point: %s",
    async (_name, file, before, after, points) => {
      const mutant = await plantMutant(src(file), before, after);
      try {
        const id = `../../src/${file.replace(/\.ts$/, ".js")}`;
        // The copy replaces the module for every importer; exports are read when used.
        const names = Object.keys(
          (await import(/* @vite-ignore */ id)) as Record<string, unknown>,
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
        planted = await (import(/* @vite-ignore */ mutant.path) as Promise<
          Record<string, unknown>
        >);
        const failed = broken(await run(await modules()));
        // Exactly the named points: a mutant that broke everything would prove nothing.
        expect(failed).toEqual(points);
      } finally {
        await mutant.cleanup();
      }
    },
  );
});
