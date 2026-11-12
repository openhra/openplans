import { PGlite } from "@electric-sql/pglite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../../src/db/migrate.js";
import { ingestGeo } from "../../src/ingest/geo/index.js";
import { importPufs } from "../../src/ingest/puf/import.js";
import { ingestRatingRules } from "../../src/ingest/rating-rules/index.js";
import { coreMigrations, testDatabase } from "../pglite.js";
import { fixtureFiles as geoFiles } from "../ingest/geo/helpers.js";
import { fixtureFiles } from "../api/helpers.js";

export const FIXED_TIME = "2026-11-08T00:00:00.000Z";
export const TOKEN = "synthetic-digest-token";
export const CURSOR_SECRET = "synthetic-digest-cursor-secret";

/** Same imports as quoteFixture; all new inputs are synthetic. No new source data. */
export async function digestFixture() {
  const db = testDatabase(new PGlite());
  const directory = await mkdtemp(join(tmpdir(), "openplans-digests-"));
  const core = await coreMigrations();
  const close = async () => {
    await db.close();
    await core.cleanup();
    await rm(directory, { recursive: true, force: true });
  };
  try {
    // Inject the database clock before migrations, defaults and provenance triggers run.
    // Explicit pg_catalog placement makes the test clock win function lookup.
    await db.exec(`
      CREATE FUNCTION public.now() RETURNS timestamptz LANGUAGE sql IMMUTABLE
        AS $$ SELECT '${FIXED_TIME}'::timestamptz $$;
      CREATE FUNCTION public.clock_timestamp() RETURNS timestamptz LANGUAGE sql IMMUTABLE
        AS $$ SELECT '${FIXED_TIME}'::timestamptz $$;
      SET search_path TO public, pg_catalog;
      SET timezone TO 'UTC';
      SELECT setseed(0.5);
    `);
    await migrate(db, core.directory);
    await ingestGeo(db, { files: await geoFiles() });
    const report = await importPufs(db, {
      year: 2026,
      state: "TX",
      files: await fixtureFiles(directory),
      dataDir: directory,
    });
    if (report.status !== "ACTIVE")
      throw new Error("Digest fixture import failed");
    await ingestRatingRules(db);
    return { db, close };
  } catch (error) {
    await close();
    throw error;
  }
}
