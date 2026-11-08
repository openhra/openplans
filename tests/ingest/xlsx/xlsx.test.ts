import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readXlsxRows } from '../../../src/ingest/xlsx/index.js';
import { xmlTokens } from '../../../src/ingest/xlsx/xml.js';
import { dishonestRatioZip, dishonestZip, syntheticWorkbook, workbook } from '../../fixtures/qhp/generate.mjs';
import { inspectZip, streamZipMember } from '../../../src/fetch/index.js';
import { syntheticZip } from '../../fixtures/fetch/generate.mjs';
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'openplans-xlsx-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
async function file(bytes: Buffer): Promise<string> { const path = join(directory, 'synthetic.zip'); await writeFile(path, bytes); return path; }
async function collect<T>(items: AsyncIterable<T>): Promise<T[]> { const result: T[] = []; for await (const item of items) result.push(item); return result; }

describe('minimal bounded XLSX', () => {
  it('regenerates synthetic fixtures and decodes shared/rich/inline strings and sparse cells', async () => {
    expect((await readFile(new URL('../../fixtures/qhp/synthetic.xlsx.hex', import.meta.url), 'utf8')).trim()).toBe(syntheticWorkbook().toString('hex'));
    expect(await collect(readXlsxRows(await file(syntheticWorkbook())))).toEqual([
      ['State', 'Issuer ID', 'URL Submitted'], ['TX', '76589', 'https://synthetic.example/index.json?x=1&y=2'], ['A & B 😀', '', '2'],
    ]);
  });
  it('uses the first workbook relationship rather than assuming sheet1', async () => {
    const path = await file(workbook({ first: 'sheet2.xml', sheet: '<worksheet><sheetData><row><c t="inlineStr"><is><t>first</t></is></c></row></sheetData></worksheet>', extra: [{ name: 'xl/worksheets/sheet1.xml', body: '<worksheet/>' }] }));
    expect(await collect(readXlsxRows(path))).toEqual([['first']]);
  });
  it('rejects bad shared string references, external entities and row/string/cell limits', async () => {
    const bad = await file(workbook({ sheet: '<worksheet><row><c t="s"><v>99</v></c></row></worksheet>' }));
    await expect(collect(readXlsxRows(bad))).rejects.toThrow('invalid_xlsx');
    await expect(collect(readXlsxRows(await file(workbook({ sheet: '<!DOCTYPE x [<!ENTITY e SYSTEM "https://synthetic.example/">]><worksheet/>' }))))).rejects.toThrow();
    const path = await file(syntheticWorkbook());
    await expect(collect(readXlsxRows(path, { maxSharedStrings: 2 }))).rejects.toThrow('xlsx_too_many_strings');
    await expect(collect(readXlsxRows(path, { maxRows: 1 }))).rejects.toThrow('xlsx_row_limit');
    await expect(collect(readXlsxRows(path, { maxCellBytes: 5 }))).rejects.toThrow();
  });
  it('tokenizes one-byte chunks, comments and quoted attributes safely', async () => {
    async function* bytes() { for (const byte of Buffer.from('<?xml version="1.0"?><!-- a>b --><root a="x>y"><t>&amp;é</t></root>')) yield Buffer.from([byte]); }
    const tokens = await collect(xmlTokens(bytes()));
    expect(tokens).toContainEqual({ type: 'open', name: 'root', attributes: { a: 'x>y' } });
    expect(tokens).toContainEqual({ type: 'text', text: '&é' });
    async function* broken() { yield Buffer.from('<root><child></root>'); }
    await expect(collect(xmlTokens(broken()))).rejects.toThrow('invalid_xlsx_xml');
  });
});

describe('ZIP actual-output limits', () => {
  it('negative control: lying declared sizes pass metadata inspection but fail actual output bytes/ratio', async () => {
    const bytes = dishonestZip();
    expect(bytes.length).toBeLessThan(2000);
    expect((await readFile(new URL('../../fixtures/qhp/dishonest-size.zip.hex', import.meta.url), 'utf8')).trim()).toBe(bytes.toString('hex'));
    const path = await file(bytes);
    expect((await inspectZip(path)).uncompressedBytes).toBe(16);
    await expect(collect(streamZipMember(path, 'synthetic-bomb.xml', { maxUncompressedBytes: 64 * 1024, maxExpansionRatio: 10000 }))).rejects.toMatchObject({ code: 'zip_bomb' });
    await expect(collect(streamZipMember(path, 'synthetic-bomb.xml', { maxUncompressedBytes: 1024 ** 2, maxExpansionRatio: 200 }))).rejects.toMatchObject({ code: 'zip_bomb' });
    // Padding cannot disguise the ratio: use inflater bytes actually consumed, not claimed input length.
    const padded = await file(dishonestRatioZip());
    await expect(collect(streamZipMember(padded, 'synthetic-bomb.xml', { maxUncompressedBytes: 1024 ** 2, maxExpansionRatio: 200 }))).rejects.toMatchObject({ code: 'zip_bomb' });
    await file(bytes);
    // Relaxing the cap still cannot make the dishonest uncompressed-size claim valid.
    await expect(collect(streamZipMember(path, 'synthetic-bomb.xml', { maxUncompressedBytes: 1024 ** 2, maxExpansionRatio: 10000 }))).rejects.toMatchObject({ code: 'invalid_zip' });
  });
  it('streams ZIP64 and rejects corrupted CRC even when all sizes agree', async () => {
    const valid = syntheticZip([{ name: 'x', body: 'synthetic' }], { zip64: true });
    const path = await file(valid);
    expect(Buffer.concat(await collect(streamZipMember(path, 'x'))).toString()).toBe('synthetic');
    const central = valid.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    valid.writeUInt32LE(123, central + 16);
    await expect(collect(streamZipMember(await file(valid), 'x'))).rejects.toMatchObject({ code: 'invalid_zip' });
  });
});
