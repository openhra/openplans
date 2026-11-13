import { readFile } from "node:fs/promises";
import {
  fetchToCache,
  readCachedText,
  sidecarNames,
} from "../../fetch/index.js";
import type {
  FetchOptions,
  SnapshotMetadata,
  ZipLimits,
} from "../../fetch/index.js";
import { dataDirectory } from "../../config/access.js";

export const filesPage = "https://download.cms.gov/nppes/NPI_Files.html";
export const sourceId = "cms-nppes";
export { dataDirectory };
export const zipLimits: ZipLimits = {
  maxCompressedBytes: 2 * 1024 ** 3,
  maxUncompressedBytes: 25 * 1024 ** 3,
  maxExpansionRatio: 200,
};
export type Kind = "full" | "weekly" | "deactivation";
export interface Release {
  kind: Kind;
  url: string;
}
export interface AcquiredRelease extends Release {
  path: string;
  metadata: SnapshotMetadata;
}
export type FetchDependencies = Pick<
  FetchOptions,
  "lookup" | "transport" | "sleep"
>;

/** Select only V2 artifacts actually linked by CMS. Never guess a missing weekly URL. */
export function discoverReleases(html: string): Release[] {
  const releases: Release[] = [];
  for (const match of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    const url = new URL(match[1]!.replace(/&amp;/g, "&"), filesPage);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "download.cms.gov" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      continue;
    if (!/_V2\.zip$/i.test(url.pathname)) continue;
    let kind: Kind | undefined;
    if (/\/NPPES_Deactivated_NPI_Report_/i.test(url.pathname)) {
      kind = "deactivation";
    } else if (
      /\/NPPES_Data_Dissemination_.*_Weekly_V2\.zip$/i.test(url.pathname)
    ) {
      kind = "weekly";
    } else if (
      /\/NPPES_Data_Dissemination_[A-Za-z]+_\d{4}_V2\.zip$/i.test(url.pathname)
    ) {
      kind = "full";
    } else {
      kind = undefined;
    }
    if (kind && !releases.some((r) => r.url === url.href))
      releases.push({ kind, url: url.href });
  }
  if (
    !releases.some((r) => r.kind === "full") ||
    !releases.some((r) => r.kind === "deactivation")
  )
    throw new Error("Missing CMS V2 monthly/deactivation links");
  return releases;
}
export async function acquireRelease(
  release: Release,
  dataDir = dataDirectory(),
  dependencies: FetchDependencies = {},
): Promise<AcquiredRelease> {
  let expectedSha256: string | undefined;
  // Sidecars are read through the fetch cache's store, local or remote.
  for (const name of await sidecarNames(dataDir, sourceId).catch(
    () => [] as string[],
  )) {
    const meta = JSON.parse(
      await readCachedText(dataDir, sourceId, name),
    ) as SnapshotMetadata;
    if (meta.url === release.url) {
      expectedSha256 = meta.sha256;
      break;
    }
  }
  const result = await fetchToCache(release.url, {
    ...dependencies,
    source: sourceId,
    dataDir,
    allowHosts: ["download.cms.gov"],
    expectedContent: "zip",
    expectedSha256,
    maxBytes: 2 * 1024 ** 3,
    readTimeoutMs: 120_000,
    zipLimits,
  });
  if (result.outcome === "not_modified")
    throw new Error("NPPES archive body required");
  return { ...release, path: result.path, metadata: result.metadata };
}
export async function discoverCurrent(
  dataDir = dataDirectory(),
  dependencies: FetchDependencies = {},
): Promise<Release[]> {
  const page = await fetchToCache(filesPage, {
    ...dependencies,
    source: "cms-nppes-page",
    dataDir,
    allowHosts: ["download.cms.gov"],
    expectedContent: "binary",
    maxBytes: 2 * 1024 ** 2,
  });
  if (page.outcome === "not_modified")
    throw new Error("NPPES files page body required");
  return discoverReleases(await readFile(page.path, "utf8"));
}
