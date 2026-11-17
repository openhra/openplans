import {
  applicationStateCatalogImpact,
  applicationStateDeclarationAllowed,
  applicationStateDeclarationSchema,
} from "@openplans/plugin-sdk";
import type { ApplicationStateDeclaration } from "@openplans/plugin-sdk";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { MIGRATION_LOCK, refuseDuringBackfill } from "./maintenance-locks.js";
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
  const index = await readFile(join(directory, "INDEX"), "utf8");
  const names = index === "" ? [] : index.replace(/\r?\n$/, "").split(/\r?\n/);
  const indexed = new Set<string>();
  for (const name of names) {
    if (!/^\d+_[-a-z0-9_]+\.sql$/.test(name))
      throw new Error(`Invalid migration INDEX entry: ${name}`);
    if (indexed.has(name))
      throw new Error(`Duplicate migration INDEX entry: ${name}`);
    indexed.add(name);
    if (!files.includes(name))
      throw new Error(`Migration INDEX entry missing file: ${name}`);
  }
  for (const name of files) {
    if (!indexed.has(name))
      throw new Error(`Migration file missing from INDEX: ${name}`);
  }
  return loadMigrationFiles(directory, names);
}

const coreTimestampDigits = 14;

async function loadMigrationFiles(
  directory: string,
  files: string[],
  uniqueVersions = false,
) {
  const versions = new Set<number>();
  return Promise.all(
    files.map(async (name) => {
      const match = /^(\d+)_[-a-z0-9_]+\.sql$/.exec(name);
      const version = Number(match?.[1]);
      if (
        !match ||
        !Number.isSafeInteger(version) ||
        ((uniqueVersions || match[1]!.length !== coreTimestampDigits) &&
          versions.has(version))
      ) {
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
  readonly applicationState?: readonly ApplicationStateDeclaration[];
}
export interface PluginMigration extends Migration {
  readonly plugin: string;
  readonly tablePrefix: string;
  readonly applicationState?: readonly ApplicationStateDeclaration[];
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

function validateApplicationState(source: {
  plugin: string;
  tablePrefix?: string;
  applicationState?: readonly ApplicationStateDeclaration[];
}) {
  const declared = new Set<string>();
  for (const entry of source.applicationState ?? []) {
    if (
      !applicationStateDeclarationSchema.safeParse(entry).success ||
      !applicationStateDeclarationAllowed(
        source.plugin,
        source.tablePrefix,
        entry,
      ) ||
      declared.has(entry.table)
    )
      throw new PluginMigrationRefusal(
        source.plugin,
        "plugin_migration_scope",
        "applicationState",
      );
    declared.add(entry.table);
  }
}

function validatePluginDeclarations(plugins: readonly PluginMigration[]) {
  const owners = new Map<string, string>();
  for (const migration of plugins) {
    validateApplicationState(migration);
    if (
      !/^[a-z][a-z0-9]{1,15}$/.test(migration.tablePrefix) ||
      (owners.has(migration.tablePrefix) &&
        owners.get(migration.tablePrefix) !== migration.plugin)
    )
      throw new PluginMigrationRefusal(
        migration.plugin,
        "plugin_migration_scope",
        "migrations",
      );
    owners.set(migration.tablePrefix, migration.plugin);
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
    validateApplicationState(source);
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
      migrations = await loadMigrationFiles(source.directory, files, true);
      migrations.sort((a, b) => a.version - b.version);
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
        applicationState: source.applicationState,
      });
    }
  }
  validatePluginDeclarations(loaded);
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
  validatePluginDeclarations(plugins);
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
 * Keep generation rows and statement triggers on every plugin table. Only reviewed,
 * declared operational tables receive a false trigger condition, preserving the warmed
 * generation token while keeping provenance and policy triggers active.
 */
async function installPluginGeneration(
  tx: SqlSession,
  plugins: readonly PluginMigration[],
  classificationOnly = false,
) {
  const prefixes = [
    ...new Set(plugins.map(({ tablePrefix }) => pluginTableName(tablePrefix))),
  ];
  if (prefixes.length === 0) return;
  const { rows } = await tx.query<{
    table_name: string;
    trigger_present: boolean;
    operational: boolean;
    catalog: boolean;
  }>(
    `SELECT c.relname AS table_name, t.oid IS NOT NULL AS trigger_present,
      coalesce(t.tgqual IS NOT NULL AND pg_get_expr(t.tgqual,t.tgrelid) = 'false'
        AND t.tgtype=60 AND t.tgenabled IN ('O','A')
        AND t.tgfoid=to_regproc('bump_api_data_generation'), false) AS operational,
      coalesce(t.tgqual IS NULL AND t.tgtype=60 AND t.tgenabled IN ('O','A')
        AND t.tgfoid=to_regproc('bump_api_data_generation'), false) AS catalog
      FROM pg_class c LEFT JOIN pg_trigger t
        ON t.tgrelid=c.oid AND t.tgname='api_data_changed' AND NOT t.tgisinternal
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p')
        AND EXISTS (SELECT 1 FROM unnest($1::text[]) p(prefix)
          WHERE left(c.relname, length(p.prefix)) = p.prefix)
        AND to_regproc('bump_api_data_generation') IS NOT NULL
      ORDER BY c.relname`,
    [prefixes],
  );
  for (const row of rows) {
    const owner = plugins.find((migration) =>
      row.table_name.startsWith(pluginTableName(migration.tablePrefix)),
    )!;
    const declared = plugins.some(
      (migration) =>
        migration.plugin === owner.plugin &&
        migration.applicationState?.some(
          (entry) => entry.table === row.table_name,
        ),
    );
    // Replay reconciles classification, leaving ordinary catalog corruption for the integrity checks.
    if (classificationOnly && !declared && !row.operational) continue;
    const operational =
      declared &&
      applicationStateCatalogImpact(
        owner.plugin,
        owner.tablePrefix,
        row.table_name,
      ) === "operational";
    // Do not rewrite a correct trigger or touch its generation row on replay.
    if (operational ? row.operational : row.catalog) continue;
    const quoted = '"' + row.table_name.replaceAll('"', '""') + '"';
    await tx.query(
      "INSERT INTO api_data_generation(table_name) VALUES ($1) ON CONFLICT DO NOTHING",
      [row.table_name],
    );
    if (row.trigger_present)
      await tx.exec(`DROP TRIGGER api_data_changed ON public.${quoted}`);
    await tx.exec(`CREATE TRIGGER api_data_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.${quoted}
      FOR EACH STATEMENT ${operational ? "WHEN (false)" : ""} EXECUTE FUNCTION bump_api_data_generation()`);
    if (!operational && row.trigger_present)
      await tx.query(
        "UPDATE api_data_generation SET revision=revision+1,writer_xid=NULL WHERE table_name=$1",
        [row.table_name],
      );
  }
}

const journalSql = `CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
)`;

async function installApplicationState(
  tx: SqlSession,
  plugins: readonly PluginMigration[],
  allowMissing = false,
) {
  const installed = new Set<string>();
  for (const migration of plugins) {
    for (const entry of migration.applicationState ?? []) {
      if (installed.has(entry.table)) continue;
      installed.add(entry.table);
      const slug = `app:plugin-${migration.tablePrefix}:${entry.table}`;
      const { rows } = await tx.query<{ present: boolean }>(
        "SELECT to_regclass($1) IS NOT NULL AS present",
        [entry.table],
      );
      if (!rows[0]?.present) {
        if (allowMissing) continue;
        throw new Error("Plugin application table missing");
      }
      const prior = await tx.query<{
        fixed_by: string;
        fixed_slug: string;
        policy_name: string;
        reference_columns: string[];
      }>(
        "SELECT fixed_by,fixed_slug,policy_name,reference_columns FROM row_provenance_rule WHERE table_name=$1",
        [entry.table],
      );
      if (
        prior.rows.some(
          (r) =>
            r.reference_columns.length !== 0 ||
            r.fixed_by !== "openplans" ||
            r.fixed_slug !== slug ||
            r.policy_name !== "app_state",
        )
      )
        throw new Error("Plugin application provenance conflict");
      if (prior.rows.length) continue;
      await tx.query(
        `INSERT INTO row_provenance_rule(table_name,reference_columns,fixed_by,fixed_slug,reason,policy_name)
        VALUES ($1,'{}','openplans',$2,$3,'app_state') ON CONFLICT (table_name) DO NOTHING`,
        [entry.table, slug, entry.reason],
      );
    }
  }
}

export async function migrate(
  db: Database,
  directory = migrationsDirectory,
  plugins: readonly PluginMigration[] = ambientPlugins.getStore() ?? [],
): Promise<string[]> {
  validatePluginDeclarations(plugins);
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
    await tx.query(`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK})`);
    await refuseDuringBackfill(tx);
    await tx.exec(journalSql);
    const { rows } = await tx.query<{ name: string; sha256: string }>(
      "SELECT name, sha256 FROM schema_migrations ORDER BY name",
    );
    // INDEX orders pending core files; already applied files are verified by name and hash.
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
    await installApplicationState(tx, plugins);
    if (pending.length > 0) await installMetadata(tx);
    await installPluginGeneration(tx, plugins, pending.length === 0);
    return pending.map((migration) => migration.name);
  });
}

const journal = (
  session: SqlSession,
  migration: { name: string; sha256: string },
) =>
  session.query(
    "INSERT INTO schema_migrations (name, sha256) VALUES ($1, $2)",
    [migration.name, migration.sha256],
  );

/**
 * One connection for the whole run. A pooled database provides it; PGlite runs a single backend
 * in this process, so any adapter over it is already pinned.
 */
async function pinnedSession(
  db: Database,
): Promise<Database["withSession"] | undefined> {
  if (db.withSession) return (run) => db.withSession!(run);
  const { rows } = await db.query<{ pglite: boolean }>(
    "SELECT version() LIKE '%(PGlite %' AS pglite",
  );
  return rows[0]?.pglite ? (run) => run(db) : undefined;
}

/** Concurrent indexes require autocommit. Keep the same advisory key on one pinned session. */
async function migrateWithConcurrentIndexes(
  db: Database,
  core: Migration[],
  plugins: readonly PluginMigration[],
): Promise<string[]> {
  const migrations = [...core, ...plugins];
  const pinned = await pinnedSession(db);
  if (!pinned)
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
  return pinned(async (session) => {
    let locked = false;
    try {
      await session.exec("SET lock_timeout = '2s'");
      await session.exec("SET max_parallel_maintenance_workers = 0");
      await session.query(`SELECT pg_advisory_lock(${MIGRATION_LOCK})`);
      locked = true;
      await refuseDuringBackfill(session);
      await session.exec(journalSql);
      const { rows } = await session.query<{ name: string; sha256: string }>(
        "SELECT name, sha256 FROM schema_migrations ORDER BY name",
      );
      const pending = pendingMigrations(core, rows, plugins);
      // Consecutive ordinary files share one transaction, as in the ordinary runner, and
      // commit before the next concurrent index. Each index then builds in autocommit.
      let start = 0;
      while (start < pending.length) {
        const first = migrationStatements(pending[start]!.sql);
        if (first.some(concurrentIndex)) {
          await session.exec(first[0]!.sql);
          await journal(session, pending[start]!);
          start += 1;
          continue;
        }
        let end = start;
        while (
          end < pending.length &&
          !migrationStatements(pending[end]!.sql).some(concurrentIndex)
        )
          end += 1;
        await session.exec("BEGIN");
        try {
          for (const migration of pending.slice(start, end)) {
            await session.exec(migration.sql);
            await journal(session, migration);
          }
          await installApplicationState(session, plugins, end < pending.length);
          await installMetadata(session);
          await installPluginGeneration(session, plugins);
          await session.exec("COMMIT");
        } catch (error) {
          await session.exec("ROLLBACK");
          throw error;
        }
        start = end;
      }
      await session.exec("BEGIN");
      try {
        await installApplicationState(session, plugins);
        await installPluginGeneration(session, plugins, true);
        await session.exec("COMMIT");
      } catch (error) {
        await session.exec("ROLLBACK");
        throw error;
      }
      return pending.map((m) => m.name);
    } finally {
      if (locked)
        await session.query(`SELECT pg_advisory_unlock(${MIGRATION_LOCK})`);
      await session.exec("RESET lock_timeout");
      await session.exec("RESET max_parallel_maintenance_workers");
    }
  });
}
