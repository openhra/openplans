import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer as createTlsServer } from 'node:https';
import { createServer as createTcpServer } from 'node:net';
import type { Server as TcpServer, Socket } from 'node:net';
import { httpsTransport } from '../../src/fetch/transport.js';
import type { TransportContext } from '../../src/fetch/transport.js';

vi.mock('node:https', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:https')>();
  return { ...actual, request: vi.fn(actual.request) };
});

const context: TransportContext = {
  address: { address: '127.0.0.1', family: 4 }, headers: {}, connectTimeoutMs: 1000, readTimeoutMs: 1000,
};
let directory: string;
let key: Buffer;
let cert: Buffer;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'openplans-synthetic-tls-'));
  // Ephemeral, synthetic TLS identity; no key material is committed or printed.
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=publisher.test',
    '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem')], { stdio: 'ignore' });
  key = await readFile(join(directory, 'key.pem'));
  cert = await readFile(join(directory, 'cert.pem'));
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
async function listen(server: TcpServer): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}
async function close(server: TcpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

describe('native HTTPS transport (local servers only)', () => {
  it('pins DNS while retaining certificate verification and the publisher TLS name', async () => {
    const server = createTlsServer({ key, cert }, (_req, res) => res.end('unexpected'));
    const port = await listen(server);
    try {
      // A successful TCP/TLS connection to the pinned local address still rejects its untrusted certificate.
      await expect(httpsTransport(new URL(`https://publisher.test:${port}/`), context))
        .rejects.toMatchObject({ code: 'network_error' });
    } finally { server.closeAllConnections(); await close(server); }
  });

  it('downloads over verified TLS to a pinned address while checking the publisher name', async () => {
    const server = createTlsServer({ key, cert }, (_req, res) => res.end('synthetic TLS body'));
    const port = await listen(server);
    const actual = await vi.importActual<typeof import('node:https')>('node:https');
    const https = await import('node:https');
    vi.mocked(https.request).mockImplementationOnce(((url: URL, opts: import('node:https').RequestOptions) =>
      actual.request(url, { ...opts, ca: cert })) as typeof actual.request);
    try {
      const response = await httpsTransport(new URL(`https://publisher.test:${port}/`), context);
      const chunks: Buffer[] = [];
      for await (const chunk of response.body) chunks.push(Buffer.from(chunk));
      expect(response.status).toBe(200);
      expect(Buffer.concat(chunks).toString()).toBe('synthetic TLS body');
    } finally { server.closeAllConnections(); await close(server); }
  });

  it('bounds waiting for response headers after verified TLS connects', async () => {
    const server = createTlsServer({ key, cert }, () => {});
    const port = await listen(server);
    const actual = await vi.importActual<typeof import('node:https')>('node:https');
    const https = await import('node:https');
    vi.mocked(https.request).mockImplementationOnce(((url: URL, opts: import('node:https').RequestOptions) =>
      actual.request(url, { ...opts, ca: cert })) as typeof actual.request);
    try {
      await expect(httpsTransport(new URL(`https://publisher.test:${port}/`), { ...context, readTimeoutMs: 20 }))
        .rejects.toMatchObject({ code: 'read_timeout' });
    } finally { server.closeAllConnections(); await close(server); }
  });

  it('preserves a typed read timeout after response headers and a partial body', async () => {
    const server = createTlsServer({ key, cert }, (_req, res) => { res.writeHead(200, { 'content-length': 1000 }); res.write('partial'); });
    const port = await listen(server);
    const actual = await vi.importActual<typeof import('node:https')>('node:https');
    const https = await import('node:https');
    vi.mocked(https.request).mockImplementationOnce(((url: URL, opts: import('node:https').RequestOptions) =>
      actual.request(url, { ...opts, ca: cert })) as typeof actual.request);
    try {
      const response = await httpsTransport(new URL(`https://publisher.test:${port}/`), { ...context, readTimeoutMs: 20 });
      const consume = async () => { for await (const chunk of response.body) void chunk; };
      await expect(consume()).rejects.toMatchObject({ code: 'read_timeout' });
    } finally { server.closeAllConnections(); await close(server); }
  });

  it('bounds a TCP connection that never completes TLS', async () => {
    const sockets = new Set<Socket>();
    const server = createTcpServer((socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    const port = await listen(server);
    try {
      await expect(httpsTransport(new URL(`https://publisher.test:${port}/`), { ...context, connectTimeoutMs: 20 }))
        .rejects.toMatchObject({ code: 'connect_timeout' });
    } finally { for (const socket of sockets) socket.destroy(); await close(server); }
  });

  it('sets strict TLS, disables shared connections, and supplies the pinned DNS address', async () => {
    // Inspect request options without any connection. This also catches DNS pinning regressions under Node auto-family selection.
    const https = await import('node:https');
    const { EventEmitter } = await import('node:events');
    const emitter = new EventEmitter();
    const req = Object.assign(emitter, {
      end() { emitter.emit('error', new Error('synthetic stop')); }, destroy() { return emitter; },
    });
    const spy = vi.mocked(https.request);
    spy.mockClear();
    spy.mockReturnValueOnce(req as unknown as ReturnType<typeof https.request>);
    try {
      await expect(httpsTransport(new URL('https://publisher.test/'), context)).rejects.toMatchObject({ code: 'network_error' });
      const opts = spy.mock.calls[0]?.[1];
      expect(opts).toMatchObject({ rejectUnauthorized: true, agent: false, family: 4 });
      if (typeof opts !== 'object' || !opts || !('lookup' in opts) || !opts.lookup) throw new Error('Missing pinned lookup');
      const callback = vi.fn();
      opts.lookup('publisher.test', {}, callback);
      expect(callback).toHaveBeenCalledWith(null, '127.0.0.1', 4);
    } finally { spy.mockClear(); }
  });
});
