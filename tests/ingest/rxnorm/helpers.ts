import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { rrfFiles } from "../../../src/ingest/rxnorm/rrf.js";
import type { RrfFile, RrfInput } from "../../../src/ingest/rxnorm/rrf.js";
import type { SnapshotMetadata } from "../../../src/fetch/index.js";

export const fixtureDirectory = fileURLToPath(
  new URL("../../fixtures/rxnorm/", import.meta.url),
);
export type Fixture = Record<RrfFile, string>;
export async function fixture(): Promise<Fixture> {
  return Object.fromEntries(
    await Promise.all(
      rrfFiles.map(async (name) => [
        name,
        await readFile(join(fixtureDirectory, name), "utf8"),
      ]),
    ),
  ) as Fixture;
}
export function input(files: Fixture): RrfInput {
  return async function* (name) {
    const bytes = Buffer.from(files[name]);
    for (let at = 0; at < bytes.length; at += 37)
      yield bytes.subarray(at, at + 37);
  };
}
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
/** Small valid ZIP, stored members, built in memory only for bounded fixtures. */
export function zip(files: Record<string, string>): Buffer {
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const bytes = Buffer.from(text),
      filename = Buffer.from(`prescribe/rrf/${name}`),
      crc = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, bytes);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(bytes.length, 20);
    entry.writeUInt32LE(bytes.length, 24);
    entry.writeUInt16LE(filename.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, filename);
    offset += header.length + filename.length + bytes.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
export function metadata(bytes: Buffer): SnapshotMetadata {
  return {
    source: "nlm-rxnorm-prescribe",
    snapshot_id: createHash("sha256").update(bytes).digest("hex"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    url: "https://download.nlm.nih.gov/rxnorm/RxNorm_full_prescribe_11022026.zip",
    final_url:
      "https://download.nlm.nih.gov/rxnorm/RxNorm_full_prescribe_11022026.zip",
    redirect_chain: [],
    status: 200,
    content_type: "application/zip",
    etag: null,
    last_modified: null,
    fetched_at: "2026-11-07T00:00:00Z",
  };
}
