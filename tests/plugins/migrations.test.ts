import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/index.js";
import type { Database } from "../../src/db/database.js";
import {
  loadMigrations,
  loadPluginMigrations,
  PluginMigrationRefusal,
} from "../../src/db/migrate.js";
import type * as MigrateModule from "../../src/db/migrate.js";
import type { PluginMigrationSource } from "../../src/db/migrate.js";
import { pluginMigrationScope } from "../../src/db/plugin-migration-scope.js";
import { schemaViolations } from "../../src/db/row-provenance-check.js";
import { loadPlugins } from "../../src/plugins/index.js";
import { plantMutant } from "../../src/plugins/testing/index.js";
import { runWorker } from "../../src/worker/commands.js";
import { coreMigrations, testDatabase } from "../pglite.js";

// Design 5.13. Every database here is an in-memory PGlite instance; nothing connects anywhere.
const fixtures = fileURLToPath(
  new URL("../fixtures/plugins/", import.meta.url),
);
const PLUGIN = "@synthetic/migrations";
const fixtureSource: PluginMigrationSource = {
  plugin: PLUGIN,
  tablePrefix: "synmig",
  directory: join(fixtures, "synthetic-migrations", "migrations"),
};
const FIXTURE_NAMES = [
  `plugin:${PLUGIN}/001_create_note.sql`,
  `plugin:${PLUGIN}/002_note_body_index.sql`,
];

let core: Awaited<ReturnType<typeof coreMigrations>>;
let coreNames: string[];
const scratch = await mkdtemp(join(tmpdir(), "openplans-plugin-migrations-"));
beforeAll(async () => {
  core = await coreMigrations();
  coreNames = (await loadMigrations(core.directory)).map(({ name }) => name);
});
afterAll(async () => {
  await core.cleanup();
  await rm(scratch, { recursive: true, force: true });
});

interface Run {
  code: number;
  out: string[];
  err: string[];
  opened: number;
}
async function worker(
  db: Database,
  args: string[],
  migrations?: readonly PluginMigrationSource[],
): Promise<Run> {
  const result: Run = { code: 0, out: [], err: [], opened: 0 };
  result.code = await runWorker(
    args,
    () => {
      result.opened++;
      return { ...db, close: async () => {} };
    },
    {
      out: (line) => result.out.push(line),
      error: (line) => result.err.push(line),
    },
    core.directory,
    [],
    migrations ? { migrations } : {},
  );
  return result;
}

/** A plugin package in the scratch directory with the given migration files. */
async function pluginWith(
  name: string,
  files: Record<string, string>,
  tablePrefix: string | null = "synmig",
): Promise<PluginMigrationSource> {
  const directory = join(scratch, name, "migrations");
  await mkdir(directory, { recursive: true });
  for (const [file, sql] of Object.entries(files))
    await writeFile(join(directory, file), sql);
  return {
    plugin: `@synthetic/${name}`,
    ...(tablePrefix && { tablePrefix }),
    directory,
  };
}

const journal = async (db: Database) =>
  (
    await db.query<{ name: string }>(
      "SELECT name FROM schema_migrations ORDER BY name",
    )
  ).rows.map(({ name }) => name);
const tableExists = async (db: Database, table: string) =>
  (
    await db.query<{ present: boolean }>(
      "SELECT to_regclass($1) IS NOT NULL AS present",
      [table],
    )
  ).rows[0]!.present;

describe("plugin migration scope (design 5.13)", () => {
  it.each([
    "CREATE TABLE plg_synmig_a (id int)",
    "CREATE TABLE IF NOT EXISTS public.plg_synmig_a (id int REFERENCES snapshot(snapshot_id))",
    'CREATE UNLOGGED TABLE "plg_synmig_a" (id int)',
    "CREATE INDEX plg_synmig_a_id ON plg_synmig_a (id)",
    "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS plg_synmig_i ON ONLY plg_synmig_a (id)",
    "CREATE INDEX ON plg_synmig_a (id)",
    "CREATE OR REPLACE FUNCTION plg_synmig_f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$",
    "ALTER TABLE plg_synmig_a ADD COLUMN note text",
    "ALTER TABLE IF EXISTS ONLY plg_synmig_a RENAME TO plg_synmig_b",
    "ALTER TABLE plg_synmig_a RENAME COLUMN note TO body",
    "INSERT INTO plg_synmig_a (id) VALUES (1)",
    "-- a comment only",
  ])("allows %s", (sql) => {
    expect(pluginMigrationScope(sql, "synmig")).toBeUndefined();
  });

  it.each([
    ["INSERT INTO snapshot (snapshot_id) VALUES ('x')", "insert outside"],
    ["ALTER TABLE snapshot ADD COLUMN note text", "table outside"],
    ["ALTER TABLE public.snapshot ADD COLUMN note text", "table outside"],
    ["CREATE TABLE plg_other_a (id int)", "table outside"],
    ["CREATE TABLE plg_synmig_ (id int)", "table outside"],
    ['CREATE TABLE "PLG_SYNMIG_a" (id int)', "table outside"],
    ["CREATE TABLE elsewhere.plg_synmig_a (id int)", "table outside"],
    ["CREATE INDEX plg_synmig_i ON snapshot (source_id)", "index on a table"],
    ["CREATE INDEX snapshot_extra ON plg_synmig_a (id)", "index outside"],
    [
      "CREATE FUNCTION apply_record_policy() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$",
      "function outside",
    ],
    ["CREATE TABLE plg_synmig_p PARTITION OF snapshot DEFAULT", "attached"],
    ["CREATE TABLE plg_synmig_c () INHERITS (snapshot)", "attached"],
    ["ALTER TABLE plg_synmig_a RENAME TO snapshot_extra", "rename outside"],
    ["ALTER TABLE plg_synmig_a SET SCHEMA elsewhere", "alteration"],
    [
      "ALTER TABLE plg_synmig_a ATTACH PARTITION snapshot DEFAULT",
      "alteration",
    ],
    [
      "CREATE TRIGGER t AFTER INSERT ON plg_synmig_a FOR EACH ROW EXECUTE FUNCTION plg_synmig_f()",
      "not allowed",
    ],
    ["CREATE VIEW plg_synmig_v AS SELECT 1", "not allowed"],
    ["UPDATE snapshot SET source_id = 'x'", "not allowed"],
    ["DELETE FROM plg_synmig_a", "not allowed"],
    ["DROP TABLE snapshot", "not allowed"],
    ["DO $$ BEGIN EXECUTE 'DROP TABLE snapshot'; END $$", "not allowed"],
    ["SELECT install_row_provenance('snapshot')", "not allowed"],
    [
      "CREATE TABLE plg_synmig_a (id int); ALTER TABLE plan ADD COLUMN x int",
      "statement 2",
    ],
    ["CREATE TABLE plg_synmig_a (id int", "unreadable"],
  ])("refuses %s", (sql, reason) => {
    expect(pluginMigrationScope(sql, "synmig")).toContain(reason);
  });

  it("refuses before anything runs: a plugin migration writing a core table", async () => {
    const db = testDatabase(new PGlite());
    try {
      const source = await pluginWith("core-writer", {
        "001_note.sql": "CREATE TABLE plg_synmig_note (id int);",
        "002_core.sql": "ALTER TABLE snapshot ADD COLUMN plugin_note text;",
      });
      const run = await worker(db, ["migrate"], [source]);
      expect(run.code).toBe(1);
      expect(run.out).toEqual([]);
      expect(run.err.map((line) => JSON.parse(line))).toEqual([
        {
          plugin: "@synthetic/core-writer",
          code: "plugin_migration_scope",
          reason: "002_core.sql statement 1: table outside the plugin prefix",
        },
      ]);
      // Refused before the database was opened: not even the core migrations ran.
      expect(run.opened).toBe(0);
      expect(await tableExists(db, "schema_migrations")).toBe(false);
      const check = await worker(db, ["migrate", "--check"], [source]);
      expect(check.code).toBe(1);
      expect(check.out).toEqual([]);
      expect(check.opened).toBe(0);
    } finally {
      await db.close();
    }
  });

  it("mutant: without the scope check, the plugin migration alters the core table", async () => {
    const mutant = await plantMutant(
      new URL("../../src/db/migrate.ts", import.meta.url),
      "const reason = pluginMigrationScope(migration.sql, source.tablePrefix);",
      "const reason = undefined as string | undefined;",
    );
    const db = testDatabase(new PGlite());
    try {
      const loaded = (await import(
        pathToFileURL(mutant.path).href
      )) as typeof MigrateModule;
      const source = await pluginWith("core-writer-mutant", {
        "001_core.sql": "ALTER TABLE snapshot ADD COLUMN plugin_note text;",
      });
      const plugins = await loaded.loadPluginMigrations([source]);
      await loaded.migrate(db, core.directory, plugins);
      const { rows } = await db.query<{ present: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_name = 'snapshot' AND column_name = 'plugin_note') AS present`,
      );
      expect(rows[0]!.present).toBe(true);
    } finally {
      await db.close();
      await mutant.cleanup();
    }
  });

  it("refuses migration files from a plugin without a tablePrefix, and bad file names", async () => {
    const unprefixed = await pluginWith(
      "unprefixed",
      { "001_note.sql": "CREATE TABLE plg_synmig_note (id int);" },
      null,
    );
    await expect(loadPluginMigrations([unprefixed])).rejects.toMatchObject({
      plugin: "@synthetic/unprefixed",
      code: "plugin_migration_scope",
      reason: "tablePrefix",
    });
    const badName = await pluginWith("bad-name", {
      "note.sql": "CREATE TABLE plg_synmig_note (id int);",
    });
    await expect(loadPluginMigrations([badName])).rejects.toBeInstanceOf(
      PluginMigrationRefusal,
    );
    await expect(loadPluginMigrations([badName])).rejects.toMatchObject({
      code: "plugin_migration_invalid",
    });
    // No directory, or one without .sql files: nothing to run, nothing refused.
    expect(
      await loadPluginMigrations([
        { plugin: "@synthetic/none", directory: join(scratch, "missing") },
      ]),
    ).toEqual([]);
  });
});

describe("plugin migrations run after core (design 5.13)", () => {
  it("applies core first, then each plugin's files by number, journalled per plugin", async () => {
    const db = testDatabase(new PGlite());
    try {
      const check = await worker(db, ["migrate", "--check"], [fixtureSource]);
      expect(check.code).toBe(0);
      const pending = JSON.parse(check.out[0]!) as {
        format: number;
        pending: { name: string; classification: string }[];
      };
      expect(pending.format).toBe(1);
      expect(pending.pending.map(({ name }) => name)).toEqual([
        ...coreNames,
        ...FIXTURE_NAMES,
      ]);
      const run = await worker(db, ["migrate"], [fixtureSource]);
      expect(run.err).toEqual([]);
      expect(run.code).toBe(0);
      expect(JSON.parse(run.out[0]!)).toEqual({
        applied: [...coreNames, ...FIXTURE_NAMES],
      });
      expect(await journal(db)).toEqual(
        [...coreNames, ...FIXTURE_NAMES].sort(),
      );
      expect(await tableExists(db, "plg_synmig_note")).toBe(true);
      expect(await tableExists(db, "plg_synmig_note_body")).toBe(true);
      // The core installers gave the plugin table its provenance and record policy columns.
      expect(await schemaViolations(db)).toEqual([]);
      // Applied: a second run and a check find nothing pending.
      expect(
        JSON.parse((await worker(db, ["migrate"], [fixtureSource])).out[0]!),
      ).toEqual({ applied: [] });
      expect(
        JSON.parse(
          (await worker(db, ["migrate", "--check"], [fixtureSource])).out[0]!,
        ),
      ).toEqual({ format: 1, pending: [] });
    } finally {
      await db.close();
    }
  });

  it("mutant: plugin migrations running before core fail on a fresh database", async () => {
    const mutant = await plantMutant(
      new URL("../../src/db/migrate.ts", import.meta.url),
      "migrations = [...migrations, ...plugins];",
      "migrations = [...plugins, ...migrations];",
    );
    const db = testDatabase(new PGlite());
    try {
      const loaded = (await import(
        pathToFileURL(mutant.path).href
      )) as typeof MigrateModule;
      const plugins = await loaded.loadPluginMigrations([fixtureSource]);
      // The fixture references the core snapshot table, which does not exist yet.
      await expect(
        loaded.migrate(db, core.directory, plugins),
      ).rejects.toThrow();
      expect(await tableExists(db, "plg_synmig_note")).toBe(false);
    } finally {
      await db.close();
      await mutant.cleanup();
    }
  });

  it("an applied plugin file that changed is an error while the plugin is enabled", async () => {
    const db = testDatabase(new PGlite());
    try {
      const source = await pluginWith("changed", {
        "001_note.sql": "CREATE TABLE plg_synmig_note (id int);",
      });
      expect((await worker(db, ["migrate"], [source])).code).toBe(0);
      await writeFile(
        join(source.directory, "001_note.sql"),
        "CREATE TABLE plg_synmig_note (id bigint);",
      );
      const run = await worker(db, ["migrate"], [source]);
      expect(run.code).toBe(1);
      expect(run.err.join("\n")).toContain("worker migrate failed");
    } finally {
      await db.close();
    }
  });
});

describe("disabling a plugin (design 5.13)", () => {
  it("keeps its tables and journal rows, and migrate --check stops listing its files", async () => {
    const db = testDatabase(new PGlite());
    try {
      const pending = await pluginWith("disabled", {
        "001_note.sql":
          "CREATE TABLE plg_synmig_note (id int); INSERT INTO plg_synmig_note (id) VALUES (7);",
      });
      expect((await worker(db, ["migrate"], [pending])).code).toBe(0);
      await writeFile(
        join(pending.directory, "002_more.sql"),
        "CREATE TABLE plg_synmig_more (id int);",
      );
      // Disabled: the worker gets no plugin migrations at all.
      const check = await worker(db, ["migrate", "--check"]);
      expect(check.code).toBe(0);
      expect(JSON.parse(check.out[0]!)).toEqual({ format: 1, pending: [] });
      const run = await worker(db, ["migrate"]);
      expect(run.code).toBe(0);
      expect(JSON.parse(run.out[0]!)).toEqual({ applied: [] });
      expect(await journal(db)).toContain(
        "plugin:@synthetic/disabled/001_note.sql",
      );
      expect(
        (await db.query<{ id: number }>("SELECT id FROM plg_synmig_note")).rows,
      ).toEqual([{ id: 7 }]);
      expect(await tableExists(db, "plg_synmig_more")).toBe(false);
      // Enabled again: only its new file is pending.
      const again = await worker(db, ["migrate", "--check"], [pending]);
      expect(
        (
          JSON.parse(again.out[0]!) as { pending: { name: string }[] }
        ).pending.map(({ name }) => name),
      ).toEqual(["plugin:@synthetic/disabled/002_more.sql"]);
    } finally {
      await db.close();
    }
  });
});

describe("migrate --check classifies plugin migrations (design 5.13)", () => {
  it("reports a risky plugin migration with the same classifier and its plugin: name", async () => {
    const db = testDatabase(new PGlite());
    try {
      const source = await pluginWith("risky", {
        "001_note.sql": "CREATE TABLE plg_synmig_note (id int, body text);",
      });
      expect((await worker(db, ["migrate"], [source])).code).toBe(0);
      await writeFile(
        join(source.directory, "002_drop_body.sql"),
        "ALTER TABLE plg_synmig_note DROP COLUMN body;",
      );
      const check = await worker(db, ["migrate", "--check"], [source]);
      expect(check.code).toBe(0);
      const report = JSON.parse(check.out[0]!) as {
        format: number;
        pending: {
          name: string;
          sha256: string;
          classification: string;
          reasons: string[];
        }[];
      };
      expect(report.format).toBe(1);
      expect(report.pending).toHaveLength(1);
      expect(report.pending[0]).toMatchObject({
        name: "plugin:@synthetic/risky/002_drop_body.sql",
        classification: "risky",
      });
      expect(report.pending[0]!.reasons.length).toBeGreaterThan(0);
    } finally {
      await db.close();
    }
  });

  it("mutant: a check that leaves plugin migrations out lets a risky one through unseen", async () => {
    const mutant = await plantMutant(
      new URL("../../src/db/migrate.ts", import.meta.url),
      "const pending = pendingMigrations(migrations, rows, plugins);\n    const sizes",
      "const pending = pendingMigrations(migrations, rows);\n    const sizes",
    );
    const db = testDatabase(new PGlite());
    try {
      const loaded = (await import(
        pathToFileURL(mutant.path).href
      )) as typeof MigrateModule;
      const source = await pluginWith("risky-mutant", {
        "001_note.sql": "CREATE TABLE plg_synmig_note (id int, body text);",
      });
      await loaded.migrate(
        db,
        core.directory,
        await loaded.loadPluginMigrations([source]),
      );
      await writeFile(
        join(source.directory, "002_drop_body.sql"),
        "ALTER TABLE plg_synmig_note DROP COLUMN body;",
      );
      const report = await loaded.checkMigrations(
        db,
        core.directory,
        await loaded.loadPluginMigrations([source]),
      );
      expect(report.pending).toEqual([]);
    } finally {
      await db.close();
      await mutant.cleanup();
    }
  });
});

describe("the loader reports each plugin's migrations directory", () => {
  const run = (packages: string[]) =>
    loadPlugins(
      loadConfig(
        {},
        { version: 1, plugins: packages.map((p) => ({ package: p })) },
      ),
      "worker",
      {
        baseDirectory: fixtures,
        env: { SYNTHETIC_ALPHA_SECRET: "synthetic" },
        manifestPaths: [],
        writeLog: () => {},
        exit: (code) => {
          throw new Error(`exit ${code}`);
        },
      },
    );

  it("names a packaged plugin's directory and prefix; a single-file plugin has none", async () => {
    const loaded = await run([
      "./synthetic-alpha/index.mjs",
      "./synthetic-migrations/index.mjs",
    ]);
    try {
      expect(loaded.migrations).toEqual([fixtureSource]);
    } finally {
      await loaded.teardown();
    }
  });

  it("a package copied elsewhere keeps its migrations next to it", async () => {
    const copy = join(scratch, "copied-package");
    await cp(join(fixtures, "synthetic-migrations"), copy, { recursive: true });
    const loaded = await run([join(copy, "index.mjs")]);
    try {
      expect(loaded.migrations).toEqual([
        { ...fixtureSource, directory: join(copy, "migrations") },
      ]);
      expect(
        (await loadPluginMigrations(loaded.migrations)).map(({ name }) => name),
      ).toEqual(FIXTURE_NAMES);
    } finally {
      await loaded.teardown();
    }
  });
});
