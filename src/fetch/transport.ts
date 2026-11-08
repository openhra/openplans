import { request } from 'node:https';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { Readable } from 'node:stream';
import type { Address } from './policy.js';
import { FetchError } from './errors.js';

export interface TransportContext {
  address: Address;
  headers: Record<string, string>;
  connectTimeoutMs: number;
  readTimeoutMs: number;
}
export interface FetchResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Readable;
}
/** Injection point for offline tests. Implementations must not follow redirects. */
export type Transport = (url: URL, context: TransportContext) => Promise<FetchResponse>;

export const httpsTransport: Transport = (url, context) => new Promise((resolve, reject) => {
  let responseBody: IncomingMessage | undefined;
  let phase: 'tcp_connect' | 'tls_handshake' | 'response' = 'tcp_connect';
  const req = request(url, {
    method: 'GET', family: context.address.family, headers: context.headers, agent: false, rejectUnauthorized: true,
    // Pin the validated address through connect. TLS SNI/certificate checks still use the publisher hostname.
    lookup: (_hostname, _options, callback) => callback(null, context.address.address, context.address.family),
  });
  const timer = setTimeout(() => req.destroy(new FetchError('connect_timeout', 'HTTPS connection timed out')), context.connectTimeoutMs);
  req.once('socket', (socket) => {
    socket.once('connect', () => { phase = 'tls_handshake'; });
    socket.once('secureConnect', () => {
      phase = 'response';
      clearTimeout(timer);
      req.setTimeout(context.readTimeoutMs, () => {
        const error = new FetchError('read_timeout', 'Publisher response timed out');
        responseBody?.destroy(error);
        req.destroy(error);
      });
    });
  });
  req.once('response', (body) => {
    responseBody = body;
    // Retain the stream's errored state for the consumer even if it fails before iteration starts.
    body.on('error', () => {});
    clearTimeout(timer);
    resolve({ status: body.statusCode ?? 0, headers: body.headers, body });
  });
  req.once('error', (error) => {
    clearTimeout(timer);
    const failure = error instanceof FetchError ? error : new FetchError('network_error', 'HTTPS request failed');
    const code = (error as NodeJS.ErrnoException).code;
    failure.connection = { phase, ...(code && /^[A-Z0-9_]{1,80}$/.test(code) ? { code } : {}) };
    reject(failure);
  });
  req.end();
});
