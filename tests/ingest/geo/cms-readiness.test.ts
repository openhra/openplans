import { createHash } from "node:crypto";
import type * as Crypto from "node:crypto";
import { digestFixture, FIXED_TIME } from "../../plugins/fixture.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createResponseCache } from "../../../src/api/cache/index.js";
import { MemoryCache } from "../../../src/api/cache/store.js";
import { Readable } from "node:stream";
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
import * as fetchModule from "../../../src/fetch/index.js";
import type * as CmsRuntime from "../../../src/config/cms-fallback.js";
import {
  applyCmsFallback,
  cmsFallbackContext,
} from "../../../src/ingest/cms-api/fallback.js";
import type { DrugCoverage } from "../../../src/domain/drugs/index.js";
import type * as PassThroughModule from "../../../src/plugins/sources/passthrough.js";
import { passThrough } from "../../../src/plugins/sources/passthrough.js";
import {
  applyQuoteFallback,
  quoteFallbackEnabled,
} from "../../../src/services/quote-coverage.js";
import type { AdmissionManifest } from "../../../src/fetch/index.js";
import type { SqlSession } from "../../../src/db/database.js";
import type * as ShippedFetch from "../../../src/fetch/shipped.js";
import type * as FetchPolicy from "../../../src/fetch/policy.js";
import * as corePlugin from "../../../src/plugins/core-plugin.js";
import * as cms from "../../../src/ingest/geo/cms.js";
import * as appModule from "../../../src/api/app.js";
import { migratedTemplate } from "../../pglite.js";
import { importMutant, plantMutantFile } from "../../mutant-file.js";
import { replaceSyntax } from "../../source-mutation.js";

vi.mock("node:crypto", async (original) => {
  const module = await original<typeof Crypto>();
  return {
    ...module,
    randomUUID: () =>
      `00000000-0000-4000-8000-${String(++fixture.uuid).padStart(12, "0")}`,
  };
});

const fixture = vi.hoisted(() => ({
  runtime: undefined as typeof CmsRuntime | undefined,
  uuid: 0,
  manifest: "",
  manifestEnabled: true,
  clock: 0,
  next: new Map<string, number>(),
  paths: [] as string[],
  failTerms: false,
  failConnect: false,
  hasCounty: false,
  blockTerms: undefined as Promise<void> | undefined,
  realPacing: process.env.OPENPLANS_TEST_REAL_PACING === "1",
}));
const terms = "Synthetic publisher policy for the ZIP lookup cost test.";
vi.mock("../../../src/plugins/sources/passthrough.js", async (original) => {
  const module = await original<typeof PassThroughModule>();
  return {
    ...module,
    passThrough: {
      ...module.passThrough,
      apply: vi.fn(module.passThrough.apply),
    },
  };
});
vi.mock("../../../src/config/cms-fallback.js", () => ({
  cmsFallbackUnavailable: () =>
    fixture.runtime?.cmsFallbackUnavailable() ?? false,
  enableCmsFallback: () => fixture.runtime!.enableCmsFallback(),
  disableCmsFallback: (
    reason: Parameters<typeof CmsRuntime.disableCmsFallback>[0],
  ) => fixture.runtime!.disableCmsFallback(reason),
}));
vi.mock("../../../src/fetch/shipped.js", async (original) => ({
  ...(await original<typeof ShippedFetch>()),
  shippedManifestPaths: () =>
    fixture.manifestEnabled ? [fixture.manifest] : [],
}));
vi.mock("../../../src/fetch/policy.js", async (original) => ({
  ...(await original<typeof FetchPolicy>()),
  systemLookup: async () => [{ address: "93.184.216.34", family: 4 }],
}));
vi.mock("../../../src/fetch/transport.js", () => ({
  httpsTransport: async (url: URL) => {
    fixture.paths.push(url.host + url.pathname);
    if (fixture.failConnect)
      throw new Error(
        "synthetic-secret https://publisher.test/?apikey=synthetic-key",
      );
    if (url.pathname === "/terms") await fixture.blockTerms;
    let body = JSON.stringify({
      _fixture: `synthetic ${url.pathname}`,
      counties: fixture.hasCounty
        ? [
            {
              zipcode: url.pathname.split("/").at(-1),
              fips: "48201",
              state: "TX",
              name: "Synthetic County",
            },
          ]
        : [],
    });
    let status = 200;
    if (url.pathname === "/robots.txt") {
      body = "";
      if (url.host === "marketplace.api.healthcare.gov") status = 401;
    } else if (url.pathname === "/terms") {
      body = fixture.failTerms ? "changed policy" : terms;
    }
    return {
      status,
      headers: {
        "content-type":
          url.pathname === "/terms" ? "text/plain" : "application/json",
      },
      body: Readable.from([body]),
    };
  },
}));
vi.mock("../../../src/fetch/limiter.js", () => ({
  leaseHost: async (
    _dir: string,
    host: string,
    delay: number,
    floor = 5000,
  ) => {
    const start = fixture.clock;
    fixture.clock = Math.max(fixture.clock, fixture.next.get(host) ?? 0);
    if (fixture.realPacing)
      await new Promise((resolve) =>
        realSetTimeout(resolve, fixture.clock - start),
      );
    fixture.next.set(host, fixture.clock + Math.max(delay, floor));
    return async () => {};
  },
}));

let directory: string;
let runtimeCopy: Awaited<ReturnType<typeof plantMutantFile>> | undefined;
let warnings: string[];
let template: Awaited<ReturnType<typeof migratedTemplate>>;
let db: Awaited<ReturnType<typeof template.fresh>>;
const source = new URL("../../../src/ingest/geo/cms.ts", import.meta.url);
// Captured before any test fakes timers: cleanup waits in real time.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const runtimeSource = new URL(
  "../../../src/config/cms-fallback.ts",
  import.meta.url,
);
const digest = (s: string) => createHash("sha256").update(s).digest("hex");

beforeAll(async () => {
  template = await migratedTemplate();
});
afterAll(async () => {
  await template.close();
});
beforeEach(async () => {
  warnings = [];
  vi.spyOn(console, "warn").mockImplementation((line: string) => {
    warnings.push(line);
  });
  await freshRuntime();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(FIXED_TIME));
  vi.stubEnv("OPENPLANS_CMS_FALLBACK", "on");
  vi.stubEnv("OPENPLANS_CMS_FALLBACK_QUOTES", "on");
  directory = await mkdtemp(join(tmpdir(), "openplans-zip-policy-"));
  fixture.manifest = join(directory, "access.json");
  fixture.manifestEnabled = true;
  fixture.clock = 0;
  fixture.paths = [];
  fixture.next.clear();
  fixture.failTerms = false;
  fixture.failConnect = false;
  fixture.hasCounty = false;
  fixture.blockTerms = undefined;
  vi.stubEnv("CMS_API_KEY", "synthetic-zip-policy-key");
  vi.stubEnv("OPENPLANS_DATA_DIR", directory);
  vi.stubEnv("OPENPLANS_ACCESS_MANIFEST", "");
  const manifest: AdmissionManifest = {
    version: 1,
    publishers: [
      {
        host: "marketplace.api.healthcare.gov",
        state: "allowed",
        accessMode: "api-key",
        apiKey: { env: "CMS_API_KEY", queryParam: "apikey" },
        evidence: [
          {
            url: "https://policy.test/terms",
            observedAt: new Date().toISOString(),
            status: 200,
          },
        ],
        scope: { products: ["synthetic"], states: ["TX"], years: [2026] },
        discoveryUrls: ["https://policy.test/terms"],
        permittedPaths: ["/api/v1/counties/by/zip"],
        delegates: [],
        attribution: "Synthetic test",
        updatePolicy: "Recheck daily",
        delayMs: 1000,
        jobCaps: { maxRequests: 200, maxTransferBytes: 50 * 1024 ** 2 },
        robots: {
          url: "https://marketplace.api.healthcare.gov/robots.txt",
          status: 401,
          sha256: null,
          checkedAt: new Date().toISOString(),
          notApplicable: "Synthetic keyed API returns 401",
        },
        terms: {
          url: "https://policy.test/terms",
          disposition: "allowed",
          sha256: digest(terms),
          reviewedAt: new Date(Date.now() - 1000).toISOString(),
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
        },
      },
    ],
  };
  await writeFile(fixture.manifest, JSON.stringify(manifest));
  db = await template.fresh();
});
afterEach(async () => {
  await db.close();
  await runtimeCopy?.cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

async function freshRuntime(mutation?: [string, string]) {
  await runtimeCopy?.cleanup();
  const text = await readFile(runtimeSource, "utf8");
  runtimeCopy = await plantMutantFile(
    runtimeSource,
    mutation ? replaceSyntax(text, ...mutation) : text,
  );
  fixture.runtime = await importMutant<typeof CmsRuntime>(
    runtimeCopy.url,
    "cmsFallbackUnavailable",
    "disableCmsFallback",
  );
}

// A fresh module gives each scenario its own process-lifetime policy session.
async function withCms(
  run: (module: typeof cms) => Promise<void>,
  mutation?: [string, string],
) {
  const text = await readFile(source, "utf8");
  const planted = await plantMutantFile(
    source,
    mutation ? replaceSyntax(text, ...mutation) : text,
  );
  try {
    await run(
      await importMutant<typeof cms>(
        planted.url,
        "warmCmsZipLookup",
        "prepareCmsZipFallback",
        "cmsCountySnapshot",
      ),
    );
  } finally {
    const module = await importMutant<typeof cms>(
      planted.url,
      "stopCmsZipPreparation",
      "cmsZipPreparationSettled",
    );
    module.stopCmsZipPreparation();
    // A released publisher response may still be writing its cache; let it settle before the
    // data directory goes away. A blocked attempt that nothing releases cannot hold cleanup.
    let timer: ReturnType<typeof realSetTimeout> | undefined;
    try {
      await Promise.race([
        module.cmsZipPreparationSettled(),
        new Promise<void>((resolve) => {
          timer = realSetTimeout(resolve, 5000);
        }),
      ]);
    } finally {
      realClearTimeout(timer);
    }
    await planted.cleanup();
  }
}

async function boundedLookup(module: typeof cms) {
  const preparing = performance.now();
  await module.warmCmsZipLookup();
  if (fixture.realPacing)
    console.log(
      `ZIP readiness preparation: ${(performance.now() - preparing).toFixed(1)}ms`,
    );
  expect(fixture.paths).toEqual([
    "marketplace.api.healthcare.gov/robots.txt",
    "policy.test/robots.txt",
    "policy.test/terms",
  ]);
  expect((await db.query("SELECT * FROM cms_zip_lookup")).rows).toEqual([]);
  const start = fixture.clock;
  const wall = performance.now();
  const spy = vi
    .spyOn(cms, "cmsCountySnapshot")
    .mockImplementation(module.cmsCountySnapshot);
  try {
    const app = appModule.createApp(db, {});
    const result = await app.request("/v1/zip-counties?zip=00987", {
      headers: { Authorization: "Bearer synthetic-zip-policy" },
    });
    expect(result.status).toBe(200);
    expect(await result.text()).toBe(
      '{"zip":"00987","status":"unknown","geography":"2020_zcta","source":null,"counties":[]}',
    );
  } finally {
    spy.mockRestore();
  }
  const elapsed = fixture.clock - start;
  if (fixture.realPacing)
    console.log(
      `ZIP lookup: policy pacing ${elapsed}ms, wall ${(performance.now() - wall).toFixed(1)}ms`,
    );
  expect(elapsed).toBeLessThan(1000);
  expect(performance.now() - wall).toBeLessThan(1000);
  expect(fixture.paths.slice(3)).toEqual([
    "marketplace.api.healthcare.gov/api/v1/counties/by/zip/00987",
  ]);
  const calls = fixture.paths.length;
  const warm = performance.now();
  expect(await module.cmsCountySnapshot(db, "00987")).toBeNull();
  if (fixture.realPacing)
    console.log(
      `ZIP cached lookup: ${(performance.now() - warm).toFixed(1)}ms`,
    );
  expect(fixture.paths).toHaveLength(calls);
  await db.exec("UPDATE cms_zip_budget SET next_request_at='epoch'");
  fixture.clock += 1000;
  expect(await module.cmsCountySnapshot(db, "00000")).toBeNull();
  expect(fixture.paths.slice(calls)).toEqual([
    "marketplace.api.healthcare.gov/api/v1/counties/by/zip/00000",
  ]);
  await module.warmCmsZipLookup();
  expect(fixture.paths).toHaveLength(calls + 1);
}

describe("ZIP lookup policy cost", () => {
  it("moves policy pacing into preparation and reuses it for uncached ZIPs", async () => {
    await withCms(boundedLookup);
  });
  it("rejects the old per-fetch session cost even after a warm-up", async () => {
    await withCms(
      async (module) => {
        await expect(boundedLookup(module)).rejects.toThrow(
          /expected (5000|10000|20000) to be less than 1000/,
        );
      },
      [
        "Date.now() - current.created < SESSION_MAX_AGE_MS",
        "Date.now() - current.created < 0",
      ],
    );
  });
  it("reproduces the mandatory five-second cold cost without preparation", async () => {
    // Measure policy pacing independently of the request's 250ms deadline. Real I/O under
    // sibling workers can exhaust that deadline before the synthetic publisher responds.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date(FIXED_TIME));
    await withCms(async (module) => {
      const cold = performance.now();
      expect(await module.cmsCountySnapshot(db, "00987")).toBeNull();
      expect(fixture.clock).toBe(5000);
      if (fixture.realPacing)
        console.log(
          `ZIP unprepared cold lookup: ${(performance.now() - cold).toFixed(1)}ms`,
        );
      const warm = performance.now();
      expect(await module.cmsCountySnapshot(db, "00987")).toBeNull();
      expect(fixture.clock).toBe(5000);
      expect(fixture.paths).toHaveLength(4);
      if (fixture.realPacing)
        console.log(
          `ZIP unprepared cached lookup: ${(performance.now() - warm).toFixed(1)}ms`,
        );
    });
  });
  it("does no policy work when the optional key is absent", async () => {
    vi.stubEnv("CMS_API_KEY", "");
    await withCms(async (module) => {
      await module.warmCmsZipLookup();
      expect(fixture.paths).toEqual([]);
    });
  });
  it("does not retain clearance when its configured manifest is withdrawn", async () => {
    await withCms(async (module) => {
      await module.warmCmsZipLookup();
      fixture.manifestEnabled = false;
      await expect(module.warmCmsZipLookup()).rejects.toThrow();
      expect(fixture.paths).toHaveLength(3);
    });
  });
  it("fails closed if the publisher terms change", async () => {
    fixture.failTerms = true;
    await withCms(async (module) => {
      await expect(module.warmCmsZipLookup()).rejects.toThrow(
        "Publisher terms changed",
      );
      expect(fixture.paths.some((path) => path.includes("/api/v1/"))).toBe(
        false,
      );
    });
  });
});

const schema = {
  status: async () => ({ state: "ready" as const, pending: 0 }),
  middleware: async (_c: unknown, next: () => Promise<void>) => next(),
};

async function withApp(
  module: typeof cms,
  run: (app: ReturnType<typeof appModule.createApp>) => Promise<void>,
  database: SqlSession = db,
) {
  const prepare = vi
    .spyOn(cms, "prepareCmsZipFallback")
    .mockImplementation(module.prepareCmsZipFallback);
  const lookup = vi
    .spyOn(cms, "cmsCountySnapshot")
    .mockImplementation(module.cmsCountySnapshot);
  try {
    await run(appModule.createApp(database, {}, undefined, schema));
  } finally {
    prepare.mockRestore();
    lookup.mockRestore();
  }
}

async function withinReadinessBound(
  request: Promise<Response>,
): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error("Readiness did not become ready within 250ms")),
          250,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function expectReady(app: ReturnType<typeof appModule.createApp>) {
  const response = await withinReadinessBound(
    Promise.resolve(app.request("/readyz")),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.text()).toBe('{"status":"ready"}');
}

async function expectAvailabilityDigest(
  app: ReturnType<typeof appModule.createApp>,
  stage: string,
) {
  const recorded = JSON.parse(
    await readFile(
      new URL(
        "../../fixtures/plugins/response-digests-cms-on.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as Record<string, { body_sha256: string }>;
  const path = "/v1/data-availability?state=TX&year=2026";
  // The immutable corpus records the opt-in switch with no credential. Keep its exact
  // configuration for the byte check, then check the credentialed response too.
  vi.stubEnv("CMS_API_KEY", "");
  try {
    const response = await app.request(path);
    expect(response.status).toBe(200);
    expect(digest(await response.text()), stage).toBe(
      recorded.availability!.body_sha256,
    );
  } finally {
    vi.stubEnv("CMS_API_KEY", "synthetic-zip-policy-key");
  }
  const configured = await app.request(path);
  const rows = (await configured.json()) as {
    cms_api?: { configured: boolean };
  }[];
  expect(rows.length).toBeGreaterThan(0);
  expect(
    rows.every((row) => row.cms_api?.configured === true),
    stage,
  ).toBe(true);
}

async function availabilityDuringTimeout(module: typeof cms) {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date(FIXED_TIME));
  fixture.uuid = 0;
  const data = await digestFixture();
  let release!: () => void;
  fixture.blockTerms = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await withApp(
      module,
      async (app) => {
        await vi.waitFor(() =>
          expect(fixture.paths).toContain("policy.test/terms"),
        );
        await expectReady(app);
        await expectAvailabilityDigest(app, "pending policy");
        const early = Promise.resolve(
          app.request("/v1/zip-counties?zip=00987"),
        );
        await vi.advanceTimersByTimeAsync(module.CMS_POLICY_PREPARE_MS);
        expect((await early).status).toBe(200);
        expect(fixture.paths.some((path) => path.includes("/api/v1/"))).toBe(
          false,
        );
        await expectAvailabilityDigest(app, "policy timeout");
        await expectReady(app);
        expect(warnings).toContain(
          JSON.stringify({
            event: "cms_policy_preparation_failed",
            reason: "policy_timeout",
          }),
        );
        expect(fixture.runtime!.cmsFallbackUnavailable()).toBe(false);
        const cached: SqlSession = {
          query: async <Row extends Record<string, unknown>>() => ({
            rows: [
              {
                snapshot_id: "synthetic-stored-cms",
                outcome: "available",
                fresh: true,
              } as unknown as Row,
            ],
          }),
          exec: async () => {},
        };
        expect(await module.cmsCountySnapshot(cached, "77001")).toBe(
          "synthetic-stored-cms",
        );
        // A late policy response belongs to the retired attempt, never the next session.
        release();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(fixture.runtime!.cmsFallbackUnavailable()).toBe(false);
      },
      data.db,
    );
  } finally {
    module.stopCmsZipPreparation();
    release();
    await data.close();
    vi.useRealTimers();
  }
}

describe("optional CMS policy readiness", () => {
  it("is ready while background preparation is pending and shares it with an early lookup", async () => {
    let release!: () => void;
    fixture.blockTerms = new Promise<void>((resolve) => {
      release = resolve;
    });
    await withCms(async (module) => {
      await withApp(module, async (app) => {
        await vi.waitFor(() =>
          expect(fixture.paths).toContain("policy.test/terms"),
        );
        await expectReady(app);
        const first = module.prepareCmsZipFallback();
        expect(module.prepareCmsZipFallback()).toBe(first);
        const request = Promise.resolve(
          app.request("/v1/zip-counties?zip=00987"),
        );
        try {
          expect(fixture.paths.some((path) => path.includes("/api/v1/"))).toBe(
            false,
          );
          release();
          expect(await first).toBe(true);
          expect((await request).status).toBe(200);
          expect(fixture.paths).toHaveLength(4);
          expect(warnings).toEqual([]);
        } finally {
          release();
          await request;
        }
      });
    });
  });
  it("serves the first ZIP in under one second after successful startup preparation", async () => {
    await withCms(async (module) => {
      await withApp(module, async (app) => {
        expect(await module.prepareCmsZipFallback()).toBe(true);
        const clock = fixture.clock;
        const started = performance.now();
        const response = await app.request("/v1/zip-counties?zip=00987");
        expect(response.status).toBe(200);
        expect(performance.now() - started).toBeLessThan(1000);
        expect(fixture.clock - clock).toBeLessThan(1000);
        expect(fixture.paths).toHaveLength(4);
      });
    });
  });
  it("preserves the recorded availability bytes during a policy timeout", async () => {
    await withCms(availabilityDuringTimeout);
  });
  it.each(["success", "network_failure"] as const)(
    "preserves recorded availability after %s",
    async (outcome) => {
      fixture.failConnect = outcome === "network_failure";
      fixture.uuid = 0;
      const data = await digestFixture();
      try {
        await withCms(async (module) => {
          await withApp(
            module,
            async (app) => {
              expect(await module.prepareCmsZipFallback()).toBe(
                outcome === "success",
              );
              await expectReady(app);
              await expectAvailabilityDigest(app, outcome);
            },
            data.db,
          );
        });
      } finally {
        await data.close();
      }
    },
  );
  it("rejects the old disable-on-timeout availability regression", async () => {
    const original = new URL(
      "../../../src/plugins/core-plugin.ts",
      import.meta.url,
    );
    const planted = await plantMutantFile(
      original,
      replaceSyntax(
        await readFile(original, "utf8"),
        "if (!loadConfig().cmsFallback.enabled) return [];",
        "if (!loadConfig().cmsFallback.enabled || cmsFallbackUnavailable()) return [];",
      ),
    );
    const old = await importMutant<typeof corePlugin>(
      planted.url,
      "implicitPassThroughSources",
    );
    const sources = vi
      .spyOn(corePlugin, "implicitPassThroughSources")
      .mockImplementation(old.implicitPassThroughSources);
    try {
      await withCms(
        async (module) => {
          await expect(availabilityDuringTimeout(module)).rejects.toThrow(
            /policy timeout/,
          );
        },
        [
          'session?.stop(); if (error instanceof FetchError && error.code === "admission_denied") disableCmsFallback("policy_failed");',
          "session?.stop(); disableCmsFallback(reason);",
        ],
      );
    } finally {
      sources.mockRestore();
      await planted.cleanup();
    }
  });
  it("retries a failed background attempt and restores live ZIP fallback", async () => {
    fixture.failConnect = true;
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    await withCms(async (module) => {
      await withApp(module, async (app) => {
        expect(await module.prepareCmsZipFallback()).toBe(false);
        await expectReady(app);
        const failedCalls = fixture.paths.length;
        await vi.advanceTimersByTimeAsync(999);
        expect(fixture.paths).toHaveLength(failedCalls);
        fixture.failConnect = false;
        fixture.hasCounty = true;
        await vi.advanceTimersByTimeAsync(1);
        expect(await module.prepareCmsZipFallback()).toBe(true);
        expect(fetchModule.cmsFallbackEnabled()).toBe(true);
        expect((await app.request("/v1/zip-counties?zip=00987")).status).toBe(
          200,
        );
        expect(fixture.paths.at(-1)).toContain("/api/v1/counties/by/zip/00987");
        expect(
          (await db.query("SELECT county_fips FROM zip_county_fallback")).rows,
        ).toEqual([{ county_fips: "48201" }]);
      });
    });
  });
  it("does no policy work for a cached-only caller while fallback is held", async () => {
    await withCms(async (module) => {
      expect(await module.prepareCmsZipFallback()).toBe(true);
      fixture.runtime!.disableCmsFallback("policy_failed");
      const calls = fixture.paths.length;
      expect(
        await module.cmsCountySnapshot(db, "77001", { allowCmsLive: false }),
      ).toBeNull();
      expect(fixture.paths).toHaveLength(calls);
    });
  });
  it("caps repeated failure backoff at one minute", async () => {
    fixture.failConnect = true;
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    await withCms(async (module) => {
      expect(await module.prepareCmsZipFallback()).toBe(false);
      for (const delay of [
        1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000,
      ]) {
        const calls = fixture.paths.length;
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(fixture.paths).toHaveLength(calls);
        await vi.advanceTimersByTimeAsync(1);
        await module.prepareCmsZipFallback();
        expect(fixture.paths).toHaveLength(calls + 1);
      }
    });
  });
  it.each(["drug", "quote", "quote-drug"] as const)(
    "discards an in-flight %s fallback result after CMS is disabled",
    async (kind) => {
      const drugs: DrugCoverage[] = [
        {
          status: "unknown",
          reason: "synthetic-off",
          base_hios_id: null,
          requested_plan_id: "synthetic-plan",
          rxcui: "0",
          plan_year: 2026,
          tier_status: null,
          cost_sharing: null,
          drug_tier: null,
          prior_authorization: null,
          step_therapy: null,
          quantity_limit: null,
          patient_price: null,
          evidence: [],
          snapshot_id: null,
          manifest_snapshot_id: null,
        },
      ];
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const apply = vi
        .spyOn(passThrough, "apply")
        .mockImplementation(async (_kind, answers) => {
          if (kind === "quote-drug" && _kind === "provider") return answers;
          await blocked;
          return answers.map((answer) => ({
            ...answer,
            reason: "synthetic-late",
          }));
        });
      apply.mockClear();
      const context = cmsFallbackContext(db, db)!;
      const quotes = [{ providers: [], drugs }];
      const request =
        kind === "drug"
          ? applyCmsFallback("drug", drugs, context)
          : applyQuoteFallback(quotes, context);
      try {
        await vi.waitFor(() =>
          expect(apply).toHaveBeenCalledTimes(kind === "quote-drug" ? 2 : 1),
        );
        fixture.runtime!.disableCmsFallback("policy_failed");
        release();
        expect(await request).toEqual(kind === "drug" ? drugs : quotes);
      } finally {
        release();
        await request;
        apply.mockRestore();
      }
    },
  );
  it("stops serving earlier shared responses after this process disables CMS", async () => {
    const cache = createResponseCache(db, undefined, {
      store: new MemoryCache(1024 * 1024),
    });
    const app = new Hono();
    app.use("*", cache.middleware);
    let source = "synthetic-cms";
    app.get("/v1/zip-counties", (c) => c.json({ source }));
    const request = () => app.request("/v1/zip-counties?zip=00987");
    expect((await request()).headers.get("X-Cache")).toBe("miss");
    expect((await request()).headers.get("X-Cache")).toBe("hit");
    const catalog = () =>
      cache.catalog(
        {
          namespace: "synthetic",
          version: "1",
          generation: "1",
          query: {},
          authorized: () => true,
          accept: (value: unknown): value is string =>
            typeof value === "string",
          ttlSeconds: 300,
        },
        async () => source,
      );
    expect(await catalog()).toBe("synthetic-cms");
    source = "synthetic-local";
    expect(await catalog()).toBe("synthetic-cms");
    fixture.runtime!.disableCmsFallback("policy_failed");
    const response = await request();
    expect(response.headers.get("X-Cache")).toBe("miss");
    expect(await response.text()).toBe('{"source":"synthetic-local"}');
    expect((await request()).headers.get("X-Cache")).toBe("hit");
    expect(await catalog()).toBe("synthetic-local");
    expect(warnings).toHaveLength(1);
  });
  it("keeps availability configured but blocks stored and live fallback after changed terms", async () => {
    fixture.failTerms = true;
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date(FIXED_TIME));
    fixture.uuid = 0;
    const data = await digestFixture();
    try {
      await withCms(async (module) => {
        await withApp(
          module,
          async (app) => {
            expect(await module.prepareCmsZipFallback()).toBe(false);
            await expectReady(app);
            await expectAvailabilityDigest(app, "changed terms or recovery");
            const stored: SqlSession = {
              query: async () => {
                throw new Error(
                  "Stored CMS must not be read after policy denial",
                );
              },
              exec: async () => {},
            };
            expect(await module.cmsCountySnapshot(stored, "77001")).toBeNull();
            expect(fetchModule.cmsFallbackEnabled()).toBe(false);
            expect(quoteFallbackEnabled()).toBe(false);
            expect(
              fixture.paths.some((path) => path.includes("/api/v1/")),
            ).toBe(false);
            fixture.failTerms = false;
            await vi.advanceTimersByTimeAsync(1000);
            expect(await module.prepareCmsZipFallback()).toBe(true);
            expect(fetchModule.cmsFallbackEnabled()).toBe(true);
            await expectAvailabilityDigest(app, "changed terms or recovery");
          },
          data.db,
        );
      });
    } finally {
      await data.close();
    }
  });
});

const UNKNOWN_ZIP =
  '{"zip":"00987","status":"unknown","geography":"2020_zcta","source":null,"counties":[]}';

/** Issue a cold ZIP request under faked timers and demand an answer before one faked second
 * passes. The clock only moves once the request has scheduled its own bound timer, so real
 * database reads never eat the budget; a request that waits on the six-second publisher
 * attempt schedules none and is still pending when the real-time cap ends the wait. */
async function coldZipWithin(
  app: ReturnType<typeof appModule.createApp>,
  ms: number,
): Promise<Response> {
  let settled: Response | undefined;
  const wall = performance.now();
  const timers = vi.getTimerCount();
  const request = Promise.resolve(app.request("/v1/zip-counties?zip=00987"));
  void request.then((response) => {
    settled = response;
  });
  for (let advanced = 0; advanced < ms && !settled;) {
    if (performance.now() - wall > 1000) break;
    if (vi.getTimerCount() > timers) {
      await vi.advanceTimersByTimeAsync(10);
      advanced += 10;
    } else {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  if (!settled)
    throw new Error(`Cold ZIP request did not answer within ${ms}ms`);
  expect(performance.now() - wall).toBeLessThan(1000);
  return settled;
}

async function expectUnknownWithoutLiveCall(response: Response) {
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(UNKNOWN_ZIP);
  // The answer skipped a configured source: no shared cache may serve it after recovery.
  expect(response.headers.get("X-Cache")).toBe("bypass");
  expect(fixture.paths.some((path) => path.includes("/api/v1/"))).toBe(false);
}

/** Once the blocked publisher answers, the shared attempt completes and the next request
 * uses the live fallback: the bound skipped one request, not the feature. */
async function expectRecovery(
  module: typeof cms,
  app: ReturnType<typeof appModule.createApp>,
  release: () => void,
) {
  release();
  expect(await module.prepareCmsZipFallback()).toBe(true);
  const response = await app.request("/v1/zip-counties?zip=00987");
  expect(response.status).toBe(200);
  expect(fixture.paths.at(-1)).toBe(
    "marketplace.api.healthcare.gov/api/v1/counties/by/zip/00987",
  );
}

function blockPublisher(): () => void {
  let release!: () => void;
  fixture.blockTerms = new Promise<void>((resolve) => {
    release = resolve;
  });
  return release;
}

async function coldZipWhilePending(module: typeof cms) {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date(FIXED_TIME));
  const release = blockPublisher();
  try {
    await withApp(module, async (app) => {
      await vi.waitFor(() =>
        expect(fixture.paths).toContain("policy.test/terms"),
      );
      await expectReady(app);
      await expectUnknownWithoutLiveCall(await coldZipWithin(app, 999));
      expect(warnings).toEqual([]);
      await expectRecovery(module, app, release);
    });
  } finally {
    release();
  }
}

async function coldZipWhileRetryingAfterTimeout(module: typeof cms) {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date(FIXED_TIME));
  const release = blockPublisher();
  try {
    await withApp(module, async (app) => {
      await vi.waitFor(() =>
        expect(fixture.paths).toContain("policy.test/terms"),
      );
      await vi.advanceTimersByTimeAsync(module.CMS_POLICY_PREPARE_MS);
      expect(warnings).toContain(
        JSON.stringify({
          event: "cms_policy_preparation_failed",
          reason: "policy_timeout",
        }),
      );
      // The one-second retry is now in flight and blocked on the publisher again.
      const attempts = fixture.paths.length;
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() =>
        expect(fixture.paths.length).toBeGreaterThan(attempts),
      );
      await expectReady(app);
      await expectUnknownWithoutLiveCall(await coldZipWithin(app, 999));
      await expectRecovery(module, app, release);
    });
  } finally {
    release();
  }
}

async function coldZipWhileRetryingAfterFailure(module: typeof cms) {
  fixture.failConnect = true;
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date(FIXED_TIME));
  let release: (() => void) | undefined;
  try {
    await withApp(module, async (app) => {
      expect(await module.prepareCmsZipFallback()).toBe(false);
      expect(warnings).toContain(
        JSON.stringify({
          event: "cms_policy_preparation_failed",
          reason: "policy_failed",
        }),
      );
      // The retry reaches the publisher, which now answers slowly.
      fixture.failConnect = false;
      release = blockPublisher();
      const attempts = fixture.paths.length;
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() =>
        expect(fixture.paths.length).toBeGreaterThan(attempts),
      );
      await expectReady(app);
      await expectUnknownWithoutLiveCall(await coldZipWithin(app, 999));
      await expectRecovery(module, app, release);
    });
  } finally {
    release?.();
  }
}

describe("cold ZIP request bound", () => {
  it("answers from loaded data while policy preparation is pending", async () => {
    await withCms(coldZipWhilePending);
  });
  it("answers from loaded data while a timed-out preparation retries", async () => {
    await withCms(coldZipWhileRetryingAfterTimeout);
  });
  it("answers from loaded data while a failed preparation retries", async () => {
    await withCms(coldZipWhileRetryingAfterFailure);
  });
  it("still shares a preparation that finishes within the bound", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date(FIXED_TIME));
    const release = blockPublisher();
    await withCms(async (module) => {
      await withApp(module, async (app) => {
        await vi.waitFor(() =>
          expect(fixture.paths).toContain("policy.test/terms"),
        );
        const request = Promise.resolve(
          app.request("/v1/zip-counties?zip=00987"),
        );
        release();
        expect((await request).status).toBe(200);
        expect(fixture.paths.at(-1)).toBe(
          "marketplace.api.healthcare.gov/api/v1/counties/by/zip/00987",
        );
        expect(warnings).toEqual([]);
      });
    });
  });
  const scenarios = [
    ["pending preparation", coldZipWhilePending],
    ["a timed-out preparation", coldZipWhileRetryingAfterTimeout],
    ["a failed preparation", coldZipWhileRetryingAfterFailure],
  ] as const;
  const mutants = [
    [
      "the unbounded wait on the shared attempt",
      "!(await cmsZipFallbackPrepared())",
      "!(await prepareCmsZipFallback())",
    ],
    [
      "a bound as long as the attempt itself",
      "CMS_REQUEST_PREPARE_WAIT_MS = 250",
      "CMS_REQUEST_PREPARE_WAIT_MS = 6_000",
    ],
  ] as const;
  it.each(
    mutants.flatMap(([name, before, after]) =>
      scenarios.map(([state, scenario]) => ({
        name,
        state,
        scenario,
        mutation: [before, after] as [string, string],
      })),
    ),
  )("rejects $name under $state", async ({ scenario, mutation }) => {
    await withCms(async (module) => {
      await expect(scenario(module)).rejects.toThrow(
        /did not answer within 999ms/,
      );
    }, mutation);
  });
  it("rejects storing the bounded answer in the shared cache", async () => {
    await withCms(
      async (module) => {
        await expect(coldZipWhilePending(module)).rejects.toThrow(
          /expected 'miss' to be 'bypass'/,
        );
      },
      ['restrictCacheLevel("request");', "void 0;"],
    );
  });
});
