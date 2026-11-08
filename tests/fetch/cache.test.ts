import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, request } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { fetchToCache } from '../../src/fetch/index.js';
import type { FetchOptions, Lookup, Transport, TransportContext } from '../../src/fetch/index.js';
import { fixtures } from '../fixtures/fetch/generate.mjs';

let directory: string;
let server: Server;
let port: number;
let handle: (request: IncomingMessage, response: ServerResponse) => void;
let requests: { url: string; context: TransportContext }[];
const publicLookup: Lookup = async () => [{ address: '93.184.216.34', family: 4 }];
const body = Buffer.from('{"synthetic":true}\n');
const sha256 = createHash('sha256').update(body).digest('hex');
const localTransport: Transport = (url, context) => new Promise((resolve, reject) => {
  requests.push({ url: url.href, context });
  const req = request({ hostname: '127.0.0.1', port, path: `${url.pathname}${url.search}`, headers: context.headers }, (response) => {
    resolve({ status: response.statusCode ?? 0, headers: response.headers, body: response });
  });
  req.on('error', reject);
  req.end();
});
function options(overrides: Partial<FetchOptions> = {}): FetchOptions {
  return {
    source: 'synthetic', allowHosts: ['publisher.test', 'delegate.test'], expectedContent: 'json',
    dataDir: directory, lookup: publicLookup, transport: localTransport, maxAttempts: 1, ...overrides,
  };
}
async function cacheEntries(): Promise<string[]> {
  try { return await readdir(join(directory, 'raw', 'synthetic')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'openplans-fetch-'));
  requests = [];
  handle = (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(body); };
  server = createServer((req, res) => handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(directory, { recursive: true, force: true });
});

describe('safe cache acquisition through a loopback-only test transport', () => {
  it('streams to an immutable hash snapshot and records complete metadata', async () => {
    handle = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', etag: '"synthetic-v1"', 'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT', 'content-length': body.length });
      res.write(body.subarray(0, 5)); res.end(body.subarray(5));
    };
    const result = await fetchToCache('https://publisher.test/file?unknown_key=synthetic-secret', options());
    expect(result.outcome).toBe('downloaded');
    if (result.outcome === 'not_modified') throw new Error('Expected a snapshot');
    expect(result.snapshotId).toBe(sha256);
    expect(result.path).toBe(join(directory, 'raw', 'synthetic', sha256, 'payload'));
    expect(await readFile(result.path)).toEqual(body);
    expect(JSON.parse(await readFile(result.metadataPath, 'utf8'))).toEqual(result.metadata);
    expect(result.metadata).toMatchObject({
      source: 'synthetic', snapshot_id: sha256, status: 200, content_type: 'application/json',
      etag: '"synthetic-v1"', last_modified: 'Wed, 01 Jan 2025 00:00:00 GMT', sha256, bytes: body.length, redirect_chain: [],
    });
    expect(Date.parse(result.metadata.fetched_at)).not.toBeNaN();
    expect(JSON.stringify(result.metadata)).not.toContain('synthetic-secret');
    expect(requests[0]?.context.address).toEqual({ address: '93.184.216.34', family: 4 });
    expect(requests[0]?.context.headers['accept-encoding']).toBe('identity');
    expect((await cacheEntries()).sort()).toEqual([sha256, `${sha256}.meta.json`].sort());
  });

  it('negative control: identical content twice reuses one snapshot and keeps metadata immutable', async () => {
    const first = await fetchToCache('https://publisher.test/one', options({ snapshotId: 'synthetic-first' }));
    const second = await fetchToCache('https://publisher.test/two', options({ snapshotId: 'synthetic-second' }));
    expect(first.outcome).toBe('downloaded'); expect(second.outcome).toBe('reused');
    if (first.outcome === 'not_modified' || second.outcome === 'not_modified') throw new Error('Expected snapshots');
    expect(second.path).toBe(first.path); expect(second.metadata).toEqual(first.metadata);
    expect((await cacheEntries()).sort()).toEqual(['synthetic-first', 'synthetic-first.meta.json']);
    expect(requests).toHaveLength(2);
    const cached = await fetchToCache('https://publisher.test/one', options({ expectedSha256: sha256 }));
    expect(cached.outcome).toBe('reused'); expect(requests).toHaveLength(2);
  });

  it('reapplies byte/content limits and verifies integrity on pre-request hash cache hits', async () => {
    const first = await fetchToCache('https://publisher.test/file', options());
    if (first.outcome === 'not_modified') throw new Error('Expected a snapshot');
    await expect(fetchToCache('https://publisher.test/file', options({ expectedSha256: sha256, maxBytes: 1 })))
      .rejects.toMatchObject({ code: 'too_large' });
    await expect(fetchToCache('https://publisher.test/file', options({ expectedSha256: sha256, expectedContent: 'zip' })))
      .rejects.toMatchObject({ code: 'invalid_zip' });
    await writeFile(first.path, Buffer.alloc(body.length, 'x'));
    await expect(fetchToCache('https://publisher.test/file', options({ expectedSha256: sha256 })))
      .rejects.toMatchObject({ code: 'cache_error' });
    expect(requests).toHaveLength(1);
  });

  it('rejects HTML previously cached as binary on a structured-content hash cache hit', async () => {
    const html = Buffer.from('<html>synthetic error</html>');
    handle = (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(html); };
    await fetchToCache('https://publisher.test/file', options({ expectedContent: 'binary' }));
    const hash = createHash('sha256').update(html).digest('hex');
    await expect(fetchToCache('https://publisher.test/file', options({ expectedSha256: hash })))
      .rejects.toMatchObject({ code: 'html_error_page' });
    expect(requests).toHaveLength(1);
  });

  it('publishes one snapshot for concurrent identical downloads', async () => {
    const results = await Promise.all([fetchToCache('https://publisher.test/one', options()), fetchToCache('https://publisher.test/two', options())]);
    expect(results.map((result) => result.outcome).sort()).toEqual(['downloaded', 'reused']);
    expect((await cacheEntries()).sort()).toEqual([sha256, `${sha256}.meta.json`].sort());
  });

  it('reports 304 and sends conditional headers without writing cache files', async () => {
    handle = (req, res) => {
      expect(req.headers['if-none-match']).toBe('"v1"');
      expect(req.headers['if-modified-since']).toBe('Wed, 01 Jan 2025 00:00:00 GMT');
      res.writeHead(304); res.end();
    };
    const result = await fetchToCache('https://publisher.test/file', options({ conditional: { etag: '"v1"', lastModified: 'Wed, 01 Jan 2025 00:00:00 GMT' } }));
    expect(result).toMatchObject({ outcome: 'not_modified', status: 304 }); expect(await readdir(directory)).toEqual([]);
  });

  it('rechecks DNS at each redirect, records the chain, and withholds validators from delegates', async () => {
    const lookups: string[] = [];
    handle = (req, res) => {
      if (req.url === '/start') { res.writeHead(302, { location: 'https://delegate.test/final' }); res.end(); }
      else { res.writeHead(200); res.end(body); }
    };
    const result = await fetchToCache('https://publisher.test/start', options({
      lookup: async (host) => { lookups.push(host); return publicLookup(host); }, conditional: { etag: '"v1"' },
    }));
    expect(lookups).toEqual(['publisher.test', 'delegate.test']);
    expect(requests[1]?.context.headers['if-none-match']).toBeUndefined();
    if (result.outcome === 'not_modified') throw new Error('Expected a snapshot');
    expect(result.metadata.final_url).toBe('https://delegate.test/final');
    expect(result.metadata.redirect_chain).toEqual(['https://delegate.test/final']);
  });

  it.each(['127.0.0.1', '169.254.169.254'])('negative control: blocks redirect to %s before a second request', async (address) => {
    handle = (_req, res) => { res.writeHead(302, { location: `https://${address}/secret` }); res.end(); };
    await expect(fetchToCache('https://publisher.test/start', options())).rejects.toMatchObject({ code: 'blocked_address' });
    expect(requests).toHaveLength(1); expect(await cacheEntries()).toEqual([]);
  });

  it.each(['10.0.0.5', '::1', '::ffff:127.0.0.1'])('negative control: blocks publisher DNS answer %s', async (address) => {
    const family = address.includes(':') ? 6 : 4;
    await expect(fetchToCache('https://publisher.test/file', options({ lookup: async () => [{ address, family }] })))
      .rejects.toMatchObject({ code: 'blocked_address' });
    expect(requests).toHaveLength(0);
  });

  it('blocks redirect rebinding of an allowlisted hostname', async () => {
    let resolutions = 0;
    handle = (_req, res) => { res.writeHead(302, { location: '/again' }); res.end(); };
    await expect(fetchToCache('https://publisher.test/start', options({ lookup: async () => [
      { address: ++resolutions === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 },
    ] }))).rejects.toMatchObject({ code: 'blocked_address' });
    expect(requests).toHaveLength(1);
  });

  it.each([
    ['http://publisher.test/file', 'https_required'], ['https://publisher.test:444/file', 'blocked_port'],
    ['https://user:password\u0040publisher.test/file', 'embedded_credentials'], ['https://other.test/file', 'host_not_allowed'],
  ])('keeps production URL checks enabled with injected transport: %s', async (url, code) => {
    await expect(fetchToCache(url, options())).rejects.toMatchObject({ code }); expect(requests).toHaveLength(0);
  });

  it('bounds redirect loops', async () => {
    handle = (_req, res) => { res.writeHead(302, { location: '/loop' }); res.end(); };
    await expect(fetchToCache('https://publisher.test/loop', options({ maxRedirects: 2 }))).rejects.toMatchObject({ code: 'too_many_redirects' });
    expect(requests).toHaveLength(3);
  });

  it('negative control: aborts an oversized chunked body and removes all partial files', async () => {
    handle = (_req, res) => { res.writeHead(200); res.write('12345678'); res.end('12345678'); };
    await expect(fetchToCache('https://publisher.test/large', options({ maxBytes: 10 }))).rejects.toMatchObject({ code: 'too_large' });
    expect(await cacheEntries()).toEqual([]);
  });

  it('rejects an oversized Content-Length before making a partial file', async () => {
    handle = (_req, res) => { res.writeHead(200, { 'content-length': 1000 }); res.end('small'); };
    await expect(fetchToCache('https://publisher.test/large', options({ maxBytes: 10 }))).rejects.toMatchObject({ code: 'too_large' });
    expect(await cacheEntries()).toEqual([]);
  });

  it.each(['json', 'csv', 'zip'] as const)('negative control: HTML disguised as %s is rejected', async (expectedContent) => {
    handle = (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write(' \uFEFF<!doc'); res.end('type html><html>error</html>'); };
    await expect(fetchToCache('https://publisher.test/html', options({ expectedContent }))).rejects.toMatchObject({ code: 'html_error_page' });
    expect(await cacheEntries()).toEqual([]);
  });

  it('rejects HTML after arbitrarily long leading whitespace and split UTF-8 BOM', async () => {
    const chunks = [Buffer.from([0xef]), Buffer.from([0xbb, 0xbf]), Buffer.from(' '.repeat(10_000)), Buffer.from('<!doc'), Buffer.from('type html><html>error')];
    await expect(fetchToCache('https://publisher.test/html', options({ transport: async () => ({
      status: 200, headers: { 'content-type': 'application/json' }, body: Readable.from(chunks),
    }) }))).rejects.toMatchObject({ code: 'html_error_page' });
    expect(await cacheEntries()).toEqual([]);
  });

  it('rejects HTML content-type even if the body looks like JSON', async () => {
    handle = (_req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); };
    await expect(fetchToCache('https://publisher.test/html', options())).rejects.toMatchObject({ code: 'html_error_page' });
    expect(await cacheEntries()).toEqual([]);
  });

  it('negative control: Content-Length 1000 with 600 bytes and close is truncated', async () => {
    handle = (_req, res) => {
      res.writeHead(200, { 'content-length': 1000 }); res.write(Buffer.alloc(600, 'a')); setImmediate(() => res.destroy());
    };
    await expect(fetchToCache('https://publisher.test/truncated', options())).rejects.toMatchObject({ code: 'truncated' });
    expect(await cacheEntries()).toEqual([]);
  });

  it('times out a stalled body and removes the partial file', async () => {
    handle = (_req, res) => { res.writeHead(200); res.write('start'); };
    await expect(fetchToCache('https://publisher.test/stall', options({ readTimeoutMs: 20 }))).rejects.toMatchObject({ code: 'read_timeout' });
    expect(await cacheEntries()).toEqual([]);
  });

  it.each([401, 403, 404])('reports HTTP %i without retrying', async (status) => {
    handle = (_req, res) => { res.writeHead(status); res.end(); };
    await expect(fetchToCache('https://publisher.test/error', options({ maxAttempts: 3 }))).rejects.toMatchObject({ code: 'http_status', status });
    expect(requests).toHaveLength(1); expect(await cacheEntries()).toEqual([]);
  });

  it('honours Retry-After and uses bounded jitter for transient retries', async () => {
    let calls = 0;
    const delays: number[] = [];
    handle = (_req, res) => {
      if (++calls === 1) { res.writeHead(429, { 'retry-after': '2' }); res.end(); }
      else if (calls === 2) { res.writeHead(503); res.end(); }
      else { res.writeHead(200); res.end(body); }
    };
    const result = await fetchToCache('https://publisher.test/retry', options({ maxAttempts: 3, random: () => 0.5, sleep: async (delay) => { delays.push(delay); } }));
    expect(result.outcome).toBe('downloaded'); expect(delays).toEqual([2000, 500]); expect(requests).toHaveLength(3);
  });

  it('honours HTTP-date Retry-After and bounds jitter delays', async () => {
    const delays: number[] = [];
    let calls = 0;
    const future = new Date(Date.now() + 10_000).toUTCString();
    handle = (_req, res) => {
      if (++calls === 1) { res.writeHead(503, { 'retry-after': future }); res.end(); }
      else { res.writeHead(200); res.end(body); }
    };
    await fetchToCache('https://publisher.test/retry', options({ maxAttempts: 2, sleep: async (delay) => { delays.push(delay); }, random: () => 1 }));
    expect(delays[0]).toBeGreaterThan(8000);
    expect(delays[0]).toBeLessThanOrEqual(10_000);
  });

  it('does not retry earlier than a Retry-After outside the configured budget', async () => {
    handle = (_req, res) => { res.writeHead(503, { 'retry-after': '120' }); res.end(); };
    await expect(fetchToCache('https://publisher.test/retry', options({ maxAttempts: 3, maxRetryDelayMs: 1000 })))
      .rejects.toMatchObject({ code: 'http_status', status: 503 });
    expect(requests).toHaveLength(1);
  });

  it('bounds retries and retries connection failures', async () => {
    let calls = 0;
    await expect(fetchToCache('https://publisher.test/retry', options({
      maxAttempts: 2, sleep: async () => {}, transport: async () => { calls++; throw new Error('private transport detail'); },
    }))).rejects.toMatchObject({ code: 'network_error', message: 'Publisher connection failed' });
    expect(calls).toBe(2);
  });

  it('retries a truncated attempt from scratch and publishes only the complete body', async () => {
    let calls = 0;
    handle = (_req, res) => {
      if (++calls === 1) { res.writeHead(200, { 'content-length': 1000 }); res.write('partial'); setImmediate(() => res.destroy()); }
      else { res.writeHead(200); res.end(body); }
    };
    const result = await fetchToCache('https://publisher.test/retry', options({ maxAttempts: 2, sleep: async () => {} }));
    expect(result.outcome).toBe('downloaded'); expect((await cacheEntries()).sort()).toEqual([sha256, `${sha256}.meta.json`].sort());
  });

  it('checks ZIP limits and traversal before publishing a snapshot', async () => {
    for (const [fixture, code] of [[fixtures.bomb, 'zip_bomb'], [fixtures.traversal, 'zip_path_traversal']] as const) {
      handle = (_req, res) => { res.writeHead(200, { 'content-type': 'application/zip' }); res.end(fixture()); };
      await expect(fetchToCache('https://publisher.test/archive', options({ expectedContent: 'zip' }))).rejects.toMatchObject({ code });
      expect(await cacheEntries()).toEqual([]);
    }
    handle = (_req, res) => { res.writeHead(200, { 'content-type': 'application/zip' }); res.end(fixtures.valid()); };
    expect((await fetchToCache('https://publisher.test/archive', options({ expectedContent: 'zip' }))).outcome).toBe('downloaded');
  });

  it('never overwrites a caller snapshot ID containing different content', async () => {
    const first = await fetchToCache('https://publisher.test/one', options({ snapshotId: 'fixed' }));
    handle = (_req, res) => { res.writeHead(200); res.end('{"synthetic":"changed"}'); };
    await expect(fetchToCache('https://publisher.test/two', options({ snapshotId: 'fixed' }))).rejects.toMatchObject({ code: 'snapshot_conflict' });
    if (first.outcome === 'not_modified') throw new Error('Expected a snapshot');
    expect(await readFile(first.path)).toEqual(body); expect((await cacheEntries()).sort()).toEqual(['fixed', 'fixed.meta.json']);
  });

  it('rejects a mismatched expected hash and cleans the partial', async () => {
    await expect(fetchToCache('https://publisher.test/file', options({ expectedSha256: '0'.repeat(64) }))).rejects.toMatchObject({ code: 'snapshot_conflict' });
    expect(await cacheEntries()).toEqual([]);
  });

  it.each([
    ['gzip', gzipSync], ['deflate', deflateSync], ['br', brotliCompressSync],
  ] as const)('decodes %s, hashes decoded bytes and reapplies both limits to cache hits', async (encoding, compress) => {
    const encoded = compress(body);
    handle = (_req, res) => { res.writeHead(200, { 'content-encoding': encoding, 'content-length': encoded.length }); res.end(encoded); };
    const result = await fetchToCache('https://publisher.test/file', options({ maxBytes: encoded.length, maxDecompressedBytes: body.length }));
    if (result.outcome === 'not_modified') throw new Error('Expected a snapshot');
    expect(await readFile(result.path)).toEqual(body);
    expect(result.metadata).toMatchObject({ bytes: body.length, sha256, content_encoding: encoding, transferred_bytes: encoded.length });
    expect((await fetchToCache('https://publisher.test/file', options({ expectedSha256: sha256, maxBytes: encoded.length, maxDecompressedBytes: body.length }))).outcome).toBe('reused');
    await expect(fetchToCache('https://publisher.test/file', options({ expectedSha256: sha256, maxBytes: encoded.length - 1 }))).rejects.toMatchObject({ code: 'too_large' });
    await expect(fetchToCache('https://publisher.test/file', options({ expectedSha256: sha256, maxDecompressedBytes: body.length - 1 }))).rejects.toMatchObject({ code: 'too_large' });
    expect(requests).toHaveLength(1);
  });

  it.each([
    ['gzip', gzipSync], ['deflate', deflateSync], ['br', brotliCompressSync],
  ] as const)('negative control: a small %s bomb exceeds decoded cap and leaves nothing published', async (encoding, compress) => {
    // Synthetic highly compressible content: ~1 KB gzip expands to almost 1 MiB.
    const encoded = compress(Buffer.alloc(1000 * 1024, 'x'));
    expect(encoded.length).toBeLessThanOrEqual(1030);
    let destroyed = false;
    async function* input() { try { yield encoded; } finally { destroyed = true; } }
    const transport: Transport = async () => ({ status: 200,
      headers: { 'content-encoding': encoding, 'content-length': String(encoded.length) }, body: Readable.from(input()),
    });
    await expect(fetchToCache('https://publisher.test/bomb', options({ transport, maxBytes: 2048, maxDecompressedBytes: 32 * 1024 })))
      .rejects.toMatchObject({ code: 'too_large' });
    expect(destroyed).toBe(true);
    expect(await cacheEntries()).toEqual([]);
  });

  it('defaults the decoded cap to maxBytes even without Content-Length', async () => {
    const encoded = gzipSync(Buffer.alloc(32 * 1024, 'x'));
    handle = (_req, res) => { res.writeHead(200, { 'content-encoding': 'gzip' }); res.end(encoded); };
    await expect(fetchToCache('https://publisher.test/bomb', options({ maxBytes: 1024 }))).rejects.toMatchObject({ code: 'too_large' });
    expect(await cacheEntries()).toEqual([]);
  });

  it('checks wire cap independently from decoded cap', async () => {
    const encoded = gzipSync(body);
    const transport: Transport = async () => ({ status: 200, headers: { 'content-encoding': 'gzip' }, body: Readable.from([encoded]) });
    await expect(fetchToCache('https://publisher.test/file', options({ transport, maxBytes: encoded.length - 1, maxDecompressedBytes: 1024 }))).rejects.toMatchObject({ code: 'too_large' });
    expect(await cacheEntries()).toEqual([]);
  });

  it('rejects HTML after HTTP decoding', async () => {
    handle = (_req, res) => { res.writeHead(200, { 'content-encoding': 'gzip' }); res.end(gzipSync('<html>synthetic</html>')); };
    await expect(fetchToCache('https://publisher.test/file', options())).rejects.toMatchObject({ code: 'html_error_page' });
    expect(await cacheEntries()).toEqual([]);
  });

  it.each(['gzip', 'deflate', 'br'])('rejects malformed %s and removes partials', async encoding => {
    handle = (_req, res) => { res.writeHead(200, { 'content-encoding': encoding }); res.end('invalid compressed synthetic body'); };
    await expect(fetchToCache('https://publisher.test/file', options())).rejects.toMatchObject({ code: 'truncated' });
    expect(await cacheEntries()).toEqual([]);
  });

  it('rejects a truncated gzip footer and mismatched encoded Content-Length', async () => {
    const encoded = gzipSync(body);
    for (const [payload, length] of [[encoded.subarray(0, -2), encoded.length - 2], [encoded, encoded.length + 1]] as const) {
      const transport: Transport = async () => ({ status: 200, headers: { 'content-encoding': 'gzip', 'content-length': String(length) }, body: Readable.from([payload]) });
      await expect(fetchToCache('https://publisher.test/file', options({ transport }))).rejects.toMatchObject({ code: 'truncated' });
      expect(await cacheEntries()).toEqual([]);
    }
  });

  it('times out stalled compressed input and tears down the decoder', async () => {
    handle = (_req, res) => { res.writeHead(200, { 'content-encoding': 'gzip' }); res.write(gzipSync(body).subarray(0, 10)); };
    await expect(fetchToCache('https://publisher.test/stall', options({ readTimeoutMs: 20 }))).rejects.toMatchObject({ code: 'read_timeout' });
    expect(await cacheEntries()).toEqual([]);
  });

  it.each(['compress', 'gzip, br'])('rejects unsupported encoding %s', async encoding => {
    handle = (_req, res) => { res.writeHead(200, { 'content-encoding': encoding }); res.end(body); };
    await expect(fetchToCache('https://publisher.test/file', options())).rejects.toMatchObject({ code: 'unsupported_encoding' });
    expect(await cacheEntries()).toEqual([]);
  });

  it('types invalid options and refuses cache path traversal', async () => {
    for (const overrides of [{ source: ['..', 'escape'].join('/') }, { snapshotId: '/absolute' }, { maxBytes: -1 }, { maxDecompressedBytes: 0 }, { maxDecompressedBytes: Infinity }, { maxDecompressedBytes: 1.5 }, { maxAttempts: 0 }, { maxRedirects: 50 }, { dataDir: 'relative-cache' }]) {
      await expect(fetchToCache('https://publisher.test/file', options(overrides))).rejects.toMatchObject({ code: 'invalid_options' });
    }
    expect(requests).toHaveLength(0);
  });

  it('types filesystem failures without leaking file paths', async () => {
    const result = await fetchToCache('https://publisher.test/file', options());
    if (result.outcome === 'not_modified') throw new Error('Expected a snapshot');
    await expect(fetchToCache('https://publisher.test/file', options({ dataDir: result.path })))
      .rejects.toMatchObject({ code: 'cache_error', message: 'Snapshot acquisition failed' });
    expect((await stat(result.path)).size).toBe(body.length);
  });

  it('handles a declared length longer than a clean injected EOF', async () => {
    await expect(fetchToCache('https://publisher.test/file', options({ transport: async () => ({
      status: 200, headers: { 'content-length': '1000' }, body: Readable.from([Buffer.alloc(600)]),
    }) }))).rejects.toMatchObject({ code: 'truncated' });
    expect(await cacheEntries()).toEqual([]);
  });
});
