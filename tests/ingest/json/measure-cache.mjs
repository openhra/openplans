import { homedir } from 'node:os';
// Read-only structural census of cached TX QHP children; no record bodies or URLs printed.
// Run: node tests/ingest/json/measure-cache.mjs /absolute/data/cache
import { createReadStream } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function measure(path) {
  let position = 0, depth = 0, maxDepth = 0, inString = false, escaped = false;
  let recordStart = -1, stringStart = -1, maxRecordBytes = 0, maxStringBytes = 0, records = 0;
  let root = false, closed = false;
  const endRecord = end => {
    if (recordStart < 0) return;
    maxRecordBytes = Math.max(maxRecordBytes, end - recordStart);
    records++; recordStart = -1;
  };
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 ** 2 })) {
    for (let i = 0; i < chunk.length; i++, position++) {
      const c = chunk[i];
      if (!root) {
        if (c === 32 || c === 10 || c === 13 || c === 9) continue;
        if (c !== 91) return { skipped: 'not_root_array' };
        root = true; depth = maxDepth = 1; continue;
      }
      if (inString) {
        if (escaped) escaped = false;
        else if (c === 92) escaped = true;
        else if (c === 34) {
          inString = false;
          maxStringBytes = Math.max(maxStringBytes, position + 1 - stringStart);
          if (depth === 1) endRecord(position + 1);
        }
        continue;
      }
      if (depth === 1 && recordStart < 0 && ![32, 10, 13, 9, 44, 93].includes(c)) recordStart = position;
      if (c === 34) { inString = true; stringStart = position; }
      else if (c === 91 || c === 123) { depth++; if (depth > maxDepth) maxDepth = depth; }
      else if (c === 93 || c === 125) {
        if (depth === 1) { endRecord(position); closed = true; }
        depth--;
        if (depth === 1) endRecord(position + 1);
      } else if (depth === 1 && (c === 44 || c === 32 || c === 10 || c === 13 || c === 9)) endRecord(position);
    }
  }
  return { bytes: position, maxDepth, maxRecordBytes, maxStringBytes, records, incomplete: !closed || inString || depth !== 0 };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const raw = join(process.argv[2] ?? process.env.OPENPLANS_DATA_DIR ?? join(homedir(), '.local', 'share', 'openplans'), 'raw');
  const seen = new Set(), summary = {};
  for (const source of (await readdir(raw)).sort()) {
    const kind = ['provider_urls', 'formulary_urls'].find(k => source.startsWith('qhp-') && source.includes(k));
    if (!kind) continue;
    const total = summary[kind] ??= { files: 0, bytes: 0, records: 0, incomplete: 0, skipped: 0, maxDepth: 0, maxRecordBytes: 0, maxStringBytes: 0, maxima: {} };
    for (const entry of (await readdir(join(raw, source), { withFileTypes: true })).filter(e => e.isDirectory()).sort((a,b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue;
      const path = join(raw, source, entry.name);
      const meta = JSON.parse(await readFile(join(path, 'meta.json'), 'utf8'));
      const key = `${kind}:${meta.sha256}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const result = await measure(join(path, 'payload'));
      if (result.skipped) { total.skipped++; continue; }
      total.files++; total.bytes += result.bytes; total.records += result.records; total.incomplete += Number(result.incomplete);
      for (const field of ['maxDepth', 'maxRecordBytes', 'maxStringBytes']) if (result[field] > total[field]) {
        total[field] = result[field]; total.maxima[field] = { source, sha256: meta.sha256 };
      }
      if (total.files % 25 === 0) process.stderr.write(`${kind}: ${total.files} files, ${total.bytes} bytes scanned\n`);
    }
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}
