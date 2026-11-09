#!/usr/bin/env node
/** Portable real-data discovery runner. Every persisted byte stays in OPENPLANS_DATA_DIR. */
import { PGlite } from "@electric-sql/pglite";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database, SqlSession } from "../../db/database.js";
import { migrationsDirectory } from "../../db/migrate.js";
import { runWorker } from "../../worker/commands.js";
import { qhpDataDirectory } from "./discover.js";
import type { DiscoveryReport } from "./discover.js";

const dataDir = qhpDataDirectory(),
  directory = await mkdtemp(join(tmpdir(), "openplans-qhp-migrations-"));
// runWorker validates both flags before invoking the database factory.
const scope = `${process.argv[process.argv.indexOf("--year") + 1]}-${process.argv[process.argv.indexOf("--state") + 1]}`;
let db: Database | undefined;
let report: DiscoveryReport | undefined;
try {
  for (const name of await readdir(migrationsDirectory)) {
    if (name.endsWith(".sql") && name !== "002_postgis.sql")
      await cp(join(migrationsDirectory, name), join(directory, name));
  }
  await mkdir(join(dataDir, "reports"), { recursive: true });
  process.exitCode = await runWorker(
    process.argv.slice(2),
    () => {
      const pg = new PGlite(join(dataDir, `qhp-pglite-discovery-${scope}`));
      const session: SqlSession = {
        query: (sql, args) => pg.query(sql, args),
        exec: async (sql) => {
          await pg.exec(sql);
        },
      };
      db = {
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
      return { ...db, close: async () => {} };
    },
    {
      out: (message) => {
        report = JSON.parse(message) as DiscoveryReport;
        console.log(message);
      },
      error: (message) => {
        console.error(message);
      },
    },
    directory,
  );
  if (db && report && process.exitCode === 0) {
    const indexes = (
      await db.query(
        "SELECT * FROM qhp_index WHERE discovery_id=$1 ORDER BY issuer_id,registry_row",
        [report.discovery_id],
      )
    ).rows;
    const children = (
      await db.query(
        `SELECT child.* FROM qhp_child_url child JOIN qhp_index idx USING(qhp_index_id)
      WHERE idx.discovery_id=$1 ORDER BY child.issuer_id,child.kind,child.url`,
        [report.discovery_id],
      )
    ).rows;
    const path = join(
      dataDir,
      "reports",
      `qhp-discovery-${report.year}-${report.state}.json`,
    );
    await writeFile(
      path,
      `${JSON.stringify({ database: "PGlite (portable SQL, PostGIS migration omitted)", report, indexes, children }, null, 2)}\n`,
    );
    console.log(JSON.stringify({ report: path }));
  }
} catch {
  console.error("QHP PGlite discovery failed");
  process.exitCode = 1;
} finally {
  await db?.close();
  await rm(directory, { recursive: true, force: true });
}
