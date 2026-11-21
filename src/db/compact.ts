import type { Database, SqlSession } from "./database.js";
import { COMPACT_LOCK } from "./compact-lock.js";
import { geocodeArchiveReady } from "./geocode-archive.js";
import {
  MaintenanceConflict,
  MIGRATION_LOCK,
  PROVIDER_SEARCH_BUILD_LOCK,
} from "./maintenance-locks.js";
import {
  assertStagingTables,
  stagingTables,
  tableClasses,
} from "./table-classes.js";

export interface CompactSize {
  databaseBytes: number;
  tables: { name: string; bytes: number; deadTuples: number }[];
}
export interface CompactReport {
  dryRun: boolean;
  truncated: string[];
  vacuum: { name: string; full: boolean }[];
  before: CompactSize;
  after: CompactSize;
  reclaimedRelationBytes: number;
}

const quote = (name: string) => `public."${name.replaceAll('"', '""')}"`;
const locks = [
  COMPACT_LOCK,
  1869636988,
  MIGRATION_LOCK,
  PROVIDER_SEARCH_BUILD_LOCK,
];

async function sizes(session: SqlSession): Promise<CompactSize> {
  const { rows } = await session.query<{
    name: string;
    bytes: string;
    dead: string;
  }>(
    `SELECT c.relname AS name,pg_total_relation_size(c.oid)::text AS bytes,
      coalesce(s.n_dead_tup,0)::text AS dead FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_stat_user_tables s ON s.relid=c.oid
      WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname`,
  );
  const database = await session.query<{ bytes: string }>(
    "SELECT pg_database_size(current_database())::text AS bytes",
  );
  return {
    databaseBytes: Number(database.rows[0]!.bytes),
    tables: rows.map((r) => ({
      name: r.name,
      bytes: Number(r.bytes),
      deadTuples: Number(r.dead),
    })),
  };
}

/** Fail closed on a new table, even if it is not on the truncate list. */
export function assertClassifiedTables(names: readonly string[]): void {
  const known = new Set(tableClasses.map((t) => t.name));
  if (names.some((name) => !known.has(name)))
    throw new MaintenanceConflict(
      "unclassified database table; update the table inventory before compacting",
    );
}

async function refuseUnfinished(session: SqlSession): Promise<void> {
  // Matched attempts still in geocode_attempt would ship in the served table.
  if (!(await geocodeArchiveReady(session)))
    throw new MaintenanceConflict(
      "matched geocode attempts not yet archived; run worker backfill geocode-archive before compacting",
    );
  const archive = (
    await session.query<{ present: boolean }>(
      "SELECT to_regclass('public.geocode_match_archive') IS NOT NULL AS present",
    )
  ).rows[0]!.present;
  const matchedEvidence = archive ? "geocode_match_archive" : "address_point";
  const checks = [
    `SELECT 1 FROM snapshot WHERE validation_state IN ('FETCHING','PARSED','VALIDATED','RECONCILED') LIMIT 1`,
    `SELECT 1 FROM geocode_tx_run WHERE NOT npi_staged OR NOT issuer_staged LIMIT 1`,
    `SELECT 1 FROM geocode_tx_batch WHERE NOT completed LIMIT 1`,
    `SELECT 1 FROM geocode_open_result WHERE NOT completed LIMIT 1`,
    `SELECT 1 FROM geocode_tx_address a WHERE NOT EXISTS
      (SELECT 1 FROM geocode_tx_result r WHERE r.address_hash=a.address_hash) LIMIT 1`,
    `SELECT 1 FROM geocode_cleanup_address c WHERE c.changed AND c.geocodable AND NOT EXISTS
      (SELECT 1 FROM geocode_tx_result r WHERE r.address_hash=c.retry_hash) LIMIT 1`,
    `SELECT 1 FROM geocode_tx_input i LEFT JOIN geocode_tx_result r USING(address_hash)
      WHERE r.address_hash IS NULL OR NOT EXISTS
      (SELECT 1 FROM (SELECT address_hash,source_table,source_row,geocoded_at FROM geocode_attempt
        UNION ALL SELECT address_hash,source_table,source_row,geocoded_at FROM ${matchedEvidence} WHERE match_status='Match') a WHERE a.address_hash=i.address_hash
        AND a.source_table=i.source_table AND a.source_row=i.source_row AND a.geocoded_at>=r.geocoded_at)
      OR (r.method IS NOT NULL AND NOT EXISTS
      (SELECT 1 FROM address_point p WHERE p.address_hash=i.address_hash
        AND p.source_table=i.source_table AND p.source_row=i.source_row AND p.geocoded_at>=r.geocoded_at)) LIMIT 1`,
  ];
  for (const sql of checks)
    if ((await session.query(sql)).rows.length)
      throw new MaintenanceConflict(
        "unfinished import or unpublished geocode run; finish and publish all runs before compacting",
      );
}

/** Truncate staging atomically, then reclaim dead tuples and refresh planner statistics. */
export async function compactDatabase(
  db: Database,
  dryRun = false,
): Promise<CompactReport> {
  if (!db.withSession)
    throw new MaintenanceConflict(
      "compact requires a database provider with pinned sessions",
    );
  return db.withSession(async (session) => {
    const acquired: number[] = [];
    try {
      for (const key of locks) {
        const { rows } = await session.query<{ locked: boolean }>(
          `SELECT pg_try_advisory_lock(${key}) AS locked`,
        );
        if (!rows[0]?.locked)
          throw new MaintenanceConflict(
            "an import, geocoder or maintenance worker is running; retry compact after it finishes",
          );
        acquired.push(key);
      }
      await session.exec("BEGIN");
      let before: CompactSize;
      let targets: string[];
      try {
        before = await sizes(session);
        assertClassifiedTables(before.tables.map((t) => t.name));
        // SHARE allows API reads but refuses any writer already using the database.
        await session.exec(
          `LOCK TABLE ${before.tables.map((t) => quote(t.name)).join(",")} IN SHARE MODE NOWAIT`,
        );
        await refuseUnfinished(session);
        targets = stagingTables.filter((name) =>
          before.tables.some((t) => t.name === name),
        );
        assertStagingTables(targets);
        if (!dryRun && targets.length)
          await session.exec(
            `TRUNCATE TABLE ${targets.map(quote).join(",")} RESTRICT`,
          );
        await session.exec("COMMIT");
      } catch (error) {
        await session.exec("ROLLBACK");
        throw error;
      }
      const vacuum = before.tables
        .filter((t) => t.name !== "spatial_ref_sys")
        .map((t) => ({
          name: t.name,
          // TRUNCATE already releases staging heaps, indexes and TOAST. Rewrite retained
          // relations only when statistics report dead tuples that a FULL vacuum can reclaim.
          full: !targets.includes(t.name) && t.deadTuples > 0,
        }));
      if (!dryRun)
        for (const table of vacuum)
          await session.exec(
            `VACUUM (${table.full ? "FULL, " : "PARALLEL 0, "}ANALYZE) ${quote(table.name)}`,
          );
      const after = dryRun ? before : await sizes(session);
      const relationBytes = (s: CompactSize) =>
        s.tables.reduce((n, t) => n + t.bytes, 0);
      return {
        dryRun,
        truncated: targets,
        vacuum,
        before,
        after,
        reclaimedRelationBytes: relationBytes(before) - relationBytes(after),
      };
    } finally {
      for (const key of acquired.reverse())
        await session.query(`SELECT pg_advisory_unlock(${key})`);
    }
  });
}
