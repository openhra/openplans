#!/usr/bin/env node
/** Isolated real-data batch runner. Uses existing discovery/catalog databases; no fixture data. */
import { PGlite } from "@electric-sql/pglite";
import {
  cp,
  readFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database, SqlSession } from "../../db/database.js";
import { migrate, migrationsDirectory } from "../../db/migrate.js";
import type { QhpBatchOptions } from "./formulary-batch.js";
import { ingestQhpBatch } from "./formulary-batch.js";
import { dataDirectory } from "../../config/access.js";

const cache = dataDirectory();
const path = process.env.OPENPLANS_QHP_DB ?? join(cache, "qhp-pglite-p6a");
const directory = await mkdtemp(join(tmpdir(), "openplans-p6a-"));
const pg = new PGlite(path);
const session: SqlSession = {
  query: (sql, args) => pg.query(sql, args),
  exec: async (sql) => {
    await pg.exec(sql);
  },
};
const db: Database = {
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
async function copy(from: PGlite, table: string, where = "") {
  const rows = (
    await from.query<Record<string, unknown>>(`SELECT * FROM ${table} ${where}`)
  ).rows;
  for (let at = 0; at < rows.length; at += 200)
    await pg.query(
      `INSERT INTO ${table} OVERRIDING SYSTEM VALUE
    SELECT * FROM jsonb_populate_recordset(NULL::${table},$1::jsonb) ON CONFLICT DO NOTHING`,
      [JSON.stringify(rows.slice(at, at + 200))],
    );
}
try {
  for (const name of await readdir(migrationsDirectory))
    if (name.endsWith(".sql") && name !== "002_postgis.sql")
      await cp(join(migrationsDirectory, name), join(directory, name));
  await migrate(db, directory);
  if (!(await db.query("SELECT 1 FROM qhp_index LIMIT 1")).rows.length) {
    const discovery = new PGlite(join(cache, "qhp-pglite-discovery-2026-TX"));
    try {
      for (const t of ["source", "snapshot", "qhp_index", "qhp_child_url"])
        await copy(discovery, t);
    } finally {
      await discovery.close();
    }
    const puf = new PGlite(join(cache, "puf-pglite-p1d"));
    try {
      for (const t of [
        "source",
        "snapshot",
        "puf_import",
        "puf_import_file",
        "plan",
        "puf_active_catalog",
      ])
        await copy(puf, t);
    } finally {
      await puf.close();
    }
  }
  await mkdir(join(cache, "reports"), { recursive: true });
  const kind = process.argv[2] === "providers" ? "providers" : "formulary";
  let reports: Record<string, unknown>[] = [];
  const reportPath = join(cache, "reports", `p6a-${kind}-realdata.json`);
  try {
    const previous = JSON.parse(await readFile(reportPath, "utf8"));
    if (previous.database === path) reports = previous.issuers;
  } catch {
    /* first run */
  }
  const deadline =
    Date.now() + Number(process.env.OPENPLANS_QHP_RUN_BUDGET_MS ?? 3_000_000);
  const controller = new AbortController();
  const options: QhpBatchOptions = {
    year: 2026,
    state: "TX",
    deadline,
    signal: controller.signal,
    skipIssuers:
      process.env.OPENPLANS_QHP_RESUME === "1"
        ? reports.map((r) => String(r.issuer))
        : undefined,
    issuer: process.env.OPENPLANS_QHP_ISSUER,
    onReport: async (row) => {
      reports = [...reports.filter((r) => r.issuer !== row.issuer), row];
      await writeFile(
        reportPath,
        JSON.stringify(
          { database: path, kind, issuers: reports, running: true },
          null,
          2,
        ) + "\n",
      );
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
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        database: path,
        ...report,
        issuers: reports,
        not_run: report.not_run.filter(
          (i) => !reports.some((r) => r.issuer === i),
        ),
        running: false,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify({ report: reportPath, not_run: report.not_run }));
} catch (error) {
  console.error(
    JSON.stringify({
      runner_failed: true,
      code: (error as { code?: string }).code ?? "runner_failed",
    }),
  );
  process.exitCode = 1;
} finally {
  await pg.close();
  await rm(directory, { recursive: true, force: true });
}
