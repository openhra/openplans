import { AsyncLocalStorage } from "node:async_hooks";
import { CACHE_LEVEL_ORDER } from "@openplans/plugin-sdk";
import type { CacheLevel } from "@openplans/plugin-sdk";

/**
 * Request scope (design 5.10.5). It carries the strictest cache level any answer in this request
 * came from, so the response cache and the MCP catalog cache know whether they may store.
 *
 * Scopes are opened in two places: the response cache (its middleware and `catalog()`) and the
 * MCP HTTP handler. A scope opened inside another one shares its per-request answers and passes
 * every restriction up to its parents, so the outermost scope always sees the strictest level.
 */
interface Scope {
  level: CacheLevel | null;
  /** The shortest source TTL seen at `memory` level, in seconds. */
  memoryTtlSeconds: number | null;
  readonly requestAnswers: Map<string, unknown>;
  readonly parent: Scope | undefined;
}
/** A read-only view of one scope, for code that reads the level outside its async context. */
export interface ScopeHandle {
  level(): CacheLevel | null;
}
const scope = new AsyncLocalStorage<Scope>();
const order = (level: CacheLevel) => CACHE_LEVEL_ORDER.indexOf(level);

/**
 * Run `fn` in a new scope. A nested scope starts at its parent's level, so a cache inside a
 * restricted request is never looser than the request.
 */
export function runWithScope<T>(
  fn: (handle: ScopeHandle) => Promise<T>,
): Promise<T> {
  const parent = scope.getStore();
  const own: Scope = {
    level: parent?.level ?? null,
    memoryTtlSeconds: parent?.memoryTtlSeconds ?? null,
    requestAnswers: parent?.requestAnswers ?? new Map(),
    parent,
  };
  return scope.run(own, () => fn({ level: () => own.level }));
}

/**
 * Record that an answer in this request came from a source at `level`. The strictest level
 * wins; `ttlSeconds` is the source's TTL for `memory`. Outside a scope it does nothing.
 */
export function restrictCacheLevel(level: CacheLevel, ttlSeconds?: number) {
  if (!CACHE_LEVEL_ORDER.includes(level))
    throw new TypeError("Unknown cache level");
  for (let s = scope.getStore(); s; s = s.parent) {
    if (s.level === null || order(level) < order(s.level)) s.level = level;
    if (
      level === "memory" &&
      ttlSeconds !== undefined &&
      Number.isFinite(ttlSeconds) &&
      (s.memoryTtlSeconds === null || ttlSeconds < s.memoryTtlSeconds)
    )
      s.memoryTtlSeconds = Math.max(0, Math.floor(ttlSeconds));
  }
}

/** The strictest level seen in the current scope, or null when none was set or no scope runs. */
export const scopeCacheLevel = (): CacheLevel | null =>
  scope.getStore()?.level ?? null;

/** Answers kept for the life of one request (`request` level de-duplication). */
export const scopeRequestAnswers = (): Map<string, unknown> | undefined =>
  scope.getStore()?.requestAnswers;

/**
 * The TTL a shared cache may store with under the current scope, or null when it must not
 * store. `none` and `request` never store; `memory` stores for min(route, source); `stored`
 * and no level keep the route's TTL.
 */
export function scopeStoreTtl(routeTtlSeconds: number): number | null {
  const s = scope.getStore();
  if (!s || s.level === null || s.level === "stored") return routeTtlSeconds;
  if (s.level === "memory") {
    const ttl =
      s.memoryTtlSeconds === null
        ? routeTtlSeconds
        : Math.min(routeTtlSeconds, s.memoryTtlSeconds);
    return ttl > 0 ? ttl : null;
  }
  return null;
}

/** True when the current scope forbids writing a response to disk (`none` or `request`). */
export function scopeForbidsStorage(): boolean {
  const level = scopeCacheLevel();
  return level === "none" || level === "request";
}
