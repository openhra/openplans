import { PGlite } from "@electric-sql/pglite";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database, SqlSession } from "../src/db/database.js";
import { migrationsDirectory } from "../src/db/migrate.js";

export function testDatabase(pg: PGlite): Database {
  const session: SqlSession = {
    query: (sql, parameters) => pg.query(sql, parameters),
    exec: async (sql) => {
      await pg.exec(sql);
    },
  };
  return {
    ...session,
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

// The production runner has no skip switch: only this test copy omits PostGIS.
export async function coreMigrations(): Promise<{
  directory: string;
  cleanup(): Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "openplans-migrations-"));
  for (const file of await readdir(migrationsDirectory)) {
    if (file.endsWith(".sql") && file !== "002_postgis.sql") {
      await cp(join(migrationsDirectory, file), join(directory, file));
    }
  }
  return {
    directory,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}
