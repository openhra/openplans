#!/usr/bin/env node
import { homedir } from "node:os";
/** Real-data runner; all DB/download/report bytes stay in the external cache. */
import { PGlite } from "@electric-sql/pglite";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database, SqlSession } from "../../db/database.js";
import { migrate, migrationsDirectory } from "../../db/migrate.js";
import { runWorker } from "../../worker/commands.js";
import { providerCachedRecords } from "./provider.js";
import { acquireProviders } from "./provider-acquire.js";
import { sourceSet } from "./provider-repository.js";
import { createProviderRepository } from "../../domain/providers/index.js";

const cache =
  process.env.OPENPLANS_DATA_DIR ??
  join(homedir(), ".local", "share", "openplans");
const path =
  process.env.OPENPLANS_PROVIDER_DB ?? join(cache, "provider-pglite-p3b");
const directory = await mkdtemp(
  join(tmpdir(), "openplans-provider-migrations-"),
);
let pg: PGlite | undefined;
async function insert(table: string, rows: Record<string, unknown>[]) {
  for (let at = 0; at < rows.length; at += 500)
    await pg!.query(
      `INSERT INTO ${table} OVERRIDING SYSTEM VALUE
    SELECT * FROM jsonb_populate_recordset(NULL::${table},$1::jsonb) ON CONFLICT DO NOTHING`,
      [JSON.stringify(rows.slice(at, at + 500))],
    );
}
async function copy(
  db: PGlite,
  table: string,
  where = "",
  args: unknown[] = [],
) {
  const rows = (
    await db.query<Record<string, unknown>>(
      `SELECT * FROM ${table} ${where}`,
      args,
    )
  ).rows;
  await insert(table, rows);
  return rows;
}
async function bootstrap(db: Database) {
  const discovery = new PGlite(join(cache, "qhp-pglite-p2b-integrated"));
  try {
    await copy(discovery, "source");
    await copy(discovery, "snapshot");
    await copy(
      discovery,
      "qhp_index",
      "WHERE issuer_id='76589' AND plan_year=2026 AND state='TX'",
    );
    await copy(
      discovery,
      "qhp_child_url",
      "WHERE qhp_index_id IN (SELECT qhp_index_id FROM qhp_index WHERE issuer_id='76589' AND plan_year=2026 AND state='TX')",
    );
  } finally {
    await discovery.close();
  }
  const puf = new PGlite(join(cache, "puf-pglite-p1d"));
  try {
    await copy(puf, "source");
    await copy(puf, "snapshot");
    const active = (
      await puf.query<{ import_id: string }>(
        "SELECT * FROM puf_active_catalog WHERE state='TX' AND plan_year=2026",
      )
    ).rows;
    if (!active.length) throw new Error("Missing real catalog");
    await copy(puf, "puf_import", "WHERE import_id=$1", [active[0]!.import_id]);
    const files = await copy(puf, "puf_import_file", "WHERE import_id=$1", [
      active[0]!.import_id,
    ]);
    const catalog = files.find(
      (f) => f.kind === "plan-attributes",
    )!.snapshot_id;
    await copy(puf, "plan", "WHERE snapshot_id=$1 AND issuer_id='76589'", [
      catalog,
    ]);
    await copy(
      puf,
      "plan_variant",
      "WHERE snapshot_id=$1 AND issuer_id='76589'",
      [catalog],
    );
    await copy(
      puf,
      "puf_active_catalog",
      "WHERE state='TX' AND plan_year=2026",
    );
  } finally {
    await puf.close();
  }
  // Reuse the exact fetchToCache download if already present; expected hash verifies reuse.
  const set = await sourceSet(db, { issuer: "76589", year: 2026, state: "TX" });
  const dir = join(cache, "raw/qhp-76589-2026-provider_urls");
  let expectedSha256: string | undefined;
  try {
    const { readFile } = await import("node:fs/promises");
    const names = (await readdir(dir)).filter((n) => n.endsWith(".meta.json"));
    if (names.length === 1)
      expectedSha256 = JSON.parse(
        await readFile(join(dir, names[0]!), "utf8"),
      ).sha256;
  } catch {
    /* acquire reports a missing cache as a normal download */
  }
  await acquireProviders(
    db,
    { issuer: "76589", year: 2026, state: "TX" },
    { fetchOptions: { expectedSha256 } },
  );
  console.log(JSON.stringify({ bootstrap_discovery: set.discovery }));
  const npis = new Set<string>();
  for (const child of (
    await sourceSet(db, { issuer: "76589", year: 2026, state: "TX" })
  ).children.filter((c) => c.kind === "provider_urls")) {
    for await (const value of providerCachedRecords(child)) {
      const r = value as { npi?: string };
      if (r.npi && /^[12][0-9]{9}$/.test(r.npi)) npis.add(r.npi);
    }
  }
  const nppes = new PGlite(join(cache, "nppes-pglite-p3a"));
  let matches = 0;
  try {
    await copy(nppes, "source");
    await copy(nppes, "snapshot");
    const ids = [...npis];
    for (let at = 0; at < ids.length; at += 2000) {
      const batch = ids.slice(at, at + 2000);
      matches += (
        await copy(nppes, "npi_provider", "WHERE npi=ANY($1::text[])", [batch])
      ).length;
      await copy(nppes, "npi_taxonomy", "WHERE npi=ANY($1::text[])", [batch]);
    }
  } finally {
    await nppes.close();
  }
  console.log(
    JSON.stringify({
      bootstrap_nppes_matches: matches,
      feed_distinct_npis: npis.size,
    }),
  );
}
try {
  for (const name of await readdir(migrationsDirectory))
    if (name.endsWith(".sql") && name !== "002_postgis.sql") {
      await cp(join(migrationsDirectory, name), join(directory, name));
    }
  pg = new PGlite(path);
  const session: SqlSession = {
    query: (sql, args) => pg!.query(sql, args),
    exec: async (sql) => {
      await pg!.exec(sql);
    },
  };
  const db: Database = {
    ...session,
    close: async () => {},
    transaction: (run) =>
      pg!.transaction((tx) =>
        run({
          query: (sql, args) => tx.query(sql, args),
          exec: async (sql) => {
            await tx.exec(sql);
          },
        }),
      ),
  };
  await migrate(db, directory);
  if (!(await db.query("SELECT 1 FROM plan LIMIT 1")).rows.length)
    await bootstrap(db);
  let report: Record<string, unknown> | undefined;
  process.exitCode = await runWorker(
    process.argv.slice(2),
    () => db,
    {
      out: (message) => {
        report = JSON.parse(message);
        console.log(message);
      },
      error: (message) => console.error(message),
    },
    directory,
  );
  if (report) {
    const scope = [report.snapshot_id];
    const plans = (
      await db.query(
        `SELECT p.base_hios_id,count(*)::int AS edges,count(DISTINCT r.npi)::int AS npis
      FROM qhp_provider_plan_all p JOIN qhp_provider_record r USING(snapshot_id,record_id)
      JOIN provider_shard s USING(snapshot_id) WHERE s.source_set_id=$1 GROUP BY p.base_hios_id ORDER BY p.base_hios_id`,
        scope,
      )
    ).rows;
    const shards = (
      await db.query(
        `SELECT f.*,s.sha256,s.compressed_bytes,s.raw_path FROM provider_shard f
      LEFT JOIN snapshot s ON s.snapshot_id=f.raw_snapshot_id WHERE f.source_set_id=$1`,
        scope,
      )
    ).rows;
    const edges = (
      await db.query(
        `SELECT DISTINCT r.npi,p.base_hios_id FROM qhp_provider_plan_all p
      JOIN qhp_provider_record r USING(snapshot_id,record_id) JOIN provider_shard s USING(snapshot_id)
      WHERE s.source_set_id=$1 AND r.npi IS NOT NULL ORDER BY p.base_hios_id,r.npi`,
        scope,
      )
    ).rows;
    const sample = edges[0];
    const lookup = sample
      ? await createProviderRepository(db).providerParticipation(
          String(sample.base_hios_id),
          String(sample.npi),
          2026,
        )
      : null;
    const stats = (
      await db.query(
        `SELECT count(DISTINCT r.record_id)::int AS tx_records,count(DISTINCT r.npi)::int AS tx_npis,
      count(DISTINCT n.npi)::int AS tx_nppes_matches,count(DISTINCT r.npi) FILTER(WHERE n.deactivated)::int AS tx_deactivated
      FROM qhp_provider_record r JOIN provider_shard s USING(snapshot_id) LEFT JOIN npi_provider n ON n.npi=r.npi
      WHERE s.source_set_id=$1 AND EXISTS(SELECT 1 FROM qhp_provider_plan_all p WHERE p.snapshot_id=r.snapshot_id AND p.record_id=r.record_id)`,
        scope,
      )
    ).rows;
    await mkdir(join(cache, "reports"), { recursive: true });
    const output = join(cache, "reports/p3b-provider-realdata.json");
    await writeFile(
      output,
      JSON.stringify(
        {
          database: "PGlite; PostGIS migration omitted",
          path,
          report,
          plans,
          shards,
          stats,
          lookup,
          edges,
        },
        null,
        2,
      ) + "\n",
    );
    console.log(JSON.stringify({ report: output, stats }));
  }
} catch (error) {
  // Developer runner prints only a safe error type/code, never driver details or records.
  console.error(
    JSON.stringify({
      provider_runner_failed: true,
      code: (error as { code?: string }).code ?? "bootstrap_or_import_failed",
    }),
  );
  process.exitCode = 1;
} finally {
  await pg?.close();
  await rm(directory, { recursive: true, force: true });
}
