import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { createInflateRaw } from "node:zlib";
import { createInterface } from "node:readline";
import {
  cachedFilePath,
  cachedNames,
  cachedPayloadPath,
  readCachedText,
  streamZipMember,
} from "../../fetch/index.js";
import { normalizeSbeRow } from "../sbe/normalize.js";
import { Readable } from "node:stream";
import { readCsv } from "../csv/index.js";
import type { CsvRow } from "../csv/index.js";
import { inspectPufArchive } from "./acquire-archive.js";
import type { PufManifest } from "./acquire.js";
import type { SnapshotMetadata } from "../../fetch/index.js";

export const IMPORT_KINDS = [
  "plan-attributes",
  "service-area",
  "network",
  "business-rules",
  "rate",
  "benefits-and-cost-sharing",
] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];
/** State-exchange catalog publications: CMS's SBE bundles and Georgia Access's own PUF CSVs. */
export const STATE_CATALOG_SOURCES = [
  "cms_sbe_puf",
  "georgia_access_puf",
] as const;
export type StateCatalogSource = (typeof STATE_CATALOG_SOURCES)[number];
export const isStateCatalogSource = (
  source: string | undefined,
): source is StateCatalogSource =>
  (STATE_CATALOG_SOURCES as readonly string[]).includes(source ?? "");
/** One identity for a set of separately published state CSVs, as Georgia Access issues. */
export function stateCatalogDigest(
  files: Pick<ImportFile, "kind" | "url" | "sha256">[],
): string {
  return createHash("sha256")
    .update(JSON.stringify(files.map((f) => [f.kind, f.url, f.sha256])))
    .digest("hex");
}
export interface ImportFile {
  kind: ImportKind;
  source?: StateCatalogSource;
  member?: string;
  path: string;
  format: "csv" | "zip";
  sha256: string;
  bytes: number;
  retrievedAt: string;
  url: string;
  metadata?: SnapshotMetadata;
  /** Internal, hash-verified temporary partition; original source identity is unchanged. */
  rowCache?: { path: string; sha256: string; bytes: number; count: number };
  /** Georgia Access only. Read unescaped quotes literally. Owner-gated, off by default. */
  recoverUnescapedQuotes?: boolean;
}
export const importDataDirectory = () =>
  process.env.OPENPLANS_DATA_DIR ??
  join(homedir(), ".local", "share", "openplans");

/** The newest acquired manifest. Never downloads or falls back to older publications. */
export async function newestPufManifest(
  dataDir: string,
): Promise<{ manifest: PufManifest; manifestPath: string; directory: string }> {
  if (!isAbsolute(dataDir))
    throw new Error("An absolute data directory is required");
  const directory = join(dataDir, "raw", "cms-exchange-puf");
  // Manifests live beside the snapshots they name, in the fetch cache's store (local or
  // remote). A remote manifest is copied down so `manifestPath` names a readable file.
  const name = (
    await cachedNames(dataDir, "cms-exchange-puf", { missing: "throw" })
  )
    .filter((name) => /^manifest-.*\.json$/.test(name))
    .sort()
    .at(-1);
  if (!name) throw new Error("No acquired PUF manifest");
  const manifestPath = await cachedFilePath(dataDir, "cms-exchange-puf", name);
  const manifest = JSON.parse(
    await readFile(manifestPath, "utf8"),
  ) as PufManifest;
  if (manifest.schema_version !== 1 || manifest.dry_run)
    throw new Error("Invalid PUF manifest");
  return { manifest, manifestPath, directory };
}

/** Exactly one hash-verified archive per year and kind, or the source set is incomplete. */
export async function manifestArchive(
  directory: string,
  manifest: PufManifest,
  year: number,
  kind: string,
): Promise<Omit<ImportFile, "kind">> {
  const candidates = manifest.files.filter(
    (file) => file.year === year && file.kind === kind,
  );
  const file = candidates[0];
  if (
    candidates.length !== 1 ||
    !file ||
    file.status !== "ok" ||
    !file.snapshot_id ||
    !/^[a-f0-9]{64}$/.test(file.snapshot_id) ||
    file.sha256 !== file.snapshot_id ||
    !file.url
  ) {
    throw new Error("Incomplete acquired PUF source set");
  }
  // `directory` is `<dataDir>/raw/<source>`, where the manifest lives. The snapshot it names is
  // read through the fetch cache's store, local or remote.
  const dataDir = dirname(dirname(directory));
  const source = basename(directory);
  const metadata = JSON.parse(
    await readCachedText(dataDir, source, `${file.snapshot_id}.meta.json`),
  ) as SnapshotMetadata;
  if (
    metadata.sha256 !== file.sha256 ||
    metadata.url !== file.url ||
    metadata.bytes !== file.bytes
  )
    throw new Error("Manifest metadata mismatch");
  return {
    path: await cachedPayloadPath(dataDir, source, file.snapshot_id, {
      bytes: file.bytes!,
      sha256: file.sha256,
    }),
    format: "zip",
    sha256: file.sha256,
    bytes: file.bytes!,
    retrievedAt: metadata.fetched_at,
    url: file.url,
    metadata,
  };
}

export async function cachedImportFiles(
  dataDir: string,
  year: number,
): Promise<{ files: ImportFile[]; manifestPath: string }> {
  const { manifest, manifestPath, directory } =
    await newestPufManifest(dataDir);
  const files: ImportFile[] = [];
  for (const kind of IMPORT_KINDS)
    files.push({
      kind,
      ...(await manifestArchive(directory, manifest, year, kind)),
    });
  return { files, manifestPath };
}

export async function verifyImportFile(
  file: Pick<ImportFile, "path" | "sha256" | "bytes" | "rowCache">,
): Promise<void> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(file.path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  if (hash.digest("hex") !== file.sha256 || bytes !== file.bytes)
    throw new Error("PUF bytes differ from acquisition hash");
  if (file.rowCache) {
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of createReadStream(file.rowCache.path)) {
      hash.update(chunk);
      bytes += chunk.length;
    }
    if (
      hash.digest("hex") !== file.rowCache.sha256 ||
      bytes !== file.rowCache.bytes
    )
      throw new Error("PUF partition integrity failed");
  }
}

/** CMS's observed archives contain one CSV local member. Fail closed on a changed archive layout. */
export async function* importRows(file: ImportFile): AsyncGenerator<CsvRow> {
  if (file.rowCache) {
    const input = createReadStream(file.rowCache.path);
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) yield JSON.parse(line) as CsvRow;
    } finally {
      lines.close();
      input.destroy();
    }
    return;
  }
  if (isStateCatalogSource(file.source)) {
    const stream =
      file.format === "csv"
        ? createReadStream(file.path)
        : Readable.from(streamZipMember(file.path, file.member!));
    // Georgia Access ends benefit, network and rule rows with one trailing comma.
    const georgia = file.source === "georgia_access_puf";
    try {
      for await (const row of readCsv(stream, {
        trailingEmptyField: georgia,
        recoverUnescapedQuotes: georgia && file.recoverUnescapedQuotes === true,
      }))
        yield normalizeSbeRow(file.kind, row);
    } finally {
      stream.destroy();
    }
    return;
  }
  if (file.format === "csv") {
    yield* readCsv(createReadStream(file.path));
    return;
  }
  yield* csvArchiveRows(file.path);
}

/** Streams the single CSV member of an acquired CMS archive. */
export async function* csvArchiveRows(path: string): AsyncGenerator<CsvRow> {
  const members = await inspectPufArchive(path);
  const member = members[0];
  if (
    members.length !== 1 ||
    !member ||
    member.format !== "csv" ||
    ![0, 8].includes(member.compressionMethod)
  ) {
    throw new Error("PUF import requires a single CSV archive member");
  }
  const handle = await open(path, "r");
  let start: number;
  try {
    const header = Buffer.alloc(30);
    if (
      (await handle.read(header, 0, 30, 0)).bytesRead !== 30 ||
      header.readUInt32LE(0) !== 0x04034b50
    )
      throw new Error("Invalid local ZIP header");
    const name = Buffer.alloc(header.readUInt16LE(26));
    await handle.read(name, 0, name.length, 30);
    if (name.toString("utf8") !== member.name)
      throw new Error("Changed ZIP member layout");
    start = 30 + name.length + header.readUInt16LE(28);
  } finally {
    await handle.close();
  }
  const source = createReadStream(path, {
    start,
    end: start + member.compressedBytes - 1,
  });
  const stream =
    member.compressionMethod === 8 ? source.pipe(createInflateRaw()) : source;
  source.on("error", (error) => stream.destroy(error));
  try {
    yield* readCsv(stream);
  } finally {
    stream.destroy();
    source.destroy();
  }
}
