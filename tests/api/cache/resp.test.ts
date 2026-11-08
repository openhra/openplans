import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createResponseCache } from '../../../src/api/cache/index.js';
import { RespCache, MAX_ENTRY_BYTES } from '../../../src/api/cache/resp.js';
import type { SqlSession } from '../../../src/db/database.js';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });
async function server(reply: (socket: Socket, command: string) => void) {
  const sockets = new Set<Socket>();
  const tcp = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.on('data', bytes => reply(socket, bytes.toString()));
  });
  await new Promise<void>(resolve => tcp.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise<void>(resolve => { for (const socket of sockets) socket.destroy(); tcp.close(() => resolve()); }));
  const address = tcp.address(); if (!address || typeof address === 'string') throw Error('No listener');
  return `redis://127.0.0.1:${address.port}`;
}

describe('bounded RESP GET/SET EX without new runtime dependencies', () => {
  it('frames UTF-8 arguments by bytes and handles fragmented replies, null and SET EX', async () => {
    const commands: string[] = [], sockets: Socket[] = [];
    const url = await server((socket, command) => {
      commands.push(command); sockets.push(socket);
      if (command.includes('GET')) {
        if (commands.length === 1) { socket.write('$5\r'); setTimeout(() => socket.end('\né雪\r\n'), 5); }
        else socket.end('$-1\r\n');
      } else socket.end('+OK\r\n');
    });
    const cache = new RespCache(url, 500);
    expect(await cache.get('synthetic-key')).toBe('é雪');
    expect(await cache.get('absent')).toBeNull();
    await cache.set('key', 'é雪', 30);
    expect(commands[2]).toBe('*5\r\n$3\r\nSET\r\n$3\r\nkey\r\n$5\r\né雪\r\n$2\r\nEX\r\n$2\r\n30\r\n');
    expect(sockets).toHaveLength(3);
  });
  it('bounds slow sockets with a whole-command deadline', async () => {
    const url = await server(() => {}), start = Date.now();
    await expect(new RespCache(url, 30).get('key')).rejects.toThrow('deadline');
    expect(Date.now() - start).toBeLessThan(500);
  });
  it('rejects errors, truncated/invalid framing, excessive lengths and credential URLs', async () => {
    for (const reply of ['-ERR synthetic\r\n', '$no\r\n', '$-2\r\n', `$${MAX_ENTRY_BYTES + 1}\r\n`, '$3\r\nabcXX', '$3\r\na']) {
      const url = await server(socket => socket.end(reply));
      await expect(new RespCache(url, 100).get('key')).rejects.toThrow();
    }
    expect(() => new RespCache('redis://synthetic:synthetic@localhost')).toThrow('without credentials');
  });
  it('a down cache returns 200 from the application with X-Cache bypass', async () => {
    const url = await server(socket => socket.destroy());
    const db = { query: async () => ({ rows: [{ generation: 'synthetic' }] }) } as unknown as SqlSession;
    const app = new Hono(), cache = createResponseCache(db, undefined, { store: new RespCache(url, 30) });
    app.use('*', cache.middleware); app.get('/v1/plans', c => c.json({ synthetic: true }));
    const response = await app.request('/v1/plans');
    expect(response.status).toBe(200); expect(response.headers.get('X-Cache')).toBe('bypass');
    expect(cache.stats()).toMatchObject({ hits: 0, misses: 0, bypasses: 1 });
  });
});
