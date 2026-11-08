import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { acquireGeo, centroidStream, GEO_SOURCES } from '../../../src/ingest/geo/sources.js';
import { centroids } from '../../../src/ingest/geo/parse.js';
import { fixtureFiles } from './helpers.js';

// Synthetic ZIP envelope around labelled synthetic tabular data; no network or real archive fixture.
function archive(content: string, filename = '2021_Gaz_zcta_national.txt'): Buffer {
  const name = Buffer.from(filename), body = Buffer.from(content), compressed = deflateRawSync(body);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(body.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(body.length, 24); central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + compressed.length, 16);
  return Buffer.concat([local, name, compressed, central, name, end]);
}
describe('geography acquisition', () => {
  it('acquires all sources via the safe fetcher and reuses hash-verified snapshots offline', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openplans-geo-cache-'));
    try {
      const fixtures = await fixtureFiles(); let requests = 0;
      const files = await acquireGeo({ dataDir: directory, fetchOptions: {
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        transport: async (url) => {
          requests++;
          const kind = (Object.keys(GEO_SOURCES) as (keyof typeof GEO_SOURCES)[]).find((key) => GEO_SOURCES[key].url === url.href)!;
          const body = kind === 'centroids' ? archive('GEOID\tINTPTLAT\tINTPTLONG\n00000\t0.000000\t0.000000\n') : await readFile(fixtures[kind].path);
          return { status: 200, headers: { 'content-type': kind === 'centroids' ? 'application/zip' : kind === 'ratingAreas' ? 'text/html' : 'text/plain' }, body: Readable.from([body]) };
        },
      } });
      expect(requests).toBe(3);
      expect(files.relationship.path).toContain('raw/census-zcta-county-2020');
      expect(files.ratingAreas.path).toContain('raw/cms-rating-areas');
      const reused = await acquireGeo({ dataDir: directory, fetchOptions: {
        lookup: async () => { throw new Error('cache hit must not resolve DNS'); },
        transport: async () => { throw new Error('cache hit must not request'); },
      } });
      expect(reused).toEqual(files);
      const decoded = [];
      for await (const row of centroids(centroidStream(files.centroids))) decoded.push(row);
      expect(decoded).toEqual([{ zcta: '00000', latitude: '0.000000', longitude: '0.000000', rowNumber: 2 }]);
      // Deliberately damage cached bytes: expectedSha256 must not bypass integrity checks.
      await writeFile(files.relationship.path, Buffer.alloc(files.relationship.metadata.bytes, 'x'));
      await expect(acquireGeo({ dataDir: directory })).rejects.toMatchObject({ code: 'cache_error' });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('rejects the wrong archive member before reading Gazetteer rows', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openplans-geo-archive-'));
    try {
      const file = (await fixtureFiles()).centroids;
      const path = join(directory, 'wrong.zip'), body = archive('synthetic', 'unexpected.txt'); await writeFile(path, body);
      const stream = centroidStream({ ...file, path, zipped: true, metadata: { ...file.metadata,
        bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') } });
      await expect((async () => { for await (const _chunk of stream) { /* fully consume */ } })()).rejects.toThrow('Unexpected Gazetteer');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

});
