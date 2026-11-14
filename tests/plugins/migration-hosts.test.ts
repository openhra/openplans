import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { OpenPlansPlugin } from "@openplans/plugin-sdk";
import type { Database } from "../../src/db/database.js";
import { loadPluginMigrations, migrate } from "../../src/db/migrate.js";
import type * as MigrateModule from "../../src/db/migrate.js";
import type { PluginMigrationSource } from "../../src/db/migrate.js";
import { schemaViolations } from "../../src/db/row-provenance-check.js";
import * as fetcher from "../../src/fetch/index.js";
import * as geoSources from "../../src/ingest/geo/sources.js";
import { loadForTest, plantMutant } from "../../src/plugins/testing/index.js";
import type * as KitModule from "../../src/plugins/testing/load.js";
import { runWorker } from "../../src/worker/commands.js";
import type * as CommandsModule from "../../src/worker/commands.js";
import { coreMigrations, testDatabase } from "../pglite.js";

// Design 5.13: the test kit, bootstrap and the ingest commands run enabled plugins'
// migrations. Every database is an in-memory PGlite instance and every network call is stubbed.
const packageRoot = new URL(
  "../fixtures/plugins/synthetic-migrations/",
  import.meta.url,
);
const PLUGIN = "@synthetic/migrations";
const fixtureSource: PluginMigrationSource = {
  plugin: PLUGIN,
  tablePrefix: "synmig",
  directory: join(fileURLToPath(packageRoot), "migrations"),
};
const FIXTURE_NAMES = [
  `plugin:${PLUGIN}/001_create_note.sql`,
  `plugin:${PLUGIN}/002_note_body_index.sql`,
];
const fixturePlugin = (
  (await import(new URL("index.mjs", packageRoot).href)) as {
    default: OpenPlansPlugin;
  }
).default;

let core: Awaited<ReturnType<typeof coreMigrations>>;
let dataDir: string;
beforeAll(async () => {
  core = await coreMigrations();
  dataDir = await mkdtemp(join(tmpdir(), "openplans-migration-hosts-"));
});
afterAll(async () => {
  await core.cleanup();
  await rm(dataDir, { recursive: true, force: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const pluginJournal = async (db: Database) =>
  (
    await db.query<{ name: string }>(
      "SELECT name FROM schema_migrations WHERE name LIKE 'plugin:%' ORDER BY name",
    )
  ).rows.map(({ name }) => name);
const tableExists = async (db: Database, table: string) =>
  (
    await db.query<{ present: boolean }>(
      "SELECT to_regclass($1) IS NOT NULL AS present",
      [table],
    )
  ).rows[0]!.present;
const revision = async (db: Database, table: string) =>
  (
    await db.query<{ revision: string }>(
      "SELECT revision::text FROM api_data_generation WHERE table_name = $1",
      [table],
    )
  ).rows[0]?.revision;

describe("the test kit runs the plugin's own migrations", () => {
  it("creates the plugin tables after the core ones, with a working generation trigger", async () => {
    const loaded = await loadForTest(fixturePlugin, { packageRoot });
    try {
      const { db } = loaded;
      expect(await tableExists(db, "plg_synmig_note")).toBe(true);
      expect(await pluginJournal(db)).toEqual(FIXTURE_NAMES);
      expect(await schemaViolations(db)).toEqual([]);
      const before = await revision(db, "plg_synmig_note");
      expect(before).toBeDefined();
      await db.query("INSERT INTO plg_synmig_note (body) VALUES ('synthetic')");
      expect(await revision(db, "plg_synmig_note")).not.toBe(before);
    } finally {
      await loaded.close();
    }
  });

  it("accepts a string package root and an already migrated database", async () => {
    const db = testDatabase(new PGlite());
    try {
      await migrate(db, core.directory);
      const loaded = await loadForTest(fixturePlugin, {
        db,
        packageRoot: fileURLToPath(packageRoot),
      });
      await loaded.close();
      expect(await pluginJournal(db)).toEqual(FIXTURE_NAMES);
    } finally {
      await db.close();
    }
  });

  it("refuses a plugin with a table prefix and no package root", async () => {
    await expect(loadForTest(fixturePlugin)).rejects.toThrow(
      /pass packageRoot/,
    );
  });

  it("negative control: a plugin table without the generation trigger fails the kit", async () => {
    // A core that forgot to give plugin tables the trigger. The core ships a concurrent index,
    // so every run takes the pinned-session path.
    const mutant = await plantMutant(
      new URL("../../src/db/migrate.ts", import.meta.url),
      "          await installMetadata(session);\n          await installPluginGeneration(session, plugins);",
      "          await installMetadata(session);",
    );
    const db = testDatabase(new PGlite());
    try {
      const broken = (await import(
        pathToFileURL(mutant.path).href
      )) as typeof MigrateModule;
      await broken.migrate(
        db,
        core.directory,
        await broken.loadPluginMigrations([fixtureSource]),
      );
      await expect(
        loadForTest(fixturePlugin, { db, packageRoot }),
      ).rejects.toThrow(
        /plg_synmig_note: no api_data_changed trigger; plg_synmig_note: no api_data_generation row/,
      );
    } finally {
      await db.close();
      await mutant.cleanup();
    }
  });

  it("mutant: a kit that skips plugin migrations leaves the plugin without its tables", async () => {
    const mutant = await plantMutant(
      new URL("../../src/plugins/testing/load.ts", import.meta.url),
      "await migrateForTest(db, migrations);",
      "await migrateForTest(db, []);",
    );
    try {
      const kit = (await import(
        pathToFileURL(mutant.path).href
      )) as typeof KitModule;
      const loaded = await kit.loadForTest(fixturePlugin, { packageRoot });
      try {
        expect(await tableExists(loaded.db, "plg_synmig_note")).toBe(false);
      } finally {
        await loaded.close();
      }
    } finally {
      await mutant.cleanup();
    }
  });
});

interface Run {
  code: number;
  out: string[];
  err: string[];
}
async function worker(
  run: typeof runWorker,
  db: Database,
  args: string[],
  migrations?: readonly PluginMigrationSource[],
): Promise<Run> {
  const result: Run = { code: 0, out: [], err: [] };
  result.code = await run(
    args,
    () => ({ ...db, close: async () => {} }),
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

/** Bootstrap with every download refused: only the migrate step can succeed. */
function offlineBootstrap() {
  vi.stubEnv("OPENPLANS_DATA_DIR", dataDir);
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic@127.0.0.1/synthetic");
  vi.spyOn(fetcher, "fetchToCache").mockRejectedValue(
    new Error("synthetic offline"),
  );
  vi.spyOn(geoSources, "acquireGeo").mockRejectedValue(
    new Error("synthetic offline"),
  );
  vi.stubGlobal("fetch", () => Promise.reject(new Error("synthetic offline")));
}
const BOOTSTRAP = ["bootstrap", "--states", "TX", "--years", "2026"];
const migrateStep = (run: Run) =>
  (
    JSON.parse(run.out.at(-1)!) as {
      steps: { id: string; status: string; evidence?: { applied: string[] } }[];
    }
  ).steps.find(({ id }) => id === "migrate");

describe("bootstrap and ingest commands run enabled plugins' migrations", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("bootstrap's migrate step applies the plugin's files after the core ones", async () => {
    offlineBootstrap();
    const db = testDatabase(new PGlite());
    try {
      const run = await worker(runWorker, db, BOOTSTRAP, [fixtureSource]);
      expect(migrateStep(run)?.status).toBe("completed");
      expect(await pluginJournal(db)).toEqual(FIXTURE_NAMES);
      expect(await tableExists(db, "plg_synmig_note")).toBe(true);
      const applied = migrateStep(run)!.evidence!.applied;
      expect(applied.slice(-2)).toEqual(FIXTURE_NAMES);
    } finally {
      await db.close();
    }
  });

  it("without plugins, bootstrap prints the same lines as with an empty plugin list", async () => {
    offlineBootstrap();
    const runs: Run[] = [];
    for (const migrations of [undefined, []]) {
      const db = testDatabase(new PGlite());
      try {
        runs.push(await worker(runWorker, db, BOOTSTRAP, migrations));
        expect(await pluginJournal(db)).toEqual([]);
      } finally {
        await db.close();
      }
    }
    // Only step timings differ between the runs.
    const strip = (run: Run) =>
      run.out.map((line) =>
        line.replace(/"elapsed_ms":\d+/g, '"elapsed_ms":0'),
      );
    expect(runs[1]!.code).toBe(runs[0]!.code);
    expect(strip(runs[1]!)).toEqual(strip(runs[0]!));
    expect(runs[1]!.err).toEqual(runs[0]!.err);
  });

  it("an ingest command migrates the plugin too, and refuses an out-of-scope plugin file first", async () => {
    const db = testDatabase(new PGlite());
    try {
      const missing = join(dataDir, "absent-rules.json");
      const args = ["ingest", "rating-rules", "--file", missing];
      const run = await worker(runWorker, db, args, [fixtureSource]);
      // The import fails on the missing file after migrate has committed.
      expect(run.code).toBe(1);
      expect(await pluginJournal(db)).toEqual(FIXTURE_NAMES);
      const plain = testDatabase(new PGlite());
      try {
        const before = await worker(runWorker, plain, args);
        expect(before.err).toEqual(run.err);
        expect(await pluginJournal(plain)).toEqual([]);
      } finally {
        await plain.close();
      }
    } finally {
      await db.close();
    }
    const refused = testDatabase(new PGlite());
    try {
      const scratch = await mkdtemp(join(tmpdir(), "openplans-scope-"));
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(join(scratch, "migrations"));
      await writeFile(
        join(scratch, "migrations", "001_core_writer.sql"),
        "ALTER TABLE snapshot ADD COLUMN plg_note text;",
      );
      const source = {
        plugin: "@synthetic/core-writer",
        tablePrefix: "synmig",
        directory: join(scratch, "migrations"),
      };
      await expect(loadPluginMigrations([source])).rejects.toThrow();
      let opened = 0;
      const err: string[] = [];
      const code = await runWorker(
        ["ingest", "rating-rules"],
        () => {
          opened++;
          return { ...refused, close: async () => {} };
        },
        { out: () => {}, error: (line) => err.push(line) },
        core.directory,
        [],
        { migrations: [source] },
      );
      expect(code).toBe(1);
      expect(opened).toBe(0);
      expect(JSON.parse(err[0]!)).toMatchObject({
        plugin: "@synthetic/core-writer",
        code: "plugin_migration_scope",
      });
      await rm(scratch, { recursive: true, force: true });
    } finally {
      await refused.close();
    }
  });

  it("mutant: a worker that leaves bootstrap out skips the plugin's migrations", async () => {
    offlineBootstrap();
    const mutant = await plantMutant(
      new URL("../../src/worker/commands.ts", import.meta.url),
      'argv[0] === "bootstrap" || argv[0] === "ingest"',
      'argv[0] === "ingest"',
    );
    const db = testDatabase(new PGlite());
    try {
      const broken = (await import(
        pathToFileURL(mutant.path).href
      )) as typeof CommandsModule;
      const run = await worker(broken.runWorker, db, BOOTSTRAP, [
        fixtureSource,
      ]);
      expect(migrateStep(run)?.status).toBe("completed");
      expect(await pluginJournal(db)).toEqual([]);
    } finally {
      await db.close();
      await mutant.cleanup();
    }
  });
});
