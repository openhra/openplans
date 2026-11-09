import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { Database } from "./database.js";

export const migrationsDirectory = fileURLToPath(
  new URL("../../migrations/", import.meta.url),
);

export async function migrate(
  db: Database,
  directory = migrationsDirectory,
): Promise<string[]> {
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

  return db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(1869636974)");
    await tx.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await tx.query<{ name: string; sha256: string }>(
      "SELECT name, sha256 FROM schema_migrations ORDER BY name",
    );
    for (const row of rows) {
      if (
        !migrations.some(
          (migration) =>
            migration.name === row.name && migration.sha256 === row.sha256,
        )
      ) {
        throw new Error(`Applied migration missing or changed: ${row.name}`);
      }
    }
    // Lanes own disjoint number ranges and merge in any order, so a pending migration may sit
    // below the newest applied one. Pending migrations still run in version order.
    const applied = new Set(rows.map((row) => row.name));
    const pending = migrations.filter(
      (migration) => !applied.has(migration.name),
    );
    for (const migration of pending) {
      await tx.exec(migration.sql);
      await tx.query(
        "INSERT INTO schema_migrations (name, sha256) VALUES ($1, $2)",
        [migration.name, migration.sha256],
      );
    }
    return pending.map((migration) => migration.name);
  });
}
