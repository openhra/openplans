import { homedir } from "node:os";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  AdmissionSession,
  fetchToCache,
  shippedManifestPaths,
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

export const dataDirectory = () =>
  process.env.OPENPLANS_DATA_DIR ??
  join(homedir(), ".local", "share", "openplans");

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
  manifest = process.env.OPENPLANS_ACCESS_MANIFEST,
): AdmissionSession | undefined {
  if (!manifest) return undefined;
  return new AdmissionSession(
    [...shippedManifestPaths(), manifest],
    { maxRequests: 60, maxTransferBytes: 512 * 1024 ** 2 },
    { egressCountry: process.env.OPENPLANS_EGRESS_COUNTRY || undefined },
  );
}

/** Snapshots already in the cache for one family, newest release label first. */
export async function cachedArchives(
  family: MedicareFamily,
  dataDir = dataDirectory(),
): Promise<CachedArchive[]> {
  const directory = join(dataDir, "raw", sourceIds[family]);
  const found: CachedArchive[] = [];
  for (const name of await readdir(directory).catch(() => [] as string[])) {
    if (!name.endsWith(".meta.json")) continue;
    const metadata = JSON.parse(
      await readFile(join(directory, name), "utf8"),
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
      path: join(directory, metadata.snapshot_id, "payload"),
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
