#!/usr/bin/env node
/** Cache-only catalog/premium oracle. Each state has its own resumable developer DB and result. */
import { PGlite } from "@electric-sql/pglite";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { database, portableMigrations } from "./negative-controls.mjs";
import { migrate } from "../../dist/db/migrate.js";
import { importPufs } from "../../dist/ingest/puf/import.js";
import {
  cachedImportFiles,
  importDataDirectory,
} from "../../dist/ingest/puf/import-source.js";
import {
  pufStates,
  partitionPufs,
} from "../../dist/ingest/puf/import-batch.js";
import {
  ingestRatingRules,
  ratingRule,
} from "../../dist/ingest/rating-rules/index.js";
import { ingestGeo } from "../../dist/ingest/geo/index.js";
import { allStatesReport, atomicWrite } from "./all-states-report.mjs";
import { domainRate, rateKey, checkRate, setComparison } from "./logic.mjs";
const cache = importDataDirectory(),
  reports = join(cache, "reports");
const args = process.argv.slice(2),
  year = Number(args[args.indexOf("--year") + 1]);
if (![2026, 2027].includes(year))
  throw new Error("Usage: all-states.mjs --year 2026|2027");
await mkdir(reports, { recursive: true });
await mkdir(join(cache, "work"), { recursive: true });
function child(command, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(command, args, { stdio: ["ignore", "inherit", "inherit"] });
    p.once("error", reject);
    p.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
  });
}
const acquired = await cachedImportFiles(cache, year);
if (args.includes("--state")) {
  const state = args[args.indexOf("--state") + 1],
    dir = args[args.indexOf("--directory") + 1];
  const raw = JSON.parse(await readFile(join(dir, "summary.json"), "utf8"))[
    state
  ];
  let manifestPath = acquired.manifestPath;
  try {
    manifestPath = JSON.parse(
      await readFile(join(dir, "manifest-path.json"), "utf8"),
    );
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const files = JSON.parse(
    await readFile(join(dir, "partitions.json"), "utf8"),
  )[state];
  const output = join(reports, `p6d-${year}-${state}.json`),
    scratch = await mkdtemp(join(reports, ".p6d-"));
  const result = {
    state,
    year,
    generated_at: new Date().toISOString(),
    passed: false,
    counts: [],
    premiums: {
      comparisons: 0,
      unknown: 0,
      skipped_family: 0,
      mismatch_count: 0,
      mismatches: [],
    },
    family_options: raw.family_options,
    failures: [],
  };
  let db;
  try {
    db = database(new PGlite(join(cache, `puf-pglite-p6d-${year}-${state}`)));
    await migrate(db, await portableMigrations(join(scratch, "migrations")));
    let active = (
      await db.query(
        "SELECT import_id FROM puf_active_catalog WHERE state=$1 AND plan_year=$2",
        [state, year],
      )
    ).rows[0];
    if (active) {
      const saved = (
        await db.query(
          "SELECT f.kind,s.sha256 FROM puf_import_file f JOIN snapshot s ON s.snapshot_id=f.snapshot_id WHERE import_id=$1",
          [active.import_id],
        )
      ).rows;
      if (
        saved.length !== files.length ||
        files.some(
          (f) => !saved.some((s) => s.kind === f.kind && s.sha256 === f.sha256),
        )
      )
        active = undefined;
    }
    if (!active) {
      console.log(`import PY${year} ${state}: starting`);
      result.import = await importPufs(db, {
        year,
        state,
        dataDir: cache,
        files,
        manifestPath,
      });
      if (!result.import.passed)
        throw new Error(`Quarantined: ${result.import.report_json}`);
      active = { import_id: result.import.import_id };
    }
    result.import_id = active.import_id;
    const snapshots = Object.fromEntries(
      (
        await db.query(
          "SELECT kind,snapshot_id FROM puf_import_file WHERE import_id=$1",
          [active.import_id],
        )
      ).rows.map((r) => [r.kind, r.snapshot_id]),
    );
    for (const [metric, table, kind] of [
      ["base_plans", "plan", "plan-attributes"],
      ["variants", "plan_variant", "plan-attributes"],
      ["rate", "rate", "rate"],
      ["service-area", "service_area_county", "service-area"],
      ["plan-attributes", "plan_attribute", "plan-attributes"],
      ["network", "network", "network"],
      ["business-rules", "business_rule", "business-rules"],
      [
        "benefits-and-cost-sharing",
        "plan_benefit",
        "benefits-and-cost-sharing",
      ],
    ]) {
      const actual = Number(
        (
          await db.query(
            `SELECT count(*) AS n FROM ${table} WHERE snapshot_id=$1`,
            [snapshots[kind]],
          )
        ).rows[0].n,
      );
      result.counts.push({
        metric,
        actual,
        expected: raw.counts[metric],
        passed: actual === raw.counts[metric],
      });
    }
    for (const [key, table, column] of [
      ["base_ids", "plan", "base_plan_id"],
      ["variant_ids", "plan_variant", "variant_plan_id"],
    ]) {
      result[key] = setComparison(
        (
          await db.query(
            `SELECT ${column} AS id FROM ${table} WHERE snapshot_id=$1`,
            [snapshots["plan-attributes"]],
          )
        ).rows.map((r) => r.id),
        raw[key],
      );
    }
    await ingestRatingRules(
      db,
      fileURLToPath(
        new URL(`../../data/rating-rules/${year}.json`, import.meta.url),
      ),
    );
    result.rating_rule = await ratingRule(db, state, year, "individual");
    const groups = new Map();
    let last = 0,
      loaded = 0;
    for (;;) {
      const rows = (
        await db.query(
          "SELECT *,effective_date::text,expiration_date::text FROM rate WHERE snapshot_id=$1 AND source_row>$2 ORDER BY source_row LIMIT 3000",
          [snapshots.rate, last],
        )
      ).rows;
      if (!rows.length) break;
      for (const stored of rows) {
        const row = domainRate(stored),
          key = rateKey(row.planId, row.ratingAreaId);
        delete row.raw;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
        last = stored.source_row;
        loaded++;
      }
    }
    let expectedRows = 0;
    for await (const line of createInterface({
      input: createReadStream(join(dir, `${state}-rates.jsonl`)),
      crlfDelay: Infinity,
    })) {
      const expected = JSON.parse(line),
        checked = checkRate(
          expected,
          groups.get(rateKey(expected.plan, expected.area)) ?? [],
        );
      expectedRows++;
      for (const key of ["comparisons", "unknown", "skipped_family"])
        result.premiums[key] += checked[key];
      result.premiums.mismatch_count += checked.mismatches.length;
      if (result.premiums.mismatches.length < 20)
        result.premiums.mismatches.push(
          ...checked.mismatches.slice(
            0,
            20 - result.premiums.mismatches.length,
          ),
        );
    }
    result.premiums.raw_rows = expectedRows;
    result.premiums.stored_rows = loaded;
    result.premiums.passed =
      expectedRows === loaded &&
      loaded === raw.counts.rate &&
      result.premiums.mismatch_count === 0;
    try {
      result.geography = await ingestGeo(db, {
        state,
        planYear: year,
        dataDir: cache,
        fetchOptions: {
          lookup: async () => {
            throw new Error(
              "Cached geography required; acquisition is separate",
            );
          },
        },
      });
    } catch (e) {
      result.geography = { status: "failed", error: e.message };
      result.failures.push("Geography failed");
    }
    result.passed =
      result.counts.every((c) => c.passed) &&
      result.base_ids.passed &&
      result.variant_ids.passed &&
      result.premiums.passed &&
      result.rating_rule?.method === "per_member" &&
      !result.failures.length;
  } catch (e) {
    result.failures.push(e.message);
  } finally {
    await db?.close();
    await rm(scratch, { recursive: true, force: true });
    await atomicWrite(output, JSON.stringify(result, null, 2) + "\n");
  }
  await allStatesReport(cache);
  console.log(
    `PY${year} ${state}: ${result.passed ? "PASS" : "FAIL"} comparisons=${result.premiums.comparisons} mismatches=${result.premiums.mismatch_count} ${result.failures.join("; ")}`,
  );
  // State errors are data in the aggregate. The parent still schedules all other states.
} else {
  const states = await pufStates(acquired.files, year),
    scratch = await mkdtemp(join(cache, "work", `p6d-${year}-`));
  let partitions;
  try {
    console.log(
      `PY${year}: ${states.length} states; preparing independent CSV expectations`,
    );
    await child("python3", [
      fileURLToPath(new URL("./all-states-reference.py", import.meta.url)),
      "--cache",
      cache,
      "--manifest",
      acquired.manifestPath,
      "--year",
      String(year),
      "--directory",
      scratch,
    ]);
    await writeFile(
      join(scratch, "manifest-path.json"),
      JSON.stringify(acquired.manifestPath),
    );
    console.log(`PY${year}: partitioning immutable inputs`);
    partitions = await partitionPufs(acquired.files, states, year, cache);
    await writeFile(
      join(scratch, "partitions.json"),
      JSON.stringify(Object.fromEntries(partitions.states)),
    );
    const queue = [...states];
    await Promise.all(
      Array.from({ length: 2 }, async () => {
        while (queue.length) {
          const state = queue.shift();
          await child(process.execPath, [
            fileURLToPath(import.meta.url),
            "--year",
            String(year),
            "--state",
            state,
            "--directory",
            scratch,
          ]);
        }
      }),
    );
    const results = await Promise.all(
      states.map(async (s) =>
        JSON.parse(
          await readFile(join(reports, `p6d-${year}-${s}.json`), "utf8"),
        ),
      ),
    );
    const report = {
      year,
      states,
      passed: results.every((r) => r.passed),
      results,
    };
    await writeFile(
      join(reports, `p6d-all-states-${year}.json`),
      JSON.stringify(report, null, 2) + "\n",
    );
    await allStatesReport(cache);
    console.log(
      `PY${year} all-states: ${report.passed ? "PASS" : "FAIL"} (${results.filter((r) => r.passed).length}/${states.length})`,
    );
    if (!report.passed) process.exitCode = 1;
  } finally {
    await partitions?.cleanup();
    await rm(scratch, { recursive: true, force: true });
  }
}
