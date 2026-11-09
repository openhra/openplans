import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { createInflateRaw } from "node:zlib";
import { inspectZip } from "../../fetch/index.js";
import { readRecords } from "../csv/index.js";

export const rrfFiles = ["RXNCONSO.RRF", "RXNREL.RRF", "RXNSAT.RRF"] as const;
export type RrfFile = (typeof rrfFiles)[number];
export type RrfInput = (name: RrfFile) => AsyncIterable<Uint8Array | string>;
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++)
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc32(bytes: Buffer, previous: number): number {
  let crc = previous ^ 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]!;
  return (crc ^ 0xffffffff) >>> 0;
}
const columns: Record<RrfFile, number> = {
  "RXNCONSO.RRF": 18,
  "RXNREL.RRF": 16,
  "RXNSAT.RRF": 13,
};

/** RRF has literal quotes, no CSV quoting. Escape each bounded physical line for the shared parser. */
async function* csvCompatible(
  input: AsyncIterable<Uint8Array | string>,
): AsyncGenerator<string> {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  function* lines(text: string, final = false): Generator<string> {
    pending += text;
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline).replace(/\r$/, "");
      pending = pending.slice(newline + 1);
      if (Buffer.byteLength(line) > 1024 * 1024)
        throw new Error("RRF record exceeds byte limit");
      yield line
        .split("|")
        .map((field) => `"${field.replaceAll('"', '""')}"`)
        .join("|") + "\n";
    }
    if (Buffer.byteLength(pending) > 1024 * 1024)
      throw new Error("RRF record exceeds byte limit");
    if (final && pending) {
      const last = pending;
      pending = "";
      yield* lines(last + "\n");
    }
  }
  for await (const chunk of input)
    yield* lines(
      typeof chunk === "string"
        ? decoder.end() + chunk
        : decoder.write(Buffer.from(chunk)),
    );
  yield* lines(decoder.end(), true);
}
export async function* rrfRecords(
  input: AsyncIterable<Uint8Array | string>,
  name: RrfFile,
): AsyncGenerator<string[]> {
  for await (const row of readRecords(csvCompatible(input), {
    delimiter: "|",
    maxRecordLength: 3 * 1024 * 1024,
  })) {
    if (row.fields.length !== columns[name] + 1 || row.fields.at(-1) !== "")
      throw new Error(`Invalid ${name} layout at row ${row.rowNumber}`);
    yield row.fields.slice(0, -1);
  }
}

/** Inspect all paths/ratios before streaming the three named files. No extraction or whole-file buffers. */
export async function archiveInput(path: string): Promise<RrfInput> {
  const inspection = await inspectZip(path, {
    maxUncompressedBytes: 4 * 1024 ** 3,
  });
  const handle = await open(path, "r");
  const entries = new Map<
    RrfFile,
    {
      start: number;
      compressed: number;
      size: number;
      method: number;
      crc: number;
    }
  >();
  try {
    const size = (await handle.stat()).size;
    const tail = Buffer.alloc(Math.min(size, 65557));
    await handle.read(tail, 0, tail.length, size - tail.length);
    let end = tail.length - 22;
    while (
      end >= 0 &&
      !(
        tail.readUInt32LE(end) === 0x06054b50 &&
        end + 22 + tail.readUInt16LE(end + 20) === tail.length
      )
    )
      end--;
    if (end < 0) throw new Error("Missing ZIP directory");
    let at = tail.readUInt32LE(end + 16);
    if (at === 0xffffffff) throw new Error("CPC ZIP64 layout unsupported");
    for (const member of inspection.members) {
      const header = Buffer.alloc(46);
      await handle.read(header, 0, 46, at);
      const offset = header.readUInt32LE(42);
      at +=
        46 +
        header.readUInt16LE(28) +
        header.readUInt16LE(30) +
        header.readUInt16LE(32);
      const name = member.name.split("/").at(-1) as RrfFile;
      if (!rrfFiles.includes(name)) continue;
      if (
        entries.has(name) ||
        offset === 0xffffffff ||
        ![0, 8].includes(member.compressionMethod)
      )
        throw new Error("Ambiguous/unsupported RRF archive");
      const local = Buffer.alloc(30);
      await handle.read(local, 0, 30, offset);
      entries.set(name, {
        start: offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28),
        compressed: member.compressedBytes,
        size: member.uncompressedBytes,
        method: member.compressionMethod,
        crc: header.readUInt32LE(16),
      });
    }
  } finally {
    await handle.close();
  }
  if (entries.size !== 3)
    throw new Error("CPC archive must contain all three RRF files");
  return async function* (name) {
    const entry = entries.get(name)!;
    if (!entry.size) return;
    const source = createReadStream(path, {
      start: entry.start,
      end: entry.start + entry.compressed - 1,
    });
    const stream =
      entry.method === 8 ? source.pipe(createInflateRaw()) : source;
    source.on("error", (error) => stream.destroy(error));
    let actual = 0,
      crc = 0;
    try {
      for await (const chunk of stream) {
        actual += (chunk as Buffer).length;
        if (actual > entry.size)
          throw new Error("RRF expanded beyond declared size");
        crc = crc32(chunk as Buffer, crc);
        yield chunk as Buffer;
      }
      if (actual !== entry.size) throw new Error("Truncated RRF member");
      if (crc !== entry.crc) throw new Error("RRF ZIP checksum mismatch");
    } finally {
      stream.destroy();
      source.destroy();
    }
  };
}
