import { PGlite } from "@electric-sql/pglite";
import { Hono } from "hono";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pluginManifestSchema } from "@openplans/plugin-sdk";
import type {
  AdmittedFetch,
  BlobStoreFactory,
  CacheStoreFactory,
  CoreConfigView,
  Database,
  DbProviderFactory,
  EventInput,
  OpenPlansPlugin,
  PluginContext,
  RouteSpec,
  ScheduleSpec,
  WorkerCommandSpec,
} from "@openplans/plugin-sdk";
import {
  loadPluginMigrations,
  migrate,
  migrationsDirectory,
} from "../../db/migrate.js";
import type { PluginMigration } from "../../db/migrate.js";
import { pluginTableName } from "../../db/plugin-migration-scope.js";
import { checkCatalogTriggers } from "./checks.js";
import { checkRouteResponses } from "./response-columns.js";

export interface TestPluginOptions {
  options?: unknown;
  db?: Database;
  config?: CoreConfigView;
  secrets?: Readonly<Record<string, string>>;
  fetch?: AdmittedFetch;
  /**
   * The plugin's package root. The kit runs `<packageRoot>/migrations` after the core
   * migrations and checks the plugin's tables before setup. Required when the manifest
   * declares a `tablePrefix`.
   */
  packageRoot?: string | URL;
}

const testConfig: CoreConfigView = {
  db: { provider: "pglite" },
  listen: { port: 3000, host: "127.0.0.1" },
  cache: { enabled: false, provider: "memory", maxMb: 0 },
  blobs: { provider: "local" },
  access: { shipped: false },
  public: { quoting: true, household: true, compat: true },
  mcp: { enabled: false, allowedHosts: [], allowedOrigins: [] },
  trustProxy: [],
  cmsFallback: { enabled: false, quotes: false },
  plugins: [],
};

function fixtureDatabase(): Database {
  const pg = new PGlite();
  return {
    query: (sql, parameters) => pg.query(sql, parameters),
    exec: async (sql) => {
      await pg.exec(sql);
    },
    transaction: (run) =>
      pg.transaction((tx) =>
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

/**
 * Core migrations, then the plugin's own. PGlite has no PostGIS, so the kit's database skips
 * 002_postgis.sql; a database that already applied it keeps the full list.
 */
async function migrateForTest(
  db: Database,
  plugins: readonly PluginMigration[],
): Promise<void> {
  const { rows } = await db.query<{ present: boolean }>(
    `SELECT to_regclass('schema_migrations') IS NOT NULL
       AND EXISTS (SELECT 1 FROM pg_class WHERE relname = 'spatial_ref_sys') AS present`,
  );
  if (rows[0]?.present) {
    await migrate(db, migrationsDirectory, plugins);
    return;
  }
  // Keep the test adapter in src so the core build never imports tests/.
  const directory = await mkdtemp(
    join(tmpdir(), "openplans-plugin-migrations-"),
  );
  try {
    for (const file of await readdir(migrationsDirectory))
      if (file.endsWith(".sql") && file !== "002_postgis.sql")
        await cp(join(migrationsDirectory, file), join(directory, file));
    await migrate(db, directory, plugins);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Every `plg_<prefix>_` table needs the `api_data_changed` trigger and a generation row. */
async function pluginGenerationProblems(
  db: Database,
  tablePrefix: string,
): Promise<string[]> {
  const prefix = pluginTableName(tablePrefix);
  const owned = (name: string) => name.startsWith(prefix);
  const { rows } = await db.query<{ table_name: string }>(
    `SELECT c.relname AS table_name FROM pg_class c
      WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind IN ('r','p')
        AND left(c.relname, length($1)) = $1
        AND NOT EXISTS (SELECT 1 FROM api_data_generation g WHERE g.table_name = c.relname)
      ORDER BY c.relname`,
    [prefix],
  );
  return [
    ...(await checkCatalogTriggers(db, {})).filter((problem) => owned(problem)),
    ...rows.map(
      ({ table_name }) => `${table_name}: no api_data_generation row`,
    ),
  ];
}

async function pluginMigrations(
  name: string,
  tablePrefix: string | undefined,
  packageRoot: string | URL | undefined,
): Promise<PluginMigration[]> {
  if (packageRoot === undefined) {
    if (tablePrefix)
      throw new Error(
        "loadForTest: pass packageRoot for a plugin that declares tablePrefix",
      );
    return [];
  }
  const root =
    typeof packageRoot === "string" ? packageRoot : fileURLToPath(packageRoot);
  return loadPluginMigrations([
    {
      plugin: name,
      ...(tablePrefix && { tablePrefix }),
      directory: join(root, "migrations"),
    },
  ]);
}

/** Isolated setup fixture. Registrations are recorded without production policy or dispatch. */
export async function loadForTest(
  plugin: OpenPlansPlugin,
  settings: TestPluginOptions = {},
) {
  const manifest = pluginManifestSchema.parse(plugin.manifest);
  const options = manifest.options
    ? manifest.options.parse(settings.options)
    : settings.options;
  const migrations = await pluginMigrations(
    manifest.name,
    manifest.tablePrefix,
    settings.packageRoot,
  );
  const db = settings.db ?? fixtureDatabase();
  try {
    if (!settings.db || migrations.length) await migrateForTest(db, migrations);
    if (manifest.tablePrefix) {
      const problems = await pluginGenerationProblems(db, manifest.tablePrefix);
      if (problems.length)
        throw new Error(
          `loadForTest: plugin tables fail the generation check: ${problems.join("; ")}`,
        );
    }
  } catch (error) {
    if (!settings.db) await db.close();
    throw error;
  }
  const app = checkRouteResponses(new Hono());
  const registrations = {
    routes: [] as RouteSpec[],
    mcpTools: [] as unknown[],
    sources: [] as unknown[],
    workerCommands: [] as WorkerCommandSpec[],
    schedules: [] as ScheduleSpec[],
    cacheStores: new Map<string, CacheStoreFactory>(),
    dbProviders: new Map<string, DbProviderFactory>(),
    blobStores: new Map<string, BlobStoreFactory>(),
    subscriptions: [] as {
      type: string;
      handler: unknown;
      options: { durable: boolean; subscriber: string };
    }[],
  };
  const events: EventInput[] = [];
  const logs: Record<string, string | number | boolean | null>[] = [];
  const context: PluginContext = {
    plugin: { name: manifest.name, version: manifest.version },
    options,
    config: structuredClone(settings.config ?? testConfig),
    secrets: {
      get: (name) =>
        manifest.capabilities?.secrets?.includes(name)
          ? settings.secrets?.[name]
          : undefined,
    },
    log: (entry) => {
      logs.push(entry);
    },
    db: {
      reader: db,
      ...(manifest.capabilities?.writes?.includes("staging")
        ? { writer: db }
        : {}),
    },
    routes: {
      add: (spec) => {
        registrations.routes.push(spec);
      },
    },
    mcpTools: {
      add: (spec) => {
        registrations.mcpTools.push(spec);
      },
    },
    sources: {
      add: (source: unknown) => {
        registrations.sources.push(source);
      },
      // Registration only: the kit never calls a source.
      passThrough: {
        apply: async (_kind, answers) => answers,
        availability: async () => null,
      },
    },
    cacheStores: {
      provide: (name, factory) => {
        registrations.cacheStores.set(name, factory);
      },
    },
    dbProviders: {
      provide: (name, factory) => {
        registrations.dbProviders.set(name, factory);
      },
    },
    blobStores: {
      provide: (name, factory) => {
        registrations.blobStores.set(name, factory);
      },
    },
    workerCommands: {
      add: (spec) => {
        registrations.workerCommands.push(spec);
      },
    },
    schedules: {
      add: (spec) => {
        registrations.schedules.push(spec);
      },
    },
    events: {
      on: (type, handler, options) => {
        registrations.subscriptions.push({ type, handler, options });
      },
      emit: async (event) => {
        events.push(event as EventInput);
      },
    },
    fetch:
      settings.fetch ??
      (async () => {
        throw new Error("Test fetch must be injected");
      }),
  };
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await plugin.teardown?.();
    } finally {
      if (!settings.db) await db.close();
    }
  };
  try {
    await plugin.setup(context);
    for (const spec of registrations.routes)
      app.on(spec.method, spec.path, spec.handler);
    return { app, db, context, registrations, events, logs, close };
  } catch (error) {
    await close();
    throw error;
  }
}
