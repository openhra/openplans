#!/usr/bin/env node
import pg from "pg";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Database, SqlSession } from "../../db/database.js";
import { migrationsDirectory } from "../../db/migrate.js";
import { dataDirectory } from "./census.js";
import { acquireCounties, geocodeState } from "./counties.js";
import { cleanupGeocodes } from "./cleanup.js";
import { operatorGeocoder } from "./operator.js";

const args = process.argv.slice(2),
  value = (flag: string) => args[args.indexOf(flag) + 1];
if (
  !args.includes("--source-run") ||
  !args.includes("--run-id") ||
  args.length % 2 ||
  args.some(
    (a, i) =>
      i % 2 === 0 &&
      !["--state", "--source-run", "--run-id", "--budget-minutes"].includes(a),
  )
)
  throw new Error(
    "Usage: cleanup-cli --state TX|FL|NC --source-run ID --run-id ID [--budget-minutes N]",
  );
const state = geocodeState(args.includes("--state") ? value("--state")! : "TX"),
  runId = value("--run-id")!,
  sourceRunId = value("--source-run")!;
const minutes = args.includes("--budget-minutes")
  ? Number(value("--budget-minutes"))
  : 60;
if (!Number.isFinite(minutes) || minutes <= 0)
  throw new Error("Invalid cleanup time budget");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  idleTimeoutMillis: 0,
});
pool.on("error", () => {});
const sql: SqlSession = {
  query: (q, a) => pool.query(q, a),
  exec: async (q) => {
    await pool.query(q);
  },
};
const db: Database = {
  ...sql,
  close: () => pool.end(),
  transaction: async (run) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await run({
        query: (q, a) => client.query(q, a),
        exec: async (q) => {
          await client.query(q);
        },
      });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};
let deadline = Date.now() + minutes * 60_000;
process.on("SIGINT", () => {
  deadline = Date.now();
});
process.on("SIGTERM", () => {
  deadline = Date.now();
});
try {
  await db.exec("SET max_parallel_workers_per_gather=0; SET jit=off");
  if (
    !(await db.query("SELECT pg_try_advisory_lock(1869636988) locked")).rows[0]
      ?.locked
  )
    throw new Error("Another statewide geocoder owns the lock");
  await db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(1869636974)");
    for (const name of [
      "520_tx_geocode.sql",
      "521_geocode_batch_profile.sql",
      "600_geocode_row_rejection.sql",
      "870_multistate_geocode.sql",
      "871_geocode_state_cursors.sql",
      "872_geocode_bootstrap_scope.sql",
      "900_geocode_cleanup.sql",
    ]) {
      const text = await readFile(join(migrationsDirectory, name), "utf8"),
        sha = createHash("sha256").update(text).digest("hex");
      const applied = (
        await tx.query("SELECT sha256 FROM schema_migrations WHERE name=$1", [
          name,
        ])
      ).rows[0];
      if (applied && applied.sha256 !== sha)
        throw new Error("Cleanup migration changed after application");
      if (!applied) {
        await tx.exec(text);
        await tx.query(
          "INSERT INTO schema_migrations(name,sha256) VALUES($1,$2)",
          [name, sha],
        );
      }
    }
  });
  const root = dataDirectory(),
    counties = await acquireCounties(db, root, state);
  const report = await cleanupGeocodes(db, counties, {
    state,
    runId,
    sourceRunId,
    dataDir: root,
    get deadline() {
      return deadline;
    },
    operator: operatorGeocoder(process.env, { log: console.log }),
    progress: console.log,
  });
  await mkdir(join(root, "reports"), { recursive: true });
  await writeFile(
    join(root, "reports", `p3m-geocode-${state.toLowerCase()}.json`),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
  if (Number(report.pending) > 0) process.exitCode = 1;
} catch (error) {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === "string" && /^[a-zA-Z0-9_]{1,40}$/.test(code))
    console.error(`Failure code: ${code}`);
  if (
    error instanceof Error &&
    [
      "Cleanup changed the house number",
      "Cleanup requires a fully staged source run",
      "County geometry state differs from run",
      "Census snapshot hash mismatch",
      "Incomplete Census batch; pending manifest retained",
      "Another statewide geocoder owns the lock",
      "Cleanup migration changed after application",
    ].includes(error.message)
  )
    console.error(error.message);
  console.error(
    "Geocode cleanup failed; retained observations and cached batches can be resumed",
  );
  process.exitCode = 1;
} finally {
  await db.close();
}
