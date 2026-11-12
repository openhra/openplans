import { runRecordPolicy } from "./record-policy.js";
import { databaseErrorDiagnostic } from "./database-error.js";
import { runSbe } from "../ingest/sbe/command.js";
import { runState } from "../ingest/state/command.js";
import { runBootstrap } from "./bootstrap.js";
import { runQhpProviders } from "../ingest/qhp/provider-command.js";
import { runGeocode } from "../ingest/geocode/command.js";
import { runQhpFormulary } from "../ingest/qhp/formulary-command.js";
import { runNppes } from "../ingest/nppes/command.js";
import { runQhpDiscover } from "../ingest/qhp/discover-command.js";
import { runRxnorm } from "../ingest/rxnorm/command.js";
import { runMedicare } from "../ingest/medicare/command.js";
import { runPufImport, runPufLineage } from "../ingest/puf/import-command.js";
import { runGeo } from "../ingest/geo/command.js";
import { coverageManifest } from "../db/availability.js";
import type { Database } from "../db/database.js";
import {
  checkMigrations,
  loadPluginMigrations,
  migrate,
  migrationsDirectory,
  PluginMigrationRefusal,
  withPluginMigrations,
} from "../db/migrate.js";
import type { PluginMigration, PluginMigrationSource } from "../db/migrate.js";
import { backfillRowProvenance } from "../db/row-provenance.js";
import { runPufAcquire } from "../ingest/puf/acquire.js";
import { runRatingRules } from "../ingest/rating-rules/command.js";

import type { ScheduleSpec } from "@openplans/plugin-sdk";
import type { EventSubscription, Registered } from "../plugins/registries.js";
import {
  busSubscriptions,
  coreArgvConflict,
  matchWorkerCommand,
  runPluginCommand,
  withIngestEvents,
} from "../plugins/worker.js";
import type {
  CoreEvents,
  IngestSource,
  PluginWorkerCommand,
} from "../plugins/worker.js";
import { ingestSources } from "./ingest-sources.js";
import {
  DELIVERY_QUERY_TIMEOUT_MS,
  runDeliverEvents,
  runEmit,
} from "./deliver-events.js";
import { CORE_SCHEDULES, runScheduleCommand } from "./schedule.js";
import type { ScheduledCommand } from "./schedule.js";
import { runTaxonomyIngest } from "../plugins/core-plugin.js";
import { runBackupArgs } from "./backup-args.js";

const usage =
  "Usage: worker migrate [--check] | status | record-policy list|set|expire | backup-args [--tar] | backfill row-provenance [--table NAME] [--blocks N] | ingest puf|qhp|nppes|rxnorm|taxonomy|geo|medicare";

export interface WorkerOutput {
  out(message: string): void;
  error(message: string): void;
}

type OpenDatabase = (connectionString?: string) => Database;
interface CoreIo {
  /** Opens with the command's queryTimeoutMs; without one, the opener as passed in. */
  open: OpenDatabase;
  openDatabase: OpenDatabase;
  output: WorkerOutput;
  directory: string;
  host: WorkerHost;
}

/** What the plugins registered besides commands, and the scheduler's bounds for one run. */
export interface WorkerHost {
  subscriptions?: readonly Registered<EventSubscription>[];
  schedules?: readonly Registered<ScheduleSpec>[];
  /** The worker's stop signal, and `maxRunMs` when the scheduler runs a command in this process. */
  run?: { signal: AbortSignal; timeoutMs?: number };
  /** Runs another argv in this process; set by `runWorker`. */
  dispatch?: (
    argv: string[],
    run: { signal: AbortSignal; timeoutMs: number },
  ) => Promise<number>;
  /** The worker's own emits; without it, no core event is written. */
  events?: CoreEvents;
  /** Design 5.13: enabled plugins' migrations, run by `migrate` after the core ones. */
  migrations?: readonly PluginMigrationSource[];
}
/** A core command: the same argv, usage and timeout fields as a plugin's WorkerCommandSpec. */
export interface CoreWorkerCommand {
  readonly argv: readonly string[];
  readonly usage: string;
  readonly queryTimeoutMs?: number;
  /** The source id that `ingest.*` events report for this command. */
  readonly source?: IngestSource;
  readonly run: (args: string[], io: CoreIo) => Promise<number>;
}

const notImplemented =
  (kind: string) =>
  async (args: string[], { output }: CoreIo): Promise<number> => {
    output.error(args.length === 0 ? `ingest ${kind}: not implemented` : usage);
    return 1;
  };

/** The core plugin's worker commands. Each keeps its usage text and query timeout. */
export const coreWorkerCommands: readonly CoreWorkerCommand[] = Object.freeze(
  (
    [
      {
        argv: ["migrate"],
        usage: "Usage: worker migrate [--check]",
        // Index builds on a populated database take minutes (740 on TX: 6m28s).
        queryTimeoutMs: 3_600_000,
        run: (args, io) => runMaintenance("migrate", args, io),
      },
      {
        argv: ["status"],
        usage: "Usage: worker status",
        run: (args, io) => runMaintenance("status", args, io),
      },
      {
        argv: ["record-policy"],
        usage:
          "Usage: worker record-policy list | set NAME --ttl INTERVAL [--stale INTERVAL] | expire NAME [--before TIMESTAMP]",
        queryTimeoutMs: 3_600_000,
        run: (args, { open, output, host }) =>
          runRecordPolicy(args, () => open(), output, host.events),
      },
      {
        argv: ["backfill", "row-provenance"],
        usage:
          "Usage: worker backfill row-provenance [--table NAME] [--blocks N]",
        queryTimeoutMs: 3_600_000,
        run: (args, { open, output }) =>
          runRowProvenanceBackfill(args, () => open(), output),
      },
      {
        argv: ["bootstrap"],
        usage:
          "Usage: worker bootstrap --states TX,FL --years 2026,2027 [--with-drugs] [--with-providers] [--with-nucc-taxonomy] [--with-geocode] [--qhp-cache-only] [--qhp-profile PATH] [--dry-run]",
        run: (args, { open, output, directory, host }) =>
          runBootstrap(args, open, output, directory, host.events),
      },
      {
        argv: ["ingest", "sbe"],
        source: ingestSources.sbe,
        usage:
          "Usage: worker ingest sbe acquire|import --year 2026|2027 (--state XX | --all-states)",
        queryTimeoutMs: 300_000,
        run: (args, { open, output, directory }) =>
          runSbe(args, () => open(), output, directory),
      },
      {
        argv: ["ingest", "state"],
        source: ingestSources.state,
        usage:
          "Usage: worker ingest state --state NY|VT --file /absolute/path/to/prepared-2026.json",
        run: (args, { open, output, directory }) =>
          runState(args, open, output, directory),
      },
      {
        argv: ["ingest", "qhp"],
        usage,
        run: notImplemented("qhp"),
      },
      {
        argv: ["ingest", "qhp", "providers"],
        source: ingestSources.qhpProviders,
        usage:
          "Usage: worker ingest qhp providers --year YYYY --state ST (--issuer NNNNN | --all-readable)",
        run: (args, { open, output, directory }) =>
          runQhpProviders(args, open, output, directory),
      },
      {
        argv: ["ingest", "qhp", "formulary"],
        source: ingestSources.qhpFormulary,
        usage:
          "Usage: worker ingest qhp formulary --year YYYY --state ST (--issuer NNNNN | --all-readable)",
        run: (args, { open, output, directory }) =>
          runQhpFormulary(args, open, output, directory),
      },
      {
        argv: ["ingest", "qhp", "discover"],
        source: ingestSources.qhpDiscover,
        usage: "Usage: worker ingest qhp discover --year YYYY --state ST",
        run: (args, { open, output, directory }) =>
          runQhpDiscover(args, open, output, directory),
      },
      {
        argv: ["ingest", "geocode"],
        source: ingestSources.geocode,
        usage:
          "Usage: worker ingest geocode [--state TX] [--county 48201] [--zips 77002,77030] [--source npi_address|qhp_provider_address]",
        run: (args, { open, output, directory }) =>
          runGeocode(args, open, output, directory),
      },
      {
        argv: ["ingest", "nppes"],
        source: ingestSources.nppes,
        usage:
          "Usage: worker ingest nppes --state TX [--kind full|weekly|deactivation|all]",
        run: (args, { open, output, directory }) =>
          runNppes(args, open, output, directory),
      },
      {
        argv: ["ingest", "rxnorm"],
        source: ingestSources.rxnorm,
        usage: "Usage: worker ingest rxnorm",
        run: (args, { open, output, directory }) =>
          runRxnorm(args, open, output, directory),
      },
      {
        argv: ["ingest", "medicare"],
        source: ingestSources.medicare,
        usage:
          "Usage: worker ingest medicare acquire|import --year 2026|2027 [--family landscape|pbp|stars|crosswalk|service_area] [--service-area-month YYYY-MM]",
        // A PBP release inserts about 1.5 M rows in one transaction.
        queryTimeoutMs: 3_600_000,
        run: (args, { open, output, directory }) =>
          runMedicare(args, () => open(), output, directory),
      },
      {
        argv: ["ingest", "taxonomy"],
        source: ingestSources.taxonomy,
        usage:
          "Usage: worker ingest taxonomy --accept-nucc-terms (review NUCC licensing terms before importing)",
        run: (args, { open, output, directory }) =>
          runTaxonomyIngest(args, open, output, directory),
      },
      {
        argv: ["ingest", "rating-rules"],
        source: ingestSources.ratingRules,
        usage: "Usage: worker ingest rating-rules [--file path]",
        run: (args, { open, output, directory }) =>
          runRatingRules(args, open, output, directory),
      },
      {
        argv: ["ingest", "puf"],
        usage,
        run: notImplemented("puf"),
      },
      {
        argv: ["ingest", "puf", "import"],
        source: ingestSources.pufImport,
        usage:
          "Usage: worker ingest puf import --year 2025|2026|2027 (--state XX | --all-states)",
        // National reconciliation scans exceed the API's five-second read timeout.
        queryTimeoutMs: 300_000,
        run: (args, { open, output, directory }) =>
          runPufImport(args, () => open(), output, directory),
      },
      {
        argv: ["ingest", "puf", "lineage"],
        source: ingestSources.puf,
        usage: "Usage: worker ingest puf lineage --year 2026|2027",
        queryTimeoutMs: 300_000,
        run: (args, { open, output, directory }) =>
          runPufLineage(args, () => open(), output, directory),
      },
      {
        argv: ["ingest", "puf", "acquire"],
        source: ingestSources.puf,
        usage:
          "Usage: worker ingest puf acquire [--year 2025|2026|2027] [--dry-run]",
        run: (args, { output }) => runPufAcquire(args, output),
      },
      {
        argv: ["ingest", "geo"],
        source: ingestSources.geo,
        usage:
          "Usage: worker ingest geo [--year 2026|2027] [--state XX | --all-states]",
        run: (args, { open, output, directory }) =>
          runGeo(args, open, output, directory),
      },
      {
        argv: ["deliver-events"],
        usage: "Usage: worker deliver-events",
        queryTimeoutMs: DELIVERY_QUERY_TIMEOUT_MS,
        run: (args, { open, output, host }) =>
          runDeliverEvents(
            args,
            () => open(),
            output,
            (host.subscriptions ?? [])
              .filter(({ spec }) => spec.durable)
              .map(({ plugin, spec }) => ({
                plugin,
                type: spec.type,
                subscriber: spec.subscriber,
                handler: spec.handler,
              })),
            host.run?.signal,
          ),
      },
      {
        argv: ["schedule"],
        usage: "Usage: worker schedule run [--loop]",
        queryTimeoutMs: DELIVERY_QUERY_TIMEOUT_MS,
        run: (args, { open, output, host }) =>
          runScheduleCommand(
            args,
            () => open(),
            output,
            [
              ...CORE_SCHEDULES.map((spec): ScheduledCommand => ({
                plugin: "openplans",
                spec,
              })),
              ...(host.schedules ?? []),
            ],
            host.dispatch ?? (async () => 1),
            { signal: host.run?.signal },
          ),
      },
      {
        // Prints dump exclusions for this installation; it opens no database.
        argv: ["backup-args"],
        usage: "Usage: worker backup-args [--tar]",
        run: async (args, { output }) => runBackupArgs(args, output),
      },
      {
        argv: ["emit"],
        usage: "Usage: worker emit TYPE --payload JSON [--idempotency-key KEY]",
        run: (args, { open, output, host }) =>
          runEmit(
            args,
            () => open(),
            output,
            busSubscriptions(host.subscriptions),
          ),
      },
    ] satisfies CoreWorkerCommand[]
  ).map((command) => Object.freeze(command)),
);

/**
 * Design 5.8: match the longest registered argv prefix, open the database with that command's
 * query timeout, and print the usage line on no match. Plugin commands come from
 * `loadWorkerPlugins`; with none, only the core commands are registered.
 */
export async function runWorker(
  args: string[],
  openDatabase: OpenDatabase,
  output: WorkerOutput,
  directory = migrationsDirectory,
  pluginCommands: readonly PluginWorkerCommand[] = [],
  host: WorkerHost = {},
): Promise<number> {
  for (const command of pluginCommands)
    if (coreArgvConflict(command.spec.argv, coreWorkerCommands)) {
      output.error(
        JSON.stringify({
          plugin: command.plugin,
          code: "plugin_registration_collision",
        }),
      );
      return 1;
    }
  const opener =
    (milliseconds: number | undefined): OpenDatabase =>
    (connectionString) =>
      milliseconds === undefined
        ? openDatabase(connectionString)
        : openWithQueryTimeout(openDatabase, milliseconds);
  const matched = matchWorkerCommand<
    CoreWorkerCommand | PluginWorkerCommand["spec"]
  >([...coreWorkerCommands, ...pluginCommands.map(({ spec }) => spec)], args);
  if (!matched) {
    output.error(usage);
    return 1;
  }
  const rest = args.slice(matched.argv.length);
  const plugin = pluginCommands.find(({ spec }) => spec === matched);
  if (plugin)
    return withIngestEvents(
      {
        argv: plugin.spec.argv,
        source: plugin.spec.source ?? plugin.spec.argv.slice(1).join("-"),
      },
      rest,
      output,
      host.events,
      (io) =>
        runPluginCommand(
          plugin,
          rest,
          () => io.opened(opener(plugin.spec.queryTimeoutMs)()),
          io.output,
          {
            signal: host.run?.signal,
            timeoutMs: host.run?.timeoutMs,
            subscriptions: host.subscriptions,
          },
        ),
    );
  const core = matched as CoreWorkerCommand;
  const dispatch: NonNullable<WorkerHost["dispatch"]> = (argv, run) =>
    argv[0] === "schedule"
      ? Promise.resolve(1)
      : runWorker(argv, openDatabase, output, directory, pluginCommands, {
          ...host,
          run,
        });
  const coreOpen =
    core.queryTimeoutMs === undefined
      ? openDatabase
      : opener(core.queryTimeoutMs);
  const runCore = () =>
    withIngestEvents(core, rest, output, host.events, (io) =>
      core.run(rest, {
        // Spread keeps the opener's arity: callers that pass nothing still pass nothing.
        open: (...connection) => io.opened(coreOpen(...connection)),
        openDatabase: (...connection) => io.opened(openDatabase(...connection)),
        output: io.output,
        directory,
        host: { ...host, dispatch },
      }),
    );
  // Design 5.13: bootstrap and the ingest commands migrate before they write. With plugins
  // enabled, those migrate() calls run the plugins' migrations too, as `worker migrate` does.
  if (!migratingCommand(core.argv) || !host.migrations?.length)
    return runCore();
  const plugins = await pluginMigrationsOrRefuse(host.migrations, output);
  return plugins ? withPluginMigrations(plugins, runCore) : 1;
}

const migratingCommand = (argv: readonly string[]) =>
  argv[0] === "bootstrap" || argv[0] === "ingest";

/** Reads and scope-checks plugin migrations; prints the refusal line and returns undefined. */
async function pluginMigrationsOrRefuse(
  sources: readonly PluginMigrationSource[],
  output: WorkerOutput,
): Promise<PluginMigration[] | undefined> {
  try {
    return await loadPluginMigrations(sources);
  } catch (error) {
    if (!(error instanceof PluginMigrationRefusal)) throw error;
    output.error(
      JSON.stringify({
        plugin: error.plugin,
        code: error.code,
        reason: error.reason,
      }),
    );
    return undefined;
  }
}

async function runMaintenance(
  command: "migrate" | "status",
  args: string[],
  { open, openDatabase, output, directory, host }: CoreIo,
): Promise<number> {
  const check =
    command === "migrate" && args.length === 1 && args[0] === "--check";
  if (!check && args.length !== 0) {
    output.error(usage);
    return 1;
  }
  // Plugin migrations are read and scope-checked before the database is opened.
  let plugins: PluginMigration[] = [];
  if (command === "migrate" && host.migrations?.length) {
    const loaded = await pluginMigrationsOrRefuse(host.migrations, output);
    if (!loaded) return 1;
    plugins = loaded;
  }
  let db: Database | undefined;
  let exitCode = 0;
  try {
    db = command === "migrate" && !check ? open() : openDatabase();
    if (check) {
      output.out(JSON.stringify(await checkMigrations(db, directory, plugins)));
    } else if (command === "migrate") {
      const applied = await migrate(db, directory, plugins);
      output.out(JSON.stringify({ applied }));
    } else {
      output.out(JSON.stringify(await coverageManifest(db)));
    }
  } catch (error) {
    // Driver errors can contain credentials, URLs or source-record contents.
    output.error(
      `worker ${command} failed${databaseErrorDiagnostic(error)}; check database connectivity and migration files`,
    );
    exitCode = 1;
  } finally {
    try {
      await db?.close();
    } catch {
      output.error("worker database shutdown failed");
      exitCode = 1;
    }
  }
  return exitCode;
}

async function runRowProvenanceBackfill(
  args: string[],
  open: () => Database,
  output: WorkerOutput,
): Promise<number> {
  let table: string | undefined, blocks: number | undefined;
  for (let i = 0; i < args.length; i += 2) {
    const value = args[i + 1] ?? "";
    if (
      args[i] === "--table" &&
      table === undefined &&
      /^[a-z_][a-z0-9_]*$/.test(value)
    )
      table = value;
    else if (
      args[i] === "--blocks" &&
      blocks === undefined &&
      /^[1-9][0-9]{0,6}$/.test(value)
    )
      blocks = Number(value);
    else {
      output.error(
        "Usage: worker backfill row-provenance [--table NAME] [--blocks N]",
      );
      return 1;
    }
  }
  let db: Database | undefined,
    code = 0;
  try {
    db = open();
    await backfillRowProvenance(db, { table, blocks }, (result) =>
      output.out(JSON.stringify(result)),
    );
  } catch (error) {
    output.error(
      `worker backfill row-provenance failed${databaseErrorDiagnostic(error)}; run worker migrate first and check the database`,
    );
    code = 1;
  } finally {
    try {
      await db?.close();
    } catch {
      output.error("worker database shutdown failed");
      code = 1;
    }
  }
  return code;
}

// pg accepts query_timeout in the connection URI and it overrides the pool's five-second default;
// an operator's explicit setting wins.
function openWithQueryTimeout(
  openDatabase: (connectionString?: string) => Database,
  milliseconds: number,
): Database {
  const connection = process.env.DATABASE_URL;
  if (!connection) return openDatabase();
  const url = new URL(connection);
  if (!url.searchParams.has("query_timeout"))
    url.searchParams.set("query_timeout", String(milliseconds));
  return openDatabase(url.href);
}
