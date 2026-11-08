import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { serve } from '@hono/node-server';
import { once } from 'node:events';
import { createApp } from '../../../src/api/app.js';
import { compatKeyHeader } from '../../../src/compat/v1/auth.js';
import { BASE, TOKEN, searchBody, setup } from './helpers.js';

let h: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { h = await setup(); });
afterAll(async () => { await h?.close(); });
beforeEach(() => {
  vi.stubEnv('OPENPLANS_COMPAT_API_KEY', TOKEN);
  vi.stubEnv('OPENPLANS_COMPAT_KEY_HEADER', '');
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('compatibility credential headers', () => {
  it('always accepts X-Api-Key and only enables the configured extra header', async () => {
    const defaultApp = createApp(h.db);
    expect((await defaultApp.request(BASE + '/carriers', { headers: { 'X-Reference-Key': TOKEN } })).status).toBe(401);
    vi.stubEnv('OPENPLANS_COMPAT_KEY_HEADER', 'X-Reference-Key');
    const app = createApp(h.db);
    const accepted: Record<string, string>[] = [{ 'X-Api-Key': TOKEN }, { 'x-reference-key': TOKEN },
      { 'X-Api-Key': 'synthetic-wrong', 'X-Reference-Key': TOKEN },
      { 'X-Api-Key': TOKEN, 'X-Reference-Key': 'synthetic-wrong' }];
    for (const headers of accepted) {
      expect((await app.request(BASE + '/carriers', { headers })).status).toBe(200);
    }
    const rejected: Record<string, string>[] = [{}, { 'X-Api-Key': 'synthetic-wrong' }, { 'X-Reference-Key': 'synthetic-wrong' },
      { 'X-Unconfigured-Key': TOKEN }, { 'X-Api-Key': 'synthetic-wrong', 'X-Reference-Key': 'synthetic-wrong' }];
    for (const headers of rejected) {
      expect((await app.request(BASE + '/carriers', { headers })).status).toBe(401);
    }
    const preflight = await app.request(BASE + '/plans/medical/search', { method: 'OPTIONS' });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type, X-Api-Key, Accept-Version, X-Reference-Key');
    // Header configuration belongs to this app instance, not a later request.
    vi.stubEnv('OPENPLANS_COMPAT_KEY_HEADER', 'invalid header');
    expect((await app.request(BASE + '/carriers', { headers: { 'X-Reference-Key': TOKEN } })).status).toBe(200);
  });

  it.each(['x-api-key', 'content-type', 'ACCEPT-VERSION'])('does not duplicate an existing CORS header: %s', async header => {
    vi.stubEnv('OPENPLANS_COMPAT_KEY_HEADER', header);
    const response = await createApp(h.db).request(BASE + '/carriers', { method: 'OPTIONS' });
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type, X-Api-Key, Accept-Version');
  });

  it('allows exactly the RFC 7230 token characters, with empty configuration disabled', () => {
    expect(compatKeyHeader('')).toBeUndefined();
    const token = "!#$%&'*+-.^_`|~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    expect(compatKeyHeader(token)).toBe(token);
  });

  it.each([' X-Key', 'X-Key ', 'X Key', 'X-Key,X-Other', 'X-Key\r\nX-Injected', 'X-Key\t',
    'X:Key', 'X/Key', 'X[Key]', 'X(Key)', 'X{Key}', 'X"Key', 'X\\Key', 'X-☃'])
  ('rejects invalid header configuration before startup: %j', header => {
    vi.stubEnv('OPENPLANS_COMPAT_KEY_HEADER', header);
    expect(() => createApp(h.db)).toThrow('OPENPLANS_COMPAT_KEY_HEADER must be a single RFC 7230 token');
  });

  it('serves HTTP search on PGlite with either key header, rejecting bad keys and the retired path', async () => {
    vi.stubEnv('OPENPLANS_COMPAT_KEY_HEADER', 'X-Reference-Key');
    const server = serve({ fetch: createApp(h.db).fetch, hostname: '127.0.0.1', port: 0 });
    try {
      if (!server.listening) await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing loopback port');
      const origin = `http://127.0.0.1:${address.port}`;
      const request = (path: string, headers: Record<string, string>) => fetch(origin + path, { method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(searchBody()) });
      const primary = await request(BASE + '/plans/medical/search', { 'X-Api-Key': TOKEN });
      expect(primary.status).toBe(200);
      expect((await primary.json() as any).plans).toHaveLength(43);
      const extra = await request(BASE + '/plans/medical/search', { 'X-Reference-Key': TOKEN });
      expect(extra.status).toBe(200);
      expect((await extra.json() as any).plans).toHaveLength(43);
      expect((await request(BASE + '/plans/medical/search', { 'X-Api-Key': 'synthetic-wrong' })).status).toBe(401);
      expect((await request(BASE + '/plans/medical/search', { 'X-Reference-Key': 'synthetic-wrong' })).status).toBe(401);
      const retired = '/compat/synthetic-retired-version/plans/medical/search';
      expect((await request(retired, { 'X-Api-Key': TOKEN })).status).toBe(404);
      expect((await request(retired, {})).status).toBe(404);
      console.log('compat HTTP/PGlite: primary 200, configured 200, wrong keys 401, retired path 404');
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
});
