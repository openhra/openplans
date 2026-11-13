import { readFile } from "node:fs/promises";
import {
  AdmissionSession,
  fetchToCache,
  payloadLocation,
  readCachedText,
  shippedManifestPaths,
  sidecarNames,
} from "../../fetch/index.js";
import type { FetchOptions, SnapshotMetadata } from "../../fetch/index.js";
import {
  archiveLimits,
  discoverArchive,
  discoveryPage,
  host,
  pageSourceId,
  parseArchiveUrl,
  sourceIds,
} from "./sources.js";
import type { Archive, MedicareFamily } from "./sources.js";
import {
  dataDirectory,
  egressCountry,
  operatorManifest,
} from "../../config/access.js";

export { dataDirectory };

export type FetchDependencies = Pick<
  FetchOptions,
  "lookup" | "transport" | "sleep"
>;
export interface AcquireContext {
  dataDir?: string;
  admission?: AdmissionSession;
  dependencies?: FetchDependencies;
}
export interface CachedArchive {
  archive: Archive;
  path: string;
  metadata: SnapshotMetadata;
}

/**
 * One reviewed session for a whole collection job. Medicare files need an operator manifest entry
 * for www.cms.gov that permits the `/files/zip/` archives and listing pages (data/access has none).
 */
export function medicareSession(
  manifest = operatorManifest(),
): AdmissionSession | undefined {
  if (!manifest) return undefined;
  return new AdmissionSession(
    [...shippedManifestPaths(), manifest],
    { maxRequests: 60, maxTransferBytes: 512 * 1024 ** 2 },
    { egressCountry: egressCountry() },
  );
}

/**
 * Snapshots already in the cache for one family, newest release label first. Sidecars are read
 * through the fetch cache's store. With a remote store `path` is where the payload will be once
 * `ensureCachedPayload` copies it down, so listing never downloads an archive.
 */
export async function cachedArchives(
  family: MedicareFamily,
  dataDir = dataDirectory(),
): Promise<CachedArchive[]> {
  const source = sourceIds[family];
  const found: CachedArchive[] = [];
  for (const name of await sidecarNames(dataDir, source).catch(
    () => [] as string[],
  )) {
    const metadata = JSON.parse(
      await readCachedText(dataDir, source, name),
    ) as SnapshotMetadata;
    const archive = parseArchiveUrl(metadata.url);
    if (
      !archive ||
      archive.family !== family ||
      metadata.source !== sourceIds[family]
    )
      continue;
    found.push({
      archive,
      metadata,
      path: payloadLocation(dataDir, source, metadata.snapshot_id),
    });
  }
  return found.sort(
    (a, b) =>
      b.archive.label.localeCompare(a.archive.label) ||
      b.metadata.fetched_at.localeCompare(a.metadata.fetched_at),
  );
}

/** Reads a listing page and picks the archive; the page is never parsed from a query URL. */
export async function discover(
  family: MedicareFamily,
  year: number,
  context: AcquireContext = {},
): Promise<Archive> {
  const page = await fetchToCache(discoveryPage(family, year), {
    ...context.dependencies,
    admission: context.admission,
    source: pageSourceId,
    dataDir: context.dataDir ?? dataDirectory(),
    allowHosts: [host],
    expectedContent: "binary",
    maxBytes: 4 * 1024 ** 2,
  });
  if (page.outcome === "not_modified")
    throw new Error("Listing page body required");
  return discoverArchive(family, year, await readFile(page.path, "utf8"));
}

export async function acquireArchive(
  archive: Archive,
  context: AcquireContext = {},
): Promise<CachedArchive> {
  const dataDir = context.dataDir ?? dataDirectory();
  const cached = (await cachedArchives(archive.family, dataDir)).find(
    (entry) => entry.metadata.url === archive.url,
  );
  const limits = archiveLimits[archive.family];
  const result = await fetchToCache(archive.url, {
    ...context.dependencies,
    admission: context.admission,
    source: sourceIds[archive.family],
    dataDir,
    allowHosts: [host],
    expectedContent: "zip",
    expectedSha256: cached?.metadata.sha256,
    maxBytes: limits.maxBytes,
    zipLimits: {
      maxMembers: limits.maxMembers,
      maxUncompressedBytes: limits.maxUncompressedBytes,
    },
  });
  if (result.outcome === "not_modified")
    throw new Error("Archive body required");
  return { archive, path: result.path, metadata: result.metadata };
}
