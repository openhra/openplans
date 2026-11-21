import {
  dataPolicyActive,
  policyForGeneration,
  guardAnnualInput,
  servingPolicy,
  servingGeneration,
  withDataPolicy,
} from "../../services/data-window.js";
import { catalogPolicyActive } from "../../services/catalog-policy.js";
import { cmsFallbackUnavailable } from "../../config/cms-fallback.js";
import { recordCache } from "../../telemetry/observer.js";
import type { LowestInput } from "../handy.js";
import type { LowestCell } from "../../services/handy.js";
import { loadConfig } from "../../config/index.js";
import type { CoreConfig } from "../../config/index.js";
import { createHash } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { SqlSession } from "../../db/database.js";
import { compatKeyHeader, credentialMatches } from "../../compat/v1/auth.js";
import { MemoryCache } from "./store.js";
import type { CacheStats, CacheStore } from "./store.js";
import { MAX_ENTRY_BYTES } from "./resp.js";
import type { PluginRegistries } from "../../plugins/registries.js";
import { providerTables, selectCacheStore } from "../../plugins/providers.js";
import {
  runWithScope,
  scopeStoreTtl,
  setScopeResponseGeneration,
} from "../../plugins/request-scope.js";

/**
 * Key parts for the pass-through switches that can change an answer without a data generation:
 * the RxNav identity switch and the CMS fallback's two switches. Each state keys its own entries,
 * so an answer cached under one state (in a store that outlives the process) cannot serve another.
 * They are read from the cache's configuration, loaded once when the process builds the cache:
 * the switches take effect on restart, and a warm hit never re-parses the configuration.
 */
export function passThroughSwitchParts(
  config: Pick<CoreConfig, "rxnavIdentity" | "cmsFallback">,
): string[] {
  return [
    ...(config.rxnavIdentity ? ["rxnav_identity"] : []),
    ...(config.cmsFallback.enabled ? ["cms_fallback"] : []),
    ...(config.cmsFallback.quotes ? ["cms_fallback_quotes"] : []),
  ];
}

export type CacheOutcome = "hit" | "miss" | "bypass";
export type ResponseCache = ReturnType<typeof createResponseCache>;
const caches = new WeakMap<SqlSession, ResponseCache>();

/** Share the API backend with transport adapters, including request-scoped MCP factories. */
export function sharedResponseCache(db: SqlSession): ResponseCache {
  return (
    caches.get(db) ?? createResponseCache(db, loadConfig().tokens.api?.reveal())
  );
}

/** The cache `createApp` built for this database, if any; it never builds one. */
export function responseCacheFor(db: SqlSession): ResponseCache | undefined {
  return caches.get(db);
}

export interface ResponseCacheOptions {
  store?: CacheStore;
  config?: CoreConfig;
  /**
   * Loaded plugin registries. Their routes are mounted after the core routes; their cache stores
   * can be selected with `cache.provider`.
   */
  plugins?: Pick<PluginRegistries, "routes"> &
    Partial<
      Pick<PluginRegistries, "cacheStores" | "sources" | "catalogPolicies">
    >;
}
interface Entry {
  body: string;
  headers: [string, string][];
}
const secretField =
  /authorization|credential|password|secret|token|api[-_]?key|cookie/i;
const responseHeaders = [
  "content-type",
  "cache-control",
  "x-openplans-gaps",
  // Upstream disclosure travels with the cached body it describes.
  "x-openplans-upstream",
  "access-control-allow-origin",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-expose-headers",
  "x-quote-tier",
];

/** Object keys are unordered; array order and repeated query-value order are significant. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => {
        if (a < b) {
          return -1;
        } else if (a > b) {
          return 1;
        } else {
          return 0;
        }
      })
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function hasCredentials(
  value: unknown,
  publicEvidence = false,
): boolean {
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (Array.isArray(item)) {
      for (const child of item) pending.push(child);
    } else if (item && typeof item === "object") {
      for (const [key, child] of Object.entries(item)) {
        // Degrees and boolean formulary restrictions are published evidence.
        const published =
          publicEvidence &&
          (["credential", "credentials"].includes(key) ||
            (key === "prior_authorization" &&
              (child === null || typeof child === "boolean")));
        if (secretField.test(key) && !published) return true;
        pending.push(child);
      }
    }
  }
  return false;
}
// Public DTOs never contain household inputs, request credentials or error payloads.
function publicDto(value: unknown): boolean {
  if (hasCredentials(value, true)) return false;
  if (Array.isArray(value)) return value.every(publicDto);
  if (value && typeof value === "object")
    return Object.entries(value).every(
      ([key, child]) =>
        !/^(household.*|members|applicants|dependents|age|tobacco|relationship|income.*|tax_filing|coverage_start)$/i.test(
          key,
        ) &&
        !(key === "error" && child !== null) &&
        !(key === "status" && child === "error") &&
        publicDto(child),
    );
  return true;
}
// Response TTLs by "METHOD /path". Core entries are fixed; plugin routes add theirs (design 5.5).
const CORE_TTLS: readonly (readonly [string, number])[] = [
  ["GET /v1/plans", 60],
  ["GET /v1/providers", 60],
  ["GET /v1/drugs", 60],
  ["GET /compat/v1/drugs", 60],
  ["GET /v1/zip-counties", 300],
  ["GET /compat/v1/zip_counties", 300],
  ["GET /v1/benchmark", 30],
  ["POST /v1/quotes", 30],
  ["POST /v1/premium-quotes", 30],
  ["POST /compat/v1/plans/medical/search", 30],
  ["POST /compat/v1/plans/dental/search", 30],
  ["POST /compat/v1/providers/search", 60],
];
/** Core entries plus public plugin routes that declare `cache`. Operator routes are never stored. */
export function ttlTable(
  routes: PluginRegistries["routes"] = [],
): ReadonlyMap<string, number> {
  const table = new Map<string, number>(CORE_TTLS);
  for (const { spec } of routes) {
    const key = `${spec.method} ${spec.path}`;
    if (
      spec.exposure === "public" &&
      spec.cache &&
      Number.isSafeInteger(spec.cache.ttlSeconds) &&
      spec.cache.ttlSeconds > 0 &&
      !table.has(key)
    )
      table.set(key, spec.cache.ttlSeconds);
  }
  return table;
}
async function boundedText(response: Response): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return Buffer.concat(chunks).toString();
      size += value.length;
      if (size > MAX_ENTRY_BYTES) {
        void reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Start-up work for the miss path's body read, run once before the API listens. A process's
 * first web-stream reader release makes Node build its released-reader error, which creates an
 * internal script context (about a millisecond), and the clone, read and release code runs for
 * the first time. Reading a throwaway response here moves that to start-up, so it does not land
 * on the first cacheable request. It touches no store, statistic or response.
 */
export async function warmResponseBodyReads(): Promise<void> {
  await boundedText(new Response("{}").clone());
}

export function createResponseCache(
  db: SqlSession,
  premiumToken?: string,
  options: ResponseCacheOptions = {},
) {
  const config = options.config ?? loadConfig();
  const disabled = !config.cache.enabled;
  const switchParts = passThroughSwitchParts(config);
  /** The CMS fallback's process-local hold changes at run time, so it is read per key. */
  const passThroughKeyParts = (cmsUnavailable: boolean) => [
    ...(cmsUnavailable ? ["cms_fallback_unavailable"] : []),
    ...switchParts,
  ];
  // Design 5.7: off is a zero-byte memory store; otherwise the registry's configured provider.
  const store = disabled
    ? new MemoryCache(0)
    : (options.store ??
      selectCacheStore(config, providerTables(options.plugins)));
  const ttls = ttlTable(options.plugins?.routes);
  const stats: Omit<CacheStats, "bytes"> = { hits: 0, misses: 0, bypasses: 0 };
  // "" when unset: undefined would make compatKeyHeader load the configuration a second time.
  const extraHeader = compatKeyHeader(config.tokens.compatKeyHeader ?? "");
  const bypass: MiddlewareHandler = async (c, next) => {
    stats.bypasses++;
    recordCache("bypass");
    c.header("X-Cache", "bypass");
    await next();
  };
  // Design 5.10.5: every request runs in a scope, so a pass-through answer's level is known here.
  const middleware: MiddlewareHandler = (c, next) => {
    const run = () => runWithScope(() => respond(c, next));
    if (
      c.req.method === "GET" &&
      (c.req.path === "/readyz" || c.req.path === "/healthz")
    )
      return run();
    return withDataPolicy(config.data, run);
  };
  const respond: MiddlewareHandler = async (c, next) => {
    const boundedYear = /\/(?:providers|drugs)(?:\/|$)|^\/v1\/medicare\//.test(
      c.req.path,
    );
    if (boundedYear && Number(c.req.query("year")) > 2100)
      return bypass(c, next);
    if (c.req.path.startsWith("/v1/") || c.req.path.startsWith("/compat/v1/"))
      await guardAnnualInput(
        db,
        c.req.query(),
        c.req.path.startsWith("/v1/medicare/") ? "medicare" : "individual",
      );
    if (config.catalogPolicy || catalogPolicyActive()) {
      c.header("Cache-Control", "no-store");
      return bypass(c, next);
    }
    // Census bodies must not become cache keys, including under a conflicting plugin TTL.
    if (c.req.path === "/v1/ichra/affordability/batch") {
      c.header("Cache-Control", "no-store");
      return bypass(c, next);
    }
    const seconds = ttls.get(`${c.req.method} ${c.req.path}`);
    if (disabled || !seconds) return bypass(c, next);
    const compat = c.req.path.startsWith("/compat/v1/");
    const personalized = ["/v1/premium-quotes", "/v1/benchmark"].includes(
      c.req.path,
    );
    // Recheck before hits; the routers retain their own authentication and error responses.
    if (compat) {
      // Read per compat request: callers may set the key after building the app (follow-up).
      const token = (options.config ?? loadConfig()).tokens.compatKey?.reveal();
      if (
        !token ||
        !(
          credentialMatches(c.req.header("X-Api-Key"), token) ||
          (extraHeader && credentialMatches(c.req.header(extraHeader), token))
        )
      )
        return bypass(c, next);
    } else if (
      personalized &&
      (!premiumToken ||
        !credentialMatches(
          c.req.header("Authorization"),
          `Bearer ${premiumToken}`,
        ))
    )
      return bypass(c, next);
    function credentialHeaders() {
      if (compat) {
        return [
          "x-api-key",
          ...(extraHeader ? [extraHeader.toLowerCase()] : []),
        ];
      } else if (personalized) {
        return ["authorization"];
      } else {
        return [];
      }
    }
    const allowedCredentials = new Set(credentialHeaders());
    for (const [name] of c.req.raw.headers) {
      if (secretField.test(name) && !allowedCredentials.has(name))
        return bypass(c, next);
    }
    const url = new URL(c.req.url);
    if ([...url.searchParams.keys()].some((key) => secretField.test(key)))
      return bypass(c, next);
    url.searchParams.sort();
    let body: unknown = null;
    if (c.req.method === "POST") {
      // Keep the existing route's 64 KiB bound even on a cache hit.
      const reader = c.req.raw.clone().body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (!reader) return bypass(c, next);
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          size += result.value.length;
          if (size > 65_536) {
            void reader.cancel();
            return bypass(c, next);
          }
          chunks.push(result.value);
        }
        body = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        return bypass(c, next);
      } finally {
        reader.releaseLock();
      }
      if (hasCredentials(body)) return bypass(c, next);
    }
    if (body && typeof body === "object" && !Array.isArray(body))
      await guardAnnualInput(db, body as Record<string, unknown>);
    if (
      c.req.path.startsWith("/compat/v1/plans/") &&
      c.req.method === "POST" &&
      body &&
      typeof body === "object" &&
      !("enrollment_date" in body)
    )
      await guardAnnualInput(db, { year: 2026 });
    let key: string;
    let generation: string;
    const cmsUnavailable = cmsFallbackUnavailable();
    try {
      generation = await servingGeneration(db);
      const pendingPolicy = policyForGeneration(db, generation);
      const policy =
        pendingPolicy instanceof Promise ? await pendingPolicy : pendingPolicy;
      const request = canonical([
        c.req.method,
        c.req.path,
        [...url.searchParams],
        body,
        generation,
        policy.generation,
        ...passThroughKeyParts(cmsUnavailable),
      ]);
      key = `openplans:response:v1:${createHash("sha256").update(request).digest("hex")}`;
      const cached = await store.get(key);
      if (cmsUnavailable !== cmsFallbackUnavailable()) return bypass(c, next);
      if (cached !== null) {
        const entry = JSON.parse(cached) as Entry;
        if (
          typeof entry.body !== "string" ||
          !Array.isArray(entry.headers) ||
          entry.headers.some(
            (pair) =>
              !Array.isArray(pair) ||
              pair.length !== 2 ||
              !responseHeaders.includes(pair[0]) ||
              typeof pair[1] !== "string",
          )
        ) {
          throw new Error("Invalid cached response");
        }
        stats.hits++;
        recordCache("hit");
        c.res = new Response(entry.body, {
          status: 200,
          headers: entry.headers,
        });
        c.header("X-Cache", "hit");
        return;
      }
    } catch {
      return bypass(c, next);
    }
    setScopeResponseGeneration(generation);
    await next();
    // A `none` or `request` answer is never shared; `memory` shortens the TTL.
    const ttl = scopeStoreTtl(seconds);
    if (
      ttl === null ||
      c.res.status !== 200 ||
      c.res.headers.has("set-cookie") ||
      !c.res.headers.get("content-type")?.includes("application/json")
    ) {
      stats.bypasses++;
      recordCache("bypass");
      c.header("X-Cache", "bypass");
      return;
    }
    try {
      // Hono's c.header() replaces a finalized Response while reusing its stream.
      // After clone(), Node 22 can cancel that stream when the old Response is collected.
      // Keep the Response alive by mutating its headers directly on every path below.
      const text = await boundedText(c.res.clone());
      const credentials = [...allowedCredentials]
        .map((name) => c.req.header(name))
        .filter((value): value is string => !!value);
      if (personalized && premiumToken) credentials.push(premiumToken);
      const json: unknown = text === undefined ? null : JSON.parse(text);
      // Published evidence: provider degrees and boolean prior-authorization flags in quotes.
      const professionalCredentials = [
        "/v1/providers",
        "/v1/quotes",
        "/compat/v1/providers/search",
      ].includes(c.req.path);
      if (
        text === undefined ||
        hasCredentials(json, professionalCredentials) ||
        (json && typeof json === "object" && "error" in json) ||
        credentials.some((value) => text.includes(value))
      ) {
        stats.bypasses++;
        recordCache("bypass");
        c.res.headers.set("X-Cache", "bypass");
        return;
      }
      const entry: Entry = {
        body: text,
        headers: responseHeaders.flatMap((name) => {
          const value = c.res.headers.get(name);
          return value === null ? [] : [[name, value] as [string, string]];
        }),
      };
      const value = JSON.stringify(entry);
      if (Buffer.byteLength(value) > MAX_ENTRY_BYTES) {
        stats.bypasses++;
        recordCache("bypass");
        c.res.headers.set("X-Cache", "bypass");
        return;
      }
      await store.set(key, value, ttl);
      stats.misses++;
      recordCache("miss");
      c.res.headers.set("X-Cache", "miss");
    } catch {
      stats.bypasses++;
      recordCache("bypass");
      c.res.headers.set("X-Cache", "bypass");
    }
  };
  async function catalog<T>(
    request: {
      namespace: string;
      version: string;
      generation: string;
      query: unknown;
      authorized: () => boolean;
      accept: (value: unknown) => value is T;
      ttlSeconds: number;
      outcome?: (value: CacheOutcome) => void;
    },
    load: () => Promise<T>,
  ): Promise<T> {
    if (!dataPolicyActive())
      return withDataPolicy(config.data, () => catalog(request, load));
    const report = (outcome: CacheOutcome) => {
      function counterForOutcome() {
        if (outcome === "hit") {
          return "hits";
        } else if (outcome === "miss") {
          return "misses";
        } else {
          return "bypasses";
        }
      }
      stats[counterForOutcome()]++;
      recordCache(outcome);
      request.outcome?.(outcome);
    };
    if (
      disabled ||
      catalogPolicyActive() ||
      !request.authorized() ||
      !publicDto(request.query)
    ) {
      report("bypass");
      return load();
    }
    if (
      request.query &&
      typeof request.query === "object" &&
      !Array.isArray(request.query)
    )
      await guardAnnualInput(db, request.query as Record<string, unknown>);
    const policy = await servingPolicy(db);
    const cmsUnavailable = cmsFallbackUnavailable();
    const identity = canonical([
      request.namespace,
      request.version,
      request.generation,
      policy.generation,
      request.query,
      ...passThroughKeyParts(cmsUnavailable),
    ]);
    const key = `openplans:catalog:v1:${createHash("sha256").update(identity).digest("hex")}`;
    try {
      const cached = await store.get(key);
      if (cmsUnavailable !== cmsFallbackUnavailable()) {
        report("bypass");
        return load();
      }
      if (cached !== null) {
        if (Buffer.byteLength(cached) > MAX_ENTRY_BYTES)
          throw new Error("Cache entry too large");
        const dto: unknown = JSON.parse(cached);
        if (!publicDto(dto) || !request.accept(dto))
          throw new Error("Invalid public DTO");
        report("hit");
        return dto;
      }
    } catch {
      report("bypass");
      return load();
    }
    // load() runs in its own scope so this entry obeys the levels of the answers inside it.
    let dto: T, ttl: number | null;
    try {
      [dto, ttl] = await runWithScope(async () => {
        const value = await load();
        return [value, scopeStoreTtl(request.ttlSeconds)] as const;
      });
    } catch (error) {
      report("bypass");
      throw error;
    }
    if (!publicDto(dto) || !request.accept(dto)) {
      report("bypass");
      return dto;
    }
    try {
      const serialized = JSON.stringify(dto);
      if (ttl === null || Buffer.byteLength(serialized) > MAX_ENTRY_BYTES) {
        report("bypass");
        return dto;
      }
      await store.set(key, serialized, ttl);
      report("miss");
    } catch {
      report("bypass");
    }
    return dto;
  }
  // Separate typed contract for single-age public-data cells. publicDto stays unchanged.
  async function lowest(
    request: {
      input: LowestInput;
      generation: string;
      manifest: string;
      accept: (value: unknown) => value is LowestCell;
    },
    load: () => Promise<LowestCell>,
  ): Promise<LowestCell> {
    if (!dataPolicyActive())
      return withDataPolicy(config.data, () => lowest(request, load));
    await guardAnnualInput(db, { year: request.input.year });
    const policy = await servingPolicy(db);
    const key = `openplans:lowest:v1:${createHash("sha256")
      .update(
        canonical([
          request.input,
          request.generation,
          request.manifest,
          policy.generation,
        ]),
      )
      .digest("hex")}`;
    if (disabled || scopeStoreTtl(30) === null) return load();
    try {
      const stored = await store.get(key);
      if (stored !== null) {
        const parsed: unknown = JSON.parse(stored);
        if (
          Buffer.byteLength(stored) <= MAX_ENTRY_BYTES &&
          request.accept(parsed) &&
          parsed.provenance.input_manifest === request.manifest &&
          parsed.basis.age === request.input.age &&
          parsed.year === request.input.year
        ) {
          stats.hits++;
          recordCache("hit");
          return parsed;
        }
      }
    } catch {
      stats.bypasses++;
      recordCache("bypass");
      return load();
    }
    const [answer, ttl] = await runWithScope(async () => {
      const answer = await load();
      return [answer, scopeStoreTtl(30)] as const;
    });
    if (
      ttl !== null &&
      request.accept(answer) &&
      ["calculated", "no_plans"].includes(answer.status)
    ) {
      const serialized = JSON.stringify(answer);
      if (Buffer.byteLength(serialized) <= MAX_ENTRY_BYTES) {
        try {
          await store.set(key, serialized, ttl);
          stats.misses++;
          recordCache("miss");
        } catch {
          stats.bypasses++;
          recordCache("bypass");
        }
      }
    }
    return answer;
  }
  const cache = {
    middleware,
    catalog,
    lowest,
    stats: () => {
      function cacheBackend() {
        if (disabled) {
          return "off";
        } else if (store instanceof MemoryCache) {
          return "memory";
        } else {
          return "external";
        }
      }
      return {
        ...stats,
        bytes: store.bytes(),
        backend: cacheBackend(),
        bytes_scope:
          store instanceof MemoryCache
            ? "resident_keys_and_values"
            : "payload_bytes_transferred",
      };
    },
  };
  caches.set(db, cache);
  return cache;
}
