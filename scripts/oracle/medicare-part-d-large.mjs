#!/usr/bin/env node
/**
 * Cache-only network and pricing check on a dedicated local Postgres database.
 * npm run build; OPENPLANS_PARTD_CHECK_DATABASE_URL=... node scripts/oracle/medicare-part-d-large.mjs
 * --year 2026 --mode sample [--sample-modulus 1000]. --mode full imports every plan.
 * --mode inventory counts rows per inner file without a database. Reports go to OPENPLANS_DATA_DIR.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrate, migrationsDirectory } from "../../dist/db/migrate.js";
import { parsePlanKey } from "../../dist/domain/medicare/index.js";
import { dataDirectory } from "../../dist/ingest/medicare/acquire.js";
import { cachedSpuf, importSpuf } from "../../dist/ingest/medicare/spuf.js";
import {
  partDDrug,
  partDPharmacies,
} from "../../dist/services/medicare-part-d.js";
import {
  compareLarge,
  largeNegativeControls,
  readLargeActual,
} from "./medicare-part-d-large-logic.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const year = Number(option("--year", "2026"));
const mode = option("--mode", "sample");
const modulus =
  mode === "full" ? 1 : Number(option("--sample-modulus", "1000"));
assert.ok(
  ["sample", "full", "inventory"].includes(mode),
  "--mode must be sample, full or inventory",
);
assert.ok(
  Number.isSafeInteger(modulus) && modulus >= 1,
  "sample modulus must be positive",
);
const dataDir = dataDirectory();
const cached = [
  ...(await cachedSpuf("quarterly", dataDir)),
  ...(await cachedSpuf("monthly", dataDir)),
]
  .filter((entry) => entry.archive.year === year)
  .sort((a, b) => b.archive.label.localeCompare(a.archive.label))[0];
assert.ok(cached, `no cached Part D archive for ${year}`);
await mkdir(join(dataDir, "work"), { recursive: true });
await mkdir(join(dataDir, "reports"), { recursive: true });
const directory = await mkdtemp(join(dataDir, "work", "part-d-large-"));
let client;
let schema;
const previousSwitch = process.env.OPENPLANS_MEDICARE_PART_D;
const started = Date.now();
try {
  if (mode !== "inventory") {
    // A separate variable prevents accidental use of the serving database's DATABASE_URL.
    let url;
    try {
      url = new URL(process.env.OPENPLANS_PARTD_CHECK_DATABASE_URL ?? "");
    } catch {
      throw new Error(
        "OPENPLANS_PARTD_CHECK_DATABASE_URL must name a dedicated local Postgres database",
      );
    }
    assert.ok(
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
      "check database must be local",
    );
    assert.ok(
      /^\/(?:openplans_)?med4(?:_[a-z0-9_]+)?$/.test(url.pathname),
      "use a dedicated med4 database",
    );
    client = new pg.Client({ connectionString: url.href, query_timeout: 0 });
    await client.connect();
    const name = `partd_check_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${name}`);
    schema = name;
    await client.query(`SET search_path TO ${schema}, public`);
  }
  const samplePath = join(directory, "sample.zip");
  console.log(
    `Reading cached Part D ${year}: ${mode}, hash modulus ${modulus}`,
  );
  const reference = spawnSync(
    "python3",
    [
      "-I",
      fileURLToPath(new URL("medicare-part-d-reference.py", import.meta.url)),
      cached.path,
      ...(mode === "inventory"
        ? ["--inventory"]
        : [
            "--large",
            "--sample-modulus",
            String(modulus),
            ...(mode === "sample" ? ["--sample-archive", samplePath] : []),
          ]),
    ],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  assert.equal(reference.status, 0, reference.stderr);
  if (reference.stderr) process.stderr.write(reference.stderr);
  const expected = JSON.parse(reference.stdout);
  if (mode === "inventory") {
    await writeFile(
      join(dataDir, "reports", `medicare-part-d-size-${year}.json`),
      JSON.stringify(expected, null, 2) + "\n",
    );
    console.log(JSON.stringify(expected));
  } else {
    assert.ok(
      expected.plans.length,
      "sample has no plans; choose a smaller modulus",
    );
    const migrations = join(directory, "migrations");
    await mkdir(migrations);
    for (const name of await readdir(migrationsDirectory))
      if (name.endsWith(".sql") && name !== "002_postgis.sql")
        await cp(join(migrationsDirectory, name), join(migrations, name));
    const session = {
      query: (s, p) => client.query(s, p),
      exec: async (s) => void (await client.query(s)),
    };
    const db = {
      ...session,
      close: async () => {},
      transaction: async (run) => {
        await client.query("BEGIN");
        try {
          const value = await run(session);
          await client.query("COMMIT");
          return value;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      },
    };
    await migrate(db, migrations);
    let input = cached;
    if (mode === "sample") {
      const hash = createHash("sha256");
      for await (const block of createReadStream(samplePath))
        hash.update(block);
      input = {
        ...cached,
        path: samplePath,
        metadata: {
          ...cached.metadata,
          sha256: hash.digest("hex"),
          bytes: (await stat(samplePath)).size,
        },
      };
    }
    const tables = [
      "plan",
      "formulary",
      "pharmacy_network",
      ...(expected.headers.pricing ? ["pricing"] : []),
    ];
    const importStarted = Date.now();
    const imported = await importSpuf(db, input, tables);
    const importMs = Date.now() - importStarted;
    const drug = (key, rxcui) => partDDrug(db, parsePlanKey(key), year, rxcui);
    const pharmacy = (key, zip) =>
      partDPharmacies(db, parsePlanKey(key), year, zip);
    delete process.env.OPENPLANS_MEDICARE_PART_D;
    assert.deepEqual(await pharmacy(expected.plans[0], "00000"), {
      status: "unknown",
      reason: "pending_terms_review",
    });
    assert.deepEqual(await drug(expected.plans[0], "1"), {
      status: "unknown",
      reason: "pending_terms_review",
    });
    process.env.OPENPLANS_MEDICARE_PART_D = "on";
    const actual = await readLargeActual(
      db,
      imported.snapshot_id,
      expected,
      pharmacy,
      drug,
    );
    const problems = compareLarge(expected, actual);
    const controls = largeNegativeControls(expected, actual);
    const databaseBytes = Number(
      (
        await client.query(
          `SELECT coalesce(sum(pg_total_relation_size(c.oid)),0)::text AS n
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='r'`,
          [schema],
        )
      ).rows[0].n,
    );
    const report = {
      year,
      mode,
      sample_modulus: modulus,
      archive_sha256: cached.metadata.sha256,
      archive_kind: cached.archive.kind,
      archive_label: cached.archive.label,
      checked_at: new Date().toISOString(),
      raw_rows: expected.raw_rows,
      selected_rows: expected.rows,
      selected_plans: expected.plans,
      import_counts: imported.counts,
      pharmacy_lookups: actual.pharmacy_sample.length,
      price_lookups: actual.price_sample.length,
      reader_seconds: expected.elapsed_seconds,
      reader_peak_rss_bytes: expected.peak_rss_bytes,
      import_ms: importMs,
      elapsed_ms: Date.now() - started,
      database_bytes: databaseBytes,
      node_peak_rss_bytes: process.resourceUsage().maxRSS * 1024,
      problem_count: problems.length,
      problems: problems.slice(0, 50),
      negative_controls: controls,
    };
    await writeFile(
      join(dataDir, "reports", `medicare-part-d-large-${mode}-${year}.json`),
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(JSON.stringify(report));
    assert.equal(problems.length, 0, `${problems.length} mismatches`);
    for (const [name, caught] of Object.entries(controls))
      assert.ok(caught, `negative control ${name} was not caught`);
  }
  console.log(`PASS medicare part d ${mode} ${year}`);
} finally {
  if (previousSwitch === undefined)
    delete process.env.OPENPLANS_MEDICARE_PART_D;
  else process.env.OPENPLANS_MEDICARE_PART_D = previousSwitch;
  if (client) {
    try {
      if (schema) await client.query(`DROP SCHEMA ${schema} CASCADE`);
    } finally {
      await client.end();
    }
  }
  await rm(directory, { recursive: true, force: true });
}
