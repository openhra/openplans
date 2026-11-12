import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
  CacheStore,
  HostAvailabilityEntry,
  HostPluginEntry,
  StatusHost,
} from "@openplans/plugin-sdk";
import { responseCacheFor } from "../api/cache/index.js";
import type { CoreConfig } from "../config/index.js";
import type { SqlSession } from "../db/database.js";
import { dataAvailability } from "../services/availability.js";
import { providerTables, selectCacheStore } from "./providers.js";
import type { PluginRegistries } from "./registries.js";
import {
  passThroughHitRate,
  passThroughSourceIds,
} from "./sources/passthrough.js";

export const CACHE_PROBE_KEY = "openplans:status:v1:probe";
export const CACHE_PROBE_TIMEOUT_MS = 2_000;

/** What the caller of `loadPlugins` knows about its process. */
export interface StatusHostParts {
  /**
   * The database the API serves from. Its pool reports waits, and the response cache
   * `createApp` builds for it reports counters.
   */
  database?: SqlSession & { poolWaiting?(): number };
}

/** Filled by the loader once every plugin ran setup. */
export interface LoadedStatus {
  plugins: readonly HostPluginEntry[];
  registries: Pick<PluginRegistries, "cacheStores">;
}

let coreVersion: string | null | undefined;

/** The `openplans` package.json version, read once. */
export function coreApplicationVersion(): string | undefined {
  if (coreVersion === undefined) {
    coreVersion = null;
    try {
      const pkg = JSON.parse(
        readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
      ) as { name?: unknown; version?: unknown };
      if (pkg.name === "openplans" && typeof pkg.version === "string")
        coreVersion = pkg.version;
    } catch {
      // No readable package.json next to the build.
    }
  }
  return coreVersion ?? undefined;
}

const text = (value: unknown) =>
  value === null || value === undefined ? null : String(value);

/** The availability service `/v1/data-availability` serves, one entry per scope. */
export async function hostAvailability(
  db: SqlSession,
): Promise<HostAvailabilityEntry[]> {
  return (await dataAvailability(db)).map((row) => ({
    state: String(row.state),
    year: Number(row.plan_year),
    market: text(row.market),
    issuer_id: text(row.issuer_id),
    catalog: String(row.catalog_status),
    premium: String(row.premium_status),
    provider: String(row.provider_status),
    formulary: String(row.formulary_status),
    snapshot_id: text(row.snapshot_id),
  }));
}

async function probe(store: CacheStore): Promise<boolean> {
  const nonce = randomUUID();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((done) => {
    timer = setTimeout(() => done(false), CACHE_PROBE_TIMEOUT_MS);
    timer.unref();
  });
  const roundTrip = (async () => {
    await store.set(CACHE_PROBE_KEY, nonce, 60);
    return (await store.get(CACHE_PROBE_KEY)) === nonce;
  })().catch(() => false);
  try {
    return await Promise.race([roundTrip, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The read-only view a plugin with `capabilities.hostStatus` gets (design 5.11). Every member
 * reads live values; before `loaded()` returns, plugin and cache answers are undefined.
 */
export function createStatusHost(
  config: CoreConfig,
  parts: StatusHostParts,
  loaded: () => LoadedStatus | undefined,
): StatusHost {
  let store: CacheStore | undefined;
  const host: StatusHost = {
    version: coreApplicationVersion,
    poolWaiting: () => parts.database?.poolWaiting?.(),
    cacheStats: () => {
      const cache = parts.database && responseCacheFor(parts.database);
      if (!cache) return undefined;
      const { hits, misses, bypasses, bytes } = cache.stats();
      return { hits, misses, bypasses, bytes };
    },
    plugins: () => loaded()?.plugins.map((entry) => ({ ...entry })),
    passthroughEnabled: (id) =>
      loaded() ? passThroughSourceIds().includes(id) : undefined,
    passthroughHitRate: passThroughHitRate,
    dataAvailability: hostAvailability,
  };
  if (config.cache.enabled)
    host.cacheProbe = async () => {
      const state = loaded();
      if (!state) return false;
      try {
        store ??= selectCacheStore(config, providerTables(state.registries));
      } catch {
        return false;
      }
      return probe(store);
    };
  return Object.freeze(host);
}
