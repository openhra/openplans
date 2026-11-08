import { Hono } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { hostHeaderValidation } from '@modelcontextprotocol/hono';
import { createMcpHandler, readRequestBody } from '@modelcontextprotocol/server';
import type { SqlSession } from '../db/database.js';
import { buildServer } from './server.js';
import { toolNames } from './schemas.js';
import { MAX_OUTPUT_BYTES, limits } from './tools.js';
import { authenticated, boundedDatabase, dependencies, DEADLINE_MS } from './policy.js';
import type { McpEnvironment } from './policy.js';

export interface McpLog { tool: string | null; status: number; timing_ms: number; bytes: number; cache: 'bypass' }
export interface HttpOptions {
  env?: McpEnvironment;
  now?: () => number;
  log?: (entry: McpLog) => void;
  /** Trusted socket peer supplied by a hosting adapter, never an HTTP header. */
  peerAddress?: (request: Request) => string | undefined;
}
const list = (value: string | undefined, defaults: string[] = []) => value === undefined || value === ''
  ? defaults : value.split(',').map(s => s.trim()).filter(Boolean);
function failure(status: number, code: number, message: string, headers?: HeadersInit) {
  return Response.json({ jsonrpc: '2.0', id: null, error: { code, message } }, { status, headers });
}

export function createMcpHttp(db: SqlSession, options: HttpOptions = {}) {
  const env = options.env ?? process.env, now = options.now ?? Date.now;
  const port = env.PORT ?? '3000';
  const locals = ['127.0.0.1', 'localhost', '[::1]'];
  const hosts = list(env.OPENPLANS_MCP_ALLOWED_HOSTS, [...locals, ...locals.map(h => `${h}:${port}`)]);
  const origins = list(env.OPENPLANS_MCP_ALLOWED_ORIGINS, locals.map(h => `http://${h}:${port}`));
  const proxies = list(env.OPENPLANS_TRUST_PROXY);
  const log = options.log ?? (entry => console.error(JSON.stringify(entry)));
  const buckets = new Map<string, { count: number; until: number }>();
  let active = 0;
  const app = new Hono();
  app.use('/mcp', async (c, next) => {
    if (env.OPENPLANS_MCP === 'off') return c.notFound();
    const host = c.req.header('host') ?? new URL(c.req.url).host;
    if (!hosts.includes(host)) return failure(403, -32000, 'Host forbidden');
    // Exact scheme/host/port comparison; SDK hostname checks alone are insufficient.
    const origin = c.req.header('origin');
    if (origin !== undefined && !origins.includes(origin)) return failure(403, -32000, 'Origin forbidden');
    if (origin) {
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Vary', 'Origin');
      c.header('Access-Control-Expose-Headers', 'WWW-Authenticate, Retry-After');
    }
    await next();
  });
  // The official adapter additionally checks a supplied Host's hostname.
  app.use('/mcp', async (c, next) => c.req.header('host')
    ? hostHeaderValidation(hosts.map(h => new URL(`http://${h}`).hostname))(c, next) : next());
  app.options('/mcp', c => {
    c.header('Access-Control-Allow-Methods', 'POST');
    c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Accept');
    return c.body(null, 204);
  });
  app.all('/mcp', async c => {
    if (c.req.method !== 'POST') return failure(405, -32600, 'Method not allowed', { Allow: 'POST, OPTIONS' });
    const started = now(), controller = new AbortController();
    const signal = AbortSignal.any([c.req.raw.signal, controller.signal]);
    let done = false, acquired = false, bytes = 0, tool: string | null = null;
    let status = 500;
    let handler: ReturnType<typeof createMcpHandler> | undefined;
    const finish = () => {
      if (done) return;
      done = true; clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (acquired) active--;
      void handler?.close().catch(() => {});
      log({ tool, status, timing_ms: Math.max(0, now() - started), bytes, cache: 'bypass' });
    };
    let rejectAbort: (reason: Error) => void;
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const onAbort = () => { if (status === 500) status = 504; rejectAbort(new Error('Request cancelled')); finish(); };
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
    timer.unref();
    try {
      signal.throwIfAborted();
      const granted = authenticated(c.req.header('authorization') ?? null, env.OPENPLANS_MCP_TOKEN);
      let peer = options.peerAddress?.(c.req.raw);
      if (!peer) { try { peer = getConnInfo(c).remote.address; } catch { /* In-process hosts share one conservative bucket. */ } }
      const forwarded = c.req.header('x-forwarded-for');
      const source = peer && proxies.includes(peer) && forwarded ? forwarded.split(',').at(-1)!.trim() : peer ?? 'in-process';
      const key = `${granted ? 'auth' : 'anon'}:${source}`, time = now();
      for (const [k, bucket] of buckets) if (bucket.until <= time) buckets.delete(k);
      let bucket = buckets.get(key);
      if (!bucket && buckets.size < 10_000) { bucket = { count: 0, until: time + 60_000 }; buckets.set(key, bucket); }
      if (!bucket || ++bucket.count > (granted ? 120 : 60)) {
        status = 429; return failure(status, -32000, 'Rate limit exceeded', { 'Retry-After': String(Math.max(1, Math.ceil(((bucket?.until ?? time + 60_000) - time) / 1000))) });
      }
      if (c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
        status = 415; return failure(status, -32600, 'JSON required');
      }
      const body = await Promise.race([readRequestBody(c.req.raw, limits.input_bytes), aborted]);
      if (body.tooLarge) { status = 413; return failure(status, -32600, 'Request too large'); }
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(body.text); } catch { status = 400; return failure(status, -32700, 'Parse error'); }
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') { status = 400; return failure(status, -32600, 'Invalid request'); }
      const params = parsed.params as Record<string, unknown> | undefined;
      tool = parsed.method === 'tools/call' && toolNames.some(name => name === params?.name) ? String(params?.name) : null;
      // Legacy initialize predates metadata headers; all modern metadata validation is delegated to the SDK.
      if (parsed.method !== 'initialize' && !c.req.header('mcp-protocol-version')) {
        status = 400; return failure(status, -32020, 'Missing MCP-Protocol-Version');
      }
      const needsGrant = parsed.method === 'tools/call' && params?.name === 'estimate_premiums' && !granted;
      const heavy = parsed.method === 'tools/call' || parsed.method === 'resources/read';
      if (heavy && active >= 4) { status = 429; return failure(status, -32000, 'Concurrency limit exceeded', { 'Retry-After': '1' }); }
      if (heavy) { active++; acquired = true; }
      handler = createMcpHandler(() => buildServer(dependencies(boundedDatabase(db, signal), env, granted)), {
        legacy: 'stateless', responseMode: 'auto', keepAliveMs: 15000, maxRequestBodySize: limits.input_bytes,
        maxSubscriptions: 0,
      });
      const request = new Request(c.req.url, { method: 'POST', headers: c.req.raw.headers, body: body.text, signal });
      const response = await Promise.race([handler.fetch(request, { parsedBody: parsed }), aborted]);
      status = response.status;
      // The denied factory omits estimates entirely, so validation cannot dispatch household work.
      // Preserve SDK metadata errors before applying the HTTP authentication challenge.
      if (needsGrant && (status === 200 || status === 404)) {
        await response.body?.cancel();
        status = 401;
        return failure(status, -32000, 'Personalized access required', { 'WWW-Authenticate': 'Bearer realm="openplans-mcp"' });
      }
      if (!response.body) { finish(); return response; }
      const reader = response.body.getReader();
      const headers = new Headers(response.headers);
      headers.set('Cache-Control', 'no-store'); headers.set('X-Accel-Buffering', 'no');
      // Streaming preserves SDK auto mode while binding disconnect to SQL cancellation.
      const stream = new ReadableStream<Uint8Array>({
        async pull(out) {
          try {
            const part = await Promise.race([reader.read(), aborted]);
            if (part.done) { out.close(); finish(); return; }
            bytes += part.value.byteLength;
            if (bytes > MAX_OUTPUT_BYTES) throw new Error('Response limit');
            out.enqueue(part.value);
          } catch { controller.abort(); void reader.cancel(); out.error(new Error('MCP response interrupted')); finish(); }
        },
        async cancel() { controller.abort(); await reader.cancel(); finish(); },
      });
      return new Response(stream, { status, headers });
    } catch {
      status = signal.aborted ? 504 : 500;
      return failure(status, -32603, signal.aborted ? 'Request deadline or cancellation' : 'Request failed');
    } finally {
      // Body-bearing responses keep their request scope until EOF or disconnect.
      if (!handler || status >= 400) { controller.abort(); finish(); }
      // Avoid an unhandled rejection when a completed response is subsequently cancelled.
      void aborted.catch(() => {});
    }
  });
  return app;
}
