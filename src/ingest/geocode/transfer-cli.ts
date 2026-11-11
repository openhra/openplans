#!/usr/bin/env node
import assert from "node:assert/strict";
import pg from "pg";
import type { Database, SqlSession } from "../../db/database.js";
import { exportGeocodes, importGeocodes } from "./transfer.js";
import { dataDirectory } from "./census.js";

const [mode, runId, path, ...extra] = process.argv.slice(2);
assert.ok(
  ["export", "import"].includes(mode ?? "") && runId && path && !extra.length,
  "Usage: transfer-cli export|import RUN_ID FILE (DATABASE_URL required)",
);
assert.match(runId!, /^[a-zA-Z0-9_-]{1,80}$/);
assert.ok(process.env.DATABASE_URL, "DATABASE_URL required");
// One bulk connection owns the same advisory lock as the statewide geocoder.
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
client.on("error", () => {});
const sql: SqlSession = {
  query: (q, p) => client.query(q, p),
  exec: async (q) => {
    await client.query(q);
  },
};
const db: Database = {
  ...sql,
  close: () => client.end(),
  transaction: async (run) => {
    await client.query("BEGIN");
    try {
      const result = await run(sql);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  },
};
try {
  await client.connect();
  await db.exec("SET max_parallel_workers_per_gather=0; SET jit=off");
  assert.equal(
    (await db.query("SELECT pg_try_advisory_lock(1869636988) locked")).rows[0]
      ?.locked,
    true,
    "geocoder busy",
  );
  const started = Date.now();
  const result =
    mode === "export"
      ? await exportGeocodes(db, runId!, path!)
      : await importGeocodes(db, path!, runId!, dataDirectory());
  console.log(JSON.stringify({ ...result, wall_ms: Date.now() - started }));
} catch {
  console.error(
    "Geocode transfer failed; inspect completion, evidence, transport and target scope.",
  );
  process.exitCode = 1;
} finally {
  await db.close();
}
