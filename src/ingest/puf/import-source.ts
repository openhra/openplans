import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createInflateRaw } from 'node:zlib';
import { createInterface } from 'node:readline';
import { readCsv } from '../csv/index.js';
import type { CsvRow } from '../csv/index.js';
import { inspectPufArchive } from './acquire-archive.js';
import type { PufManifest } from './acquire.js';
import type { SnapshotMetadata } from '../../fetch/index.js';

export const IMPORT_KINDS = ['plan-attributes', 'service-area', 'network', 'business-rules', 'rate', 'benefits-and-cost-sharing'] as const;
export type ImportKind = typeof IMPORT_KINDS[number];
export interface ImportFile {
  kind: ImportKind;
  path: string;
  format: 'csv' | 'zip';
  sha256: string;
  bytes: number;
  retrievedAt: string;
  url: string;
  metadata?: SnapshotMetadata;
  /** Internal, hash-verified temporary partition; original source identity is unchanged. */
  rowCache?: { path: string; sha256: string; bytes: number; count: number };
}
export const importDataDirectory = () => process.env.OPENPLANS_DATA_DIR ?? join(homedir(), '.local', 'share', 'openplans');

/** Reads only the newest acquired manifest. Never downloads or falls back to older publications. */
export async function cachedImportFiles(dataDir: string, year: number): Promise<{ files: ImportFile[]; manifestPath: string }> {
  if (!isAbsolute(dataDir)) throw new Error('An absolute data directory is required');
  const directory = join(dataDir, 'raw', 'cms-exchange-puf');
  const name = (await readdir(directory)).filter(name => /^manifest-.*\.json$/.test(name)).sort().at(-1);
  if (!name) throw new Error('No acquired PUF manifest');
  const manifestPath = join(directory, name);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as PufManifest;
  if (manifest.schema_version !== 1 || manifest.dry_run) throw new Error('Invalid PUF manifest');
  const files: ImportFile[] = [];
  for (const kind of IMPORT_KINDS) {
    const candidates = manifest.files.filter(file => file.year === year && file.kind === kind);
    const file = candidates[0];
    if (candidates.length !== 1 || !file || file.status !== 'ok' || !file.snapshot_id
      || !/^[a-f0-9]{64}$/.test(file.snapshot_id) || file.sha256 !== file.snapshot_id || !file.url) {
      throw new Error('Incomplete acquired PUF source set');
    }
    const path = join(directory, file.snapshot_id, 'payload');
    const metadata = JSON.parse(await readFile(join(directory, `${file.snapshot_id}.meta.json`), 'utf8')) as SnapshotMetadata;
    if (metadata.sha256 !== file.sha256 || metadata.url !== file.url || metadata.bytes !== file.bytes) throw new Error('Manifest metadata mismatch');
    files.push({ kind, path, format: 'zip', sha256: file.sha256, bytes: file.bytes!, retrievedAt: metadata.fetched_at,
      url: file.url, metadata });
  }
  return { files, manifestPath };
}

export async function verifyImportFile(file: ImportFile): Promise<void> {
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(file.path)) { hash.update(chunk); bytes += chunk.length; }
  if (hash.digest('hex') !== file.sha256 || bytes !== file.bytes) throw new Error('PUF bytes differ from acquisition hash');
  if (file.rowCache) {
    const hash = createHash('sha256'); let bytes = 0;
    for await (const chunk of createReadStream(file.rowCache.path)) { hash.update(chunk); bytes += chunk.length; }
    if (hash.digest('hex') !== file.rowCache.sha256 || bytes !== file.rowCache.bytes) throw new Error('PUF partition integrity failed');
  }
}

/** CMS's observed archives contain one CSV local member. Fail closed on a changed archive layout. */
export async function* importRows(file: ImportFile): AsyncGenerator<CsvRow> {
  if (file.rowCache) {
    const input = createReadStream(file.rowCache.path);
    const lines = createInterface({ input, crlfDelay: Infinity });
    try { for await (const line of lines) yield JSON.parse(line) as CsvRow; }
    finally { lines.close(); input.destroy(); }
    return;
  }
  if (file.format === 'csv') { yield* readCsv(createReadStream(file.path)); return; }
  const members = await inspectPufArchive(file.path);
  const member = members[0];
  if (members.length !== 1 || !member || member.format !== 'csv' || ![0, 8].includes(member.compressionMethod)) {
    throw new Error('PUF import requires a single CSV archive member');
  }
  const handle = await open(file.path, 'r');
  let start: number;
  try {
    const header = Buffer.alloc(30);
    if ((await handle.read(header, 0, 30, 0)).bytesRead !== 30 || header.readUInt32LE(0) !== 0x04034b50) throw new Error('Invalid local ZIP header');
    const name = Buffer.alloc(header.readUInt16LE(26));
    await handle.read(name, 0, name.length, 30);
    if (name.toString('utf8') !== member.name) throw new Error('Changed ZIP member layout');
    start = 30 + name.length + header.readUInt16LE(28);
  } finally { await handle.close(); }
  const source = createReadStream(file.path, { start, end: start + member.compressedBytes - 1 });
  const stream = member.compressionMethod === 8 ? source.pipe(createInflateRaw()) : source;
  source.on('error', error => stream.destroy(error));
  try { yield* readCsv(stream); } finally { stream.destroy(); source.destroy(); }
}
