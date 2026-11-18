import { z } from "zod";
import { eventPayloadSchemas } from "@openplans/plugin-sdk";
import type {
  OperatorCommandSpec,
  CatalogPolicyProvider,
  BlobStoreFactory,
  CacheStoreFactory,
  DbProviderFactory,
  Event,
  EventType,
  FeedSource,
  McpToolSpec,
  PassThroughSource,
  PluginContext,
  PluginKind,
  PluginManifest,
  Question,
  RouteSpec,
  ScheduleSpec,
  WorkerCommandSpec,
} from "@openplans/plugin-sdk";
import { toolNames } from "../mcp/schemas.js";
import { passThrough } from "./sources/passthrough.js";

export type PluginHost = "api" | "worker" | "stdio";

/** Design 5.3: each host keeps only the kinds it serves. Every host still checks every registration. */
export const HOSTED_KINDS: Readonly<Record<PluginHost, readonly PluginKind[]>> =
  Object.freeze({
    api: Object.freeze([
      "routes",
      "mcpTools",
      "catalogPolicies",
      "operatorCommands",
      "cacheStores",
      "dbProviders",
      "blobStores",
      "sources",
      "events",
    ] as const),
    worker: Object.freeze([
      "catalogPolicies",
      "operatorCommands",
      "cacheStores",
      "dbProviders",
      "blobStores",
      "sources",
      "workerCommands",
      "schedules",
      "events",
    ] as const),
    stdio: Object.freeze([
      "mcpTools",
      "catalogPolicies",
      "cacheStores",
      "dbProviders",
      "sources",
    ] as const),
  });

export const REFUSAL_CODES = [
  "plugin_import_failed",
  "plugin_export_invalid",
  "plugin_api_version_mismatch",
  "plugin_name_duplicate",
  "plugin_table_prefix_duplicate",
  "plugin_secret_missing",
  "plugin_network_host_not_allowed",
  "plugin_options_invalid",
  "plugin_kind_undeclared",
  "plugin_registration_invalid",
  "plugin_route_collision",
  "plugin_mcp_tool_collision",
  "plugin_registration_collision",
  "mcp_tool_page_overflow",
  "plugin_provider_collision",
  "plugin_provider_unknown",
  "plugin_setup_failed",
  "passthrough_level_loosened",
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];

/** Carries only fixed codes and reasons, so the startup log line never holds a configured value. */
export class PluginRefusal extends Error {
  constructor(
    readonly plugin: string,
    readonly code: RefusalCode,
    readonly reason?: string,
  ) {
    super(code);
    this.name = "PluginRefusal";
  }
}

export interface Registered<T> {
  readonly plugin: string;
  readonly spec: T;
}
export interface EventSubscription {
  readonly type: EventType;
  readonly handler: (event: Event) => Promise<void>;
  readonly durable: boolean;
  readonly subscriber: string;
}
export type PluginSource = FeedSource | PassThroughSource<Question, unknown>;
/** A source with its plugin's declared network hosts; a feed run checks its hosts against them. */
export interface RegisteredSource extends Registered<PluginSource> {
  readonly network: readonly string[];
}

type ProviderTable<F> = Record<string, Registered<F>>;

/** Plain arrays and records keep insertion order, which is plugin configuration order. */
export interface StagingRegistries {
  operatorCommands: Registered<OperatorCommandSpec>[];
  catalogPolicies: ProviderTable<CatalogPolicyProvider>;
  routes: Registered<RouteSpec>[];
  mcpTools: Registered<McpToolSpec<unknown, unknown>>[];
  cacheStores: ProviderTable<CacheStoreFactory>;
  dbProviders: ProviderTable<DbProviderFactory>;
  blobStores: ProviderTable<BlobStoreFactory>;
  sources: RegisteredSource[];
  workerCommands: Registered<WorkerCommandSpec>[];
  schedules: Registered<ScheduleSpec>[];
  events: Registered<EventSubscription>[];
}
export type PluginRegistries = {
  readonly [K in keyof StagingRegistries]: Readonly<StagingRegistries[K]>;
};

/** Every name registered during one load, on any host, so collisions do not depend on the host. */
export type SeenNames = Record<
  | "operatorCommands"
  | "catalogPolicies"
  | "routes"
  | "mcpTools"
  | "cacheStores"
  | "dbProviders"
  | "blobStores"
  | "sources"
  | "workerCommands"
  | "schedules"
  | "events",
  Set<string>
>;
export function emptySeen(): SeenNames {
  return {
    operatorCommands: new Set(),
    catalogPolicies: new Set(),
    routes: new Set(),
    mcpTools: new Set([
      ...toolNames,
      "get_lowest_premiums",
      "get_market_summary",
      "get_benchmark",
    ]),
    cacheStores: new Set(CORE_PROVIDERS.cacheStores),
    dbProviders: new Set(CORE_PROVIDERS.dbProviders),
    blobStores: new Set(CORE_PROVIDERS.blobStores),
    sources: new Set(),
    workerCommands: new Set(),
    schedules: new Set(CORE_SCHEDULE_NAMES),
    events: new Set(),
  };
}

export function emptyRegistries(): StagingRegistries {
  return {
    operatorCommands: [],
    catalogPolicies: {},
    routes: [],
    mcpTools: [],
    cacheStores: {},
    dbProviders: {},
    blobStores: {},
    sources: [],
    workerCommands: [],
    schedules: [],
    events: [],
  };
}

// API projections retain route-array identity while omitting other registry fields.
const commandsByRoutes = new WeakMap<
  readonly Registered<RouteSpec>[],
  readonly Registered<OperatorCommandSpec>[]
>();
export function operatorCommandsForRoutes(
  routes: readonly Registered<RouteSpec>[],
): readonly Registered<OperatorCommandSpec>[] {
  return commandsByRoutes.get(routes) ?? [];
}

export function freezeRegistries(
  registries: StagingRegistries,
): PluginRegistries {
  if (registries.operatorCommands.length)
    commandsByRoutes.set(registries.routes, registries.operatorCommands);
  for (const table of Object.values(registries) as object[]) {
    for (const entry of Object.values(table)) Object.freeze(entry);
    Object.freeze(table);
  }
  return Object.freeze(registries);
}

let active: PluginRegistries = freezeRegistries(emptyRegistries());

/** The registries from the last load that succeeded. */
export function currentRegistries(): PluginRegistries {
  return active;
}

/** Called by the loader once every plugin has loaded; the registries are already frozen. */
export function activateRegistries(registries: PluginRegistries): void {
  active = registries;
}

// Core paths and provider names a plugin may not take (design 5.2). The core plugin registers them later.
const CORE_ROUTE_PATHS = ["/healthz", "/readyz", "/mcp"];
const CORE_ROUTE_PREFIXES = ["/v1", "/compat"];
export const ADMIN_PLUGIN = "@openplans/plugin-admin";
export const ADMIN_AUTH_PATHS = [
  "/admin/login",
  "/admin/logout",
  "/admin/reauth",
];
export function isAdminPath(path: string) {
  return path === "/admin" || path.startsWith("/admin/");
}
export function validAdminRoute(plugin: string, spec: RouteSpec) {
  return (
    spec.adminSession === undefined ||
    (spec.adminSession === true &&
      plugin === ADMIN_PLUGIN &&
      isAdminPath(spec.path) &&
      spec.exposure === "operator" &&
      spec.cache === undefined)
  );
}
/** `/status*` belongs to the status plugin; no other plugin may register under it. */
export const STATUS_PLUGIN = "@openplans/plugin-status";
export const STATUS_ROUTE_PREFIX = "/status";
const CORE_PROVIDERS = {
  cacheStores: ["memory", "valkey"],
  dbProviders: ["pg", "pglite"],
  blobStores: ["local"],
} as const;
/** Argv prefixes of the core worker commands (src/worker/commands.ts); a test keeps them in step. */
export const CORE_WORKER_ARGV: readonly (readonly string[])[] = Object.freeze(
  [
    ["prebuild", "lowest-premiums"],
    ["build", "lowest-premiums"],
    ["migrate"],
    ["status"],
    ["record-policy"],
    ["backfill", "row-provenance"],
    ["backfill", "rate-plan-count"],
    ["backfill", "provider-search"],
    ["bootstrap"],
    ["ingest", "sbe"],
    ["ingest", "state"],
    ["ingest", "qhp"],
    ["ingest", "qhp", "providers"],
    ["ingest", "qhp", "formulary"],
    ["ingest", "qhp", "discover"],
    ["ingest", "geocode"],
    ["ingest", "nppes"],
    ["ingest", "rxnorm"],
    ["ingest", "medicare"],
    ["ingest", "taxonomy"],
    ["ingest", "rating-rules"],
    ["ingest", "puf"],
    ["ingest", "puf", "import"],
    ["ingest", "puf", "lineage"],
    ["ingest", "puf", "acquire"],
    ["ingest", "geo"],
    ["deliver-events"],
    ["schedule"],
    ["backup-args"],
    ["backup-restored"],
    ["emit"],
  ].map((argv) => Object.freeze(argv)),
);
/** Names of the core schedules (src/worker/schedule.ts); a test keeps them in step. */
export const CORE_SCHEDULE_NAMES: readonly string[] = Object.freeze([
  "deliver-events",
]);

/** True when one argv repeats, extends or shortens the other. */
export function argvOverlaps(
  a: readonly string[],
  b: readonly string[],
): boolean {
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.every((word, index) => longer[index] === word);
}

const ROUTE_PATH = /^\/[A-Za-z0-9._~/-]*$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{2,63}$/;
const PROVIDER_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const COMMAND_WORD = /^[a-z][a-z0-9-]{0,31}$/;
const SCHEDULE_NAME = /^[a-z][a-z0-9-]{0,63}$/;
const CRON_FIELDS = 5;

function isCorePath(path: string, plugin: string): boolean {
  return (
    ADMIN_AUTH_PATHS.includes(path) ||
    (plugin !== ADMIN_PLUGIN && isAdminPath(path)) ||
    (plugin !== STATUS_PLUGIN && path.startsWith(STATUS_ROUTE_PREFIX)) ||
    CORE_ROUTE_PATHS.includes(path) ||
    CORE_ROUTE_PREFIXES.some(
      (prefix) => path === prefix || path.startsWith(`${prefix}/`),
    )
  );
}

type RegistryParts = Pick<
  PluginContext,
  | "operatorCommands"
  | "catalogPolicies"
  | "routes"
  | "mcpTools"
  | "cacheStores"
  | "dbProviders"
  | "blobStores"
  | "sources"
  | "workerCommands"
  | "schedules"
  | "events"
>;

export interface Registrar {
  readonly context: RegistryParts;
  /** Number of MCP tools the plugin registered, whether or not this host keeps them. */
  readonly toolCount: () => number;
  /** The first refusal raised during setup, even if the plugin caught the thrown error. */
  readonly refusal: () => PluginRefusal | undefined;
  readonly close: () => void;
}

/**
 * Registrations land in `staging` only. Every registration is checked on every host, so the API,
 * worker and stdio server refuse the same configuration.
 */
export function stagingRegistrar(
  staging: StagingRegistries,
  manifest: PluginManifest,
  host: PluginHost,
  seen: SeenNames,
): Registrar {
  const plugin = manifest.name;
  const hosted = new Set<PluginKind>(HOSTED_KINDS[host]);
  let first: PluginRefusal | undefined;
  let open = true;
  let tools = 0;
  const refuse = (code: RefusalCode): never => {
    first ??= new PluginRefusal(plugin, code);
    throw first;
  };
  const admit = (kind: PluginKind, valid: boolean) => {
    if (!open) throw new Error("Registries close when setup returns");
    if (!manifest.kinds.includes(kind)) refuse("plugin_kind_undeclared");
    if (!valid) refuse("plugin_registration_invalid");
    return hosted.has(kind);
  };
  const claim = (kind: keyof SeenNames, name: string, code: RefusalCode) => {
    if (seen[kind].has(name)) refuse(code);
    seen[kind].add(name);
  };
  const provider =
    <F>(kind: keyof typeof CORE_PROVIDERS) =>
    (name: string, factory: F) => {
      const keep = admit(
        kind,
        typeof name === "string" &&
          PROVIDER_NAME.test(name) &&
          typeof factory === "function",
      );
      claim(kind, name, "plugin_provider_collision");
      if (keep)
        (staging[kind] as ProviderTable<F>)[name] = { plugin, spec: factory };
    };

  const context: RegistryParts = {
    operatorCommands: {
      add(spec) {
        const strict = (schema: unknown) =>
          schema instanceof z.ZodObject &&
          schema._zod.def.catchall instanceof z.ZodNever;
        const keep = admit(
          "operatorCommands",
          /^[a-z][a-z0-9_.-]{2,95}$/.test(spec.name) &&
            (spec.permission === "edit" || spec.permission === "publish") &&
            (spec.publication === false ||
              (spec.publication === true &&
                spec.permission === "publish" &&
                plugin === "@openplans/plugin-msot" &&
                manifest.capabilities?.writes?.includes("events") === true)) &&
            strict(spec.inputSchema) &&
            strict(spec.outputSchema) &&
            Number.isSafeInteger(spec.timeoutMs) &&
            spec.timeoutMs > 0 &&
            spec.timeoutMs <= 15_000 &&
            Array.isArray(spec.sources) &&
            spec.sources.length > 0 &&
            spec.sources.length <= 100 &&
            spec.sources.every(
              (source: unknown) =>
                typeof source === "string" &&
                /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,99}$/.test(source),
            ) &&
            Array.isArray(spec.tables) &&
            spec.tables.length > 0 &&
            spec.tables.every(
              (table: unknown) =>
                typeof table === "string" &&
                Boolean(manifest.tablePrefix) &&
                table.startsWith(`plg_${manifest.tablePrefix}_`) &&
                manifest.applicationState?.some(
                  (entry) => entry.table === table,
                ) === true,
            ) &&
            typeof spec.run === "function" &&
            ["lookup", "current", "audit", "remember"].every(
              (method) =>
                typeof spec.store?.[method as keyof typeof spec.store] ===
                "function",
            ),
        );
        claim("operatorCommands", spec.name, "plugin_registration_collision");
        if (keep)
          staging.operatorCommands.push({
            plugin,
            spec: Object.freeze({
              ...spec,
              sources: Object.freeze([...spec.sources]),
              tables: Object.freeze([...spec.tables]),
              store: Object.freeze({
                lookup: spec.store.lookup.bind(spec.store),
                current: spec.store.current.bind(spec.store),
                audit: spec.store.audit.bind(spec.store),
                remember: spec.store.remember.bind(spec.store),
              }),
            }) as OperatorCommandSpec,
          });
      },
    },
    catalogPolicies: {
      provide(name, spec) {
        const keep = admit(
          "catalogPolicies",
          PROVIDER_NAME.test(name) && typeof spec?.resolve === "function",
        );
        claim("catalogPolicies", name, "plugin_provider_collision");
        if (keep) staging.catalogPolicies[name] = { plugin, spec };
      },
    },
    routes: {
      add(spec) {
        const keep = admit(
          "routes",
          (spec.method === "GET" || spec.method === "POST") &&
            typeof spec.path === "string" &&
            ROUTE_PATH.test(spec.path) &&
            (spec.exposure === "public" ||
              (spec.exposure === "operator" &&
                manifest.capabilities?.operatorRoutes === true)) &&
            (spec.contentType === "application/json" ||
              spec.contentType === "text/html") &&
            validAdminRoute(plugin, spec) &&
            typeof spec.handler === "function",
        );
        if (isCorePath(spec.path, plugin)) refuse("plugin_route_collision");
        claim(
          "routes",
          `${spec.method} ${spec.path}`,
          "plugin_route_collision",
        );
        if (keep) staging.routes.push({ plugin, spec });
      },
    },
    mcpTools: {
      add(spec) {
        const keep = admit(
          "mcpTools",
          typeof spec.name === "string" &&
            TOOL_NAME.test(spec.name) &&
            spec.readOnly === true &&
            typeof spec.handler === "function",
        );
        claim("mcpTools", spec.name, "plugin_mcp_tool_collision");
        tools += 1;
        if (keep)
          staging.mcpTools.push({
            plugin,
            spec: spec as McpToolSpec<unknown, unknown>,
          });
      },
    },
    cacheStores: { provide: provider<CacheStoreFactory>("cacheStores") },
    dbProviders: { provide: provider<DbProviderFactory>("dbProviders") },
    blobStores: { provide: provider<BlobStoreFactory>("blobStores") },
    sources: {
      add(source: PluginSource) {
        const keep = admit(
          "sources",
          (source?.kind === "feed" || source?.kind === "passthrough") &&
            typeof source.id === "string" &&
            source.id.length > 0,
        );
        claim("sources", source.id, "plugin_registration_collision");
        if (keep)
          staging.sources.push({
            plugin,
            spec: source,
            network: Object.freeze([...(manifest.capabilities?.network ?? [])]),
          });
      },
      passThrough,
    },
    workerCommands: {
      add(spec) {
        const keep = admit(
          "workerCommands",
          Array.isArray(spec.argv) &&
            spec.argv.length > 0 &&
            spec.argv.every(
              (word) => typeof word === "string" && COMMAND_WORD.test(word),
            ) &&
            typeof spec.usage === "string" &&
            (spec.timeoutMs === undefined ||
              (Number.isSafeInteger(spec.timeoutMs) && spec.timeoutMs > 0)) &&
            typeof spec.run === "function",
        );
        if (CORE_WORKER_ARGV.some((core) => argvOverlaps(core, spec.argv)))
          refuse("plugin_registration_collision");
        claim(
          "workerCommands",
          spec.argv.join(" "),
          "plugin_registration_collision",
        );
        if (keep) staging.workerCommands.push({ plugin, spec });
      },
    },
    schedules: {
      add(spec) {
        const keep = admit(
          "schedules",
          typeof spec.name === "string" &&
            SCHEDULE_NAME.test(spec.name) &&
            typeof spec.cron === "string" &&
            spec.cron.trim().split(/\s+/).length === CRON_FIELDS &&
            Array.isArray(spec.command) &&
            spec.command.length > 0 &&
            spec.command.every((word) => typeof word === "string") &&
            // A schedule may not start the scheduler.
            spec.command[0] !== "schedule" &&
            Number.isSafeInteger(spec.maxRunMs) &&
            spec.maxRunMs > 0,
        );
        claim("schedules", spec.name, "plugin_registration_collision");
        if (keep) staging.schedules.push({ plugin, spec });
      },
    },
    events: {
      on(type, handler, options) {
        const keep = admit(
          "events",
          Object.hasOwn(eventPayloadSchemas, type) &&
            typeof handler === "function" &&
            typeof options?.durable === "boolean" &&
            typeof options.subscriber === "string" &&
            options.subscriber.length > 0,
        );
        claim(
          "events",
          `${type} ${options.subscriber}`,
          "plugin_registration_collision",
        );
        if (keep)
          staging.events.push({
            plugin,
            spec: {
              type,
              handler: handler as EventSubscription["handler"],
              durable: options.durable,
              subscriber: options.subscriber,
            },
          });
      },
      async emit() {
        throw new Error("Events are not delivered while plugins load");
      },
    },
  };
  return {
    context,
    toolCount: () => tools,
    refusal: () => first,
    close: () => {
      open = false;
    },
  };
}
