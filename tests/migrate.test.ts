import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/db/migrate.js";
import { coreMigrations, testDatabase } from "./pglite.js";

describe("migration transactions (PGlite; only PostGIS omitted)", () => {
  let pg: PGlite;
  let directory: string;
  beforeEach(async () => {
    pg = new PGlite();
    directory = await mkdtemp(join(tmpdir(), "openplans-order-"));
  });
  afterEach(async () => {
    await pg.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("applies SQL in numeric order and is idempotent", async () => {
    await writeFile(
      join(directory, "10_append.sql"),
      "INSERT INTO ordered VALUES ('second');",
    );
    await writeFile(
      join(directory, "2_create.sql"),
      "CREATE TABLE ordered (value text); INSERT INTO ordered VALUES ('first');",
    );
    const db = testDatabase(pg);
    expect(await migrate(db, directory)).toEqual([
      "2_create.sql",
      "10_append.sql",
    ]);
    expect(await migrate(db, directory)).toEqual([]);
    expect((await pg.query("SELECT value FROM ordered")).rows).toEqual([
      { value: "first" },
      { value: "second" },
    ]);
    expect(
      (
        await pg.query(
          "SELECT name FROM schema_migrations ORDER BY applied_at, name",
        )
      ).rows,
    ).toHaveLength(2);
  });

  it("negative control: syntax failure rolls back all new DDL and journal entries", async () => {
    const db = testDatabase(pg);
    await writeFile(
      join(directory, "001_initial.sql"),
      "CREATE TABLE initial (value integer);",
    );
    await migrate(db, directory);
    const before = (await pg.query("SELECT * FROM schema_migrations")).rows;
    await writeFile(
      join(directory, "002_pending.sql"),
      "CREATE TABLE pending (value integer);",
    );
    await writeFile(
      join(directory, "003_broken.sql"),
      "CREAT TABLE broken (value integer);",
    );
    await expect(migrate(db, directory)).rejects.toThrow(/syntax error/i);
    expect((await pg.query("SELECT * FROM schema_migrations")).rows).toEqual(
      before,
    );
    expect(
      (await pg.query("SELECT to_regclass('pending') AS table_name")).rows,
    ).toEqual([{ table_name: null }]);
    await writeFile(
      join(directory, "003_broken.sql"),
      "CREATE TABLE repaired (value integer);",
    );
    expect(await migrate(db, directory)).toEqual([
      "002_pending.sql",
      "003_broken.sql",
    ]);
  });

  it("rejects changed history and duplicate numbers, and applies migrations merged below history", async () => {
    const db = testDatabase(pg);
    await writeFile(join(directory, "002_initial.sql"), "SELECT 1;");
    await migrate(db, directory);
    await writeFile(join(directory, "002_initial.sql"), "SELECT 2;");
    await expect(migrate(db, directory)).rejects.toThrow("missing or changed");
    await writeFile(join(directory, "002_initial.sql"), "SELECT 1;");
    await writeFile(join(directory, "002_duplicate.sql"), "SELECT 1;");
    await expect(migrate(db, directory)).rejects.toThrow("duplicate migration");
    await rm(join(directory, "002_duplicate.sql"));
    await writeFile(
      join(directory, "001_late.sql"),
      "CREATE TABLE late_lane (value integer);",
    );
    expect(await migrate(db, directory)).toEqual(["001_late.sql"]);
    expect(await migrate(db, directory)).toEqual([]);
  });

  it("installs the real provenance schema and rejects incomplete ACTIVE snapshots", async () => {
    const core = await coreMigrations();
    try {
      const db = testDatabase(pg);
      expect(await migrate(db, core.directory)).toEqual(
        (await readdir(core.directory))
          .filter((name) => name.endsWith(".sql"))
          .sort((a, b) => a.localeCompare(b, "en", { numeric: true })),
      );
      expect(await migrate(db, core.directory)).toEqual([]);
      // All records in these tests are synthetic and claim no real coverage.
      await pg.query(
        "INSERT INTO source (source_id, publisher, source_kind) VALUES ('synthetic', 'Synthetic test publisher', 'synthetic')",
      );
      await pg.query(
        "INSERT INTO snapshot (snapshot_id, source_id, validation_state) VALUES ('synthetic-quarantine', 'synthetic', 'QUARANTINED')",
      );
      await expect(
        pg.query(
          "INSERT INTO snapshot (snapshot_id, source_id, validation_state) VALUES ('synthetic-active', 'synthetic', 'ACTIVE')",
        ),
      ).rejects.toThrow(/check constraint/i);
      await pg.query(
        "INSERT INTO quality_issue (snapshot_id, severity, issue_code, explanation) VALUES ('synthetic-quarantine', 'error', 'synthetic_incomplete', 'Synthetic test issue')",
      );
      expect(
        (await pg.query("SELECT validation_state FROM snapshot")).rows,
      ).toEqual([{ validation_state: "QUARANTINED" }]);
    } finally {
      await core.cleanup();
    }
  });
});
