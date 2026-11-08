import { Readable } from 'node:stream';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireRelease, discoverRelease, filesPage } from '../../../src/ingest/rxnorm/acquire.js';
import { archiveInput, rrfRecords } from '../../../src/ingest/rxnorm/rrf.js';
import type { Transport } from '../../../src/fetch/index.js';
import { fixture, zip } from './helpers.js';

// Real link/filename cut from the official NLM files page, 2026-11-07.
const page = '<a href="https://download.nlm.nih.gov/rxnorm/RxNorm_full_prescribe_11022026.zip">RxNorm_full_prescribe_11022026.zip</a>';
describe('public CPC acquisition', () => {
  it('selects the newest dated CPC link, never the licensed full release', () => {
    const result = discoverRelease(page + '<a href="https://download.nlm.nih.gov/rxnorm/RxNorm_full_12072026.zip">full</a>'
      + '<a href="https://download.nlm.nih.gov/rxnorm/RxNorm_full_prescribe_10052026.zip">old</a>');
    expect(result).toEqual({ version: '2026-11-02', url: 'https://download.nlm.nih.gov/rxnorm/RxNorm_full_prescribe_11022026.zip' });
    expect(() => discoverRelease(page.replace('download.nlm.nih.gov', 'evil.example'))).toThrow('No public');
    expect(() => discoverRelease(page.replace('11022026', '11322026'))).toThrow('No public');
  });
  it('downloads via the safe fetch cache, streams real RRF cuts and reuses the same hash', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'rxnorm-cache-')), bytes = zip(await fixture());
    const calls: string[] = [];
    const transport: Transport = async url => {
      calls.push(url.href);
      return { status: 200, headers: { 'content-type': url.href === filesPage ? 'text/html' : 'application/zip' },
        body: Readable.from([url.href === filesPage ? Buffer.from(page) : bytes]) };
    };
    try {
      const deps = { lookup: async () => [{ address: '130.14.16.1', family: 4 as const }], transport };
      const first = await acquireRelease(dataDir, deps), second = await acquireRelease(dataDir, deps);
      expect(first.path).toBe(second.path);
      expect(calls.filter(url => url !== filesPage)).toHaveLength(1);
      expect(await readFile(first.path)).toEqual(bytes);
      const input = await archiveInput(first.path);
      let count = 0;
      for await (const row of rrfRecords(input('RXNCONSO.RRF'), 'RXNCONSO.RRF')) { expect(row).toHaveLength(18); count++; }
      expect(count).toBeGreaterThan(10);
    } finally { await rm(dataDir, { recursive: true, force: true }); }
  });
  it('negative control: mutated RRF bytes fail the ZIP member checksum', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rxnorm-crc-'));
    const bytes = zip(await fixture());
    const start = 30 + bytes.readUInt16LE(26) + bytes.readUInt16LE(28);
    bytes[start] = bytes[start]! ^ 1;
    const path = join(directory, 'mutant.zip');
    try {
      await writeFile(path, bytes);
      const input = await archiveInput(path);
      await expect(async () => { for await (const row of rrfRecords(input('RXNCONSO.RRF'), 'RXNCONSO.RRF')) { void row; } }).rejects.toThrow('checksum');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('fails on a login redirect without attempting a UMLS account', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'rxnorm-login-'));
    const transport: Transport = async url => url.href === filesPage
      ? { status: 200, headers: {}, body: Readable.from([page]) }
      : { status: 302, headers: { location: 'https://uts.nlm.nih.gov/login' }, body: Readable.from([]) };
    try {
      await expect(acquireRelease(dataDir, { lookup: async () => [{ address: '130.14.16.1', family: 4 }], transport })).rejects.toThrow();
    } finally { await rm(dataDir, { recursive: true, force: true }); }
  });
  it('preserves literal quotes, Unicode across chunks, trailing empty fields; rejects truncated records', async () => {
    const row = '1|ENG||||||2||||RXNORM|IN|1|a "quoted" café||N|4096|\n';
    async function* chunks() { const bytes = Buffer.from(row); for (const byte of bytes) yield Buffer.from([byte]); }
    const result = [];
    for await (const fields of rrfRecords(chunks(), 'RXNCONSO.RRF')) result.push(fields);
    expect(result[0]?.[14]).toBe('a "quoted" café');
    async function* truncated() { yield row.replace('|4096|', '|4096'); }
    await expect(async () => { for await (const _ of rrfRecords(truncated(), 'RXNCONSO.RRF')) { void _; } }).rejects.toThrow('layout');
  });
});
