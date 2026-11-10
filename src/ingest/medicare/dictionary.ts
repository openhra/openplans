import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { inspectZip, streamZipMember } from "../../fetch/index.js";
import type { ZipLimits } from "../../fetch/index.js";
import { readXlsxRows } from "../xlsx/index.js";

export interface DictionaryField {
  table: string;
  field: string;
  dataType: string;
  title: string;
  codes: Record<string, string>;
}

const expectedHeader = ["FILE", "NAME", "TYPE", "LENGTH"];

/** Parses PBP dictionary rows: a field row, then continuation rows that add one code each. */
export function dictionaryFields(rows: Iterable<string[]>): DictionaryField[] {
  const fields = new Map<string, DictionaryField>();
  let header: string[] | undefined;
  for (const row of rows) {
    if (!header) {
      header = row.map((cell) => cell.trim().toUpperCase());
      if (expectedHeader.some((name, i) => header![i] !== name))
        throw new Error("PBP dictionary header changed");
      continue;
    }
    const cell = (name: string) => (row[header!.indexOf(name)] ?? "").trim();
    const table = cell("FILE").toLowerCase(),
      field = cell("NAME").toLowerCase();
    if (!table || !field) continue;
    const key = `${table}\u0000${field}`;
    let entry = fields.get(key);
    if (!entry) {
      entry = {
        table,
        field,
        dataType: cell("TYPE"),
        title: cell("FIELD_TITLE") || cell("TITLE"),
        codes: {},
      };
      fields.set(key, entry);
    }
    const code = cell("CODES"),
      label = cell("CODE_VALUES");
    if (code && label && !Object.hasOwn(entry.codes, code))
      entry.codes[code] = label;
  }
  if (!header) throw new Error("Empty PBP dictionary");
  return [...fields.values()];
}

/** Copies the nested dictionary workbook to a private temp file and reads its first sheet. */
export async function readDictionary(
  archive: string,
  limits: ZipLimits,
): Promise<DictionaryField[]> {
  const member = (await inspectZip(archive, limits)).members.find((entry) =>
    /^PBP_Benefits_\d{4}_dictionary\.xlsx$/i.test(entry.name),
  );
  if (!member) return [];
  const directory = await mkdtemp(join(tmpdir(), "openplans-pbp-dictionary-"));
  try {
    const path = join(directory, "dictionary.xlsx");
    await pipeline(
      Readable.from(streamZipMember(archive, member.name, limits)),
      createWriteStream(path, { flags: "wx" }),
    );
    const rows: string[][] = [];
    for await (const row of readXlsxRows(path, { maxRows: 200_000 }))
      rows.push(row);
    return dictionaryFields(rows);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
