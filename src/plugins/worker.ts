import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  AdmittedFetch,
  EventInput,
  EventRegistry,
  PluginContext,
  ScheduleSpec,
  WorkerCommandSpec,
  WorkerContext,
} from "@openplans/plugin-sdk";
import { coreConfigView, loadConfig } from "../config/index.js";
import type { Environment } from "../config/index.js";
import type { Database, SqlSession } from "../db/database.js";
import type { PluginMigrationSource } from "../db/migrate.js";
import type { WorkerOutput } from "../worker/commands.js";
import { databaseErrorDiagnostic } from "../worker/database-error.js";
import { createEventBus } from "./events.js";
import type { EventLog, Subscription } from "./events.js";
import { argvOverlaps } from "./registries.js";
import type { PluginFetchSettings } from "./fetch.js";
import type { EventSubscription, Registered } from "./registries.js";
import { pluginState } from "./state.js";

/** Core and plugin commands both carry an argv prefix and share one matcher. */
export interface ArgvPrefixed {
  readonly argv: readonly string[];
}

/** Design 5.8: the longest registered argv prefix wins. */
export function matchWorkerCommand<T extends ArgvPrefixed>(
  commands: readonly T[],
  args: readonly string[],
): T | undefined {
  const ordered = [...commands];
  ordered.sort((a, b) => b.argv.length - a.argv.length);
  return ordered.find((command) =>
    command.argv.every((word, index) => args[index] === word),
  );
}

/** One plugin's worker command, its writer grant and the config view it receives. */
export interface PluginWorkerCommand {
  readonly plugin: string;
  readonly spec: WorkerCommandSpec;
  /** True only when the plugin declared `capabilities.writes` with "staging". */
  readonly writer: boolean;
  /** True only when the plugin declared `capabilities.writes` with "events". */
  readonly emits?: boolean;
  readonly config: PluginContext["config"];
  /**
   * The run's `ctx.fetch`, bound to its `ctx.signal`. Without it the command's fetch rejects.
   */
  readonly fetch?: (signal: AbortSignal) => AdmittedFetch;
}
export interface WorkerPlugins {
  readonly commands: readonly PluginWorkerCommand[];
  /** Event subscriptions from setup, in configuration order, durable or not. */
  readonly subscriptions: readonly Registered<EventSubscription>[];
  readonly schedules: readonly Registered<ScheduleSpec>[];
  /** Name and version of every plugin that loaded, for `plugin.loaded`. */
  readonly plugins: readonly { name: string; version: string }[];
  readonly teardown: () => Promise<void>;
  /** Design 5.13: the enabled plugins' migration directories, in configuration order. */
  readonly migrations: readonly PluginMigrationSource[];
  /**
   * Design 5.10.4: applies the operator's `stored` pass-through settings (TTL changes, a level
   * tightened below `stored`) through `worker record-policy`. Opens the database only when such
   * a setting exists. Returns the exit code: 0, or 1 after one error line.
   */
  readonly applyPassThroughPolicies?: (
    open: () => Database,
    output: WorkerOutput,
  ) => Promise<number>;
}
export interface LoadWorkerPluginsOptions {
  env?: Environment;
  baseDirectory?: string;
  writeLog?: (line: string) => void;
  exit?: (code: number) => never;
  /** Tests only: the transport and DNS lookup every plugin fetch uses. */
  fetchTesting?: PluginFetchSettings["testing"];
}

const NO_PLUGINS: WorkerPlugins = Object.freeze({
  commands: Object.freeze([]),
  subscriptions: Object.freeze([]),
  schedules: Object.freeze([]),
  plugins: Object.freeze([]),
  teardown: async () => {},
  migrations: Object.freeze([]),
});

/**
 * Loads the configured plugins for the worker host. With no enabled plugin, the loader is never
 * imported. A configuration that does not parse loads no plugins: the worker then reports the
 * error where it does today, when a command opens the database.
 */
export async function loadWorkerPlugins(
  options: LoadWorkerPluginsOptions = {},
): Promise<WorkerPlugins> {
  const env = options.env ?? process.env;
  let config;
  try {
    config = loadConfig(env);
  } catch {
    return NO_PLUGINS;
  }
  const enabled = config.plugins.filter((entry) => entry.enabled);
  if (enabled.length === 0) return NO_PLUGINS;
  const base =
    options.baseDirectory ??
    (env.OPENPLANS_CONFIG ? dirname(env.OPENPLANS_CONFIG) : process.cwd());
  const { defaultManifestPaths, loadPlugins } = await import("./loader.js");
  const { pluginCommandFetch, pluginFetch } = await import("./fetch.js");
  // One fetch factory per plugin for its worker commands; each run binds its own signal.
  const commandFetch = new Map<
    string,
    (signal: AbortSignal) => AdmittedFetch
  >();
  const loaded = await loadPlugins(config, "worker", {
    env,
    baseDirectory: base,
    // Durable event handlers post through the setup fetch; commands get a GET as well.
    fetchFor: (manifest, loadedConfig) => {
      const settings: PluginFetchSettings = {
        manifestPaths: defaultManifestPaths(loadedConfig),
        dataDir: loadedConfig.access.dataDir,
        projectUrl: loadedConfig.access.projectUrl,
        egressCountry: loadedConfig.access.egressCountry,
        ...(options.fetchTesting && { testing: options.fetchTesting }),
      };
      commandFetch.set(manifest.name, (signal) =>
        pluginCommandFetch(manifest, settings, signal),
      );
      return pluginFetch(manifest, settings);
    },
    writeLog: options.writeLog,
    exit: options.exit,
  });
  const passthrough = await import("./sources/passthrough.js");
  passthrough.configureHostPassThrough(loaded.passThrough);
  const sources = passthrough.passThroughSourcesOf(loaded.registries.sources);
  const policies = passthrough.operatorSourcePolicies(config);
  const writes = await declaredWrites(
    enabled.map((entry) => entry.package),
    base,
  );
  // Deeply frozen at runtime; the SDK view types its arrays as mutable.
  const view = coreConfigView(config) as unknown as PluginContext["config"];
  // Feed sources run as `worker ingest <source>` commands (design 5.10.1).
  const feeds = loaded.registries.sources.some(
    ({ spec }) => spec.kind === "feed",
  )
    ? (await import("./sources/index.js")).feedWorkerCommands(
        loaded.registries.sources,
        new Set(
          [...writes].filter(([, set]) => set.has("staging")).map(([n]) => n),
        ),
        view,
      )
    : [];
  return Object.freeze({
    commands: Object.freeze([
      ...loaded.registries.workerCommands.map(({ plugin, spec }) =>
        Object.freeze({
          plugin,
          spec,
          writer: writes.get(plugin)?.has("staging") ?? false,
          emits: writes.get(plugin)?.has("events") ?? false,
          config: view,
          ...(commandFetch.has(plugin) && { fetch: commandFetch.get(plugin) }),
        }),
      ),
      ...feeds,
    ]),
    subscriptions: loaded.registries.events,
    schedules: loaded.registries.schedules,
    plugins: Object.freeze(
      loaded.plugins.map(({ name, version }) =>
        Object.freeze({ name, version }),
      ),
    ),
    teardown: loaded.teardown,
    migrations: loaded.migrations,
    applyPassThroughPolicies: async (
      open: () => Database,
      output: WorkerOutput,
    ): Promise<number> => {
      if (
        !sources.some(
          (source) =>
            source.cache.level === "stored" &&
            source.cache.recordPolicy &&
            policies[source.id],
        )
      )
        return 0;
      let db: Database | undefined;
      try {
        const opened = open();
        db = opened;
        await passthrough.applyPassThroughPolicies(
          opened,
          sources,
          policies,
          output,
        );
        return 0;
      } catch (error) {
        output.error(
          `worker pass-through policy failed${databaseErrorDiagnostic(error)}; check plugins[].sources and record policies`,
        );
        return 1;
      } finally {
        await db?.close().catch(() => {});
      }
    },
  });
}

// The loader has already imported and validated these modules, so this import hits the module
// cache and reads the same manifests.
async function declaredWrites(
  specifiers: readonly string[],
  base: string,
): Promise<Map<string, Set<string>>> {
  const declared = new Map<string, Set<string>>();
  for (const specifier of specifiers) {
    const target =
      isAbsolute(specifier) ||
      specifier.startsWith("./") ||
      specifier.startsWith("../")
        ? pathToFileURL(resolve(base, specifier)).href
        : specifier;
    const module = (await import(target)) as {
      default?: {
        manifest?: { name?: unknown; capabilities?: { writes?: unknown } };
      };
    };
    const manifest = module.default?.manifest;
    const writes = manifest?.capabilities?.writes;
    if (typeof manifest?.name === "string" && Array.isArray(writes))
      declared.set(
        manifest.name,
        new Set(writes.filter((w): w is string => typeof w === "string")),
      );
  }
  return declared;
}

/** Core argv prefixes are reserved. A plugin may not repeat, extend or shorten one. */
export function coreArgvConflict(
  plugin: readonly string[],
  core: readonly ArgvPrefixed[],
): boolean {
  return core.some(({ argv }) => argvOverlaps(argv, plugin));
}

// The same key pattern the plugin loader uses for setup log lines.
const SECRET_KEY =
  /authorization|credential|password|secret|token|api[-_]?key|cookie/i;
const unavailableFetch: AdmittedFetch = () =>
  Promise.reject(new Error("Not available to this worker command"));

/** Options for one run: the scheduler passes its signal and `maxRunMs`. */
export interface PluginRunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Setup subscriptions; non-durable ones hear the command's emits in this process. */
  subscriptions?: readonly Registered<EventSubscription>[];
  log?: EventLog;
}

/** Core and plugin runs share this: the smaller of the two limits, and both signals. */
export function runLimit(
  limits: readonly (number | undefined)[],
  outer: AbortSignal | undefined,
): { controller: AbortController; signal: AbortSignal; timeoutMs?: number } {
  const controller = new AbortController();
  const bounded = limits.filter(
    (value): value is number => value !== undefined,
  );
  return {
    controller,
    signal: outer
      ? AbortSignal.any([controller.signal, outer])
      : controller.signal,
    timeoutMs: bounded.length > 0 ? Math.min(...bounded) : undefined,
  };
}

export function busSubscriptions(
  entries: readonly Registered<EventSubscription>[] = [],
): Subscription[] {
  return entries.map(({ spec }) => ({
    type: spec.type,
    subscriber: spec.subscriber,
    durable: spec.durable,
    handler: spec.handler,
  }));
}

/**
 * Runs one plugin command. The database opens on first use, so a command that rejects its
 * arguments never connects. Reads go through read-only transactions.
 */
export async function runPluginCommand(
  command: PluginWorkerCommand,
  args: string[],
  open: () => Database,
  output: WorkerOutput,
  options: PluginRunOptions = {},
): Promise<number> {
  let database: Database | undefined;
  const connect = () => (database ??= open());
  const readOnly = <T>(run: (session: SqlSession) => Promise<T>) =>
    connect().transaction(async (session) => {
      await session.exec("SET TRANSACTION READ ONLY");
      return run(session);
    });
  const reader: SqlSession = Object.freeze({
    query: <Row extends Record<string, unknown>>(
      sql: string,
      parameters?: unknown[],
    ) => readOnly((session) => session.query<Row>(sql, parameters)),
    exec: (sql: string) => readOnly((session) => session.exec(sql)),
  });
  // The worker owns the connection and closes it after the command returns.
  const writer: Database = Object.freeze({
    query: <Row extends Record<string, unknown>>(
      sql: string,
      parameters?: unknown[],
    ) => connect().query<Row>(sql, parameters),
    exec: (sql: string) => connect().exec(sql),
    transaction: <T>(run: (session: SqlSession) => Promise<T>) =>
      connect().transaction(run),
    close: async () => {},
  });
  // Emits write the outbox through the command's own connection; the bus checks the capability.
  const bus = createEventBus({
    db: writer,
    subscriptions: busSubscriptions(options.subscriptions),
    log:
      options.log ??
      ((entry) =>
        output.error(JSON.stringify({ ...entry, plugin: command.plugin }))),
  });
  const registry = bus.registry({
    kind: "plugin",
    manifest: {
      name: command.plugin,
      capabilities: { writes: command.emits ? ["events"] : [] },
    },
  });
  const events: EventRegistry = Object.freeze({
    on() {
      throw new Error("Register event handlers during setup");
    },
    emit: registry.emit,
  });
  const limit = runLimit(
    [command.spec.timeoutMs, options.timeoutMs],
    options.signal,
  );
  // `db.writer` exists only for plugins that declared staging writes.
  const context: WorkerContext = Object.freeze({
    db: Object.freeze(command.writer ? { reader, writer } : { reader }),
    config: command.config,
    log: (entry: Record<string, string | number | boolean | null>) => {
      if (Object.keys(entry).some((key) => SECRET_KEY.test(key)))
        throw new Error("Plugin log keys may not name credentials");
      output.error(JSON.stringify({ ...entry, plugin: command.plugin }));
    },
    // Admitted GETs and posts on the plugin's declared hosts; the run's signal stops them.
    fetch: command.fetch?.(limit.signal) ?? unavailableFetch,
    events,
    state: pluginState(() => connect(), command.plugin),
    signal: limit.signal,
  });
  let code: number;
  let timer: NodeJS.Timeout | undefined;
  const name = command.spec.argv.join(" ");
  try {
    const timedOut = new Promise<"timeout">((resolve) => {
      if (limit.timeoutMs === undefined) return;
      timer = setTimeout(() => {
        limit.controller.abort(new Error("worker command time limit"));
        resolve("timeout");
      }, limit.timeoutMs);
      timer.unref?.();
    });
    const result = await Promise.race([
      Promise.resolve().then(() => command.spec.run(args, context)),
      timedOut,
    ]);
    if (result === "timeout") {
      output.error(`worker ${name} timed out after ${limit.timeoutMs} ms`);
      code = 1;
    } else
      code =
        Number.isInteger(result) && result >= 0 && result <= 255 ? result : 1;
  } catch (error) {
    output.error(`worker ${name} failed${databaseErrorDiagnostic(error)}`);
    code = 1;
  } finally {
    clearTimeout(timer);
    try {
      await database?.close();
    } catch {
      output.error("worker database shutdown failed");
      code = 1;
    }
  }
  return code;
}

/**
 * The worker's own emits (design 5.9): the ingest lifecycle, record policy changes, bootstrap
 * readiness failures and `plugin.loaded`. They use a connection of their own, so a command's
 * connection, queries and output stay as they were. Nothing here can fail the command it
 * reports on: a refused emit, an unreachable database or a failed outbox insert is logged
 * with the event type and error class only, never the payload.
 */
export interface CoreEvents {
  emit(input: EventInput): Promise<void>;
  /** Reads through the events connection; undefined when the read fails. */
  read<Row extends Record<string, unknown>>(
    sql: string,
    parameters?: unknown[],
  ): Promise<Row[] | undefined>;
  close(): Promise<void>;
}
export interface CoreEventsOptions {
  /** Opens the events connection on the first emit. */
  open: () => Database;
  log?: EventLog;
  /** Setup subscriptions; non-durable ones hear core emits in this process. */
  subscriptions?: readonly Registered<EventSubscription>[];
  /** The host these emits come from: `emitted_by` is `api` or `worker` (the default). */
  host?: "api" | "worker";
}

function errorClassName(error: unknown): string {
  const name = error instanceof Error ? error.constructor.name : "";
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : "Error";
}

export function createCoreEvents(options: CoreEventsOptions): CoreEvents {
  const log =
    options.log ?? ((entry) => void console.error(JSON.stringify(entry)));
  let database: Database | undefined;
  let registry: EventRegistry | undefined;
  const connect = () => (database ??= options.open());
  return {
    async emit(input) {
      try {
        registry ??= createEventBus({
          db: connect(),
          log,
          subscriptions: busSubscriptions(options.subscriptions),
        }).registry({ kind: "core", name: options.host ?? "worker" });
        await registry.emit(input);
      } catch (error) {
        log({
          event: "core_emit_failed",
          event_type: input.type,
          error_class: errorClassName(error),
        });
      }
    },
    async read(sql, parameters) {
      try {
        return (await connect().query(sql, parameters)).rows as never;
      } catch {
        return undefined;
      }
    },
    async close() {
      try {
        await database?.close();
      } catch {
        // The events connection never decides an exit code.
      }
    },
  };
}

/**
 * One emit per set of loaded plugins: the key repeats while the set stays the same, so the API
 * and the worker share one row for the same set, whichever host starts first.
 */
export async function emitPluginLoaded(
  events: CoreEvents | undefined,
  plugins: readonly { name: string; version: string }[],
): Promise<void> {
  if (!events || plugins.length === 0) return;
  const list = plugins.map(({ name, version }) => ({ name, version }));
  const digest = createHash("sha256")
    .update(
      JSON.stringify(
        [...list].sort((a, b) =>
          a.name === b.name
            ? a.version.localeCompare(b.version)
            : a.name.localeCompare(b.name),
        ),
      ),
    )
    .digest("hex");
  await events.emit({
    type: "plugin.loaded",
    idempotencyKey: `plugin.loaded:${digest}`,
    payload: { plugins: list },
  });
}

const reasonPattern = /^[A-Za-z][A-Za-z0-9_]{0,95}$/;
const wordPattern = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * A reason code for one stderr line of a failed ingest command, with its rank: a higher rank
 * wins. Only fixed codes and identifiers the command already prints come back, never the text.
 */
export function ingestReason(
  line: string,
): { rank: number; code: string } | undefined {
  if (/ timed out after \d+ ms$/.test(line))
    return { rank: 6, code: "timeout" };
  const sqlState = /; PostgreSQL ([0-9A-Z]{5}):/.exec(line);
  if (sqlState) return { rank: 5, code: `postgres_${sqlState[1]}` };
  if (line.startsWith("{")) {
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      for (const key of ["reason", "code"]) {
        const code = value[key];
        if (typeof code === "string" && reasonPattern.test(code))
          return { rank: 4, code };
      }
    } catch {
      // Not a JSON line.
    }
    return undefined;
  }
  if (line === "worker database shutdown failed")
    return { rank: 3, code: "database_shutdown_failed" };
  if (/^Usage: |^Invalid .*command/.test(line))
    return { rank: 2, code: "usage" };
  if (/previous (?:import|snapshot|active)[a-z ]* preserved/.test(line))
    return { rank: 1, code: "import_failed_previous_preserved" };
  if (/\bfailed\b/.test(line)) return { rank: 0, code: "command_failed" };
  return undefined;
}

/** The registered argv and any bare subcommand words after it; flag values never appear. */
export function ingestCommandWords(
  argv: readonly string[],
  args: readonly string[],
): string[] {
  const words = [...argv];
  for (const arg of args) {
    if (!wordPattern.test(arg)) break;
    words.push(arg);
  }
  return words;
}

export function ingestScope(args: readonly string[]): {
  state?: string;
  year?: number;
} {
  const scope: { state?: string; year?: number } = {};
  const state = args[args.indexOf("--state") + 1];
  const year = args[args.indexOf("--year") + 1];
  if (args.includes("--state") && state && /^[A-Z]{2}$/.test(state))
    scope.state = state;
  if (args.includes("--year") && year && /^\d{4}$/.test(year))
    scope.year = Number(year);
  return scope;
}

/**
 * The `sourceId` an ingest command reports: a fixed id, or one worked out from the command's
 * arguments (docs/plugins/events.md lists the mapping).
 */
export type IngestSource = string | ((args: readonly string[]) => string);

/** Hooks the wrapped command reports through: its output and the databases it opens. */
export interface IngestRunIo {
  output: WorkerOutput;
  /** Call on every database the command opens; returns the database the command uses. */
  opened: (database: Database) => Database;
}

/** The session setting the snapshot trigger (migration 1002) reads to tag a run's snapshots. */
export const INGEST_RUN_SETTING = "openplans.ingest_run";
const SNAPSHOT_WRITE =
  /\b(?:INSERT\s+INTO|UPDATE|MERGE\s+INTO)\s+(?:public\.)?snapshot\b/i;
// Statements that cannot run inside a transaction block, or that manage their own.
const OWN_TRANSACTION =
  /\b(?:BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION|CONCURRENTLY|VACUUM)\b/i;

/**
 * Tags the snapshots one ingest run writes with its run id. Before a statement that inserts or
 * updates `snapshot`, the run id goes into INGEST_RUN_SETTING for that transaction only, and the
 * trigger records the pair. A snapshot write outside a transaction runs in one of its own. Other
 * statements, results and errors pass through unchanged. A write the pattern misses only leaves
 * that snapshot out of the run's list; it never adds another run's.
 */
export function trackIngestRun(database: Database, runId: string): Database {
  const mark = (session: SqlSession) =>
    session.query("SELECT set_config($1, $2, true)", [
      INGEST_RUN_SETTING,
      runId,
    ]);
  const inTransaction = (session: SqlSession): SqlSession => {
    let marked = false;
    const before = async (sql: string) => {
      if (marked || !SNAPSHOT_WRITE.test(sql)) return;
      await mark(session);
      marked = true;
    };
    return {
      ...session,
      query: async (sql, parameters) => {
        await before(sql);
        return session.query(sql, parameters);
      },
      exec: async (sql) => {
        await before(sql);
        return session.exec(sql);
      },
    };
  };
  const own = (sql: string) =>
    SNAPSHOT_WRITE.test(sql) && !OWN_TRANSACTION.test(sql);
  const tracked: Database = {
    ...database,
    query: (sql, parameters) =>
      own(sql)
        ? database.transaction(async (session) => {
            await mark(session);
            return session.query(sql, parameters);
          })
        : database.query(sql, parameters),
    exec: (sql) =>
      own(sql)
        ? database.transaction(async (session) => {
            await mark(session);
            return session.exec(sql);
          })
        : database.exec(sql),
    transaction: (run) =>
      database.transaction((session) => run(inTransaction(session))),
    close: () => database.close(),
  };
  if (database.withRequest)
    tracked.withRequest = (signal, run, options) =>
      database.withRequest!(
        signal,
        (session) => run(inTransaction(session)),
        options,
      );
  return tracked;
}

/**
 * Design 5.9: `ingest.started`, `ingest.completed` and `ingest.failed` around one `ingest *`
 * command, from its spec, arguments and exit code. `ingest.started` goes out when the command
 * first opens its database, or after it ends if it never did; a command that only printed its
 * usage line emits nothing. The command's output passes through unchanged.
 */
export async function withIngestEvents(
  command: { argv: readonly string[]; source?: IngestSource },
  args: readonly string[],
  output: WorkerOutput,
  events: CoreEvents | undefined,
  run: (io: IngestRunIo) => Promise<number>,
  now: () => number = Date.now,
): Promise<number> {
  const sourceId =
    typeof command.source === "function"
      ? command.source(args)
      : command.source;
  if (!events || !sourceId || command.argv[0] !== "ingest")
    return run({ output, opened: (database) => database });
  const runId = randomUUID();
  const words = ingestCommandWords(command.argv, args);
  const startedMs = now();
  let reason: { rank: number; code: string } | undefined;
  let started: Promise<void> | undefined;
  const start = () =>
    (started ??= events.emit({
      type: "ingest.started",
      idempotencyKey: `ingest.started:${runId}`,
      payload: { sourceId, command: words, scope: ingestScope(args) },
    }));
  const io: IngestRunIo = {
    output: {
      out: (message) => output.out(message),
      error: (message) => {
        const found = ingestReason(message);
        if (found && (!reason || found.rank > reason.rank)) reason = found;
        output.error(message);
      },
    },
    opened: (database) => {
      void start();
      return trackIngestRun(database, runId);
    },
  };
  let code: number;
  try {
    code = await run(io);
  } catch (error) {
    await start();
    await events.emit({
      type: "ingest.failed",
      idempotencyKey: `ingest.failed:${runId}`,
      payload: { sourceId, command: words, reasonCode: "exception" },
    });
    throw error;
  }
  if (!started && code !== 0 && reason?.code === "usage") return code;
  await start();
  if (code === 0) {
    // Only this run's snapshots: the ones it inserted or moved between states, now active.
    const rows = await events.read<{ snapshot_id: string }>(
      `SELECT s.snapshot_id FROM ingest_run_snapshot r
        JOIN snapshot s ON s.snapshot_id = r.snapshot_id
        WHERE r.run_id = $1 AND s.validation_state = 'ACTIVE'
        ORDER BY s.activated_at, s.snapshot_id LIMIT 1000`,
      [runId],
    );
    await events.emit({
      type: "ingest.completed",
      idempotencyKey: `ingest.completed:${runId}`,
      payload: {
        sourceId,
        command: words,
        durationMs: Math.max(0, Math.round(now() - startedMs)),
        snapshotIds: (rows ?? []).map(({ snapshot_id }) => snapshot_id),
      },
    });
  } else
    await events.emit({
      type: "ingest.failed",
      idempotencyKey: `ingest.failed:${runId}`,
      payload: {
        sourceId,
        command: words,
        reasonCode: reason?.code ?? `exit_${code}`,
      },
    });
  return code;
}
