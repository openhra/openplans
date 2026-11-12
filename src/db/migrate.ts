import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  classifyMigrationBatchWithRules,
  concurrentIndex,
  migrationStatements,
} from "./migrate-safety.js";
import {
  collectSizeEvidence,
  tableSizesFromEvidence,
  type MigrationSizeEvidence,
} from "./migration-size-evidence.js";
import type { Database, SqlSession } from "./database.js";
import {
  pluginMigrationScope,
  pluginTableName,
} from "./plugin-migration-scope.js";

export const migrationsDirectory = fileURLToPath(
  new URL("../../migrations/", import.meta.url),
);

export async function loadMigrations(directory = migrationsDirectory) {
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

  return migrations;
}

type Migration = Awaited<ReturnType<typeof loadMigrations>>[number];

/** Where one enabled plugin keeps its migrations (design 5.13), in configuration order. */
export interface PluginMigrationSource {
  /** The manifest name; journal rows are `plugin:<name>/<file>`. */
  readonly plugin: string;
  /** The manifest's `tablePrefix`; required once the directory holds a `.sql` file. */
  readonly tablePrefix?: string;
  /** `<package root>/migrations`; it need not exist. */
  readonly directory: string;
}
export interface PluginMigration extends Migration {
  readonly plugin: string;
  readonly tablePrefix: string;
}

// The worker sets this around bootstrap and ingest commands, so their own migrate() calls run
// the enabled plugins' migrations too. Outside it, migrate() runs the core migrations only.
const ambientPlugins = new AsyncLocalStorage<readonly PluginMigration[]>();

/** Runs `run` with `plugins` as the default plugin list of every migrate() call inside it. */
export function withPluginMigrations<T>(
  plugins: readonly PluginMigration[],
  run: () => Promise<T>,
): Promise<T> {
  return ambientPlugins.run(plugins, run);
}

export type PluginMigrationRefusalCode =
  "plugin_migration_scope" | "plugin_migration_invalid";

/** Carries the plugin name, a fixed code and a file name: no SQL text and no configured value. */
export class PluginMigrationRefusal extends Error {
  constructor(
    readonly plugin: string,
    readonly code: PluginMigrationRefusalCode,
    readonly reason: string,
  ) {
    super(code);
    this.name = "PluginMigrationRefusal";
  }
}

const PLUGIN_JOURNAL = "plugin:";
export const pluginMigrationName = (plugin: string, file: string) =>
  `${PLUGIN_JOURNAL}${plugin}/${file}`;
const journalPlugin = (name: string) =>
  name.startsWith(PLUGIN_JOURNAL)
    ? name.slice(PLUGIN_JOURNAL.length, name.lastIndexOf("/"))
    : undefined;

/**
 * Reads every enabled plugin's migrations and checks them before anything runs: file names
 * follow the core rule, and every statement stays inside the plugin's `plg_<prefix>_`
 * namespace. A plugin without migration files contributes nothing. Throws
 * `PluginMigrationRefusal` on the first problem.
 */
export async function loadPluginMigrations(
  sources: readonly PluginMigrationSource[],
): Promise<PluginMigration[]> {
  const loaded: PluginMigration[] = [];
  for (const source of sources) {
    let files: string[];
    try {
      files = (await readdir(source.directory)).filter((name) =>
        name.endsWith(".sql"),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new PluginMigrationRefusal(
        source.plugin,
        "plugin_migration_invalid",
        "migrations",
      );
    }
    if (files.length === 0) continue;
    if (!source.tablePrefix)
      throw new PluginMigrationRefusal(
        source.plugin,
        "plugin_migration_scope",
        "tablePrefix",
      );
    let migrations: Migration[];
    try {
      migrations = await loadMigrations(source.directory);
    } catch {
      throw new PluginMigrationRefusal(
        source.plugin,
        "plugin_migration_invalid",
        "migrations",
      );
    }
    for (const migration of migrations) {
      const reason = pluginMigrationScope(migration.sql, source.tablePrefix);
      if (reason)
        throw new PluginMigrationRefusal(
          source.plugin,
          "plugin_migration_scope",
          `${migration.name} ${reason}`,
        );
      loaded.push({
        ...migration,
        name: pluginMigrationName(source.plugin, migration.name),
        plugin: source.plugin,
        tablePrefix: source.tablePrefix,
      });
    }
  }
  return loaded;
}

/**
 * Applied rows must match a file. A plugin's rows are checked only while that plugin is enabled:
 * a disabled plugin keeps its tables and journal rows untouched.
 */
function pendingMigrations(
  migrations: Migration[],
  rows: { name: string; sha256: string }[],
  plugins: readonly PluginMigration[] = [],
) {
  const enabled = new Set(plugins.map((migration) => migration.plugin));
  migrations = [...migrations, ...plugins];
  for (const row of rows) {
    const plugin = journalPlugin(row.name);
    if (plugin !== undefined && !enabled.has(plugin)) continue;
    if (
      !migrations.some(
        (migration) =>
          migration.name === row.name && migration.sha256 === row.sha256,
      )
    )
      throw new Error(`Applied migration missing or changed: ${row.name}`);
  }
  const applied = new Set(rows.map((row) => row.name));
  return migrations.filter((migration) => !applied.has(migration.name));
}

/** No journal creation, advisory locks, DDL, or installer calls in preflight. */
export async function checkMigrations(
  db: Database,
  directory = migrationsDirectory,
  plugins: readonly PluginMigration[] = [],
) {
  const migrations = await loadMigrations(directory);
  return db.transaction(async (tx) => {
    await tx.exec("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    await tx.exec("SET LOCAL lock_timeout = '2s'");
    const evidence = await collectSizeEvidence(tx);
    return checkMigrationsWithEvidence(evidence, migrations, plugins);
  });
}

/** Prints the read-only size evidence that `migrate --check` classifies with. */
export async function migrationSizeEvidence(db: Database) {
  return db.transaction(async (tx) => {
    await tx.exec("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    await tx.exec("SET LOCAL lock_timeout = '2s'");
    return collectSizeEvidence(tx);
  });
}

/**
 * Classifies the files pending against the journal in `evidence`. `migrate --check` calls it
 * with evidence it has just collected; it also replays saved evidence without a database.
 */
export function checkMigrationsWithEvidence(
  evidence: MigrationSizeEvidence,
  migrations: Migration[],
  plugins: readonly PluginMigration[] = [],
) {
  const rows = (evidence.journal ?? []).map(([name, sha256]) => ({
    name,
    sha256,
  }));
  const pending = pendingMigrations(migrations, rows, plugins);
  const safety = classifyMigrationBatchWithRules(
    pending.map((migration) => migration.sql),
    tableSizesFromEvidence(evidence),
  );
  return {
    format: 1,
    pending: pending.map(({ name, sha256 }, i) => ({
      name,
      sha256,
      ...safety[i]!,
    })),
    sizeEvidence: evidence,
  };
}

async function installMetadata(tx: SqlSession) {
  for (const name of [
    "install_row_provenance_all",
    "install_record_policy_all",
  ]) {
    const { rows } = await tx.query<{ present: boolean }>(
      `SELECT to_regproc('${name}') IS NOT NULL AS present`,
    );
    if (rows[0]?.present) await tx.query(`SELECT ${name}()`);
  }
}

/**
 * Plugin migrations may not create triggers, so the core gives every enabled plugin's
 * `plg_<prefix>_` tables the `api_data_changed` trigger and a generation row. Cached responses
 * built from a plugin table then expire when it changes, as they do for core tables.
 */
async function installPluginGeneration(
  tx: SqlSession,
  plugins: readonly PluginMigration[],
) {
  const prefixes = [
    ...new Set(plugins.map(({ tablePrefix }) => pluginTableName(tablePrefix))),
  ];
  if (prefixes.length === 0) return;
  const { rows } = await tx.query<{ table_name: string }>(
    `SELECT c.relname AS table_name FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p')
        AND EXISTS (SELECT 1 FROM unnest($1::text[]) p(prefix)
          WHERE left(c.relname, length(p.prefix)) = p.prefix)
        AND to_regproc('bump_api_data_generation') IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM pg_trigger t
          WHERE t.tgrelid = c.oid AND t.tgname = 'api_data_changed' AND NOT t.tgisinternal)
      ORDER BY c.relname`,
    [prefixes],
  );
  for (const { table_name } of rows) {
    const quoted = '"' + table_name.replaceAll('"', '""') + '"';
    await tx.query(
      "INSERT INTO api_data_generation(table_name) VALUES ($1) ON CONFLICT DO NOTHING",
      [table_name],
    );
    await tx.exec(`CREATE TRIGGER api_data_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.${quoted}
      FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation()`);
  }
}

const journalSql = `CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
)`;

export async function migrate(
  db: Database,
  directory = migrationsDirectory,
  plugins: readonly PluginMigration[] = ambientPlugins.getStore() ?? [],
): Promise<string[]> {
  const migrations = await loadMigrations(directory);
  if (
    [...migrations, ...plugins].some(
      (m) =>
        /\bCONCURRENTLY\b/i.test(m.sql) &&
        migrationStatements(m.sql).some(concurrentIndex),
    )
  )
    return migrateWithConcurrentIndexes(db, migrations, plugins);
  return db.transaction(async (tx) => {
    await tx.exec("SET LOCAL lock_timeout = '2s'");
    // Index builds on populated tables must fit Docker's default 64 MiB /dev/shm.
    await tx.exec("SET LOCAL max_parallel_maintenance_workers = 0");
    await tx.query("SELECT pg_advisory_xact_lock(1869636974)");
    await tx.exec(journalSql);
    const { rows } = await tx.query<{ name: string; sha256: string }>(
      "SELECT name, sha256 FROM schema_migrations ORDER BY name",
    );
    // Disjoint lane ranges can merge below the newest applied migration. Core runs first.
    const pending = pendingMigrations(migrations, rows, plugins);
    for (const migration of pending) {
      await tx.exec(migration.sql);
      await tx.query(
        "INSERT INTO schema_migrations (name, sha256) VALUES ($1, $2)",
        [migration.name, migration.sha256],
      );
    }
    // A lane's table can land below 990 after 990 has run on this database. Give every
    // table the row provenance columns and trigger, whatever order the migrations ran in.
    if (pending.length > 0) {
      await installMetadata(tx);
      await installPluginGeneration(tx, plugins);
    }
    return pending.map((migration) => migration.name);
  });
}

/** Concurrent indexes require autocommit. Keep the same advisory key on one pinned session. */
async function migrateWithConcurrentIndexes(
  db: Database,
  core: Migration[],
  plugins: readonly PluginMigration[],
): Promise<string[]> {
  const migrations = [...core, ...plugins];
  if (!db.withSession)
    throw new Error("Concurrent indexes require a pinned PostgreSQL session");
  // Reject mixed files before executing anything. Retrying a failed index needs operator review.
  for (const migration of migrations) {
    const statements = migrationStatements(migration.sql);
    if (statements.some(concurrentIndex)) {
      if (statements.length !== 1)
        throw new Error(
          `Concurrent indexes must be in a standalone migration: ${migration.name}`,
        );
      // IF NOT EXISTS can silently accept an invalid index left by a failed build.
      if (statements[0]!.tokens.join(" ").includes(" IF NOT EXISTS "))
        throw new Error(
          `Concurrent index retries require inspection: ${migration.name}`,
        );
    }
  }
  return db.withSession(async (session) => {
    let locked = false;
    try {
      await session.exec("SET lock_timeout = '2s'");
      await session.exec("SET max_parallel_maintenance_workers = 0");
      await session.query("SELECT pg_advisory_lock(1869636974)");
      locked = true;
      await session.exec(journalSql);
      const { rows } = await session.query<{ name: string; sha256: string }>(
        "SELECT name, sha256 FROM schema_migrations ORDER BY name",
      );
      const pending = pendingMigrations(core, rows, plugins);
      for (const migration of pending) {
        const statements = migrationStatements(migration.sql);
        const concurrent = statements.some(concurrentIndex);
        if (!concurrent) await session.exec("BEGIN");
        try {
          if (concurrent) {
            await session.exec(statements[0]!.sql);
          } else {
            await session.exec(migration.sql);
            await installMetadata(session);
            await installPluginGeneration(session, plugins);
          }
          await session.query(
            "INSERT INTO schema_migrations (name, sha256) VALUES ($1, $2)",
            [migration.name, migration.sha256],
          );
          if (!concurrent) await session.exec("COMMIT");
        } catch (error) {
          if (!concurrent) await session.exec("ROLLBACK");
          throw error;
        }
      }
      return pending.map((m) => m.name);
    } finally {
      if (locked) await session.query("SELECT pg_advisory_unlock(1869636974)");
      await session.exec("RESET lock_timeout");
      await session.exec("RESET max_parallel_maintenance_workers");
    }
  });
}
