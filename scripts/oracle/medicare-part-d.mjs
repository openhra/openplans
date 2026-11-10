#!/usr/bin/env node
/**
 * Cache-only Part D check. Imports the newest cached Part D public use archive of a contract year
 * into a disposable PGlite database, then compares every imported row group, every plan's
 * formulary and suppression flag, and a sample of drug lookups with an independent Python reading
 * of the raw archive. Planted mutants must each be caught. Pharmacy networks and pricing are not
 * loaded here.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { migrate, migrationsDirectory } from "../../dist/db/migrate.js";
import { parsePlanKey } from "../../dist/domain/medicare/index.js";
import { dataDirectory } from "../../dist/ingest/medicare/acquire.js";
import { cachedSpuf, importSpuf } from "../../dist/ingest/medicare/spuf.js";
import { partDDrug } from "../../dist/services/medicare-part-d.js";
import {
  compare,
  negativeControls,
  readActual,
} from "./medicare-part-d-logic.mjs";

const args = process.argv.slice(2);
const year = args[0] === "--year" ? Number(args[1]) : 2026;
const dataDir = dataDirectory();
const cached = [
  ...(await cachedSpuf("quarterly", dataDir)),
  ...(await cachedSpuf("monthly", dataDir)),
]
  .filter((entry) => entry.archive.year === year)
  .sort((a, b) => b.archive.label.localeCompare(a.archive.label))[0];
if (!cached) {
  console.log(`SKIP medicare part d ${year}: no Part D archive in the cache`);
  process.exit(0);
}

const reference = spawnSync(
  "python3",
  [
    "-I",
    fileURLToPath(new URL("medicare-part-d-reference.py", import.meta.url)),
    cached.path,
  ],
  { encoding: "utf8", maxBuffer: 1024 ** 3 },
);
assert.equal(reference.status, 0, reference.stderr);
const expected = JSON.parse(reference.stdout);

const migrations = await mkdtemp(join(tmpdir(), "part-d-oracle-migrations-"));
for (const name of await readdir(migrationsDirectory))
  if (name.endsWith(".sql") && name !== "002_postgis.sql")
    await cp(join(migrationsDirectory, name), join(migrations, name));
const pg = new PGlite();
const db = {
  query: (sql, parameters) => pg.query(sql, parameters),
  exec: async (sql) => void (await pg.exec(sql)),
  close: () => pg.close(),
  transaction: (run) =>
    pg.transaction((tx) =>
      run({
        query: (s, p) => tx.query(s, p),
        exec: async (s) => void (await tx.exec(s)),
      }),
    ),
};
const started = Date.now();
await migrate(db, migrations);
const imported = await importSpuf(db, cached);
let drugNameChecks = 0;
const drug = async (planKey, rxcui) => {
  const body = await partDDrug(db, parsePlanKey(planKey), year, rxcui);
  // This disposable database has no RxNorm release; the Part D archive has no drug names.
  if (body.status === "listed" || body.status === "not_listed") {
    assert.equal(body.name, null);
    assert.equal(body.name_tty, null);
    assert.equal(body.name_snapshot_id, null);
    assert.equal(
      body.name_reason,
      body.status === "listed"
        ? "rxnorm_not_loaded"
        : "rxcui_not_in_plan_formulary",
    );
    drugNameChecks++;
  }
  return body;
};

// Serving is off until the operator turns it on, even with the release loaded.
const anyPlan = expected.sample[0];
delete process.env.OPENPLANS_MEDICARE_PART_D;
assert.deepEqual(await drug(anyPlan.plan_key, anyPlan.rxcui), {
  status: "unknown",
  reason: "pending_terms_review",
});
process.env.OPENPLANS_MEDICARE_PART_D = "on";

const actual = await readActual(db, imported.snapshot_id, expected, drug);
const problems = compare(expected, actual);
const controls = negativeControls(expected, actual);
const report = {
  year,
  kind: cached.archive.kind,
  as_of_label: cached.archive.label,
  snapshot_id: imported.snapshot_id,
  checked_at: new Date().toISOString(),
  elapsed_ms: Date.now() - started,
  import_counts: imported.counts,
  raw_rows: expected.rows,
  row_groups_checked: Object.values(expected.groups).reduce(
    (n, groups) => n + Object.keys(groups).length,
    0,
  ),
  plans_checked: Object.keys(expected.plans).length,
  drug_lookups_checked: expected.sample.length,
  drug_name_checks_without_rxnorm: drugNameChecks,
  suppressed_plans_checked: expected.suppressed_sample.length,
  problems: problems.slice(0, 50),
  problem_count: problems.length,
  negative_controls: controls,
};
await mkdir(join(dataDir, "reports"), { recursive: true });
await writeFile(
  join(dataDir, "reports", `medicare-part-d-oracle-${year}.json`),
  JSON.stringify(report, null, 2) + "\n",
);
await db.close();
await rm(migrations, { recursive: true, force: true });
console.log(
  JSON.stringify({ ...report, problems: report.problems.slice(0, 5) }),
);
assert.equal(
  problems.length,
  0,
  `medicare part d ${year}: ${problems.length} mismatches`,
);
for (const [name, caught] of Object.entries(controls))
  assert.ok(caught, `negative control ${name} was not caught`);
console.log(`PASS medicare part d ${year}`);
