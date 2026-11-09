import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { createInflateRaw } from "node:zlib";
import { FetchError, inspectZip } from "../../fetch/index.js";
import type { ZipMember } from "../../fetch/index.js";

export interface AcquiredMember extends ZipMember {
  format: "csv" | "xlsx" | "other";
  header: string[] | null;
  issues: string[];
}

const invalid = () =>
  new FetchError("invalid_zip", "Cannot read ZIP member header");
async function read(
  file: FileHandle,
  position: number,
  length: number,
): Promise<Buffer> {
  if (!Number.isSafeInteger(position) || position < 0) throw invalid();
  const result = Buffer.alloc(length);
  if ((await file.read(result, 0, length, position)).bytesRead !== length)
    throw invalid();
  return result;
}
function integer(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid();
  return Number(value);
}

// inspectZip validates the structure first. Read central offsets separately because its public
// member description deliberately exposes no extraction API. Supports ZIP64 member offsets.
async function memberOffsets(
  file: FileHandle,
  count: number,
): Promise<Map<string, number>> {
  const size = (await file.stat()).size;
  const tail = await read(
    file,
    Math.max(0, size - 65_557),
    Math.min(size, 65_557),
  );
  let end = tail.length - 22;
  while (
    end >= 0 &&
    !(
      tail.readUInt32LE(end) === 0x06054b50 &&
      end + 22 + tail.readUInt16LE(end + 20) === tail.length
    )
  )
    end--;
  if (end < 0) throw invalid();
  let position = tail.readUInt32LE(end + 16);
  if (position === 0xffffffff) {
    const locator = await read(file, size - tail.length + end - 20, 20);
    const zip64 = await read(file, integer(locator.readBigUInt64LE(8)), 56);
    position = integer(zip64.readBigUInt64LE(48));
  }
  const offsets = new Map<string, number>();
  for (let index = 0; index < count; index++) {
    const header = await read(file, position, 46);
    const nameLength = header.readUInt16LE(28);
    const extraLength = header.readUInt16LE(30);
    const name = (await read(file, position + 46, nameLength)).toString("utf8");
    let offset = header.readUInt32LE(42);
    if (offset === 0xffffffff) {
      const extra = await read(file, position + 46 + nameLength, extraLength);
      let found = false;
      for (let at = 0; at + 4 <= extra.length;) {
        const tag = extra.readUInt16LE(at);
        const length = extra.readUInt16LE(at + 2);
        if (tag === 1) {
          const skip =
            (header.readUInt32LE(24) === 0xffffffff ? 8 : 0) +
            (header.readUInt32LE(20) === 0xffffffff ? 8 : 0);
          if (skip + 8 > length) throw invalid();
          offset = integer(extra.readBigUInt64LE(at + 4 + skip));
          found = true;
          break;
        }
        at += 4 + length;
      }
      if (!found) throw invalid();
    }
    if (offsets.has(name)) throw invalid();
    offsets.set(name, offset);
    position += 46 + nameLength + extraLength + header.readUInt16LE(32);
  }
  return offsets;
}

/** One physical CSV header line, including quoted comma/escaped quote handling. */
export function parsePufHeader(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  let closedQuote = false;
  const text = line.replace(/^\uFEFF/, "").replace(/\r$/, "");
  for (let at = 0; at < text.length; at++) {
    const char = text[at]!;
    if (char === '"') {
      if (quoted && text[at + 1] === '"') {
        field += '"';
        at++;
      } else if (quoted) {
        quoted = false;
        closedQuote = true;
      } else if (field === "" && !closedQuote) quoted = true;
      else throw invalid();
    } else if (char === "," && !quoted) {
      fields.push(field);
      field = "";
      closedQuote = false;
    } else {
      if (closedQuote) throw invalid();
      field += char;
    }
  }
  if (quoted) throw invalid();
  fields.push(field);
  return fields;
}

async function csvHeader(
  path: string,
  file: FileHandle,
  member: ZipMember,
  offset: number,
): Promise<string[]> {
  if (![0, 8].includes(member.compressionMethod)) throw invalid();
  if (member.uncompressedBytes === 0) return [];
  if (!member.compressedBytes) throw invalid();
  const local = await read(file, offset, 30);
  const start = offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  const source = createReadStream(path, {
    start,
    end: start + member.compressedBytes - 1,
    highWaterMark: 4096,
  });
  const stream =
    member.compressionMethod === 8
      ? source.pipe(createInflateRaw({ chunkSize: 4096 }))
      : source;
  source.on("error", (error) => stream.destroy(error));
  let prefix = Buffer.alloc(0);
  try {
    for await (const chunk of stream) {
      const bytes = chunk as Buffer;
      const newline = bytes.indexOf(10);
      prefix = Buffer.concat([
        prefix,
        newline < 0 ? bytes : bytes.subarray(0, newline),
      ]);
      if (prefix.length > 64 * 1024)
        throw new FetchError("too_large", "CSV header exceeds byte limit");
      if (newline >= 0) return parsePufHeader(prefix.toString("utf8"));
    }
    return parsePufHeader(prefix.toString("utf8"));
  } finally {
    stream.destroy();
    source.destroy();
  }
}

/** No archive extraction: only bounded first-line inflation for CSV members. */
export async function inspectPufArchive(
  path: string,
): Promise<AcquiredMember[]> {
  const inspection = await inspectZip(path);
  const file = await open(path, "r");
  try {
    const offsets = await memberOffsets(file, inspection.members.length);
    const members: AcquiredMember[] = [];
    for (const member of inspection.members) {
      let format: AcquiredMember["format"];
      if (/\.csv$/i.test(member.name)) {
        format = "csv";
      } else if (/\.xlsx$/i.test(member.name)) {
        format = "xlsx";
      } else {
        format = "other";
      }
      const header =
        format === "csv"
          ? await csvHeader(path, file, member, offsets.get(member.name)!)
          : null;
      // Issuer-scoped Network/Service Area files legitimately lack plan IDs. This is a
      // schema observation, not a claim that those files are invalid or empty.
      const issues =
        header !== null &&
        !header.some((column) =>
          /^(?:PlanId|StandardComponentId)$/i.test(column),
        )
          ? ["missing_plan_identifier"]
          : [];
      members.push({ ...member, format, header, issues });
    }
    return members;
  } catch (error) {
    if (error instanceof FetchError) throw error;
    throw invalid();
  } finally {
    await file.close();
  }
}
