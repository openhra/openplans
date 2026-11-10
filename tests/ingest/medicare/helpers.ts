import { PGlite } from "@electric-sql/pglite";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { migrate } from "../../../src/db/migrate.js";
import type { Database } from "../../../src/db/database.js";
import type { Transport } from "../../../src/fetch/index.js";
import { acquireArchive } from "../../../src/ingest/medicare/acquire.js";
import { importMedicare } from "../../../src/ingest/medicare/command.js";
import { parseArchiveUrl } from "../../../src/ingest/medicare/sources.js";
import { coreMigrations, testDatabase } from "../../pglite.js";

export const fixtureDirectory = fileURLToPath(
  new URL("../../fixtures/medicare/", import.meta.url),
);

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Small stored ZIP built in memory from fixture members. */
export function zip(files: Record<string, Buffer>): Buffer {
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const [name, bytes] of Object.entries(files)) {
    const filename = Buffer.from(name),
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
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(bytes.length, 20);
    entry.writeUInt32LE(bytes.length, 24);
    entry.writeUInt16LE(filename.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, filename);
    offset += header.length + filename.length + bytes.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

const escape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function column(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}
/** Minimal one-sheet workbook with inline strings, for TSV subsets of published workbooks. */
export function xlsx(rows: string[][]): Buffer {
  const sheet = rows
    .map(
      (row, r) =>
        `<row r="${r + 1}">${row
          .map((cell, c) =>
            cell === ""
              ? ""
              : `<c r="${column(c)}${r + 1}" t="inlineStr"><is><t>${escape(cell)}</t></is></c>`,
          )
          .join("")}</row>`,
    )
    .join("");
  return zip({
    "xl/workbook.xml": Buffer.from(
      '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    ),
    "xl/_rels/workbook.xml.rels": Buffer.from(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    ),
    "xl/worksheets/sheet1.xml": Buffer.from(
      `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheet}</sheetData></worksheet>`,
    ),
  });
}

const tsv = (text: string) =>
  text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.split("\t"));

async function members(
  directory: string,
  prefix = "",
): Promise<Record<string, Buffer>> {
  const out: Record<string, Buffer> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      Object.assign(out, await members(path, `${prefix}${entry.name}/`));
    else out[`${prefix}${entry.name}`] = await readFile(path);
  }
  return out;
}

export type Mutate = (family: string, files: Record<string, Buffer>) => void;

/** Fixture archives keyed by their real CMS URL; `mutate` edits members before zipping. */
export async function fixtureArchives(
  mutate?: Mutate,
): Promise<Map<string, Buffer>> {
  const f = (path: string) => join(fixtureDirectory, path);
  const pbp = await members(f("pbp"));
  const dictionary = pbp["dictionary.tsv"]!;
  delete pbp["dictionary.tsv"];
  pbp["PBP_Benefits_2026_dictionary.xlsx"] = xlsx(
    tsv(dictionary.toString("utf8")),
  );
  const stars = {
    "Master Tables Individual Files 8 17 26/2026 Star Ratings Data Table - Summary Ratings (July 22 2026).xlsx":
      xlsx(tsv((await readFile(f("stars/summary.tsv"))).toString("utf8"))),
  };
  const sets: [string, string, Record<string, Buffer>][] = [
    [
      "landscape",
      "https://www.cms.gov/files/zip/cy2026-landscape-202609.zip",
      await members(f("landscape")),
    ],
    ["pbp", "https://www.cms.gov/files/zip/pbp-benefits-2026.zip", pbp],
    [
      "stars",
      "https://www.cms.gov/files/zip/2026-star-ratings-data-tables.zip",
      stars,
    ],
    [
      "crosswalk",
      "https://www.cms.gov/files/zip/plan-crosswalk-2026.zip",
      await members(f("crosswalk")),
    ],
    [
      "pdp",
      "https://www.cms.gov/files/zip/pdp-contract-service-area-state-county-october-2026.zip",
      await members(f("service-area/pdp")),
    ],
    [
      "ma",
      "https://www.cms.gov/files/zip/ma-contract-service-area-state-county-october-2026.zip",
      await members(f("service-area/ma")),
    ],
  ];
  const out = new Map<string, Buffer>();
  for (const [family, url, files] of sets) {
    mutate?.(family, files);
    out.set(url, zip(files));
  }
  return out;
}

export function fixtureTransport(
  archives: Map<string, Buffer>,
  calls: string[] = [],
): Transport {
  return async (url) => {
    calls.push(url.href);
    const body = archives.get(url.href);
    return body
      ? {
          status: 200,
          headers: { "content-type": "application/zip" },
          body: Readable.from([body]),
        }
      : { status: 404, headers: {}, body: Readable.from([]) };
  };
}
export const lookup = async () => [
  { address: "104.103.69.140", family: 4 as const },
];

/** Seeds a temp data cache through the real acquisition path (trusted offline transport). */
export async function seedCache(
  dataDir: string,
  mutate?: Mutate,
): Promise<void> {
  const archives = await fixtureArchives(mutate);
  for (const url of archives.keys())
    await acquireArchive(parseArchiveUrl(url)!, {
      dataDir,
      dependencies: { lookup, transport: fixtureTransport(archives) },
    });
}

export interface Loaded {
  db: Database;
  dataDir: string;
  cleanup(): Promise<void>;
}
export async function loadedDatabase(
  mutate?: Mutate,
  year = 2026,
): Promise<Loaded> {
  const migrations = await coreMigrations();
  const dataDir = await mkdtemp(join(tmpdir(), "medicare-cache-"));
  const db = testDatabase(new PGlite());
  await migrate(db, migrations.directory);
  await seedCache(dataDir, mutate);
  await importMedicare(db, { year }, dataDir);
  return {
    db,
    dataDir,
    cleanup: async () => {
      await db.close();
      await migrations.cleanup();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

export const spufUrl =
  "https://data.cms.gov/sites/default/files/2026-10/062e9434-ed9d-4e83-abbd-4d64eb375949/SPUF_2026_20261007.zip";

/** Quarterly Part D archive rebuilt as nested zips from the fixture cut; `mutate` edits a table. */
export async function spufArchive(
  mutate?: (outer: string, inner: Record<string, Buffer>) => void,
): Promise<Buffer> {
  const root = join(fixtureDirectory, "partd");
  const outer: Record<string, Buffer> = {};
  for (const name of (await readdir(root)).sort()) {
    const inner = await members(join(root, name));
    mutate?.(name, inner);
    outer[name] = zip(inner);
  }
  return zip(outer);
}
