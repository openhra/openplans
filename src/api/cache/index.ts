import { createHash } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { SqlSession } from '../../db/database.js';
import { compatKeyHeader, credentialMatches } from '../../compat/v1/auth.js';
import { dataGeneration } from './generation.js';
import { MemoryCache } from './store.js';
import type { CacheStats, CacheStore } from './store.js';
import { MAX_ENTRY_BYTES, RespCache } from './resp.js';

export interface ResponseCacheOptions {
  store?: CacheStore;
}
interface Entry { body: string; headers: [string, string][] }
const secretField = /authorization|credential|password|secret|token|api[-_]?key|cookie/i;
const responseHeaders = ['content-type', 'cache-control', 'x-openplans-gaps', 'access-control-allow-origin',
  'access-control-allow-methods', 'access-control-allow-headers', 'access-control-expose-headers'];

/** Object keys are unordered; array order and repeated query-value order are significant. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
function hasCredentials(value: unknown, professionalCredentials = false): boolean {
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (Array.isArray(item)) { for (const child of item) pending.push(child); }
    else if (item && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) {
        // These public provider fields mean degrees such as MD, not API credentials.
        if (secretField.test(key) && !(professionalCredentials && ['credential', 'credentials'].includes(key))) return true;
        pending.push(child);
      }
    }
  }
  return false;
}
function ttl(method: string, path: string): number | undefined {
  if (method === 'GET') {
    if (['/v1/plans', '/v1/providers', '/v1/drugs', '/compat/v1/drugs'].includes(path)) return 60;
    if (['/v1/zip-counties', '/compat/v1/zip_counties'].includes(path)) return 300;
    if (path === '/v1/benchmark') return 30;
  }
  if (method === 'POST') {
    if (path === '/v1/premium-estimates' || /^\/compat\/v1\/plans\/(medical|dental)\/search$/.test(path)) return 30;
    if (path === '/compat/v1/providers/search') return 60;
  }
  return undefined;
}
async function boundedText(response: Response): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return Buffer.concat(chunks).toString();
      size += value.length;
      if (size > MAX_ENTRY_BYTES) { void reader.cancel(); return undefined; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
}

export function createResponseCache(db: SqlSession, premiumToken?: string, options: ResponseCacheOptions = {}) {
  const disabled = process.env.OPENPLANS_API_CACHE === 'off';
  const mb = Number(process.env.OPENPLANS_API_CACHE_MB ?? 64);
  if (!Number.isSafeInteger(mb) || mb < 0 || mb > 4096) throw new Error('OPENPLANS_API_CACHE_MB must be an integer from 0 to 4096');
  const store = disabled ? new MemoryCache(0) : options.store ?? (process.env.OPENPLANS_CACHE_URL
    ? new RespCache(process.env.OPENPLANS_CACHE_URL) : new MemoryCache(mb * 1024 * 1024));
  const stats: Omit<CacheStats, 'bytes'> = { hits: 0, misses: 0, bypasses: 0 };
  const extraHeader = compatKeyHeader();
  const bypass: MiddlewareHandler = async (c, next) => {
    stats.bypasses++; c.header('X-Cache', 'bypass'); await next();
  };
  const middleware: MiddlewareHandler = async (c, next) => {
    const seconds = ttl(c.req.method, c.req.path);
    if (disabled || !seconds) return bypass(c, next);
    const compat = c.req.path.startsWith('/compat/v1/');
    const personalized = ['/v1/premium-estimates', '/v1/benchmark'].includes(c.req.path);
    // Recheck before hits; the routers retain their own authentication and error responses.
    if (compat) {
      const token = process.env.OPENPLANS_COMPAT_API_KEY;
      if (!token || !(credentialMatches(c.req.header('X-Api-Key'), token)
        || extraHeader && credentialMatches(c.req.header(extraHeader), token))) return bypass(c, next);
    } else if (personalized && (!premiumToken || !credentialMatches(c.req.header('Authorization'), `Bearer ${premiumToken}`))) return bypass(c, next);
    const allowedCredentials = new Set(compat ? ['x-api-key', ...(extraHeader ? [extraHeader.toLowerCase()] : [])]
      : personalized ? ['authorization'] : []);
    for (const [name] of c.req.raw.headers) {
      if (secretField.test(name) && !allowedCredentials.has(name)) return bypass(c, next);
    }
    const url = new URL(c.req.url);
    if ([...url.searchParams.keys()].some(key => secretField.test(key))) return bypass(c, next);
    url.searchParams.sort();
    let body: unknown = null;
    if (c.req.method === 'POST') {
      // Keep the existing route's 64 KiB bound even on a cache hit.
      const reader = c.req.raw.clone().body?.getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      if (!reader) return bypass(c, next);
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          size += result.value.length;
          if (size > 65_536) { void reader.cancel(); return bypass(c, next); }
          chunks.push(result.value);
        }
        body = JSON.parse(Buffer.concat(chunks).toString());
      } catch { return bypass(c, next); }
      finally { reader.releaseLock(); }
      if (hasCredentials(body)) return bypass(c, next);
    }
    let key: string;
    try {
      const generation = await dataGeneration(db);
      const request = canonical([c.req.method, c.req.path, [...url.searchParams], body, generation]);
      key = `openplans:response:v1:${createHash('sha256').update(request).digest('hex')}`;
      const cached = await store.get(key);
      if (cached !== null) {
        const entry = JSON.parse(cached) as Entry;
        if (typeof entry.body !== 'string' || !Array.isArray(entry.headers)
          || entry.headers.some(pair => !Array.isArray(pair) || pair.length !== 2 || !responseHeaders.includes(pair[0]) || typeof pair[1] !== 'string')) {
          throw new Error('Invalid cached response');
        }
        stats.hits++;
        c.res = new Response(entry.body, { status: 200, headers: entry.headers });
        c.header('X-Cache', 'hit'); return;
      }
    } catch { return bypass(c, next); }
    await next();
    if (c.res.status !== 200 || c.res.headers.has('set-cookie') || !c.res.headers.get('content-type')?.includes('application/json')) {
      stats.bypasses++; c.header('X-Cache', 'bypass'); return;
    }
    try {
      const text = await boundedText(c.res.clone());
      const credentials = [...allowedCredentials].map(name => c.req.header(name)).filter((value): value is string => !!value);
      if (personalized && premiumToken) credentials.push(premiumToken);
      const json: unknown = text === undefined ? null : JSON.parse(text);
      const professionalCredentials = ['/v1/providers', '/compat/v1/providers/search'].includes(c.req.path);
      if (text === undefined || hasCredentials(json, professionalCredentials) || json && typeof json === 'object' && 'error' in json
        || credentials.some(value => text.includes(value))) {
        stats.bypasses++; c.header('X-Cache', 'bypass'); return;
      }
      const entry: Entry = { body: text, headers: responseHeaders.flatMap(name => {
        const value = c.res.headers.get(name); return value === null ? [] : [[name, value] as [string, string]];
      }) };
      const value = JSON.stringify(entry);
      if (Buffer.byteLength(value) > MAX_ENTRY_BYTES) { stats.bypasses++; c.header('X-Cache', 'bypass'); return; }
      await store.set(key, value, seconds);
      stats.misses++; c.header('X-Cache', 'miss');
    } catch { stats.bypasses++; c.header('X-Cache', 'bypass'); }
  };
  return { middleware, stats: () => ({ ...stats, bytes: store.bytes(), backend: disabled ? 'off' : store instanceof MemoryCache ? 'memory' : 'external',
    bytes_scope: store instanceof MemoryCache ? 'resident_keys_and_values' : 'payload_bytes_transferred' }) };
}
