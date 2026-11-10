import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  classifyMigration,
  concurrentIndex,
  migrationStatements,
} from "./migrate-safety.js";
import type { Database, SqlSession } from "./database.js";

export const migrationsDirectory = fileURLToPath(
  new URL("../../migrations/", import.meta.url),
);

export async function loadMigrations(directory = migrationsDirectory) {
  const files = (await readdir(directory)).filter((name) =>
    name.endsWith(".sql"),
  );
  const versions = new Set<number>();
  const migrations = await Promise.all(
    files.map(async (name) => {
      const match = /^(\d+)_[-a-z0-9_]+\.sql$/.exec(name);
      const version = Number(match?.[1]);
      if (!match || !Number.isSafeInteger(version) || versions.has(version)) {
        throw new Error(`Invalid or duplicate migration number: ${name}`);
      }
      versions.add(version);
      const sql = await readFile(join(directory, name), "utf8");
      return {
        name,
        version,
        sql,
        sha256: createHash("sha256").update(sql).digest("hex"),
      };
    }),
  );
  migrations.sort((a, b) => a.version - b.version);

  return migrations;
}

type Migration = Awaited<ReturnType<typeof loadMigrations>>[number];

function pendingMigrations(
  migrations: Migration[],
  rows: { name: string; sha256: string }[],
) {
  for (const row of rows) {
    if (
      !migrations.some(
        (migration) =>
          migration.name === row.name && migration.sha256 === row.sha256,
      )
    )
      throw new Error(`Applied migration missing or changed: ${row.name}`);
  }
  const applied = new Set(rows.map((row) => row.name));
  return migrations.filter((migration) => !applied.has(migration.name));
}

/** No journal creation, advisory locks, DDL, or installer calls in preflight. */
export async function checkMigrations(
  db: Database,
  directory = migrationsDirectory,
) {
  const migrations = await loadMigrations(directory);
  return db.transaction(async (tx) => {
    await tx.exec("SET TRANSACTION READ ONLY");
    const { rows: journal } = await tx.query<{ present: boolean }>(
      "SELECT to_regclass('schema_migrations') IS NOT NULL AS present",
    );
    const rows = journal[0]?.present
      ? (
          await tx.query<{ name: string; sha256: string }>(
            "SELECT name, sha256 FROM schema_migrations ORDER BY name",
          )
        ).rows
      : [];
    return {
      format: 1,
      pending: pendingMigrations(migrations, rows).map(
        ({ name, sha256, sql }) => ({
          name,
          sha256,
          ...classifyMigration(sql),
        }),
      ),
    };
  });
}

async function installMetadata(tx: SqlSession) {
  for (const name of [
    "install_row_provenance_all",
    "install_record_policy_all",
  ]) {
    const { rows } = await tx.query<{ present: boolean }>(
      `SELECT to_regproc('${name}') IS NOT NULL AS present`,
    );
    if (rows[0]?.present) await tx.query(`SELECT ${name}()`);
  }
}

const journalSql = `CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
)`;

export async function migrate(
  db: Database,
  directory = migrationsDirectory,
): Promise<string[]> {
  const migrations = await loadMigrations(directory);
  if (
    migrations.some(
      (m) =>
        /\bCONCURRENTLY\b/i.test(m.sql) &&
        migrationStatements(m.sql).some(concurrentIndex),
    )
  )
    return migrateWithConcurrentIndexes(db, migrations);
  return db.transaction(async (tx) => {
    await tx.exec("SET LOCAL lock_timeout = '2s'");
    // Index builds on populated tables must fit Docker's default 64 MiB /dev/shm.
    await tx.exec("SET LOCAL max_parallel_maintenance_workers = 0");
    await tx.query("SELECT pg_advisory_xact_lock(1869636974)");
    await tx.exec(journalSql);
    const { rows } = await tx.query<{ name: string; sha256: string }>(
      "SELECT name, sha256 FROM schema_migrations ORDER BY name",
    );
    // Disjoint lane ranges can merge below the newest applied migration.
    const pending = pendingMigrations(migrations, rows);
    for (const migration of pending) {
      await tx.exec(migration.sql);
      await tx.query(
        "INSERT INTO schema_migrations (name, sha256) VALUES ($1, $2)",
        [migration.name, migration.sha256],
      );
    }
    // A lane's table can land below 990 after 990 has run on this database. Give every
    // table the row provenance columns and trigger, whatever order the migrations ran in.
    if (pending.length > 0) await installMetadata(tx);
    return pending.map((migration) => migration.name);
  });
}

/** Concurrent indexes require autocommit. Keep the same advisory key on one pinned session. */
async function migrateWithConcurrentIndexes(
  db: Database,
  migrations: Migration[],
): Promise<string[]> {
  if (!db.withSession)
    throw new Error("Concurrent indexes require a pinned PostgreSQL session");
  // Reject mixed files before executing anything. Retrying a failed index needs operator review.
  for (const migration of migrations) {
    const statements = migrationStatements(migration.sql);
    if (statements.some(concurrentIndex)) {
      if (statements.length !== 1)
        throw new Error(
          `Concurrent indexes must be in a standalone migration: ${migration.name}`,
        );
      // IF NOT EXISTS can silently accept an invalid index left by a failed build.
      if (statements[0]!.tokens.join(" ").includes(" IF NOT EXISTS "))
        throw new Error(
          `Concurrent index retries require inspection: ${migration.name}`,
        );
    }
  }
  return db.withSession(async (session) => {
    let locked = false;
    try {
      await session.exec("SET lock_timeout = '2s'");
      await session.exec("SET max_parallel_maintenance_workers = 0");
      await session.query("SELECT pg_advisory_lock(1869636974)");
      locked = true;
      await session.exec(journalSql);
      const { rows } = await session.query<{ name: string; sha256: string }>(
        "SELECT name, sha256 FROM schema_migrations ORDER BY name",
      );
      const pending = pendingMigrations(migrations, rows);
      for (const migration of pending) {
        const statements = migrationStatements(migration.sql);
        const concurrent = statements.some(concurrentIndex);
        if (!concurrent) await session.exec("BEGIN");
        try {
          if (concurrent) {
            await session.exec(statements[0]!.sql);
          } else {
            await session.exec(migration.sql);
            await installMetadata(session);
          }
          await session.query(
            "INSERT INTO schema_migrations (name, sha256) VALUES ($1, $2)",
            [migration.name, migration.sha256],
          );
          if (!concurrent) await session.exec("COMMIT");
        } catch (error) {
          if (!concurrent) await session.exec("ROLLBACK");
          throw error;
        }
      }
      return pending.map((m) => m.name);
    } finally {
      if (locked) await session.query("SELECT pg_advisory_unlock(1869636974)");
      await session.exec("RESET lock_timeout");
      await session.exec("RESET max_parallel_maintenance_workers");
    }
  });
}
