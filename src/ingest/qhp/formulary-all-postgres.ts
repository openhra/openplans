#!/usr/bin/env node
/** Isolated native Postgres developer run; the caller owns the openplans-<lane> container. */
import pg from "pg";
import { bootstrapEnrichment } from "./postgres-enrichment.js";
import { PGlite } from "@electric-sql/pglite";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { Database, SqlSession } from "../../db/database.js";
import { migrate } from "../../db/migrate.js";
import { ingestQhpBatch } from "./formulary-batch.js";
import { discoverQhp } from "./discover.js";
import type { QhpBatchOptions } from "./formulary-batch.js";
import { dataDirectory } from "../../config/access.js";

const cache = dataDirectory();
const url = process.env.OPENPLANS_QHP_DATABASE_URL;
const state = process.env.OPENPLANS_QHP_STATE ?? "TX";
const year = Number(process.env.OPENPLANS_QHP_YEAR ?? 2026);
if (
  !/^[A-Z]{2}$/.test(state) ||
  !Number.isInteger(year) ||
  year < 2014 ||
  year > 2100
)
  throw new Error("Invalid QHP scope");
function openPool() {
  try {
    if (!url) throw new Error("missing");
    const target = new URL(url);
    if (
      target.hostname !== "127.0.0.1" ||
      !["postgres:", "postgresql:"].includes(target.protocol)
    )
      throw new Error("invalid");
    return new pg.Pool({
      connectionString: url,
      max: 4,
      connectionTimeoutMillis: 10_000,
      query_timeout: 0,
    });
  } catch {
    throw new Error("Explicit loopback developer database required");
  }
}
const pool = openPool();
pool.on("error", () => {});
const session = (client: pg.Pool | pg.PoolClient): SqlSession => ({
  query: (sql, args) => client.query(sql, args),
  exec: async (sql) => {
    await client.query(sql);
  },
});
const db: Database = {
  ...session(pool),
  close: () => pool.end(),
  transaction: async (run) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await run(session(client));
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
async function copy(from: PGlite, table: string) {
  const rows = (
    await from.query<Record<string, unknown>>(`SELECT * FROM ${table}`)
  ).rows;
  for (let at = 0; at < rows.length; at += 200)
    await db.query(
      `INSERT INTO ${table} OVERRIDING SYSTEM VALUE
    SELECT * FROM jsonb_populate_recordset(NULL::${table},$1::jsonb) ON CONFLICT DO NOTHING`,
      [JSON.stringify(rows.slice(at, at + 200))],
    );
}
try {
  await migrate(db, process.env.OPENPLANS_QHP_MIGRATIONS_DIRECTORY);
  if (
    !(
      await db.query(
        "SELECT 1 FROM puf_active_catalog WHERE state=$1 AND plan_year=$2",
        [state, year],
      )
    ).rows.length
  ) {
    const catalog = new PGlite(
      process.env.OPENPLANS_QHP_CATALOG_DB ??
        join(
          cache,
          state === "TX" && year === 2026
            ? "puf-pglite-p1d"
            : `puf-pglite-p6d-${year}-${state}`,
        ),
    );
    try {
      for (const t of [
        "source",
        "snapshot",
        "puf_import",
        "puf_import_file",
        "plan",
        "plan_variant",
        "puf_active_catalog",
      ])
        await copy(catalog, t);
    } finally {
      await catalog.close();
    }
  }
  if (process.argv[2] === "discover") {
    const report = await discoverQhp(db, { year, state });
    await mkdir(join(cache, "reports"), { recursive: true });
    await writeFile(
      join(cache, "reports", `qhp-discovery-${year}-${state}.json`),
      JSON.stringify({ report }, null, 2) + "\n",
    );
    console.log(JSON.stringify(report));
    await db.close();
    process.exit(0);
  }
  if (
    !(
      await db.query(
        "SELECT 1 FROM qhp_index WHERE state=$1 AND plan_year=$2",
        [state, year],
      )
    ).rows.length
  ) {
    // Cached child IDs are local serials. Another discovery DB can reuse the same
    // IDs; adding a scope to an existing DB must allocate them through discovery.
    if ((await db.query("SELECT 1 FROM qhp_index LIMIT 1")).rows.length)
      throw new Error(
        "Run discover for the selected state/year before adding its batch",
      );
    const discovery = new PGlite(
      join(cache, `qhp-pglite-discovery-${year}-${state}`),
    );
    try {
      for (const t of ["source", "snapshot", "qhp_index", "qhp_child_url"])
        await copy(discovery, t);
    } finally {
      await discovery.close();
    }
    await db.exec(`SELECT setval(pg_get_serial_sequence('qhp_child_url','qhp_child_url_id'),
      GREATEST(1,COALESCE((SELECT max(qhp_child_url_id) FROM qhp_child_url),0)),true)`);
  }
  if (process.env.OPENPLANS_QHP_ENRICHMENT === "1")
    await bootstrapEnrichment(db, cache);
  if (process.argv[2] === "bootstrap") {
    await db.close();
    process.exit(0);
  }
  const kind = process.argv[2] === "providers" ? "providers" : "formulary";
  const prefix = process.env.OPENPLANS_QHP_REPORT_PREFIX ?? "p6a-postgres";
  if (!/^[a-z0-9-]+$/.test(prefix)) throw new Error("Invalid report prefix");
  const database =
      prefix === "p6a-postgres"
        ? "openplans-p6a-postgres"
        : `${prefix}-postgres`,
    backend = "Native arm64 Postgres; full migrations including PostGIS";
  const reportPath = join(cache, "reports", `${prefix}-${kind}-realdata.json`);
  await mkdir(join(cache, "reports"), { recursive: true });
  let reports: Record<string, unknown>[] = [];
  try {
    const prior = JSON.parse(await readFile(reportPath, "utf8"));
    if (prior.database === database) reports = prior.issuers;
  } catch {
    /* first run */
  }
  const controller = new AbortController();
  const options: QhpBatchOptions = {
    year,
    state,
    deadline:
      Date.now() + Number(process.env.OPENPLANS_QHP_RUN_BUDGET_MS ?? 1_800_000),
    signal: controller.signal,
    issuer: process.env.OPENPLANS_QHP_ISSUER,
    skipIssuers:
      process.env.OPENPLANS_QHP_RESUME === "1"
        ? (
            await db.query<{ issuer_id: string }>(
              `SELECT issuer_id
      FROM qhp_coverage_manifest WHERE plan_year=$2 AND state=$3 AND kind=$1 AND reason IS DISTINCT FROM 'not_run_budget'`,
              [kind === "providers" ? "provider" : "drug", year, state],
            )
          ).rows.map((r) => r.issuer_id)
        : undefined,
    onShard: (row) => console.log(JSON.stringify({ shard: true, ...row })),
    onReport: async (row) => {
      await db.transaction(async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `qhp-report:${reportPath}`,
        ]);
        try {
          const current = JSON.parse(await readFile(reportPath, "utf8"));
          if (current.database === database) reports = current.issuers;
        } catch {
          /* first report */
        }
        reports = [...reports.filter((r) => r.issuer !== row.issuer), row];
        const temp = `${reportPath}.${process.pid}.tmp`;
        await writeFile(
          temp,
          JSON.stringify(
            { database, backend, kind, issuers: reports, running: true },
            null,
            2,
          ) + "\n",
        );
        await rename(temp, reportPath);
      });
      console.log(
        JSON.stringify({
          issuer: row.issuer,
          kind,
          status: row.completeness,
          records: row.records,
          edges: row.edges,
          reason: row.reason,
          elapsed_ms: row.elapsed_ms,
        }),
      );
    },
  };
  const stop = () => {
    options.deadline = Date.now();
    controller.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const report = await ingestQhpBatch(db, kind, options);
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  await db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `qhp-report:${reportPath}`,
    ]);
    try {
      const current = JSON.parse(await readFile(reportPath, "utf8"));
      if (current.database === database) reports = current.issuers;
    } catch {
      /* first run */
    }
    const temp = `${reportPath}.${process.pid}.tmp`;
    await writeFile(
      temp,
      JSON.stringify(
        { database, backend, ...report, issuers: reports, running: false },
        null,
        2,
      ) + "\n",
    );
    await rename(temp, reportPath);
  });
} catch (error) {
  console.error(
    JSON.stringify({
      postgres_runner_failed: true,
      code: (error as { code?: string }).code ?? "runner_failed",
    }),
  );
  process.exitCode = 1;
} finally {
  await db.close();
}
