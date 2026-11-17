import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkMigrations,
  loadMigrations,
  migrate,
  migrationsDirectory,
} from "../src/db/migrate.js";
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

  const index = (...names: string[]) =>
    writeFile(join(directory, "INDEX"), names.join("\n") + "\n");

  it("applies SQL in INDEX order rather than numeric order and is idempotent", async () => {
    await writeFile(
      join(directory, "2_append.sql"),
      "INSERT INTO ordered VALUES ('second');",
    );
    await writeFile(
      join(directory, "10_create.sql"),
      "CREATE TABLE ordered (value text); INSERT INTO ordered VALUES ('first');",
    );
    await index("10_create.sql", "2_append.sql");
    const db = testDatabase(pg);
    expect(await migrate(db, directory)).toEqual([
      "10_create.sql",
      "2_append.sql",
    ]);
    expect(await migrate(db, directory)).toEqual([]);
    expect((await pg.query("SELECT value FROM ordered")).rows).toEqual([
      { value: "first" },
      { value: "second" },
    ]);
    expect(
      (await pg.query("SELECT name FROM schema_migrations ORDER BY ctid")).rows,
    ).toEqual([{ name: "10_create.sql" }, { name: "2_append.sql" }]);
  });

  it("preflight leaves an empty database and an existing journal unchanged", async () => {
    const db = testDatabase(pg);
    await writeFile(
      join(directory, "001_initial.sql"),
      "CREATE TABLE synthetic (id integer);",
    );
    await index("001_initial.sql");
    const empty = await checkMigrations(db, directory);
    expect(empty.pending.map((m) => m.name)).toEqual(["001_initial.sql"]);
    expect(
      (await pg.query("SELECT to_regclass('schema_migrations') AS journal"))
        .rows,
    ).toEqual([{ journal: null }]);
    await migrate(db, directory);
    const before = (await pg.query("SELECT * FROM schema_migrations")).rows;
    await writeFile(
      join(directory, "002_risky.sql"),
      "ALTER TABLE synthetic DROP COLUMN id;",
    );
    await index("001_initial.sql", "002_risky.sql");
    expect((await checkMigrations(db, directory)).pending).toMatchObject([
      { name: "002_risky.sql", classification: "risky" },
    ]);
    expect((await pg.query("SELECT * FROM schema_migrations")).rows).toEqual(
      before,
    );
    await writeFile(
      join(directory, "001_initial.sql"),
      "CREATE TABLE changed (id integer);",
    );
    await expect(checkMigrations(db, directory)).rejects.toThrow(
      "missing or changed",
    );
    expect((await pg.query("SELECT * FROM schema_migrations")).rows).toEqual(
      before,
    );
  });

  it("disables parallel index maintenance only inside the migration transaction", async () => {
    await pg.exec("SET max_parallel_maintenance_workers = 2");
    await writeFile(
      join(directory, "001_index.sql"),
      `CREATE TABLE synthetic_maintenance (workers integer);
       INSERT INTO synthetic_maintenance VALUES (current_setting('max_parallel_maintenance_workers')::int);
       CREATE INDEX ON synthetic_maintenance(workers);`,
    );
    await index("001_index.sql");
    await migrate(testDatabase(pg), directory);
    expect(
      (await pg.query("SELECT workers FROM synthetic_maintenance")).rows,
    ).toEqual([{ workers: 0 }]);
    expect(
      (await pg.query("SHOW max_parallel_maintenance_workers")).rows,
    ).toEqual([{ max_parallel_maintenance_workers: "2" }]);
  });

  it("negative control: syntax failure rolls back all new DDL and journal entries", async () => {
    const db = testDatabase(pg);
    await writeFile(
      join(directory, "001_initial.sql"),
      "CREATE TABLE initial (value integer);",
    );
    await index("001_initial.sql");
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
    await index("001_initial.sql", "002_pending.sql", "003_broken.sql");
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

  it("rejects changed history and duplicate INDEX entries, and applies appended legacy names", async () => {
    const db = testDatabase(pg);
    await writeFile(join(directory, "002_initial.sql"), "SELECT 1;");
    await index("002_initial.sql");
    await migrate(db, directory);
    await writeFile(join(directory, "002_initial.sql"), "SELECT 2;");
    await expect(migrate(db, directory)).rejects.toThrow("missing or changed");
    await writeFile(join(directory, "002_initial.sql"), "SELECT 1;");
    await writeFile(join(directory, "002_duplicate.sql"), "SELECT 1;");
    await index("002_initial.sql", "002_duplicate.sql");
    await expect(migrate(db, directory)).rejects.toThrow(
      "duplicate migration number",
    );
    await rm(join(directory, "002_duplicate.sql"));
    await index("002_initial.sql", "002_initial.sql");
    await expect(migrate(db, directory)).rejects.toThrow(
      "Duplicate migration INDEX entry",
    );
    await writeFile(
      join(directory, "001_late.sql"),
      "CREATE TABLE late_lane (value integer);",
    );
    await index("002_initial.sql", "001_late.sql");
    expect(await migrate(db, directory)).toEqual(["001_late.sql"]);
    expect(await migrate(db, directory)).toEqual([]);
  });

  it("lists every existing SQL file once and preserves the historical numeric order", async () => {
    const migrations = await loadMigrations();
    const names = migrations.map(({ name }) => name);
    expect(new Set(names).size).toBe(names.length);
    const legacy = names.filter((name) => !/^\d{14}_/.test(name));
    expect(legacy).toHaveLength(72);
    expect(legacy).toEqual(
      [...legacy].sort(
        (a, b) => Number(a.split("_")[0]) - Number(b.split("_")[0]),
      ),
    );
    const history = JSON.parse(
      await readFile(
        new URL("./migrate-history.json", import.meta.url),
        "utf8",
      ),
    ) as Record<string, string>;
    for (const [name, sha256] of Object.entries(history))
      expect(migrations.find((m) => m.name === name)?.sha256).toBe(sha256);
    expect(
      (await readFile(join(migrationsDirectory, "INDEX"), "utf8"))
        .trimEnd()
        .split("\n"),
    ).toEqual(names);
  });

  it("accepts timestamp names sharing a second and follows their explicit order", async () => {
    const names = ["20261117041530_second.sql", "20261117041530_first.sql"];
    for (const name of names)
      await writeFile(join(directory, name), "SELECT 1;");
    await index(...names);
    expect((await loadMigrations(directory)).map(({ name }) => name)).toEqual(
      names,
    );
  });

  it.each([
    ["001_one.sql\n001_one.sql\n", "Duplicate migration INDEX entry"],
    ["001_one.sql\n002_missing.sql\n", "INDEX entry missing file"],
    ["", "file missing from INDEX"],
    ["../001_one.sql\n", "Invalid migration INDEX entry"],
    ["001_one.sql\n\n", "Invalid migration INDEX entry"],
    [
      "9007199254740992_large.sql\n001_one.sql\n",
      "Invalid or duplicate migration number",
    ],
  ])(
    "negative control: refuses a damaged INDEX %j",
    async (contents, error) => {
      await writeFile(join(directory, "001_one.sql"), "SELECT 1;");
      if (contents.includes("9007199254740992"))
        await writeFile(
          join(directory, "9007199254740992_large.sql"),
          "SELECT 1;",
        );
      await writeFile(join(directory, "INDEX"), contents);
      await expect(loadMigrations(directory)).rejects.toThrow(error);
      await expect(
        checkMigrations(testDatabase(pg), directory),
      ).rejects.toThrow(error);
      await expect(migrate(testDatabase(pg), directory)).rejects.toThrow(error);
      expect(
        (await pg.query("SELECT to_regclass('schema_migrations') AS journal"))
          .rows,
      ).toEqual([{ journal: null }]);
    },
  );

  it("negative control: refuses a missing INDEX even when SQL files exist", async () => {
    await writeFile(join(directory, "001_one.sql"), "SELECT 1;");
    await expect(loadMigrations(directory)).rejects.toThrow(/ENOENT/);
  });

  it("installs the real provenance schema and rejects incomplete ACTIVE snapshots", async () => {
    const core = await coreMigrations();
    try {
      const db = testDatabase(pg);
      expect(await migrate(db, core.directory)).toEqual(
        (await loadMigrations(core.directory)).map(({ name }) => name),
      );
      expect(await migrate(db, core.directory)).toEqual([]);
      expect(
        (
          await pg.query<{ name: string }>(
            "SELECT name FROM schema_migrations ORDER BY ctid",
          )
        ).rows.map(({ name }) => name),
      ).toEqual((await loadMigrations(core.directory)).map(({ name }) => name));
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
