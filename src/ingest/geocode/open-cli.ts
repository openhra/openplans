#!/usr/bin/env node
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import pg from "pg";
import type { Database } from "../../db/database.js";
import { migrationsDirectory } from "../../db/migrate.js";
import { dataDirectory } from "./census.js";
import { acquireCounties } from "./counties.js";
import {
  openGeocoder,
  validateOpenDataset,
  assertOpenServerDate,
  validateOpenIndexDate,
  openImportProfile,
  openState,
} from "./open.js";
import type { OpenDataset } from "./open.js";
import { retryOpenGeocoder } from "./open-retry.js";

const args = process.argv.slice(2),
  flags = [
    "--state",
    "--source-run",
    "--cleanup-run",
    "--run-id",
    "--snapshot",
    "--limit",
    "--budget-minutes",
  ];
const get = (flag: string) =>
  args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
if (
  args.length % 2 ||
  args.some((a, i) => i % 2 === 0 && !flags.includes(a)) ||
  flags.some((f) => args.filter((a) => a === f).length > 1) ||
  ["--state", "--source-run", "--cleanup-run", "--run-id", "--snapshot"].some(
    (f) => !get(f),
  )
)
  throw new Error(
    "Usage: open-cli --state TX|FL|NC --source-run ID --cleanup-run ID --run-id ID --snapshot YYMMDD [--limit N] [--budget-minutes N]",
  );
const state = openState(get("--state")!),
  snapshot = get("--snapshot")!,
  limit = Number(get("--limit") ?? 0),
  minutes = Number(get("--budget-minutes") ?? 60);
if (
  !/^\d{6}$/.test(snapshot) ||
  !Number.isInteger(limit) ||
  limit < 0 ||
  !Number.isFinite(minutes) ||
  minutes <= 0
)
  throw new Error("Invalid open geocoder options");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const root = dataDirectory(),
  directory = join(root, "raw", "open-geocoder", state.toLowerCase(), snapshot);
const metadata = JSON.parse(
  await readFile(join(directory, "metadata.json"), "utf8"),
) as Omit<OpenDataset, "index_sha256" | "import_profile"> & {
  licence: string;
  attribution: string;
  data_timestamp: string;
};
const index = JSON.parse(
  await readFile(
    join(
      root,
      "work",
      "open-geocoder",
      `${state.toLowerCase()}-${snapshot}-address-index.json`,
    ),
    "utf8",
  ),
) as {
  index_sha256: string;
  raw_sha256: string;
  profile: string;
  state: string;
  data_timestamp: string;
  object_timestamp: string;
};
const dataset: OpenDataset = {
  sha256: metadata.sha256,
  index_sha256: index.index_sha256,
  import_profile: openImportProfile,
  data_date: metadata.data_date,
  state,
};
validateOpenDataset(dataset);
validateOpenIndexDate(
  index.object_timestamp,
  metadata.data_timestamp,
  metadata.data_date,
);
async function fileHash(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
if (
  metadata.state !== state ||
  (await fileHash(join(directory, "data.osm.pbf"))) !== metadata.sha256 ||
  metadata.licence !== "ODbL-1.0" ||
  index.raw_sha256 !== metadata.sha256 ||
  index.profile !== openImportProfile ||
  index.state !== state ||
  index.data_timestamp !== metadata.data_timestamp ||
  (await fileHash(
    join(
      root,
      "work",
      "open-geocoder",
      `${state.toLowerCase()}-${snapshot}-addresses.osm.pbf`,
    ),
  )) !== index.index_sha256
)
  throw new Error("Open geocoder extract hash or licence mismatch");
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  query_timeout: 120_000,
  idleTimeoutMillis: 0,
});
pool.on("error", () => {});
const db: Database = {
  query: (q, a) => pool.query(q, a),
  exec: async (q) => {
    await pool.query(q);
  },
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
  if (
    !(await db.query("SELECT pg_try_advisory_lock(1869636988) locked")).rows[0]
      ?.locked
  )
    throw new Error("Another statewide geocoder owns the lock");
  const name = "910_open_geocoder.sql",
    sql = await readFile(join(migrationsDirectory, name), "utf8"),
    sha = createHash("sha256").update(sql).digest("hex");
  await db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(1869636974)");
    const applied = (
      await tx.query("SELECT sha256 FROM schema_migrations WHERE name=$1", [
        name,
      ])
    ).rows[0];
    if (applied && applied.sha256 !== sha)
      throw new Error("Open geocoder migration changed after application");
    if (!applied) {
      await tx.exec(sql);
      await tx.query(
        "INSERT INTO schema_migrations(name,sha256) VALUES($1,$2)",
        [name, sha],
      );
    }
  });
  const counties = await acquireCounties(db, root, state);
  const adapter = openGeocoder(counties, dataset);
  if (!adapter) throw new Error("OPENPLANS_OPEN_GEOCODER_URL is required");
  await assertOpenServerDate(
    process.env.OPENPLANS_OPEN_GEOCODER_URL!,
    index.object_timestamp,
  );
  const report = await retryOpenGeocoder(db, counties, {
    runId: get("--run-id")!,
    sourceRunId: get("--source-run")!,
    cleanupRunId: get("--cleanup-run")!,
    adapter,
    limit,
    get deadline() {
      return deadline;
    },
    progress: console.log,
  });
  await mkdir(join(root, "reports"), { recursive: true });
  await writeFile(
    join(
      root,
      "reports",
      `p3n-geocode-${state.toLowerCase()}-${get("--run-id")!}.json`,
    ),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
  if (Number(report.pending) > 0) process.exitCode = 1;
} catch (error) {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === "string" && /^[A-Z0-9]{5}$/.test(code))
    console.error(`Failure code: ${code}`);
  const safeMessages = [
    "Another statewide geocoder owns the lock",
    "Open geocoder migration changed after application",
    "OPENPLANS_OPEN_GEOCODER_URL is required",
    "Open geocoder requires a loopback Nominatim URL",
    "Open geocoder server dataset date differs",
    "Open geocoder requires a completed cleanup run",
    "Census cleanup is still pending",
    "Cleanup and source run identities differ",
    "Open geocoder run scope differs",
    "Missing original state geocode run",
  ];
  if (error instanceof Error && safeMessages.includes(error.message))
    console.error(error.message);
  console.error("Open geocoder run failed; completed rows retained for resume");
  process.exitCode = 1;
} finally {
  await db.close();
}
