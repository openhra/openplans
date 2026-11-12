// Pass-through host wiring (design 5.10.3 and 5.10.4): each source has its own switch, the core's
// default evidence block passes the response-column guard, and the API and worker hosts apply the
// operator's `plugins[].sources` settings, which can only tighten. Synthetic plans, answers and
// host; an injected transport; no network.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import type {
  CacheStore,
  PassThroughSource,
  Question,
} from "@openplans/plugin-sdk";
import type * as AppModule from "../../src/api/app.js";
import type { MemoryCache } from "../../src/api/cache/store.js";
import type * as FetchModule from "../../src/fetch/index.js";
import type { Transport } from "../../src/fetch/index.js";
import type * as ApiPluginsModule from "../../src/plugins/api.js";
import type * as PassThroughModule from "../../src/plugins/sources/passthrough.js";
import type * as WorkerPluginsModule from "../../src/plugins/worker.js";
import { loadConfig } from "../../src/config/index.js";
import { AdmissionSession } from "../../src/fetch/index.js";
import { plantMutant } from "../../src/plugins/testing/index.js";
import {
  createPassThrough,
  operatorPassThrough,
  PassThroughPolicyRefusal,
} from "../../src/plugins/sources/passthrough.js";
import type { PassThroughDeps } from "../../src/plugins/sources/passthrough.js";
import { checkResponses, rowProvenanceLeaks } from "../response-columns.js";
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

let h: Awaited<ReturnType<typeof setup>>;
let plan: string;
let codes: [string, string];
let scratch: string;
let manifestPath: string;
let calls: URL[];
let transport: Transport;

interface Modules {
  app: typeof AppModule;
  api: typeof ApiPluginsModule;
  worker: typeof WorkerPluginsModule;
  passthrough: typeof PassThroughModule;
  fetch: typeof FetchModule;
}
/** Fresh module graph, so a planted mutant can replace one module for every importer. */
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
    api: await import("../../src/plugins/api.js"),
    worker: await import("../../src/plugins/worker.js"),
    passthrough: await import("../../src/plugins/sources/passthrough.js"),
    fetch: await import("../../src/fetch/index.js"),
  };
}

let configs = 0;
async function configFile(
  options: Record<string, unknown>,
  sources: Record<string, unknown> = {},
): Promise<Record<string, string>> {
  const path = join(scratch, `config-${configs++}.json`);
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      access: { operatorManifest: manifestPath },
      plugins: [
        { package: "./synthetic-passthrough/index.mjs", options, sources },
      ],
    }),
  );
  return { OPENPLANS_CONFIG: path };
}

interface Served {
  status: number;
  body: unknown;
  keys: string[];
}

/** Loads the plugin through the API host and sends one request; null when the load refused. */
async function serve(
  m: Modules,
  options: Record<string, unknown>,
  sources: Record<string, unknown>,
  route: "core" | "plugin",
  log: string[] = [],
): Promise<Served | null> {
  // Test injection only: the synthetic transport and admission. The host keeps them and sets
  // its own levels, TTLs and cache store.
  m.passthrough.configurePassThrough({
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
  const env = await configFile(options, sources);
  let loaded;
  try {
    loaded = await m.api.loadApiPlugins({
      env,
      baseDirectory: fixtures,
      writeLog: (line) => log.push(line),
      exit: (code) => {
        throw new Error(`exit ${code}`);
      },
    });
  } catch {
    return null;
  }
  try {
    const config = loadConfig(env);
    const app = m.app.createApp(
      h.db,
      { premiumToken: undefined },
      { config, plugins: loaded.registries, store: loaded.cacheStore },
    );
    const response =
      route === "core"
        ? await app.request("/v1/drug-coverage", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              plan_ids: [plan],
              rxcuis: codes,
              year: 2026,
            }),
          })
        : await app.request(
            `/synthetic/passthrough/drug?plan=${plan}&rxcui=${codes[0]}`,
          );
    return {
      status: response.status,
      body: await response.json(),
      keys: (loaded.cacheStore as MemoryCache | undefined)?.keys() ?? [],
    };
  } finally {
    await loaded.teardown();
  }
}

const covered = (served: Served | null, key = "synthetic_passthrough") =>
  served?.status === 200 &&
  ((served.body as { results?: Record<string, unknown>[] }).results ?? [])
    .length === 2 &&
  (served.body as { results: Record<string, unknown>[] }).results.every(
    (r) => r.status === "listed_covered" && Boolean(r[key]),
  );

/** Each point by name. Returns the names of the points this run breaks. */
async function broken(m: Modules): Promise<string[]> {
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
  await check("A: a plugin source runs with the CMS switch off", async () => {
    vi.stubEnv("OPENPLANS_CMS_FALLBACK", "");
    return covered(await serve(m, { level: "none" }, {}, "core"));
  });
  await check(
    "B: the CMS source's reason does not hide answers from a plugin source",
    async () => {
      vi.stubEnv("OPENPLANS_CMS_FALLBACK", "on");
      vi.stubEnv("CMS_API_KEY", "");
      return covered(await serve(m, { level: "none" }, {}, "core"));
    },
  );
  await check(
    "C: the core's evidence block passes the response-column guard",
    async () => {
      vi.stubEnv("OPENPLANS_CMS_FALLBACK", "");
      const served = await serve(
        m,
        { level: "none", coreEvidence: true },
        {},
        "core",
      );
      const evidence = (
        served?.body as {
          results?: { passthrough?: Record<string, unknown> }[];
        }
      )?.results?.[0]?.passthrough;
      return (
        served?.status === 200 &&
        rowProvenanceLeaks(served.body).length === 0 &&
        typeof evidence?.retrieved_at === "string" &&
        !Number.isNaN(Date.parse(evidence.retrieved_at)) &&
        evidence.source_id === "synthetic-none"
      );
    },
  );
  await check("D: the API host applies the operator's level", async () => {
    vi.stubEnv("OPENPLANS_CMS_FALLBACK", "");
    const served = await serve(
      m,
      { level: "memory" },
      { "synthetic-memory": { cacheLevel: "request" } },
      "core",
    );
    const evidence = (
      served?.body as {
        results?: { synthetic_passthrough?: { level?: string } }[];
      }
    )?.results?.[0]?.synthetic_passthrough;
    return (
      served?.status === 200 &&
      evidence?.level === "request" &&
      !served.keys.some((k) => k.startsWith("openplans:passthrough:v1:"))
    );
  });
  await check("E: a looser level refuses the load", async () => {
    vi.stubEnv("OPENPLANS_CMS_FALLBACK", "");
    const log: string[] = [];
    const served = await serve(
      m,
      { level: "none" },
      { "synthetic-none": { cacheLevel: "memory" } },
      "plugin",
      log,
    );
    return (
      served === null &&
      log.includes(
        JSON.stringify({
          plugin: "@synthetic/passthrough",
          code: "passthrough_level_loosened",
          reason: "synthetic-none",
        }),
      )
    );
  });
  await check("F: the worker host applies the operator's level", async () => {
    m.passthrough.configurePassThrough({});
    const loaded = await m.worker.loadWorkerPlugins({
      env: await configFile(
        { level: "memory" },
        { "synthetic-memory": { cacheLevel: "none", ttl: "2 minutes" } },
      ),
      baseDirectory: fixtures,
      writeLog: () => {},
      exit: (code) => {
        throw new Error(`exit ${code}`);
      },
    });
    try {
      const settings = m.passthrough.passThroughHostSettings();
      return (
        JSON.stringify(settings.operatorLevels) ===
        JSON.stringify({ "synthetic-memory": "none" })
      );
    } finally {
      await loaded.teardown();
    }
  });
  return failed;
}

beforeAll(async () => {
  h = await setup();
  plan = h.catalog.plans[0].base_plan_id;
  const drugs = (await fixture("drugs")) as { rxnorm_id: string }[];
  codes = [drugs[0]!.rxnorm_id, drugs[1]!.rxnorm_id];
  scratch = await mkdtemp(join(tmpdir(), "openplans-synthetic-wiring-"));
  manifestPath = await writeManifest(scratch);
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
    DELETE FROM passthrough_answer;`);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const id of [
    "../../src/plugins/sources/passthrough.js",
    "../../src/ingest/cms-api/fallback.js",
    "../../src/plugins/api.js",
    "../../src/plugins/loader.js",
    "../../src/plugins/worker.js",
    "../../src/api/app.js",
  ])
    vi.doUnmock(id);
  vi.resetModules();
  const { configurePassThrough } =
    await import("../../src/plugins/sources/passthrough.js");
  configurePassThrough({});
  const registries = await import("../../src/plugins/registries.js");
  registries.activateRegistries(
    registries.freezeRegistries(registries.emptyRegistries()),
  );
});

describe("pass-through host wiring", () => {
  it("every point holds", async () => {
    vi.resetModules();
    expect(await broken(await modules())).toEqual([]);
  });

  it.each([
    [
      "the scope needs the CMS switch",
      "ingest/cms-api/fallback.ts",
      "if (!passThroughSourceIds().length) return undefined;",
      "return undefined;",
      [
        "A: a plugin source runs with the CMS switch off",
        "C: the core's evidence block passes the response-column guard",
        "D: the API host applies the operator's level",
      ],
    ],
    [
      "a later source reads the CMS source's reason",
      "plugins/sources/passthrough.ts",
      "result = await applySource(source, kind, answers, scope, served, now);",
      "result = await applySource(source, kind, out, scope, served, now);",
      ["B: the CMS source's reason does not hide answers from a plugin source"],
    ],
    [
      "sourced_at in the core's evidence block",
      "plugins/sources/passthrough.ts",
      "retrieved_at: result.sourcedAt,",
      "sourced_at: result.sourcedAt,",
      ["C: the core's evidence block passes the response-column guard"],
    ],
    [
      "the API host does not configure the core",
      "plugins/api.ts",
      "configureHostPassThrough({\n    ...loaded.passThrough,",
      "void configureHostPassThrough;\n  void ({",
      ["D: the API host applies the operator's level"],
    ],
    [
      "the loader ignores plugins[].sources",
      "plugins/loader.ts",
      "operatorSourcePolicies(config)",
      "{}",
      [
        "D: the API host applies the operator's level",
        "E: a looser level refuses the load",
        "F: the worker host applies the operator's level",
      ],
    ],
    [
      "the worker host does not configure the core",
      "plugins/worker.ts",
      "passthrough.configureHostPassThrough(loaded.passThrough);",
      "void passthrough;",
      ["F: the worker host applies the operator's level"],
    ],
  ] as const)(
    "a planted mutant fails a named point: %s",
    async (_name, file, before, after, points) => {
      const mutant = await plantMutant(src(file), before, after);
      try {
        // plantMutant rebases static imports; the hosts load some modules lazily.
        const copy = await readFile(mutant.path, "utf8");
        await writeFile(
          mutant.path,
          copy.replace(
            /import\(\s*"(\.\.?\/[^"]+)"\s*\)/g,
            (_all, path: string) =>
              `import(${JSON.stringify(new URL(path, src(file)).href)})`,
          ),
        );
        const id = `../../src/${file.replace(/\.ts$/, ".js")}`;
        const names = Object.keys(
          (await import(/* @vite-ignore */ id)) as object,
        );
        let planted: Record<string, unknown> = {};
        vi.resetModules();
        // The copy replaces the module for every importer; its exports are read when used.
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
        // Exactly the named points: a mutant that broke everything would prove nothing.
        expect(await broken(await modules())).toEqual(points);
      } finally {
        await mutant.cleanup();
      }
    },
  );
});

describe("several sources on one answer", () => {
  const local = (code: string) => ({
    status: "unknown",
    reason: "source_set_not_available",
    plan_id: "12345TX0010001",
    code,
    plan_year: 2026,
  });
  const refusing = (id: string) =>
    ({
      ...(syntheticSource("none") as Source),
      id,
      manifest: {
        host: "answers.synthetic.test",
        accessMode: "api-key",
        apiKeyEnv: "SYNTHETIC_UNSET_KEY",
        permittedPaths: ["/answers"],
      },
      reasons: { passthrough_not_configured: `${id}_not_configured` },
    }) as Source;
  function deps(sources: Source[], extra: Partial<PassThroughDeps> = {}) {
    return {
      sources: () => sources,
      fetchOptions: {
        transport,
        dataDir: scratch,
        lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      },
      admission: () =>
        new AdmissionSession([manifestPath], {
          maxRequests: 100,
          maxTransferBytes: 1024 ** 2,
        }),
      ...extra,
    } satisfies PassThroughDeps;
  }
  const scope = () => ({ reader: h.db, writer: h.db });

  it("a later source answers what an earlier one refused", async () => {
    const [answer] = await createPassThrough(
      deps([refusing("first"), syntheticSource("none") as Source]),
    ).apply("drug", [local("100")], scope());
    expect(answer).toMatchObject({
      status: "listed_covered",
      reason: null,
      synthetic_passthrough: { source_id: "synthetic-none" },
    });
  });

  it("the first refusal stays when no source answers", async () => {
    const [answer] = await createPassThrough(
      deps([refusing("first"), refusing("second")]),
    ).apply("drug", [local("100")], scope());
    expect(answer).toEqual({ ...local("100"), reason: "first_not_configured" });
    expect(calls).toHaveLength(0);
  });

  it("an answer served by an earlier source is kept and not asked again", async () => {
    const second = {
      ...(syntheticSource("none") as Source),
      id: "second",
    } as Source;
    const [answer] = await createPassThrough(
      deps([syntheticSource("none") as Source, second]),
    ).apply("drug", [local("100")], scope());
    expect(answer).toMatchObject({
      status: "listed_covered",
      synthetic_passthrough: { source_id: "synthetic-none" },
    });
    expect(calls).toHaveLength(1);
  });

  it("one source alone returns the same array when nothing is eligible", async () => {
    const answers = [{ ...local("100"), status: "listed_covered" }];
    expect(
      await createPassThrough(deps([syntheticSource("none") as Source])).apply(
        "drug",
        answers,
        scope(),
      ),
    ).toBe(answers);
  });
});

describe("operator TTLs at `memory`", () => {
  const memory = () => syntheticSource("memory") as Source;

  it("a shorter TTL is used for the shared cache entry", async () => {
    const settings = operatorPassThrough([memory()], {
      "synthetic-memory": { ttl: "2 minutes", negativeTtl: "30 seconds" },
    });
    expect(settings).toEqual({
      operatorLevels: {},
      operatorTtls: { "synthetic-memory": { ttl: 120, negativeTtl: 30 } },
    });
    const ttls: number[] = [];
    const store: CacheStore = {
      get: async () => null,
      set: async (_key, _value, ttl) => {
        ttls.push(ttl);
      },
      bytes: () => 0,
    };
    await createPassThrough({
      sources: () => [memory()],
      cacheStore: store,
      ...settings,
      fetchOptions: {
        transport,
        dataDir: scratch,
        lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      },
      admission: () =>
        new AdmissionSession([manifestPath], {
          maxRequests: 100,
          maxTransferBytes: 1024 ** 2,
        }),
    }).apply(
      "drug",
      [
        {
          status: "unknown",
          reason: "source_set_not_available",
          plan_id: "12345TX0010001",
          code: "100",
          plan_year: 2026,
        },
      ],
      { reader: h.db, writer: h.db },
    );
    expect(ttls).toEqual([120]);
  });

  it.each([
    [{ ttl: "1 hour" }],
    [{ negativeTtl: "5 minutes" }],
    [{ ttl: "not an interval" }],
  ])("a longer or unreadable TTL is refused: %j", (policy) => {
    expect(() =>
      operatorPassThrough([memory()], { "synthetic-memory": policy }),
    ).toThrow(PassThroughPolicyRefusal);
    expect(() =>
      operatorPassThrough([memory()], { "synthetic-memory": policy }),
    ).toThrow("passthrough_level_loosened: synthetic-memory");
  });

  it("TTLs at `stored` stay record policy settings, applied by the worker", () => {
    expect(
      operatorPassThrough([syntheticSource("stored") as Source], {
        "synthetic-stored": { ttl: "30 days" },
      }),
    ).toEqual({ operatorLevels: {}, operatorTtls: {} });
  });
});
