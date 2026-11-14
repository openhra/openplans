import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { sep } from "node:path";
import type { BlobStore } from "@openplans/plugin-sdk";
import {
  asFetchBlobStore,
  hostBlobStore,
  LocalBlobStore,
} from "./blob/index.js";
import type { FetchBlobStore } from "./blob/index.js";
import type { SnapshotMetadata } from "./cache.js";

/**
 * Read access to cached snapshots for readers that work outside `fetchToCache`: the ingest
 * steps that look up an earlier copy of a URL or open a payload acquired before. They resolve
 * keys through the same store the fetch cache writes to (design 5.7), so they also work when
 * snapshots live in a remote store. With the `local` store every key is the file it always was
 * under `<dataDir>/raw`, and the returned paths are those files.
 */
export interface SnapshotReadOptions {
  /** Defaults to the store the entry point selected, else `local` at the data directory. */
  blobStore?: BlobStore;
}

/** The store `fetchToCache` would use for this data directory. */
export function snapshotStore(
  dataDir: string,
  options: SnapshotReadOptions = {},
): FetchBlobStore {
  return asFetchBlobStore(
    options.blobStore ?? hostBlobStore() ?? new LocalBlobStore(dataDir),
    dataDir,
  );
}

const sourceKey = (source: string) => `raw/${source}`;

/**
 * The store's local path for `raw/<source>`, or `raw/<source>/<name>` when `name` is given.
 * Nothing is read or copied. With the `local` store this is the file or directory under
 * `<dataDir>/raw` the key has always named. Ingest code resolves `raw/` paths here rather than
 * joining them itself, so a reader cannot skip the store by accident.
 */
export function snapshotPath(
  dataDir: string,
  source: string,
  name?: string,
  options: SnapshotReadOptions = {},
): string {
  const key =
    name === undefined ? sourceKey(source) : `${sourceKey(source)}/${name}`;
  return snapshotStore(dataDir, options).localPath(key);
}

/**
 * Names of the files directly under `raw/<source>`, in listing order, as `readdir` gives them.
 * A source with nothing stored lists nothing, unless `missing` is `"throw"`: then a source with
 * no entries at all fails with `ENOENT`, as `readdir` does for a missing directory.
 */
export async function cachedNames(
  dataDir: string,
  source: string,
  options: SnapshotReadOptions & { missing?: "empty" | "throw" } = {},
): Promise<string[]> {
  const prefix = sourceKey(source);
  const names: string[] = [];
  let entries = 0;
  for await (const entry of snapshotStore(dataDir, options).list(prefix)) {
    entries++;
    if (!entry.endsWith("/")) names.push(entry.slice(prefix.length + 1));
  }
  if (!entries && options.missing === "throw") throw missingSnapshot();
  return names;
}

/** The source names under `raw/`, in listing order: the directories `readdir` would show. */
export async function cachedSources(
  dataDir: string,
  options: SnapshotReadOptions = {},
): Promise<string[]> {
  const sources: string[] = [];
  for await (const entry of snapshotStore(dataDir, options).list("raw"))
    if (entry.endsWith("/")) sources.push(entry.slice(4, -1));
  return sources;
}

const missingSnapshot = () =>
  Object.assign(new Error("Cached snapshot file is missing"), {
    code: "ENOENT",
  });

/** The `.meta.json` sidecar names under `raw/<source>`, in listing order. */
export async function sidecarNames(
  dataDir: string,
  source: string,
  options: SnapshotReadOptions & { missing?: "empty" | "throw" } = {},
): Promise<string[]> {
  return (await cachedNames(dataDir, source, options)).filter((name) =>
    name.endsWith(".meta.json"),
  );
}

/**
 * The text of `raw/<source>/<name>`, read through the store (which checks a remote object's
 * recorded hash). A missing key fails with `ENOENT`, as `readFile` does.
 */
export async function readCachedText(
  dataDir: string,
  source: string,
  name: string,
  options: SnapshotReadOptions = {},
): Promise<string> {
  const body = await snapshotStore(dataDir, options).get(
    `${sourceKey(source)}/${name}`,
  );
  if (!body) throw missingSnapshot();
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * A local path holding `raw/<source>/<name>`. For the `local` store that is the cached file
 * itself and nothing is read. For a remote store the file is copied down through the store's
 * checking `get`, and checked against `expected` when given.
 */
export async function cachedFilePath(
  dataDir: string,
  source: string,
  name: string,
  expected?: { bytes: number; sha256: string },
  options: SnapshotReadOptions = {},
): Promise<string> {
  const store = snapshotStore(dataDir, options);
  const key = `${sourceKey(source)}/${name}`;
  await store.materialize?.(key, expected);
  return store.localPath(key);
}

/** {@link cachedFilePath} for the payload of the snapshot `raw/<source>/<snapshot>`. */
export function cachedPayloadPath(
  dataDir: string,
  source: string,
  snapshot: string,
  expected?: { bytes: number; sha256: string },
  options: SnapshotReadOptions = {},
): Promise<string> {
  return cachedFilePath(
    dataDir,
    source,
    `${snapshot}/payload`,
    expected,
    options,
  );
}

/**
 * Where the payload of `raw/<source>/<snapshot>` is, or will be once {@link ensureCachedPayload}
 * copies it down. Nothing is read, so a reader can list many snapshots and fetch only the one it
 * opens. For the `local` store this is the cached file.
 */
export function payloadLocation(
  dataDir: string,
  source: string,
  snapshot: string,
  options: SnapshotReadOptions = {},
): string {
  return snapshotStore(dataDir, options).localPath(
    `${sourceKey(source)}/${snapshot}/payload`,
  );
}

/**
 * Makes a listed snapshot's `path` readable on this host: a remote store's payload is copied
 * down and checked against the sidecar's size and hash. With the `local` store the path is
 * already the cached file and the entry comes back with the same path.
 */
export async function ensureCachedPayload<
  T extends { path: string; metadata: SnapshotMetadata },
>(dataDir: string, entry: T, options: SnapshotReadOptions = {}): Promise<T> {
  const { source, snapshot_id, bytes, sha256 } = entry.metadata;
  return {
    ...entry,
    path: await cachedPayloadPath(
      dataDir,
      source,
      snapshot_id,
      { bytes, sha256 },
      options,
    ),
  };
}

/** The store, when snapshots live in one whose keys are not local files; else undefined. */
export function remoteSnapshotStore(
  dataDir: string,
  options: SnapshotReadOptions = {},
): FetchBlobStore | undefined {
  const store = snapshotStore(dataDir, options);
  return store.materialize ? store : undefined;
}

/**
 * Writes the small text file `raw/<source>/<name>` (a manifest or request index) to a remote
 * store, so every host that shares the store reads it, and returns the local copy's path. Only
 * for a remote store: with the `local` store the caller writes its file at {@link snapshotPath}
 * as it always has.
 *
 * PUF `manifest-*.json` files live beside the snapshots they name, under the same
 * `raw/cms-exchange-puf/` prefix in the same store. With the `local` store that is the file it
 * always was, written by rename, so local bytes and paths do not change. With a remote store the
 * manifest is an object in that store, written here, and readers list and read it through
 * {@link cachedNames} and {@link cachedFilePath}. A host-local manifest would let one host
 * import a set that another host sharing the store cannot see, so manifests never stay local
 * when snapshots are remote. The Census request index under `raw/census-geocoder-requests`
 * follows the same rule.
 */
export async function storeCachedText(
  store: FetchBlobStore,
  source: string,
  name: string,
  text: string,
): Promise<string> {
  const key = `${sourceKey(source)}/${name}`;
  const data = Buffer.from(text, "utf8");
  const sha256 = createHash("sha256").update(data).digest("hex");
  await store.put(
    key,
    (async function* () {
      yield data;
    })(),
    { sha256 },
  );
  await store.materialize?.(key, { bytes: data.length, sha256 });
  return store.localPath(key);
}

/**
 * A payload path recorded in the database (`snapshot.raw_path`), readable on this host. With
 * the `local` store it is returned unchanged. With a remote store a path missing here, such as
 * another host's copy, is resolved by its `raw/<source>/<snapshot>/payload` tail through the
 * store and copied down.
 */
export async function recordedPayloadPath(
  rawPath: string,
  dataDir: string,
  expected?: { bytes: number; sha256: string },
  options: SnapshotReadOptions = {},
): Promise<string> {
  const store = remoteSnapshotStore(dataDir, options);
  if (!store) return rawPath;
  try {
    await stat(rawPath);
    return rawPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const parts = rawPath.split(sep);
  if (parts.at(-1) !== "payload" || parts.at(-4) !== "raw") return rawPath;
  return cachedPayloadPath(
    dataDir,
    parts.at(-3)!,
    parts.at(-2)!,
    expected,
    options,
  );
}
