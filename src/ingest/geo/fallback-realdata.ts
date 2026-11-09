#!/usr/bin/env node
/** Explicit real-data check: bulk GeoNames/Census; at most the two requested live CMS ZIPs.
 * Run after build: node dist/ingest/geo/fallback-realdata.js. Never a ZIP-range crawler. */
import { PGlite } from "@electric-sql/pglite";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database, SqlSession } from "../../db/database.js";
import { migrationsDirectory } from "../../db/migrate.js";
import { fetchToCache } from "../../fetch/index.js";
import { runGeo } from "./command.js";
import { acquireGeoNames, geoNamesRows, geoNamesStream } from "./geonames.js";
import { cachedHash, dataDirectory, GEO_SOURCES } from "./sources.js";
import { relationships } from "./parse.js";
import { createGeoRepository } from "./repository.js";
import { ingestGeo } from "./index.js";

const dataDir = dataDirectory(),
  directory = await mkdtemp(join(tmpdir(), "openplans-p2f-migrations-"));
let db: Database | undefined, databasePath: string | undefined;
try {
  for (const name of await readdir(migrationsDirectory))
    if (name.endsWith(".sql") && name !== "002_postgis.sql") {
      await cp(join(migrationsDirectory, name), join(directory, name));
    }
  await mkdir(join(dataDir, "work"), { recursive: true });
  databasePath = await mkdtemp(join(dataDir, "work", "p2f-geo-"));
  const pg = new PGlite(databasePath);
  const session: SqlSession = {
    query: (sql, args) => pg.query(sql, args),
    exec: async (sql) => {
      await pg.exec(sql);
    },
  };
  db = {
    ...session,
    close: () => pg.close(),
    transaction: (run) =>
      pg.transaction((tx) =>
        run({
          query: (sql, args) => tx.query(sql, args),
          exec: async (sql) => {
            await tx.exec(sql);
          },
        }),
      ),
  };
  let imported: unknown;
  const code = await runGeo(
    ["--source", "geonames"],
    () => ({ ...db!, close: async () => {} }),
    {
      out: (message) => {
        imported = JSON.parse(message);
      },
      error: (message) => {
        console.error(message);
      },
    },
    directory,
  );
  if (code !== 0) throw new Error("GeoNames worker import failed");
  await ingestGeo(db, { state: "TX", dataDir });
  const file = await acquireGeoNames({ dataDir }),
    postal = new Map<string, Set<string>>();
  for await (const row of geoNamesRows(geoNamesStream(file)))
    if (row) {
      if (!postal.has(row.zip)) postal.set(row.zip, new Set());
      postal.get(row.zip)!.add(row.county_fips);
    }
  const source = GEO_SOURCES.relationship;
  const census = await fetchToCache(source.url, {
    source: source.source,
    allowHosts: ["www2.census.gov"],
    expectedContent: "csv",
    maxBytes: source.maxBytes,
    dataDir,
    expectedSha256: await cachedHash(dataDir, source.source, source.url),
  });
  if (census.outcome === "not_modified") throw new Error("Missing Census body");
  const main = new Map<string, { fips: string; land: bigint }>();
  for await (const row of relationships(createReadStream(census.path)))
    if (row.zcta && row.areas) {
      const land = BigInt(row.areas[4]),
        prior = main.get(row.zcta);
      if (
        !prior ||
        land > prior.land ||
        (land === prior.land && row.countyFips < prior.fips)
      )
        main.set(row.zcta, { fips: row.countyFips, land });
    }
  const sample = [...main.keys()]
    .map((zip) => ({
      zip,
      order: createHash("sha256")
        .update(`p2f-zip-fallback-v1:${zip}`)
        .digest("hex"),
    }))
    .sort((a, b) => a.order.localeCompare(b.order))
    .slice(0, 1000);
  let matched = 0,
    missing = 0,
    multiple = 0;
  const mismatches: { zip: string; zcta_main: string; geonames: string[] }[] =
    [];
  for (const { zip } of sample) {
    const counties = postal.get(zip),
      zcta = main.get(zip)!.fips;
    if (!counties) missing++;
    else {
      if (counties.size > 1) multiple++;
      if (counties.has(zcta)) matched++;
      else
        mismatches.push({
          zip,
          zcta_main: zcta,
          geonames: [...counties].sort(),
        });
    }
  }
  const targets = [];
  for (const [zip, fips] of [
    ["77001", "48201"],
    ["85001", "04013"],
  ]) {
    if (main.has(zip!))
      throw new Error("Target unexpectedly has a Census ZCTA");
    const result = await createGeoRepository(db, {
      allowCmsLive: false,
    }).zipToCounties(zip!);
    // Independently verify the GeoNames table even when a configured CMS key has a cached answer.
    const geoNames = (
      await db.query(
        `SELECT f.county_fips,f.snapshot_id,f.source_row FROM zip_county_fallback f
      JOIN geonames_import g ON f.snapshot_id=g.snapshot_id WHERE f.source='geonames' AND f.zip=$1`,
        [zip],
      )
    ).rows;
    if (!geoNames.some((row) => row.county_fips === fips))
      throw new Error("GeoNames target mismatch");
    targets.push({
      zip,
      expected: fips,
      zcta_present: false,
      geoNames,
      result,
    });
  }
  const cmsConfigured = Boolean(process.env.CMS_API_KEY),
    live = [];
  if (cmsConfigured) {
    for (const zip of ["77001", "85001"]) {
      const [budget] = (
        await db.query<{ wait_seconds: number }>(
          `SELECT GREATEST(0,EXTRACT(epoch FROM GREATEST(next_request_at,blocked_until)-now()))::float8 AS wait_seconds FROM cms_zip_budget`,
        )
      ).rows;
      // Never turn a rate limit or key failure into a delayed bulk job.
      if (budget && budget.wait_seconds > 0) {
        live.push({
          zip,
          status: "skipped",
          reason: "persistent_cms_rate_limit",
        });
        continue;
      }
      const result = await createGeoRepository(db).zipToCounties(zip);
      live.push({
        zip,
        source: result.source,
        cms_lookup: (
          await db.query(
            "SELECT outcome,http_status,failure_code,requested_url,fetched_at FROM cms_zip_lookup WHERE zip=$1 AND plan_year=$2",
            [zip, new Date().getUTCFullYear()],
          )
        ).rows,
      });
    }
  }
  const path = join(dataDir, "reports", "p2f-zip-fallback.md");
  await mkdir(join(dataDir, "reports"), { recursive: true });
  const report = {
    checked_at: new Date().toISOString(),
    imported,
    geonames: file.metadata,
    census: census.metadata,
    cms_key_configured: cmsConfigured,
    cms_live: cmsConfigured
      ? live
      : "Not run: CMS_API_KEY is unset. Synthetic CMS response/401/403/429 tests cover the live adapter offline.",
    targets,
    sample: {
      method:
        "First 1000 ZCTAs ordered by SHA-256(p2f-zip-fallback-v1:ZIP); all national ZCTAs eligible. Main county=max AREALAND_PART, ties by FIPS. No population inference.",
      size: sample.length,
      matched,
      missing,
      mismatches: mismatches.length,
      multiple_county_geonames: multiple,
      agreement_of_all: matched / sample.length,
      agreement_when_geonames_present: matched / (sample.length - missing),
      mismatch_rows: mismatches,
    },
  };
  await writeFile(
    path,
    `# P2f ZIP county fallback real-data check\n\nGeoNames attribution: [GeoNames](https://www.geonames.org/), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).\n\nThe agreement estimate compares published GeoNames county codes with the Census main county by land area. It is not a gate and does not change source priority.\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`,
  );
  console.log(
    JSON.stringify({
      report: path,
      targets: targets.map((t) => ({ zip: t.zip, counties: t.geoNames })),
      sample: report.sample.size,
      matched,
      missing,
      mismatches: mismatches.length,
      cmsConfigured,
    }),
  );
} catch {
  console.error(
    "P2f real-data check failed; inspect bulk snapshots and geography schemas",
  );
  process.exitCode = 1;
} finally {
  await db?.close();
  await rm(directory, { recursive: true, force: true });
  if (databasePath) await rm(databasePath, { recursive: true, force: true });
}
