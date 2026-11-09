import { createHash } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { SqlSession } from "../../db/database.js";
import { compatKeyHeader, credentialMatches } from "../../compat/v1/auth.js";
import { dataGeneration } from "./generation.js";
import { MemoryCache } from "./store.js";
import type { CacheStats, CacheStore } from "./store.js";
import { MAX_ENTRY_BYTES, RespCache } from "./resp.js";

export type CacheOutcome = "hit" | "miss" | "bypass";
export type ResponseCache = ReturnType<typeof createResponseCache>;
const caches = new WeakMap<SqlSession, ResponseCache>();

/** Share the API backend with transport adapters, including request-scoped MCP factories. */
export function sharedResponseCache(db: SqlSession): ResponseCache {
  return (
    caches.get(db) ?? createResponseCache(db, process.env.OPENPLANS_API_TOKEN)
  );
}

export interface ResponseCacheOptions {
  store?: CacheStore;
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
function hasCredentials(value: unknown, publicEvidence = false): boolean {
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
function ttl(method: string, path: string): number | undefined {
  if (method === "GET") {
    if (
      ["/v1/plans", "/v1/providers", "/v1/drugs", "/compat/v1/drugs"].includes(
        path,
      )
    )
      return 60;
    if (["/v1/zip-counties", "/compat/v1/zip_counties"].includes(path))
      return 300;
    if (path === "/v1/benchmark") return 30;
  }
  if (method === "POST") {
    if (
      ["/v1/quotes", "/v1/premium-quotes"].includes(path) ||
      /^\/compat\/v1\/plans\/(medical|dental)\/search$/.test(path)
    )
      return 30;
    if (path === "/compat/v1/providers/search") return 60;
  }
  return undefined;
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

export function createResponseCache(
  db: SqlSession,
  premiumToken?: string,
  options: ResponseCacheOptions = {},
) {
  const disabled = process.env.OPENPLANS_API_CACHE === "off";
  const mb = Number(process.env.OPENPLANS_API_CACHE_MB ?? 64);
  if (!Number.isSafeInteger(mb) || mb < 0 || mb > 4096)
    throw new Error("OPENPLANS_API_CACHE_MB must be an integer from 0 to 4096");
  const store = disabled
    ? new MemoryCache(0)
    : (options.store ??
      (process.env.OPENPLANS_CACHE_URL
        ? new RespCache(process.env.OPENPLANS_CACHE_URL)
        : new MemoryCache(mb * 1024 * 1024)));
  const stats: Omit<CacheStats, "bytes"> = { hits: 0, misses: 0, bypasses: 0 };
  const extraHeader = compatKeyHeader();
  const bypass: MiddlewareHandler = async (c, next) => {
    stats.bypasses++;
    c.header("X-Cache", "bypass");
    await next();
  };
  const middleware: MiddlewareHandler = async (c, next) => {
    const seconds = ttl(c.req.method, c.req.path);
    if (disabled || !seconds) return bypass(c, next);
    const compat = c.req.path.startsWith("/compat/v1/");
    const personalized = ["/v1/premium-quotes", "/v1/benchmark"].includes(
      c.req.path,
    );
    // Recheck before hits; the routers retain their own authentication and error responses.
    if (compat) {
      const token = process.env.OPENPLANS_COMPAT_API_KEY;
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
    let key: string;
    try {
      const generation = await dataGeneration(db);
      const request = canonical([
        c.req.method,
        c.req.path,
        [...url.searchParams],
        body,
        generation,
      ]);
      key = `openplans:response:v1:${createHash("sha256").update(request).digest("hex")}`;
      const cached = await store.get(key);
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
    await next();
    if (
      c.res.status !== 200 ||
      c.res.headers.has("set-cookie") ||
      !c.res.headers.get("content-type")?.includes("application/json")
    ) {
      stats.bypasses++;
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
        c.res.headers.set("X-Cache", "bypass");
        return;
      }
      await store.set(key, value, seconds);
      stats.misses++;
      c.res.headers.set("X-Cache", "miss");
    } catch {
      stats.bypasses++;
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
      request.outcome?.(outcome);
    };
    if (disabled || !request.authorized() || !publicDto(request.query)) {
      report("bypass");
      return load();
    }
    const identity = canonical([
      request.namespace,
      request.version,
      request.generation,
      request.query,
    ]);
    const key = `openplans:catalog:v1:${createHash("sha256").update(identity).digest("hex")}`;
    try {
      const cached = await store.get(key);
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
    let dto: T;
    try {
      dto = await load();
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
      if (Buffer.byteLength(serialized) > MAX_ENTRY_BYTES) {
        report("bypass");
        return dto;
      }
      await store.set(key, serialized, request.ttlSeconds);
      report("miss");
    } catch {
      report("bypass");
    }
    return dto;
  }
  const cache = {
    middleware,
    catalog,
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
