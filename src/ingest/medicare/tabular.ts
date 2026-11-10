import { streamZipMember } from "../../fetch/index.js";
import type { ZipLimits } from "../../fetch/index.js";

export type TextEncoding = "utf-8" | "windows-1252";

/** Streams one archive member as text; CMS PBP tables are Windows-1252, Landscape is UTF-8. */
export async function* memberText(
  path: string,
  member: string,
  limits: ZipLimits,
  encoding: TextEncoding,
): AsyncGenerator<string> {
  const decoder = new TextDecoder(encoding, { fatal: encoding === "utf-8" });
  for await (const chunk of streamZipMember(path, member, limits))
    yield decoder.decode(chunk, { stream: true });
  const tail = decoder.decode();
  if (tail) yield tail;
}

export interface TabRow {
  /** 1-based physical line, the header is line 1. */
  rowNumber: number;
  fields: string[];
}
export interface TabTable {
  header: string[];
  rows: AsyncGenerator<TabRow>;
}

/**
 * Unquoted delimited text (PBP `.txt`, crosswalk). Every record must have the header's field count;
 * a quote character or a short record is a layout change and stops the import.
 */
export async function tabTable(
  input: AsyncIterable<string>,
  delimiter = "\t",
  maxLine = 1024 * 1024,
  /** Some unquoted files carry literal quotes in names (the plan crosswalk). */
  literalQuotes = false,
): Promise<TabTable> {
  const iterator = lines(input, maxLine)[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) throw new Error("Empty delimited member");
  const header = first.value.replace(/^\uFEFF/, "").split(delimiter);
  async function* rows(): AsyncGenerator<TabRow> {
    let rowNumber = 1;
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
      rowNumber++;
      if (next.value === "") continue;
      if (!literalQuotes && next.value.includes('"'))
        throw new Error(`Quoted field at line ${rowNumber}`);
      const fields = next.value.split(delimiter);
      if (fields.length !== header.length)
        throw new Error(`Field count differs from header at line ${rowNumber}`);
      yield { rowNumber, fields };
    }
  }
  return { header, rows: rows() };
}

async function* lines(
  input: AsyncIterable<string>,
  maxLine: number,
): AsyncGenerator<string> {
  let buffer = "";
  for await (const chunk of input) {
    buffer += chunk;
    let at: number;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      yield line.endsWith("\r") ? line.slice(0, -1) : line;
    }
    if (buffer.length > maxLine) throw new Error("Delimited record too long");
  }
  if (buffer) yield buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
}

/**
 * Maps a header with repeated names to one value per name. A repeated name is accepted only when
 * every copy carries the same value on the row (PBP layouts list `segment_id` twice, for example).
 */
export function namedFields(
  header: readonly string[],
  fields: readonly string[],
  rowNumber: number,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < header.length; i++) {
    const name = header[i]!.trim().toLowerCase();
    const value = fields[i] ?? "";
    if (Object.hasOwn(out, name) && out[name] !== value)
      throw new Error(`Repeated column ${name} differs at line ${rowNumber}`);
    out[name] = value;
  }
  return out;
}
