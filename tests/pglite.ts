import { PGlite } from "@electric-sql/pglite";
import type { PGliteInterface } from "@electric-sql/pglite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database, SqlSession } from "../src/db/database.js";
import { copyMigrations } from "../src/db/copy-migrations.js";
import { migrate } from "../src/db/migrate.js";

export function testDatabase(pg: PGliteInterface): Database {
  const session: SqlSession = {
    query: (sql, parameters) => pg.query(sql, parameters),
    exec: async (sql) => {
      await pg.exec(sql);
    },
  };
  return {
    ...session,
    withSession: (run) => run(session),
    transaction: (run) =>
      pg.transaction(async (tx) =>
        run({
          query: (sql, parameters) => tx.query(sql, parameters),
          exec: async (sql) => {
            await tx.exec(sql);
          },
        }),
      ),
    close: () => pg.close(),
  };
}

// Offline tests omit PostGIS; the nightly PostgreSQL run applies every migration.
export async function coreMigrations(): Promise<{
  directory: string;
  cleanup(): Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "openplans-migrations-"));
  await copyMigrations(
    directory,
    process.env.OPENPLANS_TEST_DB === "postgres" ? [] : ["002_postgis.sql"],
  );
  return {
    directory,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

/**
 * A database with the core migrations applied once. `fresh()` returns an independent copy for one
 * test. A copy takes about 0.3 s; a new database plus migrations takes 1 to 2 s.
 * Tests of migration itself keep migrating their own database.
 */
export async function migratedTemplate(): Promise<{
  fresh(): Promise<Database>;
  close(): Promise<void>;
}> {
  const pg = new PGlite();
  const core = await coreMigrations();
  try {
    await migrate(testDatabase(pg), core.directory);
  } catch (error) {
    await pg.close();
    throw error;
  } finally {
    await core.cleanup();
  }
  return {
    fresh: async () => testDatabase(await pg.clone()),
    close: () => pg.close(),
  };
}
