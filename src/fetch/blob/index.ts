import type { BlobStore } from "@openplans/plugin-sdk";
import type { FetchBlobStore } from "./local.js";
import { RemoteFetchStore } from "./remote.js";

export { LocalBlobStore, checkedKey } from "./local.js";
export { RemoteFetchStore } from "./remote.js";
export type { FetchBlobStore, LocalBlobFs } from "./local.js";

let hostStore: BlobStore | undefined;

/**
 * The blob store an entry point selected from `blobs.provider`. `fetchToCache` uses it when a
 * call passes no `blobStore`. Unset (the core `local` store) keeps the per-call data directory.
 */
export function configureHostBlobStore(store: BlobStore | undefined): void {
  hostStore = store;
}

export function hostBlobStore(): BlobStore | undefined {
  return hostStore;
}

const fetchMethods = ["localPath", "stage", "alias", "discard"] as const;

/**
 * The fetch cache runs directly on a store that names a local path for each key. A provider
 * that offers only the SDK interface runs behind `RemoteFetchStore`, which spools and reads
 * back under `dataDir`.
 */
export function asFetchBlobStore(
  store: BlobStore,
  dataDir: string,
): FetchBlobStore {
  if (fetchMethods.some((name) => typeof Object(store)[name] !== "function"))
    return new RemoteFetchStore(store, dataDir);
  return store as FetchBlobStore;
}
