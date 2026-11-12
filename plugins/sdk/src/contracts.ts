import type { Context } from "hono";
import type { z } from "zod";
import type { EventRegistry } from "./events.js";
import type { PluginManifest } from "./index.js";
import type { SourceRegistry } from "./sources.js";

export interface SqlSession {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: unknown[],
  ): Promise<{ rows: Row[] }>;
  exec(sql: string): Promise<void>;
  withRequest?<T>(
    signal: AbortSignal,
    run: (session: SqlSession) => Promise<T>,
    options?: { readOnly?: boolean },
  ): Promise<T>;
}
export interface Database extends SqlSession {
  transaction<T>(run: (session: SqlSession) => Promise<T>): Promise<T>;
  withSession?<T>(run: (session: SqlSession) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * The database a plugin receives. `reader` runs read-only; `writer` exists only for a plugin
 * that declared `capabilities.writes` with "staging", and only where the host grants it.
 */
export interface PluginDatabase {
  readonly reader: SqlSession;
  readonly writer?: Database;
}

/** Non-secret settings visible to plugins. */
export interface CoreConfigView {
  db: { provider: string };
  listen: { port: number; host: string };
  cache: {
    enabled: boolean;
    provider: string; // "memory", "valkey" or a plugin's store
    maxMb: number;
    url?: string;
  };
  blobs: { provider: string; root?: string };
  access: {
    dataDir?: string;
    operatorManifest?: string;
    shipped: boolean;
    projectUrl?: string;
    egressCountry?: string;
  };
  public: { quoting: boolean; household: boolean; compat: boolean };
  mcp: {
    enabled: boolean;
    allowedHosts: string[];
    allowedOrigins: string[];
    allowPersonalized?: "0" | "1";
  };
  trustProxy: string[];
  cmsFallback: { enabled: boolean; quotes: boolean };
  plugins: {
    package: string;
    enabled: boolean;
    options?: unknown;
    optionalSecrets: string[];
    sources: Record<
      string,
      {
        cacheLevel?: CacheLevel;
        ttl?: string;
        staleWindow?: string;
        negativeTtl?: string;
      }
    >;
  }[];
}

/** One loaded plugin as the host reports it. `sha256` is the package hash (`packageSha256`). */
export interface HostPluginEntry {
  name: string;
  version: string | null;
  apiVersion: string | null;
  sha256: string | null;
  enabled: boolean;
}

/**
 * One coverage scope as the host reports it: the statuses `/v1/data-availability` serves for
 * that state, year, market and issuer, after every derivation the core applies.
 */
export interface HostAvailabilityEntry {
  state: string;
  year: number;
  /** null for a scope known only from provider or drug evidence. */
  market: string | null;
  issuer_id: string | null;
  catalog: string;
  premium: string;
  provider: string;
  formulary: string;
  snapshot_id: string | null;
}

/**
 * Read-only values only the host process knows. Each member is optional; a missing member or an
 * `undefined` result means the host cannot tell, never zero.
 */
export interface StatusHost {
  /** The core application version. */
  version?(): string | undefined;
  /** Clients waiting for a database connection. */
  poolWaiting?(): number | undefined;
  /** Response cache counters since the process started. */
  cacheStats?():
    | { hits: number; misses: number; bypasses: number; bytes: number }
    | undefined;
  /** A round trip on a sentinel key of the configured cache. Absent when the cache is off. */
  cacheProbe?(): Promise<boolean>;
  /** The plugins this process loaded. */
  plugins?(): HostPluginEntry[] | undefined;
  /** Whether a loaded plugin serves this pass-through source. */
  passthroughEnabled?(id: string): boolean | undefined;
  /** Share of pass-through questions answered from a cache level, 0 to 1, in this process. */
  passthroughHitRate?(id: string): number | undefined;
  /**
   * Coverage per scope from the core's availability service, read with the caller's session.
   * It rejects when the session cannot read it.
   */
  dataAvailability?(db: SqlSession): Promise<HostAvailabilityEntry[]>;
}

/**
 * A plugin module's optional factory. The host calls it instead of using the default export
 * when the manifest declares `capabilities.hostStatus`, and only where it has a status view.
 */
export type PluginFactory = (settings: { host: StatusHost }) => OpenPlansPlugin;

export interface OpenPlansPlugin {
  manifest: PluginManifest;
  setup(ctx: PluginContext): void | Promise<void>;
  teardown?(): Promise<void>;
}
export interface PluginContext {
  readonly plugin: { name: string; version: string };
  readonly options: unknown;
  readonly secrets: { get(name: string): string | undefined };
  readonly config: Readonly<CoreConfigView>;
  readonly log: (
    entry: Record<string, string | number | boolean | null>,
  ) => void;
  readonly db: PluginDatabase;
  readonly routes: RouteRegistry;
  readonly mcpTools: McpToolRegistry;
  readonly cacheStores: ProviderRegistry<CacheStoreFactory>;
  readonly dbProviders: ProviderRegistry<DbProviderFactory>;
  readonly blobStores: ProviderRegistry<BlobStoreFactory>;
  readonly sources: SourceRegistry;
  readonly workerCommands: WorkerCommandRegistry;
  readonly schedules: ScheduleRegistry;
  readonly events: EventRegistry;
  readonly fetch: AdmittedFetch;
}
/** Values the host sets on every plugin route request, read with `c.get(name)`. */
export interface PluginRouteVariables {
  /** Read-only database scope for this request, bounded by the request deadline. */
  pluginDb: SqlSession;
  /** Aborts when the request deadline passes. */
  pluginSignal: AbortSignal;
  /**
   * Set only for a plugin that registered a pass-through source. Pass it as `writer` in the
   * scope given to `ctx.sources.passThrough.apply`, so the plugin's own sources can call, store
   * and record attempts. It is not a general writer: a statement that writes anything except the
   * source's own storage tables is refused.
   */
  pluginPassThroughWriter?: SqlSession;
}
/** The Hono environment plugin route handlers run in. */
export interface PluginRouteEnv {
  Variables: PluginRouteVariables;
}
export interface RouteSpec {
  method: "GET" | "POST";
  path: `/${string}`;
  exposure: "public" | "operator";
  rateLimit?: {
    perMinute: number;
    activePerSource: number;
    activeTotal: number;
  };
  cache?: { ttlSeconds: number };
  contentType: "application/json" | "text/html";
  handler: (c: Context<PluginRouteEnv>) => Response | Promise<Response>;
}
export interface RouteRegistry {
  add(spec: RouteSpec): void;
}
export interface McpToolContext {
  db: SqlSession;
  signal: AbortSignal;
}
export interface McpToolSpec<I, O> {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodType<I>;
  outputSchema: z.ZodType<O>;
  readOnly: true;
  cache?: { ttlSeconds: number };
  handler: (input: I, ctx: McpToolContext) => Promise<O>;
}
export interface McpToolRegistry {
  add<I, O>(spec: McpToolSpec<I, O>): void;
}
export interface ProviderRegistry<F> {
  provide(name: string, factory: F): void;
}
export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  bytes(): number;
}
export type CacheStoreFactory = (settings: {
  maxBytes: number;
  url?: string;
}) => CacheStore;
export type DbProviderFactory = (settings: {
  connectionString?: string;
}) => Database;
export type BlobStoreFactory = (settings: {
  root?: string;
  url?: string;
}) => BlobStore;
export interface BlobStore {
  put(
    key: string,
    body: AsyncIterable<Uint8Array>,
    meta: { sha256?: string },
  ): Promise<{ bytes: number; sha256: string }>;
  get(key: string): Promise<AsyncIterable<Uint8Array> | null>;
  stat(key: string): Promise<{ bytes: number; sha256: string | null } | null>;
  list(prefix: string): AsyncIterable<string>;
  publish(temporaryKey: string, finalKey: string): Promise<void>;
  /**
   * Removes one key. A missing key is not an error. The host calls it only for the temporary
   * `.pending-` keys it wrote itself, to clean up after a failed publish; it never deletes a
   * published snapshot.
   */
  delete(key: string): Promise<void>;
}
/**
 * Durable key-value state owned by one plugin. Values are JSON; keys match
 * `/^[a-z0-9][a-z0-9._:-]{0,127}$/i` and may not start with `core:`.
 */
export interface PluginState {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}
export interface WorkerContext {
  db: PluginDatabase;
  config: Readonly<CoreConfigView>;
  log: PluginContext["log"];
  fetch: AdmittedFetch;
  /** Emits need `capabilities.writes` to include "events"; handlers register during setup. */
  events: EventRegistry;
  state: PluginState;
  /** Aborts when the command's time limit passes or the worker stops it. */
  signal: AbortSignal;
}
export interface WorkerCommandSpec {
  argv: readonly string[];
  usage: string;
  /** For an `ingest *` command, the source id its `ingest.*` events report. */
  source?: string;
  queryTimeoutMs?: number;
  /** Time limit for one run. When it passes, `ctx.signal` aborts and the run exits 1. */
  timeoutMs?: number;
  run: (args: string[], ctx: WorkerContext) => Promise<number>;
}
export interface WorkerCommandRegistry {
  add(spec: WorkerCommandSpec): void;
}
export interface ScheduleSpec {
  name: string;
  cron: string;
  command: readonly string[];
  maxRunMs: number;
}
export interface ScheduleRegistry {
  add(spec: ScheduleSpec): void;
}

/** One outbound POST. Header names must start with `x-openplans-`. */
export interface AdmittedPostRequest {
  body: Uint8Array;
  contentType: string;
  headers?: Readonly<Record<string, string>>;
}
export interface AdmittedPostResult {
  status: number;
}
/**
 * Plugins receive an admitted fetch function, without transport injection. The call itself is a
 * GET: in a worker command it goes only to the plugin's declared `capabilities.network` hosts,
 * through the reviewed admission manifest, robots.txt, terms and per-host pacing, and aborts
 * with `ctx.signal`. `post` exists where the host sends outbound requests for the plugin (durable
 * event delivery and worker commands). It goes only to the declared hosts, follows no redirect
 * and rejects any status outside 2xx.
 */
export type AdmittedFetch = ((
  url: string,
  options: {
    expectedContent: "csv" | "json" | "zip" | "xlsx" | "binary";
    maxBytes: number;
    expectedSha256?: string;
  },
) => Promise<AcquiredFile>) & {
  post?: (
    url: string,
    request: AdmittedPostRequest,
  ) => Promise<AdmittedPostResult>;
};
export interface SnapshotMetadata {
  snapshot_id: string;
  source: string;
  url: string;
  final_url: string;
  redirect_chain: string[];
  status: number;
  content_type: string | null;
  etag: string | null;
  last_modified: string | null;
  sha256: string;
  bytes: number;
  fetched_at: string;
  content_encoding?: "gzip" | "deflate" | "br";
  transferred_bytes?: number;
  access_policy?: {
    manifestSha256: string;
    hosts: {
      host: string;
      state: string;
      termsSha256: string;
      robots: {
        url: string;
        status: number;
        sha256: string | null;
        checkedAt: string;
      };
    }[];
  };
}
export interface AcquiredFile {
  url: string;
  /** The stored payload. Empty when the file was kept in memory only; read `body` then. */
  path: string;
  sha256: string;
  bytes: number;
  snapshotId: string;
  metadata: SnapshotMetadata;
  /**
   * The response bytes, set only when nothing was stored: a worker command whose plugin did not
   * declare `capabilities.writes` with "cache", or any fetch inside a `none` or `request` scope.
   * `snapshotId` is then the body's SHA-256 and names no stored snapshot.
   */
  body?: Uint8Array;
}
export type CacheLevel = "none" | "request" | "memory" | "stored";
export const CACHE_LEVEL_ORDER: readonly CacheLevel[] = Object.freeze([
  "none",
  "request",
  "memory",
  "stored",
]);
