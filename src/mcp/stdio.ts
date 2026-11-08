#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createDatabase } from '../db/database.js';
import { buildServer } from './server.js';
import { dependencies } from './policy.js';
import { limits, MAX_OUTPUT_BYTES } from './tools.js';

export function startStdio() {
  const db = createDatabase();
  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: limits.input_bytes });
  const send = transport.send.bind(transport);
  transport.send = async (message) => {
    if (Buffer.byteLength(JSON.stringify(message)) > MAX_OUTPUT_BYTES) throw new Error('Response limit');
    await send(message);
  };
  const handle = serveStdio(() => buildServer(dependencies(db, process.env, process.env.OPENPLANS_MCP_ALLOW_PERSONALIZED === '1')),
    { legacy: 'serve', maxSubscriptions: 0, transport, onerror: () => console.error('MCP protocol error') });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await handle.close(); await db.close();
  };
  const shutdown = () => { void close().catch(() => { console.error('MCP shutdown failed'); process.exitCode = 1; }); };
  process.stdin.once('end', shutdown);
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return { close };
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try { startStdio(); } catch { console.error('MCP startup failed; check DATABASE_URL'); process.exitCode = 1; }
}
