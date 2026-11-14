import type { SqlSession } from "./database.js";
import { loadMigrations } from "./migrate.js";

/**
 * Names of the migration files in `directory` that the database's journal does not list.
 * It only reads the journal, and never creates it or applies a file.
 */
export async function unappliedMigrations(
  db: SqlSession,
  directory: string,
): Promise<string[]> {
  return unappliedOf(db, await loadMigrations(directory));
}

/** The names in `files` that the journal does not list, read the same way. */
export async function unappliedOf(
  db: SqlSession,
  files: readonly { readonly name: string }[],
): Promise<string[]> {
  const { rows: journal } = await db.query<{ present: boolean }>(
    "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present",
  );
  if (!journal[0]?.present) return files.map(({ name }) => name);
  const { rows } = await db.query<{ name: string }>(
    "SELECT name FROM schema_migrations",
  );
  const applied = new Set(rows.map(({ name }) => name));
  return files.map(({ name }) => name).filter((name) => !applied.has(name));
}
