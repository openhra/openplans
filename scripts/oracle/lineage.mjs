#!/usr/bin/env node
/**
 * npm run build && node scripts/oracle/lineage.mjs (cache only; owns a disposable DB).
 * Imports the acquired PY2026 and PY2027 Plan ID Crosswalk PUFs and compares stored rows,
 * ID sets and every served ancestor chain with an independent stdlib CSV parse. A planted
 * wrong prior-year ID must make the comparison fail.
 */
import { PGlite } from "@electric-sql/pglite";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { database, portableMigrations } from "./negative-controls.mjs";
import { migrate } from "../../dist/db/migrate.js";
import { importPlanLineage } from "../../dist/ingest/puf/import-lineage.js";
import { newestPufManifest } from "../../dist/ingest/puf/import-source.js";
import { planLineage } from "../../dist/ingest/puf/import-repository.js";

const YEARS = [2026, 2027];
const cache =
  process.env.OPENPLANS_DATA_DIR ||
  join(homedir(), ".local", "share", "openplans");
if (!isAbsolute(cache)) throw new Error("Absolute OPENPLANS_DATA_DIR required");
const reports = join(cache, "reports");
await mkdir(reports, { recursive: true });
const scratch = await mkdtemp(join(reports, ".lineage-oracle-"));
const report = {
  passed: false,
  generated_at: new Date().toISOString(),
  years: {},
  negative_controls: [],
  failures: [],
};

function reference(manifestPath, year) {
  const output = join(scratch, `expected-${year}.json`);
  return new Promise((resolve, reject) => {
    const p = spawn(
      "python3",
      [
        "-I",
        fileURLToPath(new URL("./lineage-reference.py", import.meta.url)),
        "--cache",
        cache,
        "--manifest",
        manifestPath,
        "--year",
        String(year),
        "--output",
        output,
      ],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    p.once("error", reject);
    p.once("exit", (code) =>
      code === 0
        ? resolve(readFile(output, "utf8").then(JSON.parse))
        : reject(new Error(`Independent crosswalk oracle exited ${code}`)),
    );
  });
}

/** Ancestors per served year: direct prior IDs plus the previous year's chain. */
function expectedChains(expected) {
  const chains = {};
  for (const year of YEARS) {
    chains[year] = {};
    for (const [plan, priors] of Object.entries(expected[year].ancestors)) {
      const chain = new Set(priors.map((id) => `${year - 1}:${id}`));
      for (const prior of priors)
        for (const older of chains[year - 1]?.[prior] ?? []) chain.add(older);
      chains[year][plan] = [...chain].sort();
    }
  }
  return chains;
}

const sorted = (values) => [...values].sort();
const sameList = (a, b) =>
  a.length === b.length && a.every((value, at) => value === b[at]);

/** Every mismatch between the database and the independent expectations. */
async function compare(session, snapshots, expected, chains) {
  const mismatches = [];
  for (const year of YEARS) {
    const want = expected[year],
      snapshot = snapshots[year];
    const { rows: states } = await session.query(
      "SELECT state,count(*)::int AS n FROM plan_lineage WHERE snapshot_id=$1 GROUP BY state ORDER BY state",
      [snapshot],
    );
    const stored = Object.fromEntries(states.map((r) => [r.state, r.n]));
    if (JSON.stringify(stored) !== JSON.stringify(want.per_state))
      mismatches.push(`${year}: per-state row counts differ`);
    const { rows: priors } = await session.query(
      "SELECT DISTINCT prior_plan_id AS id FROM plan_lineage WHERE snapshot_id=$1",
      [snapshot],
    );
    if (!sameList(sorted(priors.map((r) => r.id)), want.prior_plans))
      mismatches.push(`${year}: prior-year plan ID set differs`);
    const { rows: successors } = await session.query(
      "SELECT DISTINCT plan_id AS id FROM plan_lineage WHERE snapshot_id=$1 AND plan_id IS NOT NULL",
      [snapshot],
    );
    if (!sameList(sorted(successors.map((r) => r.id)), want.successor_plans))
      mismatches.push(`${year}: successor plan ID set differs`);
    const { rows: pairs } = await session.query(
      "SELECT DISTINCT plan_id||'<'||prior_plan_id AS pair FROM plan_lineage WHERE snapshot_id=$1 AND plan_id IS NOT NULL",
      [snapshot],
    );
    const digest = createHash("sha256")
      .update(sorted(pairs.map((r) => r.pair)).join("\n"))
      .digest("hex");
    if (digest !== want.pairs_sha256)
      mismatches.push(`${year}: lineage pair set differs`);
    let served = 0;
    for (const [plan, chain] of Object.entries(chains[year])) {
      const lineage = await planLineage(session, plan, year, plan.slice(5, 7));
      const got = lineage.ancestors.map((a) => `${a.year}:${a.id}`).sort();
      served++;
      if (lineage.status !== "available" || !sameList(got, chain)) {
        mismatches.push(`${year}: served ancestors differ for ${plan}`);
        if (mismatches.length > 20) break;
      }
    }
    report.years[year].served_plans_checked = served;
  }
  return mismatches;
}

let db;
try {
  const { manifestPath } = await newestPufManifest(cache);
  const expected = {};
  for (const year of YEARS) {
    console.log(`lineage oracle: independent raw CSV expectations PY${year}`);
    expected[year] = await reference(manifestPath, year);
  }
  const chains = expectedChains(expected);
  db = database(new PGlite());
  await migrate(db, await portableMigrations(join(scratch, "migrations")));
  const snapshots = {};
  for (const year of YEARS) {
    const imported = await importPlanLineage(db, { year, dataDir: cache });
    snapshots[year] = imported.import_id;
    report.years[year] = {
      status: imported.status,
      sha256: imported.sha256,
      url: imported.url,
      raw_rows: expected[year].rows,
      stored_rows: imported.stored_rows,
      rejected_rows: imported.rejected_rows,
      states: imported.states.length,
      prior_plans: expected[year].prior_plans.length,
      successor_plans: expected[year].successor_plans.length,
      lineage_pairs: expected[year].pairs,
      ancestor_paths: Object.values(chains[year]).reduce(
        (sum, chain) => sum + chain.length,
        0,
      ),
    };
    if (imported.status !== "ACTIVE")
      report.failures.push(`${year}: import ${imported.status}`);
    if (imported.stored_rows !== expected[year].rows)
      report.failures.push(`${year}: stored rows differ from raw CSV rows`);
    if (imported.sha256 !== expected[year].sha256)
      report.failures.push(`${year}: archive hash differs`);
  }
  report.failures.push(...(await compare(db, snapshots, expected, chains)));

  // Planted control: one prior-year ID moved to a different valid plan of the same issuer.
  const rollback = new Error("rollback planted control");
  let detected = [];
  try {
    await db.transaction(async (tx) => {
      const { rows } = await tx.query(
        "SELECT source_row,prior_plan_id FROM plan_lineage WHERE snapshot_id=$1 AND plan_id IS NOT NULL ORDER BY source_row LIMIT 1",
        [snapshots[2026]],
      );
      const wrong = `${rows[0].prior_plan_id.slice(0, 7)}9999999`;
      await tx.query(
        "UPDATE plan_lineage SET prior_plan_id=$3 WHERE snapshot_id=$1 AND source_row=$2",
        [snapshots[2026], rows[0].source_row, wrong],
      );
      detected = await compare(tx, snapshots, expected, chains);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
  report.negative_controls.push({
    name: "wrong_prior_year_id",
    passed: detected.length > 0,
    detected: detected.slice(0, 5),
  });
  if (!detected.length)
    report.failures.push("planted wrong prior-year ID was not detected");
  // The rollback must leave the real comparison clean.
  const after = await compare(db, snapshots, expected, chains);
  if (after.length) report.failures.push("rollback left a changed row");
  report.passed = report.failures.length === 0;
} catch (error) {
  report.failures.push(error instanceof Error ? error.message : String(error));
} finally {
  await db?.close();
  await rm(scratch, { recursive: true, force: true });
  const path = join(reports, "lineage-oracle.json");
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, report: path }, null, 2));
  process.exitCode = report.passed ? 0 : 1;
}
