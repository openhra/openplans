import { PGlite } from "@electric-sql/pglite";
import {
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SqlSession } from "../../../src/db/database.js";
import type { Transport } from "../../../src/fetch/index.js";
import type { GeoFile } from "../../../src/ingest/geo/sources.js";
import { migrate } from "../../../src/db/migrate.js";
import {
  ingestGeo,
  createGeoRepository,
} from "../../../src/ingest/geo/index.js";
import {
  acquireGeoNames,
  ingestGeoNames,
  GEONAMES_SOURCE,
  GEONAMES_URL,
} from "../../../src/ingest/geo/geonames.js";
import { coreMigrations, testDatabase } from "../../pglite.js";
import { fixtureDirectory, fixtureFiles } from "./helpers.js";
import { syntheticZip } from "../../fixtures/fetch/generate.mjs";
import { createApp } from "../../../src/api/app.js";
import { importPufs } from "../../../src/ingest/puf/import.js";
import { fixtureFiles as pufFixtures } from "../../api/helpers.js";
import { ingestRatingRules } from "../../../src/ingest/rating-rules/index.js";

const db = testDatabase(new PGlite());
const KEY = "synthetic-cms-test-credential";
const lookup = async () => [{ address: "93.184.216.34", family: 4 as const }];
let directory: string,
  core: Awaited<ReturnType<typeof coreMigrations>>,
  file: GeoFile;
async function cutFile(): Promise<GeoFile> {
  const manifest = JSON.parse(
    await readFile(join(fixtureDirectory, "geonames-manifest.json"), "utf8"),
  );
  const path = join(fixtureDirectory, manifest.filename),
    body = await readFile(path);
  expect(createHash("sha256").update(body).digest("hex")).toBe(
    manifest.fixture_sha256,
  );
  return {
    path,
    metadata: {
      ...manifest.original_snapshot,
      snapshot_id: manifest.fixture_sha256,
      sha256: manifest.fixture_sha256,
      bytes: body.length,
    },
  };
}
const response = (status: number, body: string, headers = {}) => ({
  status,
  headers: { "content-type": "application/json", ...headers },
  body: Readable.from([body]),
});
const options = (transport: Transport) => ({
  year: 2026,
  dataDir: directory,
  fetchOptions: { lookup, transport },
});
async function cacheFiles(path: string): Promise<string> {
  let data = "";
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const next = join(path, entry.name);
    data += entry.isDirectory()
      ? await cacheFiles(next)
      : await readFile(next, "utf8");
  }
  return data;
}
beforeAll(async () => {
  core = await coreMigrations();
  directory = await mkdtemp(join(tmpdir(), "openplans-zip-fallback-"));
  await migrate(db, core.directory);
  await ingestGeo(db, { files: await fixtureFiles() });
  file = await cutFile();
  await ingestGeoNames(db, { file });
}, 30_000);
beforeEach(async () => {
  vi.stubEnv("CMS_API_KEY", "");
  await db.exec(`DELETE FROM cms_zip_lookup; DELETE FROM cms_zip_attempt; DELETE FROM zip_county_fallback WHERE source='cms_marketplace';
    UPDATE cms_zip_budget SET next_request_at='epoch',blocked_until='epoch',day_start=CURRENT_DATE,
      daily_requests=0,min_interval_ms=60000,max_daily_requests=100;`);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
afterAll(async () => {
  await db.close();
  await core.cleanup();
  await rm(directory, { recursive: true, force: true });
});

describe("ZIP fallback source order and provenance", () => {
  it("never reads a fallback row or calls CMS for a ZIP with a ZCTA", async () => {
    vi.stubEnv("CMS_API_KEY", KEY);
    const transport = vi.fn<Transport>();
    const guarded: SqlSession = {
      ...db,
      query: (sql, args) => {
        if (/cms_zip|geonames_import|zip_county_fallback/.test(sql))
          throw new Error("ZCTA consulted fallback");
        return db.query(sql, args);
      },
    };
    const result = await createGeoRepository(
      guarded,
      options(transport),
    ).zipToCounties("75034");
    expect(result.source).toBe("zcta");
    expect(result.counties.map((c) => c.county_fips)).toEqual([
      "48085",
      "48121",
    ]);
    expect(transport).not.toHaveBeenCalled();
  });
  it("returns real PO-box rows with attribution, no fabricated area shares, and leading zeroes", async () => {
    for (const [zip, fips] of [
      ["77001", "48201"],
      ["85001", "04013"],
      ["01001", "25013"],
    ]) {
      const result = await createGeoRepository(db).zipToCounties(zip!);
      expect(result).toMatchObject({
        zip,
        source: "geonames",
        geography: "postal_zip",
        status: "available",
        attribution: { publisher: "GeoNames", license: "CC BY 4.0" },
        counties: [
          {
            county_fips: fips,
            source: "geonames",
            zcta_land_share: null,
            arealand_part: null,
            snapshot_id: expect.any(String),
            source_row: expect.any(Number),
          },
        ],
      });
    }
    expect(await createGeoRepository(db).zipToCounties("00000")).toMatchObject({
      status: "unknown",
      source: null,
      counties: [],
    });
  });
  it("uses a synthetic CMS response ahead of GeoNames, caches it and never persists the credential", async () => {
    vi.stubEnv("CMS_API_KEY", KEY);
    const body = await readFile(
      join(fixtureDirectory, "cms-77001.synthetic.json"),
      "utf8",
    );
    const transport = vi.fn<Transport>(async (url, context) => {
      expect(url.pathname).toBe("/api/v1/counties/by/zip/77001");
      expect(url.searchParams.get("year")).toBe("2026");
      expect(url.searchParams.get("apikey")).toBe(KEY);
      expect(context.headers["user-agent"]).toMatch(/^openplans\/0\.3\.2 /);
      return response(200, body);
    });
    const guarded: SqlSession = {
      ...db,
      query: (sql, args) => {
        if (/geonames_import/.test(sql))
          throw new Error("CMS answer consulted GeoNames");
        return db.query(sql, args);
      },
    };
    const geo = createGeoRepository(guarded, options(transport));
    const result = await geo.zipToCounties("77001");
    expect(result).toMatchObject({
      source: "cms_marketplace",
      counties: [{ county_fips: "48201", source_row: 1 }],
    });
    expect(await geo.zipToCounties("77001")).toEqual(result);
    expect(transport).toHaveBeenCalledOnce();
    const snapshots = (
      await db.query(
        "SELECT requested_url,retrieved_at,sha256 FROM snapshot WHERE snapshot_id=$1",
        [result.counties[0]!.snapshot_id],
      )
    ).rows;
    expect(snapshots).toEqual([
      {
        requested_url:
          "https://marketplace.api.healthcare.gov/api/v1/counties/by/zip/77001?year=2026",
        retrieved_at: expect.any(Date),
        sha256: createHash("sha256").update(body).digest("hex"),
      },
    ]);
    expect(
      JSON.stringify((await db.query("SELECT * FROM cms_zip_lookup")).rows) +
        JSON.stringify(snapshots) +
        (await cacheFiles(join(directory, "raw"))),
    ).not.toContain(KEY);
    // Removing the configured key disables CMS, even when a previous key populated a cache.
    vi.stubEnv("CMS_API_KEY", "");
    expect(
      (await createGeoRepository(db, options(transport)).zipToCounties("77001"))
        .source,
    ).toBe("geonames");
  });
  it("retains the actual per-year CMS retrieval time when identical bytes reuse an older raw snapshot", async () => {
    vi.stubEnv("CMS_API_KEY", KEY);
    const body = await readFile(
      join(fixtureDirectory, "cms-77001.synthetic.json"),
      "utf8",
    );
    const transport = vi.fn<Transport>(async () => response(200, body));
    const opts = {
      ...options(transport),
      dataDir: join(directory, "cms-time-provenance"),
    };
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    await createGeoRepository(db, opts).zipToCounties("77001");
    await db.exec("UPDATE cms_zip_budget SET next_request_at='epoch'");
    vi.setSystemTime(new Date("2027-01-01T00:00:00Z"));
    const result = await createGeoRepository(db, {
      ...opts,
      year: 2027,
    }).zipToCounties("77001");
    expect(result.source).toBe("cms_marketplace");
    expect(transport).toHaveBeenCalledTimes(2);
    const row = (
      await db.query<{ retrieved_at: Date; requested_url: string }>(
        "SELECT retrieved_at,requested_url FROM snapshot WHERE snapshot_id=$1",
        [result.counties[0]!.snapshot_id],
      )
    ).rows[0]!;
    expect(row.requested_url).toContain("year=2027");
    expect(row.retrieved_at.getUTCFullYear()).toBe(2027);
  });
  it.each([401, 403, 429])(
    "records CMS %s, falls through, honors Retry-After across ZIPs, hides the key",
    async (status) => {
      vi.stubEnv("CMS_API_KEY", KEY);
      const transport = vi.fn<Transport>(async () =>
        response(status, JSON.stringify({ message: KEY }), {
          "retry-after": "7200",
        }),
      );
      const geo = createGeoRepository(db, options(transport));
      const result = await geo.zipToCounties("77001");
      expect(result.source).toBe("geonames");
      const failures = (await db.query("SELECT * FROM cms_zip_lookup")).rows;
      expect(failures).toEqual([
        expect.objectContaining({
          zip: "77001",
          outcome: "failed",
          http_status: status,
          failure_code: "http_status",
          snapshot_id: null,
        }),
      ]);
      expect(JSON.stringify(failures) + JSON.stringify(result)).not.toContain(
        KEY,
      );
      const attempts = (
        await db.query(
          "SELECT outcome,http_status,requested_url FROM cms_zip_attempt",
        )
      ).rows;
      expect(attempts).toEqual([
        expect.objectContaining({ outcome: "failed", http_status: status }),
      ]);
      expect(JSON.stringify(attempts)).not.toContain(KEY);
      expect((await geo.zipToCounties("85001")).source).toBe("geonames");
      expect(transport).toHaveBeenCalledOnce();
      expect(
        (
          await db.query(
            `SELECT blocked_until>=now()+interval '7190 seconds' AS respects_retry FROM cms_zip_budget`,
          )
        ).rows,
      ).toEqual([{ respects_retry: true }]);
    },
  );
  it("does not issue live calls for prefix/bulk use and lets an exact request fill its cache", async () => {
    vi.stubEnv("CMS_API_KEY", KEY);
    const transport = vi.fn<Transport>(async () =>
      response(
        200,
        await readFile(
          join(fixtureDirectory, "cms-77001.synthetic.json"),
          "utf8",
        ),
      ),
    );
    const cachedOnly = createGeoRepository(db, {
      ...options(transport),
      allowCmsLive: false,
    });
    expect((await cachedOnly.zipToCounties("77001")).source).toBe("geonames");
    expect(transport).not.toHaveBeenCalled();
    await createGeoRepository(db, options(transport)).zipToCounties("77001");
    expect((await cachedOnly.zipToCounties("77001")).source).toBe(
      "cms_marketplace",
    );
    expect(transport).toHaveBeenCalledOnce();
  });
  it("bounds live calls with the shared minute/day budget and retries expired cache only on demand", async () => {
    vi.stubEnv("CMS_API_KEY", KEY);
    const transport = vi.fn<Transport>(async () =>
      response(200, '{"_fixture":"synthetic empty","counties":[]}'),
    );
    const geo = createGeoRepository(db, options(transport));
    expect((await geo.zipToCounties("00000")).status).toBe("unknown");
    expect((await geo.zipToCounties("77001")).source).toBe("geonames");
    expect(transport).toHaveBeenCalledOnce();
    await db.exec(
      `UPDATE cms_zip_budget SET next_request_at='epoch',daily_requests=100`,
    );
    await geo.zipToCounties("77001");
    expect(transport).toHaveBeenCalledOnce();
    await db.exec(`UPDATE cms_zip_budget SET day_start=CURRENT_DATE-1`);
    await geo.zipToCounties("77001");
    expect(transport).toHaveBeenCalledTimes(2);
    await db.exec(
      `UPDATE cms_zip_lookup SET expires_at='epoch'; UPDATE cms_zip_budget SET next_request_at='epoch'`,
    );
    await geo.zipToCounties("77001");
    expect(transport).toHaveBeenCalledTimes(3);
    expect(
      (await db.query("SELECT COUNT(*)::int AS count FROM cms_zip_attempt"))
        .rows,
    ).toEqual([{ count: 3 }]);
  });
  it("rejects a malformed/mismatched CMS county and leaves absent sources unknown", async () => {
    vi.stubEnv("CMS_API_KEY", KEY);
    const transport = vi.fn<Transport>(async () =>
      response(
        200,
        '{"_fixture":"synthetic mutant","counties":[{"fips":"48201","state":"TX","name":"Harris","zipcode":"77001"}]}',
      ),
    );
    expect(
      await createGeoRepository(db, options(transport)).zipToCounties("00000"),
    ).toMatchObject({ status: "unknown", source: null, counties: [] });
    expect(
      (await db.query("SELECT outcome,failure_code FROM cms_zip_lookup")).rows,
    ).toEqual([{ outcome: "failed", failure_code: "invalid_response" }]);
  });
});

describe("GeoNames import and native/facade integration", () => {
  it("hash-caches and verifies ZIP content with no second request", async () => {
    const text = await readFile(file.path, "utf8");
    const archive = syntheticZip([
      { name: "US.txt", body: text },
      {
        name: "readme.txt",
        body: "synthetic test archive; rows are an unmodified real source cut",
      },
    ]);
    const transport = vi.fn<Transport>(async () => ({
      status: 200,
      headers: { "content-type": "application/zip" },
      body: Readable.from([archive]),
    }));
    const opts = {
      dataDir: join(directory, "acquire"),
      fetchOptions: { lookup, transport },
    };
    const first = await acquireGeoNames(opts),
      second = await acquireGeoNames(opts);
    expect(second.metadata.sha256).toBe(first.metadata.sha256);
    expect(transport).toHaveBeenCalledOnce();
    expect(first.metadata.source).toBe(GEONAMES_SOURCE);
    expect(first.metadata.url).toBe(GEONAMES_URL);
    expect((await ingestGeoNames(db, { file: first })).rows).toBe(5);
    // Restore the plain source cut for subsequent source-row assertions.
    await ingestGeoNames(db, { file });
  });
  it("negative controls: altered hash and four-digit county fail without changing the active snapshot", async () => {
    const before = (await db.query("SELECT * FROM geonames_import")).rows;
    await expect(
      ingestGeoNames(db, {
        file: {
          ...file,
          metadata: { ...file.metadata, sha256: "0".repeat(64) },
        },
      }),
    ).rejects.toThrow("hash");
    const path = join(directory, "geonames-mutant.tsv"),
      body = (await readFile(file.path, "utf8")).replace("\t201\t", "\t0201\t");
    await writeFile(path, body);
    await expect(
      ingestGeoNames(db, {
        file: {
          path,
          metadata: {
            ...file.metadata,
            sha256: createHash("sha256").update(body).digest("hex"),
            bytes: Buffer.byteLength(body),
          },
        },
      }),
    ).rejects.toThrow("county code");
    expect((await db.query("SELECT * FROM geonames_import")).rows).toEqual(
      before,
    );
  });
  it("serves labelled sources/attribution in native and additive facade fields; prefix never calls CMS", async () => {
    const token = "synthetic-fallback-token";
    vi.stubEnv("OPENPLANS_COMPAT_API_KEY", token);
    const app = createApp(db, { premiumToken: token });
    const native = await app.request("/v1/zip-counties?zip=77001");
    expect(await native.json()).toMatchObject({
      source: "geonames",
      attribution: { license: "CC BY 4.0" },
    });
    vi.stubEnv("CMS_API_KEY", KEY);
    const facade = await app.request(
      "/compat/v1/zip_counties?zip_prefix=7700",
      { headers: { "X-Api-Key": token } },
    );
    const body = (await facade.json()) as any;
    expect(
      body.zip_counties.find((r: any) => r.zip_code_id === 77001),
    ).toMatchObject({
      county_id: 48201,
      source: "geonames",
      attribution: { license: "CC BY 4.0" },
    });
    expect((await db.query("SELECT * FROM cms_zip_lookup")).rows).toEqual([]);
    expect(
      (await db.query("SELECT daily_requests FROM cms_zip_budget")).rows,
    ).toEqual([{ daily_requests: 0 }]);
  });
  it("resolves the fallback through real premium/plan source cuts without guessing plan availability", async () => {
    const imported = await importPufs(db, {
      year: 2026,
      state: "TX",
      files: await pufFixtures(directory),
      dataDir: directory,
    });
    expect(imported.status).toBe("ACTIVE");
    await ingestRatingRules(db);
    const token = "synthetic-fallback-premium-token",
      app = createApp(db, { premiumToken: token });
    const response = await app.request("/v1/premium-quotes", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        plan_ids: ["87226TX0100013"],
        zip: "77001",
        coverage_start: "2026-01-01",
        members: [{ age: 35, tobacco: false, relationship: "subscriber" }],
      }),
    });
    expect(response.status).toBe(200);
    expect(
      ((await response.json()) as ReturnType<typeof JSON.parse>).quotes[0],
    ).toMatchObject({
      status: "rated",
      total_cents: 52928,
    });
    const plans = await app.request("/v1/plans?zip=77001&year=2026");
    expect(await plans.json()).toMatchObject({
      status: "available",
      location: { county: "48201", counties: [{ source: "geonames" }] },
    });
  }, 30_000);
});
