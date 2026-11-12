import { dirname } from "node:path";
import { loadConfig } from "../config/index.js";
import type { CoreConfig, Environment } from "../config/index.js";
import type { Database } from "../db/database.js";
import type { CacheStore, EventInput } from "@openplans/plugin-sdk";
import type {
  EventSubscription,
  PluginRegistries,
  Registered,
} from "./registries.js";
import type { OperatorPassThrough } from "./sources/passthrough.js";
import type { StatusHostParts } from "./status-host.js";
import { createCoreEvents, emitPluginLoaded } from "./worker.js";
import type { CoreEvents, CoreEventsOptions } from "./worker.js";

/** What the API host serves from its plugins, and what it reports in `plugin.loaded`. */
export interface ApiPlugins {
  /** Undefined when no plugin loaded. The app then runs exactly as it does without plugins. */
  readonly registries?: Pick<
    PluginRegistries,
    "routes" | "cacheStores" | "sources"
  >;
  readonly plugins: readonly { name: string; version: string }[];
  /** Setup subscriptions; non-durable ones hear this host's own emits (`plugin.loaded`). */
  readonly subscriptions: readonly Registered<EventSubscription>[];
  /** Reverse load order, each plugin bounded; safe to call more than once. */
  readonly teardown: () => Promise<void>;
  /** The configured cache store, shared by the response cache and pass-through `memory`. */
  readonly cacheStore?: CacheStore;
}
export interface LoadApiPluginsOptions {
  /** The API host by default; the MCP stdio server loads as `stdio`. */
  host?: "api" | "stdio";
  /** The database this process serves from: the status host view reads its pool waits. */
  database?: StatusHostParts["database"];
  /** Wins over `database`: the server fills it in once its database provider is selected. */
  statusHost?: StatusHostParts;
  /**
   * Opens the connection for pass-through events (`passthrough.budget_exhausted`,
   * `passthrough.breaker_open`). The API host defaults to a connection of its own from
   * `db.connectionString`; stdio and a configuration without a database emit nothing.
   */
  openEvents?: () => Database;
  env?: Environment;
  baseDirectory?: string;
  writeLog?: (line: string) => void;
  exit?: (code: number) => never;
}

const NO_PLUGINS: ApiPlugins = Object.freeze({
  plugins: Object.freeze([]),
  subscriptions: Object.freeze([]),
  teardown: async () => {},
});

/**
 * Loads the configured plugins for the API host (design 5.3). With no enabled plugin, the loader
 * is never imported. A configuration that does not parse loads no plugins; the server then
 * reports its startup error as it does today.
 */
export async function loadApiPlugins(
  options: LoadApiPluginsOptions = {},
): Promise<ApiPlugins> {
  const env = options.env ?? process.env;
  let config;
  try {
    config = loadConfig(env);
  } catch {
    return NO_PLUGINS;
  }
  if (!config.plugins.some((entry) => entry.enabled)) return NO_PLUGINS;
  const { loadPlugins } = await import("./loader.js");
  const loaded = await loadPlugins(config, options.host ?? "api", {
    env,
    statusHost:
      options.statusHost ??
      (options.database ? { database: options.database } : {}),
    baseDirectory:
      options.baseDirectory ??
      (env.OPENPLANS_CONFIG ? dirname(env.OPENPLANS_CONFIG) : process.cwd()),
    writeLog: options.writeLog,
    exit: options.exit,
  });
  const connection = config.db.connectionString?.reveal();
  // The configured `db.provider`, selected through the registry like the server's own database.
  const { openHostDatabase } = await import("./host-storage.js");
  const openEvents =
    options.openEvents ??
    ((options.host ?? "api") === "api" && connection
      ? () => openHostDatabase(config)
      : undefined);
  const events = openEvents
    ? apiEvents(openEvents, undefined, loaded.registries.events)
    : undefined;
  const cacheStore = await configureApiPassThrough(config, loaded, events);
  return Object.freeze({
    registries:
      loaded.plugins.length > 0
        ? Object.freeze({
            routes: loaded.registries.routes,
            cacheStores: loaded.registries.cacheStores,
            sources: loaded.registries.sources,
          })
        : undefined,
    plugins: Object.freeze(
      loaded.plugins.map(({ name, version }) =>
        Object.freeze({ name, version }),
      ),
    ),
    subscriptions: loaded.registries.events,
    teardown: async () => {
      try {
        await loaded.teardown();
      } finally {
        await events?.close();
      }
    },
    cacheStore,
  });
}

/** Core emits from the API host; each opens its connection on the first emit. */
function apiEvents(
  open: () => Database,
  log: CoreEventsOptions["log"],
  subscriptions: ApiPlugins["subscriptions"] | undefined,
): CoreEvents {
  return createCoreEvents({ open, log, host: "api", subscriptions });
}

/** Design 5.10.4: the operator's pass-through settings and the shared cache, set at start. */
async function configureApiPassThrough(
  config: CoreConfig,
  loaded: {
    registries: PluginRegistries;
    passThrough: OperatorPassThrough;
  },
  events: CoreEvents | undefined,
): Promise<CacheStore | undefined> {
  const { providerTables, selectCacheStore } = await import("./providers.js");
  const { configureHostPassThrough } = await import("./sources/passthrough.js");
  const cacheStore = config.cache.enabled
    ? selectCacheStore(config, providerTables(loaded.registries))
    : undefined;
  configureHostPassThrough({
    ...loaded.passThrough,
    cacheStore,
    // The core's emits are whole events; CoreEvents never throws and needs no options.
    events: events && { emit: (event) => events.emit(event as EventInput) },
  });
  return cacheStore;
}

/**
 * The API host's `plugin.loaded`: the same key as the worker's, so one row per distinct plugin
 * set whichever host starts first. It uses its own connection, closed afterwards, and never
 * throws: a failed write is one log line with the event type and error class.
 */
export async function emitApiPluginLoaded(
  plugins: ApiPlugins["plugins"],
  open: () => Database,
  log?: CoreEventsOptions["log"],
  subscriptions?: ApiPlugins["subscriptions"],
): Promise<void> {
  if (plugins.length === 0) return;
  const events = apiEvents(open, log, subscriptions);
  try {
    await emitPluginLoaded(events, plugins);
  } finally {
    await events.close();
  }
}
