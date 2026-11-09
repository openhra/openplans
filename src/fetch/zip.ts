import { open } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInflateRaw } from "node:zlib";
import type { FileHandle } from "node:fs/promises";
import { FetchError } from "./errors.js";

export interface ZipLimits {
  maxMembers?: number;
  maxUncompressedBytes?: number;
  maxExpansionRatio?: number;
  maxCompressedBytes?: number;
}
export interface ZipMember {
  name: string;
  compressedBytes: number;
  uncompressedBytes: number;
  compressionMethod: number;
}
export interface ZipInspection {
  members: ZipMember[];
  compressedBytes: number;
  uncompressedBytes: number;
}
const invalid = () =>
  new FetchError("invalid_zip", "Invalid or unsupported ZIP structure");
const bomb = () => new FetchError("zip_bomb", "ZIP exceeds archive limits");

async function read(
  file: FileHandle,
  position: number,
  length: number,
): Promise<Buffer> {
  if (
    !Number.isSafeInteger(position) ||
    position < 0 ||
    !Number.isSafeInteger(length) ||
    length < 0
  )
    throw invalid();
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await file.read(buffer, 0, length, position);
  if (bytesRead !== length) throw invalid();
  return buffer;
}
function safeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw bomb();
  return Number(value);
}
function checkPath(name: string): void {
  if (
    !name ||
    name.includes("\0") ||
    name.startsWith("/") ||
    name.startsWith("\\") ||
    /^[a-z]:/i.test(name) ||
    name.split(/[\\/]/).includes("..")
  ) {
    throw new FetchError("zip_path_traversal", "ZIP member has an unsafe path");
  }
}
function extraFields(extra: Buffer): Map<number, Buffer> {
  const fields = new Map<number, Buffer>();
  for (let position = 0; position < extra.length;) {
    if (position + 4 > extra.length) throw invalid();
    const tag = extra.readUInt16LE(position);
    const length = extra.readUInt16LE(position + 2);
    position += 4;
    if (position + length > extra.length || fields.has(tag)) throw invalid();
    fields.set(tag, extra.subarray(position, position + length));
    position += length;
  }
  return fields;
}

/** Metadata inspection only; no members are inflated or extracted. ZIP64 is supported. */
async function inspectArchive(
  path: string,
  limits: ZipLimits = {},
  locations?: Map<string, { start: number; crc: number }>,
): Promise<ZipInspection> {
  const maxMembers = limits.maxMembers ?? 10_000;
  const maxUncompressed = limits.maxUncompressedBytes ?? 8 * 1024 ** 3;
  const maxRatio = limits.maxExpansionRatio ?? 200;
  const maxCompressed = limits.maxCompressedBytes ?? 1024 ** 3;
  if (
    ![maxMembers, maxUncompressed, maxRatio, maxCompressed].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  ) {
    throw new FetchError(
      "invalid_options",
      "ZIP limits must be finite and positive",
    );
  }
  let file: FileHandle | undefined;
  try {
    file = await open(path, "r");
    const size = (await file.stat()).size;
    if (size > maxCompressed) throw bomb();
    if (size < 22) throw invalid();
    const tail = await read(
      file,
      Math.max(0, size - 65_557),
      Math.min(size, 65_557),
    );
    let end = -1;
    for (let index = tail.length - 22; index >= 0; index--) {
      if (
        tail.readUInt32LE(index) === 0x06054b50 &&
        index + 22 + tail.readUInt16LE(index + 20) === tail.length
      ) {
        end = index;
        break;
      }
    }
    if (end < 0) throw invalid();
    const endPosition = size - tail.length + end;
    const eocd = tail.subarray(end);
    if (
      eocd.readUInt16LE(4) ||
      eocd.readUInt16LE(6) ||
      eocd.readUInt16LE(8) !== eocd.readUInt16LE(10)
    )
      throw invalid();
    let count = eocd.readUInt16LE(10);
    let directorySize = eocd.readUInt32LE(12);
    let directoryOffset = eocd.readUInt32LE(16);
    let directoryEndLimit = endPosition;
    if (
      count === 0xffff ||
      directorySize === 0xffffffff ||
      directoryOffset === 0xffffffff
    ) {
      const locator = await read(file, endPosition - 20, 20);
      if (
        locator.readUInt32LE(0) !== 0x07064b50 ||
        locator.readUInt32LE(4) ||
        locator.readUInt32LE(16) !== 1
      )
        throw invalid();
      const zip64Position = safeNumber(locator.readBigUInt64LE(8));
      const zip64 = await read(file, zip64Position, 56);
      const recordSize = safeNumber(zip64.readBigUInt64LE(4));
      if (
        zip64.readUInt32LE(0) !== 0x06064b50 ||
        recordSize < 44 ||
        zip64Position + 12 + recordSize !== endPosition - 20 ||
        zip64.readUInt32LE(16) ||
        zip64.readUInt32LE(20) ||
        zip64.readBigUInt64LE(24) !== zip64.readBigUInt64LE(32)
      )
        throw invalid();
      count = safeNumber(zip64.readBigUInt64LE(32));
      directorySize = safeNumber(zip64.readBigUInt64LE(40));
      directoryOffset = safeNumber(zip64.readBigUInt64LE(48));
      directoryEndLimit = zip64Position;
    }
    if (count > maxMembers) throw bomb();
    if (directoryOffset + directorySize !== directoryEndLimit) throw invalid();
    let position = directoryOffset;
    let totalCompressed = 0;
    let totalUncompressed = 0;
    const members: ZipMember[] = [];
    const names = new Set<string>();
    for (let index = 0; index < count; index++) {
      if (position + 46 > directoryEndLimit) throw invalid();
      const header = await read(file, position, 46);
      if (header.readUInt32LE(0) !== 0x02014b50) throw invalid();
      const nameLength = header.readUInt16LE(28);
      const extraLength = header.readUInt16LE(30);
      const commentLength = header.readUInt16LE(32);
      if (
        position + 46 + nameLength + extraLength + commentLength >
        directoryEndLimit
      )
        throw invalid();
      const nameBuffer = await read(file, position + 46, nameLength);
      const name = nameBuffer.toString("utf8");
      checkPath(name);
      if (names.has(name)) throw invalid();
      names.add(name);
      const extra = extraFields(
        await read(file, position + 46 + nameLength, extraLength),
      );
      const unicodeName = extra.get(0x7075);
      if (unicodeName) {
        if (unicodeName.length < 5) throw invalid();
        checkPath(unicodeName.subarray(5).toString("utf8"));
      }
      const mode = header.readUInt32LE(38) >>> 16;
      if ((mode & 0xf000) === 0xa000)
        throw new FetchError("zip_symlink", "ZIP symbolic links are forbidden");
      if (header.readUInt16LE(8) & 1) throw invalid(); // Encrypted archives cannot be inspected safely.
      let uncompressed = header.readUInt32LE(24);
      let compressed = header.readUInt32LE(20);
      let localOffset = header.readUInt32LE(42);
      const disk = header.readUInt16LE(34);
      if (disk !== 0 && disk !== 0xffff) throw invalid();
      if (
        uncompressed === 0xffffffff ||
        compressed === 0xffffffff ||
        localOffset === 0xffffffff ||
        disk === 0xffff
      ) {
        const extended = extra.get(1);
        let offset = 0;
        const next = () => {
          if (!extended || offset + 8 > extended.length) throw invalid();
          const value = safeNumber(extended.readBigUInt64LE(offset));
          offset += 8;
          return value;
        };
        if (uncompressed === 0xffffffff) uncompressed = next();
        if (compressed === 0xffffffff) compressed = next();
        if (localOffset === 0xffffffff) localOffset = next();
        if (
          disk === 0xffff &&
          (!extended ||
            offset + 4 > extended.length ||
            extended.readUInt32LE(offset))
        )
          throw invalid();
      } else if (disk) throw invalid();
      totalCompressed += compressed;
      totalUncompressed += uncompressed;
      if (
        !Number.isSafeInteger(totalUncompressed) ||
        totalUncompressed > maxUncompressed ||
        uncompressed > maxRatio * compressed ||
        totalCompressed > maxCompressed
      )
        throw bomb();
      if (localOffset + 30 > directoryOffset) throw invalid();
      const local = await read(file, localOffset, 30);
      if (
        local.readUInt32LE(0) !== 0x04034b50 ||
        local.readUInt16LE(6) !== header.readUInt16LE(8) ||
        local.readUInt16LE(8) !== header.readUInt16LE(10) ||
        local.readUInt16LE(26) !== nameLength
      )
        throw invalid();
      const localName = await read(file, localOffset + 30, nameLength);
      if (
        !localName.equals(nameBuffer) ||
        localOffset + 30 + nameLength + local.readUInt16LE(28) + compressed >
          directoryOffset
      )
        throw invalid();
      locations?.set(name, {
        start: localOffset + 30 + nameLength + local.readUInt16LE(28),
        crc: header.readUInt32LE(16),
      });
      members.push({
        name,
        compressedBytes: compressed,
        uncompressedBytes: uncompressed,
        compressionMethod: header.readUInt16LE(10),
      });
      position += 46 + nameLength + extraLength + commentLength;
    }
    if (
      position !== directoryOffset + directorySize ||
      totalUncompressed > maxRatio * totalCompressed
    )
      throw invalid();
    return {
      members,
      compressedBytes: totalCompressed,
      uncompressedBytes: totalUncompressed,
    };
  } catch (error) {
    if (error instanceof FetchError) throw error;
    throw invalid();
  } finally {
    await file?.close();
  }
}

/** Metadata-only inspection; use streamZipMember for bounded, verified inflation. */
export async function inspectZip(
  path: string,
  limits: ZipLimits = {},
): Promise<ZipInspection> {
  return inspectArchive(path, limits);
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++)
    crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc >>> 0;
});

/** Streams a ZIP member without trusting its declared inflated size. Consumers must exhaust
 * the iterator for size/CRC verification; early cancellation always closes both streams. */
export async function* streamZipMember(
  path: string,
  name: string,
  limits: ZipLimits = {},
): AsyncGenerator<Buffer> {
  const locations = new Map<string, { start: number; crc: number }>();
  const inspection = await inspectArchive(path, limits, locations);
  const member = inspection.members.find((value) => value.name === name);
  const location = locations.get(name);
  if (!member || !location || ![0, 8].includes(member.compressionMethod))
    throw invalid();
  if (!member.compressedBytes) {
    if (member.uncompressedBytes || location.crc) throw invalid();
    return;
  }
  const source = createReadStream(path, {
    start: location.start,
    end: location.start + member.compressedBytes - 1,
    highWaterMark: 64 * 1024,
  });
  const inflate =
    member.compressionMethod === 8
      ? createInflateRaw({ chunkSize: 64 * 1024 })
      : undefined;
  const stream = inflate ? source.pipe(inflate) : source;
  source.on("error", (error) => stream.destroy(error));
  let bytes = 0,
    crc = 0xffffffff;
  try {
    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      bytes += buffer.length;
      // Neither central-directory nor local-header size claims can bypass these limits.
      if (
        bytes > (limits.maxUncompressedBytes ?? 8 * 1024 ** 3) ||
        bytes >
          Math.max(1, inflate?.bytesWritten ?? bytes) *
            (limits.maxExpansionRatio ?? 200)
      )
        throw bomb();
      for (const byte of buffer)
        crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]!;
      yield buffer;
    }
    if (
      bytes !== member.uncompressedBytes ||
      (crc ^ 0xffffffff) >>> 0 !== location.crc ||
      (inflate && inflate.bytesWritten !== member.compressedBytes)
    )
      throw invalid();
  } catch (error) {
    if (error instanceof FetchError) throw error;
    throw invalid();
  } finally {
    stream.destroy();
    source.destroy();
  }
}
