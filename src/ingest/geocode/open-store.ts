import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { inflateSync } from "node:zlib";
import {
  cachedFilePath,
  cachedPayloadPath,
  fetchToCache,
  readCachedText,
  remoteSnapshotStore,
  storeCachedText,
} from "../../fetch/index.js";
import type { FetchOptions, SnapshotReadOptions } from "../../fetch/index.js";
import {
  openImportProfile,
  validateOpenDataset,
  validateOpenIndexDate,
} from "./open.js";
import type { OpenDataset } from "./open.js";

type OpenState = OpenDataset["state"];

/**
 * Where the open geocoder's state extracts live (design 5.7). Each dated extract is the pair
 * `raw/open-geocoder/<state>/<YYMMDD>/{data.osm.pbf,metadata.json}`. With the `local` store those
 * keys are the files download-open.py writes, and nothing here copies or reads them. With a
 * remote store the extract lives in the store, and a host copies it down into a private work
 * directory before the containers mount it.
 */
const source = "open-geocoder";
/** The fetch cache source that holds extracts and publisher checksums acquired for a remote store. */
export const openExtractSource = "open-geocoder-osm";
const states: Record<OpenState, string> = {
  TX: "texas",
  FL: "florida",
  NC: "north-carolina",
};
const host = "download.geofabrik.de";
const snapshotName = (state: OpenState, snapshot: string) =>
  `${state.toLowerCase()}/${snapshot}`;

interface StoredMetadata {
  state: string;
  snapshot: string;
  sha256: string;
  bytes: number;
  /** Set when the extract came through the fetch cache: the snapshot holding data.osm.pbf. */
  cache?: { source: string; snapshot_id: string };
}

/**
 * The directory that holds `<state>/<YYMMDD>/` for this host: `raw/open-geocoder` itself with the
 * `local` store, else the private copy under `work/open-geocoder/from-store`.
 */
export function openRawDirectory(
  root: string,
  options: SnapshotReadOptions = {},
): string {
  return remoteSnapshotStore(root, options)
    ? join(root, "work", source, "from-store")
    : join(root, "raw", source);
}

/**
 * The local directory holding one extract's `data.osm.pbf` and `metadata.json`. With the
 * `local` store it is the cached directory and nothing is read. With a remote store both files
 * are copied down through the store's checking `get`, the extract checked against the size and
 * hash its metadata records, and placed under {@link openRawDirectory}.
 */
export async function openSnapshotDirectory(
  root: string,
  state: OpenState,
  snapshot: string,
  options: SnapshotReadOptions = {},
): Promise<string> {
  const name = snapshotName(state, snapshot);
  if (!remoteSnapshotStore(root, options))
    return join(root, "raw", source, name);
  const text = await readCachedText(
    root,
    source,
    `${name}/metadata.json`,
    options,
  );
  const metadata = JSON.parse(text) as StoredMetadata;
  if (
    metadata.state !== state ||
    metadata.snapshot !== snapshot ||
    !/^[a-f0-9]{64}$/.test(String(metadata.sha256)) ||
    !Number.isSafeInteger(metadata.bytes) ||
    metadata.bytes < 0
  )
    throw new Error("Stored open geocoder metadata does not match its key");
  const expected = { bytes: metadata.bytes, sha256: metadata.sha256 };
  const extract = metadata.cache
    ? await cachedPayloadPath(
        root,
        String(metadata.cache.source),
        String(metadata.cache.snapshot_id),
        expected,
        options,
      )
    : await cachedFilePath(
        root,
        source,
        `${name}/data.osm.pbf`,
        expected,
        options,
      );
  const directory = join(openRawDirectory(root, options), name);
  await mkdir(directory, { recursive: true });
  await placeCopy(extract, join(directory, "data.osm.pbf"));
  await writeAtomic(join(directory, "metadata.json"), text);
  return directory;
}

/** Links (or, across file systems, copies) `from` to `to`, replacing `to` by rename. */
async function placeCopy(from: string, to: string): Promise<void> {
  const [source, target] = await Promise.all([
    stat(from),
    stat(to).catch(() => undefined),
  ]);
  if (target?.ino === source.ino && target.dev === source.dev) return;
  const temporary = `${to}.part`;
  await rm(temporary, { force: true });
  try {
    await link(from, temporary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await copyFile(from, temporary);
  }
  // Public OSM data read by the filter and import containers, whose user is not the host's.
  await chmod(temporary, 0o644);
  await rename(temporary, to);
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const temporary = `${path}.part`;
  await writeFile(temporary, text);
  await rename(temporary, path);
}

/**
 * Reads and checks the inputs the open geocoder run needs: the extract's metadata and hash and
 * the filtered address index under `work/open-geocoder`. The extract is resolved through
 * {@link openSnapshotDirectory}, so a remote store works as the local one does.
 */
export async function readOpenInputs(
  root: string,
  state: OpenState,
  snapshot: string,
  options: SnapshotReadOptions = {},
) {
  const directory = await openSnapshotDirectory(root, state, snapshot, options);
  const metadata = JSON.parse(
    await readFile(join(directory, "metadata.json"), "utf8"),
  ) as Omit<OpenDataset, "index_sha256" | "import_profile"> & {
    licence: string;
    attribution: string;
    data_timestamp: string;
  };
  const work = join(root, "work", source),
    prefix = `${state.toLowerCase()}-${snapshot}`;
  const index = JSON.parse(
    await readFile(join(work, `${prefix}-address-index.json`), "utf8"),
  ) as {
    index_sha256: string;
    raw_sha256: string;
    profile: string;
    state: string;
    data_timestamp: string;
    object_timestamp: string;
  };
  const dataset: OpenDataset = {
    sha256: metadata.sha256,
    index_sha256: index.index_sha256,
    import_profile: openImportProfile,
    data_date: metadata.data_date,
    state,
  };
  validateOpenDataset(dataset);
  validateOpenIndexDate(
    index.object_timestamp,
    metadata.data_timestamp,
    metadata.data_date,
  );
  if (
    metadata.state !== state ||
    (await fileHash(join(directory, "data.osm.pbf"))) !== metadata.sha256 ||
    metadata.licence !== "ODbL-1.0" ||
    index.raw_sha256 !== metadata.sha256 ||
    index.profile !== openImportProfile ||
    index.state !== state ||
    index.data_timestamp !== metadata.data_timestamp ||
    (await fileHash(join(work, `${prefix}-addresses.osm.pbf`))) !==
      index.index_sha256
  )
    throw new Error("Open geocoder extract hash or licence mismatch");
  return { directory, metadata, index, dataset };
}

async function fileHash(
  path: string,
  algorithm: "sha256" | "md5" = "sha256",
): Promise<string> {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Reads the wire types the OSM PBF header uses: varints and length-delimited fields. */
function protobuf(data: Buffer): Map<number, number | Buffer> {
  let index = 0;
  const varint = () => {
    let result = 0;
    for (let shift = 0; index < data.length && shift < 70; shift += 7) {
      const byte = data[index++]!;
      result += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) return result;
    }
    throw new Error("Invalid PBF header varint");
  };
  const fields = new Map<number, number | Buffer>();
  while (index < data.length) {
    const key = varint();
    let value: number | Buffer;
    if (key % 8 === 0) value = varint();
    else if (key % 8 === 2) {
      const length = varint();
      value = data.subarray(index, index + length);
      if (value.length !== length) throw new Error("Truncated PBF header");
      index += length;
    } else throw new Error("Unsupported PBF header field");
    fields.set(Math.floor(key / 8), value);
  }
  return fields;
}

/**
 * The replication timestamp in an OSM PBF file's header, as download-open.py records it
 * (`2026-11-07T21:21:36+00:00`).
 */
export async function pbfDataTimestamp(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const read = async (position: number, length: number) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, position);
      return buffer.subarray(0, bytesRead);
    };
    const size = (await read(0, 4)).readUInt32BE(0);
    if (!(size > 0 && size <= 65536))
      throw new Error("Invalid PBF header size");
    const header = protobuf(await read(4, size));
    const blobSize = header.get(3);
    if (
      !Buffer.isBuffer(header.get(1)) ||
      (header.get(1) as Buffer).toString() !== "OSMHeader" ||
      typeof blobSize !== "number" ||
      blobSize > 1024 * 1024
    )
      throw new Error("Invalid OSM PBF header");
    const blob = protobuf(await read(4 + size, blobSize));
    const raw = blob.get(1),
      compressed = blob.get(3);
    let content: Buffer | undefined;
    if (Buffer.isBuffer(raw)) content = raw;
    else if (Buffer.isBuffer(compressed)) content = inflateSync(compressed);
    const timestamp = content && protobuf(content).get(32);
    if (typeof timestamp !== "number")
      throw new Error("OSM PBF header has no replication timestamp");
    return new Date(timestamp * 1000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "+00:00");
  } finally {
    await file.close();
  }
}

/** `json.dumps(value, indent=2)` as download-open.py writes it: non-ASCII escaped. */
const pythonJson = (value: unknown) =>
  JSON.stringify(value, null, 2).replace(
    /[\u0080-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  ) + "\n";

export interface OpenAcquireOptions
  extends
    SnapshotReadOptions,
    Pick<
      FetchOptions,
      "admission" | "lookup" | "transport" | "sleep" | "random" | "projectUrl"
    > {
  /** Free bytes the data directory must keep before a download; 42 GiB as download-open.py. */
  minFreeBytes?: number;
}

/**
 * download-open.py for a remote store: acquires one dated Geofabrik state extract and its
 * publisher MD5 through `fetchToCache` (admission, robots, pacing and size limits apply), checks
 * the MD5, and writes the extract's `metadata.json` into the store. The metadata names the
 * fetch cache snapshot that holds the bytes, so the extract is stored once. A snapshot whose
 * metadata the store already holds is left alone. With the `local` store download-open.py
 * keeps writing `raw/open-geocoder` itself, and this refuses.
 */
export async function acquireOpenSnapshot(
  root: string,
  state: OpenState,
  snapshot: string,
  options: OpenAcquireOptions = {},
): Promise<void> {
  const store = remoteSnapshotStore(root, options);
  if (!store)
    throw new Error("With the local store, download-open.py acquires extracts");
  if (!/^\d{6}$/.test(snapshot)) throw new Error("Snapshot must be YYMMDD");
  const name = snapshotName(state, snapshot);
  if (await store.stat(`raw/${source}/${name}/metadata.json`)) return;
  const reserve = options.minFreeBytes ?? 42 * 1024 ** 3,
    disk = await statfs(root);
  if (disk.bavail * disk.bsize < reserve)
    throw new Error(
      "Download requires at least 42 GiB free, including the 40 GiB reserve",
    );
  const url = `https://${host}/north-america/us/${states[state]}-${snapshot}.osm.pbf`;
  const common = {
    source: openExtractSource,
    allowHosts: [host],
    expectedContent: "binary" as const,
    dataDir: root,
    blobStore: options.blobStore,
    admission: options.admission,
    lookup: options.lookup,
    transport: options.transport,
    sleep: options.sleep,
    random: options.random,
    projectUrl: options.projectUrl,
  };
  const checksum = await fetchToCache(`${url}.md5`, {
    ...common,
    maxBytes: 4096,
  });
  if (checksum.outcome === "not_modified")
    throw new Error("Unexpected not-modified checksum response");
  const publisherMd5 =
    (await readFile(checksum.path, "utf8")).split(/\s+/)[0] ?? "";
  if (!/^[a-f0-9]{32}$/.test(publisherMd5))
    throw new Error("Invalid publisher checksum");
  const extract = await fetchToCache(url, {
    ...common,
    maxBytes: 16 * 1024 ** 3,
    readTimeoutMs: 120_000,
  });
  if (extract.outcome === "not_modified")
    throw new Error("Unexpected not-modified extract response");
  if ((await fileHash(extract.path, "md5")) !== publisherMd5)
    throw new Error("Publisher MD5 mismatch");
  const timestamp = await pbfDataTimestamp(extract.path);
  const saved = {
    state,
    snapshot,
    url,
    publisher_md5: publisherMd5,
    sha256: extract.metadata.sha256,
    bytes: extract.metadata.bytes,
    source: "OpenStreetMap via Geofabrik",
    licence: "ODbL-1.0",
    attribution: "© OpenStreetMap contributors",
    data_timestamp: timestamp,
    data_date: timestamp.slice(0, 10),
    cache: { source: openExtractSource, snapshot_id: extract.snapshotId },
  };
  await storeCachedText(
    store,
    source,
    `${name}/metadata.json`,
    pythonJson(saved),
  );
}

/**
 * Makes one extract ready for geocoder.sh with a remote store: a missing extract is acquired
 * into the store, then copied down. Returns the directory to mount as the raw input
 * (`OPENPLANS_OPEN_GEOCODER_RAW_DIR`). With the `local` store it returns undefined and reads or
 * writes nothing, and download-open.py keeps `raw/open-geocoder` as it always has.
 */
export async function prepareOpenSnapshot(
  root: string,
  state: OpenState,
  snapshot: string,
  options: OpenAcquireOptions = {},
): Promise<string | undefined> {
  if (!remoteSnapshotStore(root, options)) return undefined;
  await acquireOpenSnapshot(root, state, snapshot, options);
  return dirname(
    dirname(await openSnapshotDirectory(root, state, snapshot, options)),
  );
}

/**
 * For the geocoder's own entry points (open-cli, open-store-cli): selects `blobs.provider` as
 * the worker does, so they read snapshots from the same store. A configuration that does not
 * parse, or none at all, keeps the `local` store.
 */
export async function startOpenHostStorage(): Promise<void> {
  const { loadWorkerPlugins } = await import("../../plugins/worker.js");
  const { loadConfig } = await import("../../config/index.js");
  const { startHostStorage } = await import("../../plugins/host-storage.js");
  await loadWorkerPlugins();
  let config;
  try {
    config = loadConfig();
  } catch {
    return;
  }
  startHostStorage(config);
}
