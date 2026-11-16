#!/usr/bin/env node
/** Offline check on disposable clones of the cached public-data developer databases. */
import assert from "node:assert/strict";
import { constants } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { cpus, platform, arch, totalmem } from "node:os";
import { PGlite } from "@electric-sql/pglite";
import { database, portableMigrations } from "./negative-controls.mjs";
import { migrate } from "../../dist/db/migrate.js";
import { lowestInput } from "../../dist/api/handy.js";
import { lowestPremiums } from "../../dist/services/handy.js";
import { buildLowestPremiums } from "../../dist/worker/handy-build.js";
import { callLowestTool } from "../../dist/mcp/handy.js";
import { ratePremium } from "../../dist/services/premiums.js";
import { requestReads } from "../../dist/services/request-reads.js";
import { familyOffer } from "../../dist/services/coverage-family.js";
import { countyPlans, resolveLocation } from "../../dist/api/repository.js";
import { premiumRequest } from "../../dist/api/validation.js";
import { importDataDirectory } from "../../dist/ingest/puf/import-source.js";

const root = importDataDirectory();
const args = process.argv.slice(2);
const sampleCount = args.includes("--samples")
  ? Number(args[args.indexOf("--samples") + 1])
  : 1000;
if (!Number.isInteger(sampleCount) || sampleCount < 1)
  throw new Error("--samples must be positive");
const years = args.includes("--year")
  ? [Number(args[args.indexOf("--year") + 1])]
  : [2026, 2027];
assert(
  years.every((year) => [2025, 2026, 2027].includes(year)),
  "Unsupported --year",
);
const only = args.includes("--state")
  ? args[args.indexOf("--state") + 1]
  : undefined;
// Top-level names only. No recursive cache search, network fetch or connection to a running DB.
const sources = (await readdir(root))
  .filter(
    (n) =>
      /^puf-pglite-p6d-202[567]-[A-Z]{2}$/.test(n) &&
      years.some((year) => n.includes(`-${year}-`)) &&
      (!only || n.endsWith(`-${only}`)),
  )
  .sort();
assert(sources.length, "No cached state databases");
const report = {
  schema_version: 1,
  hardware: {
    platform: platform(),
    arch: arch(),
    cpu: cpus()[0]?.model,
    memory_bytes: totalmem(),
  },
  benchmark: "not run; this command checks equality only",
  seed: 0x48414e44,
  samples_requested: sampleCount,
  plan_years: years,
  cases: [],
  failures: [],
  scopes: [],
  passed: false,
};
let seed = report.seed;
const random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed;
};
const destination = join(root, "work", "handy1b");
await mkdir(destination, { recursive: true });
const resumed = new Set();
if (args.includes("--resume")) {
  const previous = JSON.parse(
    await readFile(join(destination, "realdata.json"), "utf8"),
  );
  assert.equal(previous.seed, report.seed);
  assert.equal(previous.samples_requested, sampleCount);
  assert.deepEqual(previous.plan_years, years);
  const failed = new Set(previous.failures.map((failure) => failure.source));
  for (const scope of previous.scopes) {
    if (
      !failed.has(scope.source_database) &&
      sources.includes(scope.source_database)
    ) {
      resumed.add(scope.source_database);
      report.scopes.push(scope);
      report.cases.push(
        ...previous.cases.filter(
          (c) => c.state === scope.state && c.year === scope.year,
        ),
      );
    }
  }
  report.resumed_scopes = [...resumed].sort();
}
const scratch = await mkdtemp(join(destination, "disposable-check-"));
try {
  const directory = await portableMigrations(join(scratch, "migrations"));
  // Assign all seeded samples before opening any database. Every loaded state/year gets a case.
  const samples = new Map(sources.map((s) => [s, []]));
  for (let n = 0; n < sampleCount; n++) {
    const source = sources[Math.floor((random() / 2 ** 32) * sources.length)];
    samples
      .get(source)
      .push({ county: random(), age: random() % 121, zip: random() % 2 === 0 });
  }
  for (const source of sources) {
    if (resumed.has(source)) continue;
    let db;
    const path = join(scratch, "database");
    try {
      // Copy-on-write on supported filesystems. The cached database is never opened or changed.
      await cp(join(root, source), path, {
        recursive: true,
        mode: constants.COPYFILE_FICLONE,
      });
      db = database(new PGlite(path));
      await migrate(db, directory);
      const [year, state] = source.match(/(202[567])-([A-Z]{2})$/).slice(1);
      const counties = (
        await db.query(
          `SELECT DISTINCT county_fips FROM service_area_county
        WHERE state=$1 AND plan_year=$2 AND county_fips IS NOT NULL AND NOT dental_only
        AND market='Individual'
        UNION SELECT county_fips FROM rating_area WHERE state=$1 AND plan_year=$2
          AND NOT EXISTS (SELECT 1 FROM service_area_county
            WHERE state=$1 AND plan_year=$2 AND county_fips IS NOT NULL AND NOT dental_only AND market='Individual')
        ORDER BY county_fips`,
          [state, Number(year)],
        )
      ).rows.map((r) => r.county_fips);
      if (!counties.length) throw new Error("No loaded county scopes");
      const snapshots = (
        await db.query(
          "SELECT snapshot_id,sha256 FROM snapshot WHERE validation_state='ACTIVE' ORDER BY snapshot_id",
        )
      ).rows;
      report.scopes.push({
        state,
        year: Number(year),
        counties: counties.length,
        source_database: source,
        snapshots,
      });
      const requests = [
        { county: 0, age: 40, zip: false },
        ...samples.get(source),
      ];
      for (const profile of requests) {
        const county = counties[profile.county % counties.length];
        const zip = profile.zip
          ? (
              await db.query(
                `SELECT zcta FROM zcta_county WHERE county_fips=$1 ORDER BY zcta LIMIT 1`,
                [county],
              )
            ).rows[0]?.zcta
          : undefined;
        const input = lowestInput({
          county,
          ...(zip ? { zip } : {}),
          year: Number(year),
          age: profile.age,
        });
        const location = await resolveLocation(db, input);
        const offered = (await countyPlans(db, county, Number(year), zip))
          .filter((p) => p.on_exchange && p.metal.toLowerCase() === "silver")
          .sort((a, b) => a.base_plan_id.localeCompare(b.base_plan_id));
        const expected = [],
          reads = requestReads(db);
        reads.plan(offered);
        let incomplete = false;
        for (const plan of offered) {
          const attrs = (await reads.exchangeAttributes(plan)).rows;
          const eligible = familyOffer(
            attrs,
            profile.age >= 21,
            profile.age < 21,
          );
          if (eligible === false) continue;
          if (eligible === null) {
            incomplete = true;
            break;
          }
          const request = premiumRequest({
            county,
            ...(zip ? { zip } : {}),
            coverage_start: `${year}-01-01`,
            plan_ids: [plan.base_plan_id],
            members: [
              { age: profile.age, tobacco: false, relationship: "subscriber" },
            ],
          });
          const { estimate } = await ratePremium(
            db,
            plan,
            plan.base_plan_id,
            request,
            location,
            reads,
          );
          if (
            estimate.status !== "rated" ||
            estimate.total_cents === undefined
          ) {
            incomplete = true;
            break;
          }
          expected.push({
            id: plan.base_plan_id,
            cents: estimate.total_cents,
            provenance: estimate.provenance,
            rows: estimate.rate_rows_used,
          });
        }
        const build = await buildLowestPremiums(db, input);
        const fast = await lowestPremiums(db, input),
          slow = await lowestPremiums(db, input, { slow: true });
        assert.equal(
          JSON.stringify(fast),
          JSON.stringify(slow),
          "Fast/fallback bytes",
        );
        const mcp = await callLowestTool(
          {
            db,
            lowestPremiums: true,
            publicQuoting: true,
            cursorSecret: "synthetic-handy-check-cursor",
          },
          input,
        );
        assert(!mcp.isError, "MCP must return the complete bounded answer");
        const { next_cursor, ...mcpData } = mcp.structuredContent;
        assert.deepEqual(mcpData, fast, "MCP canonical answer");
        assert.equal(next_cursor === null, fast.next_page === null);
        const restricted =
          !zip &&
          (await reads.countyRows(county, Number(year))).some(
            (p) =>
              !p.dental_only &&
              p.on_exchange &&
              p.metal.toLowerCase() === "silver" &&
              p.zip_restricted,
          );
        if (
          !incomplete &&
          expected.length &&
          !restricted &&
          location.status === "available"
        )
          assert.equal(
            fast.status,
            "calculated",
            "Complete direct enumeration must produce a minimum",
          );
        if (fast.status === "calculated") {
          assert(!incomplete, "Minimum despite incomplete rates");
          const minimum = Math.min(...expected.map((p) => p.cents));
          const ties = expected
            .filter((p) => p.cents === minimum)
            .map((p) => p.id);
          assert.equal(fast.lowest.monthly_cents, minimum);
          assert.equal(fast.lowest.plan_id, ties[0]);
          assert.equal(fast.lowest.tied_plan_count, ties.length);
          assert.deepEqual(fast.ties, ties.slice(0, 50));
          assert.equal(fast.candidate_count, expected.length);
          expected.forEach((plan, i) => {
            assert.deepEqual(
              fast.provenance.evidence[
                fast.provenance.candidates[i].evidence_ref
              ],
              plan.provenance,
            );
            assert.deepEqual(
              fast.provenance.candidates[i].rate_rows_used,
              plan.rows,
            );
          });
        }
        report.cases.push({
          state,
          year: Number(year),
          county,
          zip: zip ?? null,
          age: profile.age,
          status: fast.status,
          reason: fast.reason,
          generation: fast.data_generation,
          build: build.status,
          candidates: fast.candidate_count,
          response_bytes: Buffer.byteLength(JSON.stringify(fast)),
          mcp_bytes: Buffer.byteLength(JSON.stringify(mcp)) + 1024,
        });
      }
      console.log(`${state} ${year}: PASS (${requests.length} cases)`);
    } catch (error) {
      report.failures.push({ source, message: error.message });
      console.error(`${source}: FAIL ${error.message}`);
    } finally {
      await db?.close();
      await rm(path, { recursive: true, force: true });
    }
  }
  report.passed =
    report.failures.length === 0 &&
    report.cases.length >= sampleCount + sources.length;
} finally {
  await rm(scratch, { recursive: true, force: true });
  await writeFile(
    join(destination, "realdata.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
}
console.log(
  `handy real data: ${report.passed ? "PASS" : "FAIL"}; scopes=${report.scopes.length} cases=${report.cases.length} failures=${report.failures.length}`,
);
if (!report.passed) process.exitCode = 1;
