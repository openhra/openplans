import { homedir } from "node:os";
import { join } from "node:path";
import type {
  BlobStore,
  BlobStoreFactory,
  CacheStoreFactory,
  DbProviderFactory,
  PluginContext,
} from "@openplans/plugin-sdk";
import { CACHE_URL_MESSAGE, RespCache } from "../api/cache/resp.js";
import { MemoryCache } from "../api/cache/store.js";
import type { CacheStore } from "../api/cache/store.js";
import type { CoreConfig } from "../config/index.js";
import { createDatabase } from "../db/database.js";
import type { Database } from "../db/database.js";
import { LocalBlobStore } from "../fetch/blob/index.js";
import { FetchError } from "../fetch/errors.js";
import type { PluginRegistries } from "./registries.js";
import { scopeForbidsStorage } from "./request-scope.js";

/** Name used in refusal lines about core settings rather than about one plugin. */
export const CORE_PLUGIN_NAME = "@openplans/core";

type Providers = Pick<
  PluginContext,
  "cacheStores" | "dbProviders" | "blobStores"
>;

/** The core `local` factory. Its store guards its own writes, so `selectBlobStore` leaves it bare. */
const localBlobStoreFactory: BlobStoreFactory = ({ root }) =>
  new LocalBlobStore(root ?? join(homedir(), ".local", "share", "openplans"));

/**
 * Design 5.7: the core plugin's providers. `memory` is today's byte-capped LRU, `valkey` today's
 * bounded RESP client, `pg` today's pool, `local` today's fetch cache tree under the data
 * directory. `pglite` is registered only by the developer runner.
 */
export function registerCoreProviders(ctx: Providers): void {
  ctx.cacheStores.provide(
    "memory",
    ({ maxBytes }) => new MemoryCache(maxBytes),
  );
  // RespCache keeps the OPENPLANS_CACHE_URL validation message.
  ctx.cacheStores.provide("valkey", ({ url }) => {
    if (!url) throw new Error(CACHE_URL_MESSAGE);
    return new RespCache(url);
  });
  ctx.dbProviders.provide("pg", ({ connectionString }) =>
    createDatabase(connectionString),
  );
  ctx.blobStores.provide("local", localBlobStoreFactory);
}

export interface ProviderTables {
  readonly cacheStores: Readonly<Record<string, CacheStoreFactory>>;
  readonly dbProviders: Readonly<Record<string, DbProviderFactory>>;
  readonly blobStores: Readonly<Record<string, BlobStoreFactory>>;
}

/** Core providers first, then plugin providers in load order. The loader refuses name clashes. */
export function providerTables(
  registries?: Partial<
    Pick<PluginRegistries, "cacheStores" | "dbProviders" | "blobStores">
  >,
  extra: Partial<ProviderTables> = {},
): ProviderTables {
  const cacheStores: Record<string, CacheStoreFactory> = {};
  const dbProviders: Record<string, DbProviderFactory> = {};
  const blobStores: Record<string, BlobStoreFactory> = {};
  registerCoreProviders({
    cacheStores: { provide: (name, factory) => (cacheStores[name] = factory) },
    dbProviders: { provide: (name, factory) => (dbProviders[name] = factory) },
    blobStores: { provide: (name, factory) => (blobStores[name] = factory) },
  });
  for (const [name, { spec }] of Object.entries(registries?.cacheStores ?? {}))
    cacheStores[name] ??= spec;
  for (const [name, { spec }] of Object.entries(registries?.dbProviders ?? {}))
    dbProviders[name] ??= spec;
  for (const [name, { spec }] of Object.entries(registries?.blobStores ?? {}))
    blobStores[name] ??= spec;
  for (const [name, factory] of Object.entries(extra.cacheStores ?? {}))
    cacheStores[name] ??= factory;
  for (const [name, factory] of Object.entries(extra.dbProviders ?? {}))
    dbProviders[name] ??= factory;
  for (const [name, factory] of Object.entries(extra.blobStores ?? {}))
    blobStores[name] ??= factory;
  return Object.freeze({
    cacheStores: Object.freeze(cacheStores),
    dbProviders: Object.freeze(dbProviders),
    blobStores: Object.freeze(blobStores),
  });
}

/** `url` set means `valkey`, whatever the provider field says (today's OPENPLANS_CACHE_URL rule). */
export function cacheProviderName(config: CoreConfig): string {
  return config.cache.url ? "valkey" : config.cache.provider;
}

/**
 * Which configured provider names no table offers. Reports setting paths only, never values.
 * The loader turns a non-empty answer into `plugin_provider_unknown`.
 */
export function unknownProviders(
  config: CoreConfig,
  tables: ProviderTables,
): ("cache.provider" | "db.provider" | "blobs.provider")[] {
  const missing: ("cache.provider" | "db.provider" | "blobs.provider")[] = [];
  if (!Object.hasOwn(tables.cacheStores, cacheProviderName(config)))
    missing.push("cache.provider");
  if (!Object.hasOwn(tables.dbProviders, config.db.provider))
    missing.push("db.provider");
  if (!Object.hasOwn(tables.blobStores, config.blobs.provider))
    missing.push("blobs.provider");
  return missing;
}

/** The store for an enabled cache. `cache.enabled === false` is handled by the caller. */
export function selectCacheStore(
  config: CoreConfig,
  tables: ProviderTables = providerTables(),
): CacheStore {
  const name = cacheProviderName(config);
  const factory = Object.hasOwn(tables.cacheStores, name)
    ? tables.cacheStores[name]
    : undefined;
  if (!factory) throw new Error("Unknown cache provider");
  return factory({
    maxBytes: config.cache.maxMb * 1024 * 1024,
    url: config.cache.url?.reveal(),
  });
}

/**
 * Opens the configured database provider. `provider` overrides `config.db.provider` and
 * `connectionString` overrides `db.connectionString`.
 */
export function selectDatabase(
  config: CoreConfig,
  tables: ProviderTables = providerTables(),
  provider: string = config.db.provider,
  connectionString: string | undefined = config.db.connectionString?.reveal(),
): Database {
  const factory = Object.hasOwn(tables.dbProviders, provider)
    ? tables.dbProviders[provider]
    : undefined;
  if (!factory) throw new Error("Unknown database provider");
  return factory({ connectionString }) as Database;
}

/**
 * The configured blob store (`config.blobs.provider`, default `local`), rooted at `blobs.root`,
 * which OPENPLANS_DATA_DIR sets. `fetchToCache` takes it as `blobStore`; without one it uses
 * `local` under its own data directory. A plugin store comes back wrapped by `guardBlobStore`.
 */
export function selectBlobStore(
  config: CoreConfig,
  tables: ProviderTables = providerTables(),
): BlobStore {
  const factory = Object.hasOwn(tables.blobStores, config.blobs.provider)
    ? tables.blobStores[config.blobs.provider]
    : undefined;
  if (!factory) throw new Error("Unknown blob provider");
  const store = factory({ root: config.blobs.root });
  return factory === localBlobStoreFactory ? store : guardBlobStore(store);
}

/**
 * Design 5.10.4: no blob write inside a `none` or `request` scope, whatever the store does. Every
 * plugin store comes out of `selectBlobStore` behind this wrapper, so the rule never depends on
 * the plugin. Only the `BlobStore` methods pass through. `put` and `publish` throw before the
 * store sees them; `delete` passes in every scope.
 */
export function guardBlobStore(store: BlobStore): BlobStore {
  const refuse = () => {
    if (scopeForbidsStorage())
      throw new FetchError(
        "storage_forbidden",
        "The request's cache level forbids storing a payload",
      );
  };
  return Object.freeze({
    async put(...args: Parameters<BlobStore["put"]>) {
      refuse();
      return store.put(...args);
    },
    async publish(temporaryKey: string, finalKey: string) {
      refuse();
      return store.publish(temporaryKey, finalKey);
    },
    get: (key: string) => store.get(key),
    stat: (key: string) => store.stat(key),
    list: (prefix: string) => store.list(prefix),
    // Removing a key stores nothing, so it passes in every scope. A store built against an
    // older SDK may lack it; the caller's cleanup then fails on its own and is best effort.
    delete: async (key: string) => {
      if (typeof store.delete !== "function")
        throw new FetchError("cache_error", "Blob store cannot delete keys");
      return store.delete(key);
    },
  });
}
