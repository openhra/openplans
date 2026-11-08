import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectZip } from '../../src/fetch/index.js';
import { fixtures, syntheticZip } from '../fixtures/fetch/generate.mjs';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'openplans-zip-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
async function archive(bytes: Buffer): Promise<string> {
  const path = join(directory, 'synthetic.zip');
  await writeFile(path, bytes);
  return path;
}

describe('ZIP central-directory inspection', () => {
  it.each(['valid', 'bomb', 'traversal'] as const)('regenerates the committed synthetic %s fixture', async (name) => {
    const hex = await readFile(new URL(`../fixtures/fetch/${name}.zip.hex`, import.meta.url), 'utf8');
    expect(fixtures[name]().toString('hex')).toBe(hex.trim());
  });

  it('lists members and byte sizes without extracting files', async () => {
    const result = await inspectZip(await archive(fixtures.valid()));
    expect(result.members).toEqual([{ name: 'synthetic/data.csv', compressedBytes: 20, uncompressedBytes: 18, compressionMethod: 8 }]);
    expect(result.uncompressedBytes).toBe(18);
  });

  it('supports a ZIP64 directory', async () => {
    const result = await inspectZip(await archive(syntheticZip([{ name: 'synthetic.txt' }], { zip64: true })));
    expect(result.members[0]?.name).toBe('synthetic.txt');
  });

  it('negative control: small compressed bomb fails the expansion limit', async () => {
    const bytes = fixtures.bomb();
    expect(bytes.length).toBeLessThan(2000);
    await expect(inspectZip(await archive(bytes))).rejects.toMatchObject({ code: 'zip_bomb' });
  });

  it.each([['..', 'evil'].join('/'), '/absolute', 'C:/absolute', '\\server\\share', ['..', 'evil'].join('\\')])('negative control: rejects unsafe member %s', async (name) => {
    await expect(inspectZip(await archive(syntheticZip([{ name }])))).rejects.toMatchObject({ code: 'zip_path_traversal' });
  });

  it('rejects symlinks', async () => {
    await expect(inspectZip(await archive(syntheticZip([{ name: 'link', symlink: true }])))).rejects.toMatchObject({ code: 'zip_symlink' });
  });

  it('enforces member count, total uncompressed size and compressed file size independently', async () => {
    const path = await archive(syntheticZip([{ name: 'a' }, { name: 'b' }]));
    await expect(inspectZip(path, { maxMembers: 1 })).rejects.toMatchObject({ code: 'zip_bomb' });
    await expect(inspectZip(path, { maxUncompressedBytes: 1 })).rejects.toMatchObject({ code: 'zip_bomb' });
    await expect(inspectZip(path, { maxCompressedBytes: 1 })).rejects.toMatchObject({ code: 'zip_bomb' });
  });

  it('rejects a truncated central directory and a falsified local filename', async () => {
    const valid = fixtures.valid();
    await expect(inspectZip(await archive(valid.subarray(0, valid.length - 1)))).rejects.toMatchObject({ code: 'invalid_zip' });
    const altered = Buffer.from(valid);
    altered[30] = 0x78;
    await expect(inspectZip(await archive(altered))).rejects.toMatchObject({ code: 'invalid_zip' });
  });
});
