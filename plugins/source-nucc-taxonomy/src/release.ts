import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { BlobStore, SnapshotMetadata } from "@openplans/plugin-sdk";

/** The NUCC page that links each published CSV release, newest first. */
export const filesPage =
  "https://www.nucc.org/index.php/code-sets-mainmenu-41/provider-taxonomy-mainmenu-40/csv-mainmenu-57";
export const sourceId = "nucc-provider-taxonomy";
export const publisher = "National Uniform Claim Committee";
export const nuccHost = "www.nucc.org";
export const PAGE_MAX_BYTES = 2 * 1024 ** 2;
export const CSV_MAX_BYTES = 10 * 1024 ** 2;

export interface Release {
  version: string;
  url: string;
}
/** A release whose CSV is on disk, with its fetch receipt. The import reads its hash and size. */
export interface AcquiredRelease extends Release {
  path: string;
  metadata: SnapshotMetadata;
}

/** The first `Version NN.N` link to a `nucc_taxonomy_NNN.csv` file on www.nucc.org. */
export function discoverRelease(html: string): Release {
  const candidates: Release[] = [];
  for (const m of html.matchAll(
    /<a\b[^>]*href=["']([^"']*nucc_taxonomy_(\d+)\.csv)["'][^>]*>\s*Version\s+(\d+\.\d+)/gi,
  )) {
    const url = new URL(m[1]!.replace(/&amp;/g, "&"), filesPage);
    if (
      url.protocol !== "https:" ||
      url.hostname !== nuccHost ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      continue;
    const digits = m[2]!;
    candidates.push({
      version: `${digits.slice(0, -1)}.${digits.slice(-1)}`,
      url: url.href,
    });
  }
  const release = candidates[0];
  if (!release)
    throw new Error("Current NUCC taxonomy CSV link/version unavailable");
  return release;
}

/**
 * The hash of a cached copy of `url`, so a repeat run reuses it instead of downloading again.
 * With `store`, the fetch cache's store, sidecars are read through it, so a copy held in a
 * remote store counts. Without one they are read from `<directory>/raw/<source>`.
 */
export async function expectedHash(
  directory: string,
  source: string,
  url: string,
  store?: BlobStore,
): Promise<string | undefined> {
  if (store) {
    const prefix = `raw/${source}`;
    for await (const key of store.list(prefix)) {
      if (!key.endsWith(".meta.json")) continue;
      const body = await store.get(key);
      if (!body) continue;
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      const meta = JSON.parse(
        Buffer.concat(chunks).toString("utf8"),
      ) as SnapshotMetadata;
      if (meta.url === url) return meta.sha256;
    }
    return undefined;
  }
  const root = join(directory, "raw", source);
  for (const name of await readdir(root).catch(() => [])) {
    if (!name.endsWith(".meta.json")) continue;
    const meta = JSON.parse(
      await readFile(join(root, name), "utf8"),
    ) as SnapshotMetadata;
    if (meta.url === url) return meta.sha256;
  }
  return undefined;
}
