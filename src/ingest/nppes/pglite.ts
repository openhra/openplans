#!/usr/bin/env node
/** Developer-only file DB runner. Downloaded bytes, database and reports remain in the shared cache. */
import { PGlite } from "@electric-sql/pglite";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database, SqlSession } from "../../db/database.js";
import { migrate, migrationsDirectory } from "../../db/migrate.js";
import { acquireRelease, dataDirectory, discoverCurrent } from "./acquire.js";
import { importNppes } from "./import.js";
import { providerByNpi } from "./lookup.js";

const dataDir = dataDirectory(),
  dbPath = join(dataDir, "nppes-pglite-p3a");
const directory = await mkdtemp(join(tmpdir(), "openplans-nppes-migrations-"));
let db: Database | undefined;
try {
  await mkdir(join(dataDir, "reports"), { recursive: true });
  for (const name of await readdir(migrationsDirectory)) {
    if (name.endsWith(".sql") && name !== "002_postgis.sql")
      await cp(join(migrationsDirectory, name), join(directory, name));
  }
  const pg = new PGlite(dbPath),
    session: SqlSession = {
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
  await migrate(db, directory);
  const releases = await discoverCurrent();
  const requested = process.argv[2] ?? "all";
  if (!["full", "weekly", "deactivation", "all"].includes(requested))
    throw new Error("Invalid kind");
  const reports = [],
    unavailable = [];
  for (const kind of ["full", "weekly", "deactivation"]) {
    if (requested !== "all" && requested !== kind) continue;
    const release = releases.find((r) => r.kind === kind);
    if (!release) {
      unavailable.push({ kind, reason: "No official V2 link" });
      continue;
    }
    let acquired;
    try {
      acquired = await acquireRelease(release);
    } catch {
      unavailable.push({
        kind,
        url: release.url,
        reason: "Publisher download failed",
      });
      continue;
    }
    const report = await importNppes(db, {
      ...acquired,
      state: "TX",
      progress: console.log,
    });
    reports.push(report);
    console.log(JSON.stringify(report));
  }
  const spots = [];
  if (process.env.OPENPLANS_REFERENCE_CAPTURES_DIR) {
    const root = join(
      process.env.OPENPLANS_REFERENCE_CAPTURES_DIR,
      "providers",
    );
    const npis = new Set<string>();
    async function visit(dir: string) {
      for (const file of await readdir(dir, { withFileTypes: true })) {
        if (file.isDirectory()) await visit(join(dir, file.name));
        else if (file.name.endsWith(".json")) {
          const visitValue = (v: unknown): void => {
            if (Array.isArray(v)) {
              for (const item of v) visitValue(item);
            } else if (v && typeof v === "object")
              for (const [key, value] of Object.entries(v)) {
                if (/npi/i.test(key) && /^[12]\d{9}$/.test(String(value)))
                  npis.add(String(value));
                else visitValue(value);
              }
          };
          visitValue(JSON.parse(await readFile(join(dir, file.name), "utf8")));
        }
      }
    }
    await visit(root);
    for (const npi of [...npis].slice(0, 5)) {
      const found = await providerByNpi(db, npi);
      spots.push({
        npi,
        found: !!found,
        entity_type: found?.entity_type,
        deactivated: found?.deactivated,
        first_name: found?.first_name,
        last_name: found?.last_name,
        organization_name: found?.organization_name,
        practices: found?.addresses
          .filter((a) => a.kind === "practice")
          .map((a) => ({ state: a.state, zip5: a.zip5 })),
      });
    }
  }
  const summary = {
    database:
      "PGlite file; PostGIS omitted from temporary developer migration copy only",
    dbPath,
    reports,
    unavailable,
    reference_spot_checks: spots,
    completed_imports: (
      await db.query("SELECT report FROM npi_import_run ORDER BY kind")
    ).rows.map((r) => r.report),
    table_sizes: (
      await db.query(`SELECT relname,pg_total_relation_size(oid)::text bytes FROM pg_class
      WHERE relname IN ('npi_provider','npi_taxonomy','npi_address','npi_deactivation') ORDER BY relname`)
    ).rows,
    counts: (
      await db.query(`SELECT (SELECT count(*)::int FROM npi_provider) providers,
      (SELECT count(*)::int FROM npi_taxonomy) taxonomies,(SELECT count(*)::int FROM npi_address) addresses,
      (SELECT count(*)::int FROM npi_provider WHERE deactivated) deactivated,
      (SELECT count(*)::int FROM quality_issue WHERE source_id='cms-nppes') quality_issues`)
    ).rows[0],
  };
  const reportPath = join(
    dataDir,
    "reports",
    `p3a-nppes-${requested}-realdata.json`,
  );
  await writeFile(reportPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ report: reportPath, ...summary }));
  if (unavailable.length) process.exitCode = 1;
} catch (error) {
  console.error(
    "NPPES PGlite import failed",
    error instanceof Error && error.message.startsWith("NPPES")
      ? error.message
      : "check cache, schema and quarantined snapshot",
  );
  process.exitCode = 1;
} finally {
  await db?.close();
  await rm(directory, { recursive: true, force: true });
}
