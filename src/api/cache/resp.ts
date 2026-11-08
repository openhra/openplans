import { createConnection } from 'node:net';
import type { CacheStore } from './store.js';

export const MAX_ENTRY_BYTES = 2 * 1024 * 1024;

/** One bounded, deadline-limited connection per command; no reconnect queue or idle sockets. */
export class RespCache implements CacheStore {
  private host: string;
  private port: number;
  private transferred = 0;
  constructor(address: string, private timeoutMs = 150) {
    const url = new URL(address);
    if (url.protocol !== 'redis:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
      throw new Error('Cache URL must be redis://host:port without credentials or a database');
    }
    this.host = url.hostname.replace(/^\[|\]$/g, ''); this.port = Number(url.port || 6379);
  }
  bytes() { return this.transferred; }
  private command(parts: string[]): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host: this.host, port: this.port });
      let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0), done = false;
      const finish = (error?: Error, value: string | null = null) => {
        if (done) return;
        done = true; clearTimeout(timer); socket.destroy();
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => finish(new Error('Cache deadline exceeded')), this.timeoutMs);
      socket.on('error', () => finish(new Error('Cache unavailable')));
      socket.on('end', () => finish(new Error('Cache closed before reply')));
      socket.on('connect', () => socket.write(`*${parts.length}\r\n${parts.map(part => `$${Buffer.byteLength(part)}\r\n${part}\r\n`).join('')}`));
      socket.on('data', chunk => {
        if (buffer.length + chunk.length > MAX_ENTRY_BYTES + 128) return finish(new Error('Cache reply too large'));
        buffer = Buffer.concat([buffer, chunk]);
        const end = buffer.indexOf('\r\n');
        if (end < 0) return;
        const prefix = buffer[0], line = buffer.subarray(1, end).toString();
        if (prefix === 43 && line === 'OK') return finish(undefined, 'OK');
        if (prefix !== 36 || !/^-?\d+$/.test(line)) return finish(new Error('Invalid cache reply'));
        const length = Number(line);
        if (length === -1) return finish();
        if (!Number.isSafeInteger(length) || length < 0 || length > MAX_ENTRY_BYTES) return finish(new Error('Invalid cache length'));
        if (buffer.length < end + 2 + length + 2) return;
        if (buffer.toString('ascii', end + 2 + length, end + 4 + length) !== '\r\n') return finish(new Error('Invalid cache terminator'));
        finish(undefined, buffer.subarray(end + 2, end + 2 + length).toString());
      });
    });
  }
  async get(key: string) {
    const value = await this.command(['GET', key]);
    if (value !== null) this.transferred += Buffer.byteLength(value);
    return value;
  }
  async set(key: string, value: string, ttlSeconds: number) {
    if (Buffer.byteLength(value) > MAX_ENTRY_BYTES) return;
    if (await this.command(['SET', key, value, 'EX', String(ttlSeconds)]) !== 'OK') throw new Error('Cache write rejected');
    this.transferred += Buffer.byteLength(value);
  }
}
