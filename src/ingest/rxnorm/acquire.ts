import { readFile } from "node:fs/promises";
import {
  fetchToCache,
  readCachedText,
  sidecarNames,
} from "../../fetch/index.js";
import type { FetchOptions, SnapshotMetadata } from "../../fetch/index.js";
import { dataDirectory } from "../../config/access.js";

export const filesPage =
  "https://www.nlm.nih.gov/research/umls/rxnorm/docs/rxnormfiles.html";
export const sourceId = "nlm-rxnorm-prescribe";
export { dataDirectory };
export interface Release {
  version: string;
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

/** Only public CPC links on the official files page; never the licensed full release. */
export function discoverRelease(html: string): Release {
  const candidates: Release[] = [];
  for (const match of html.matchAll(
    /href\s*=\s*["']([^"']*RxNorm_full_prescribe_(\d{2})(\d{2})(\d{4})\.zip)["']/gi,
  )) {
    const url = new URL(match[1]!.replace(/&amp;/g, "&"), filesPage);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "download.nlm.nih.gov" ||
      url.username ||
      url.password ||
      url.search
    )
      continue;
    const version = `${match[4]}-${match[2]}-${match[3]}`;
    const date = new Date(`${version}T00:00:00Z`);
    if (!Number.isNaN(+date) && date.toISOString().slice(0, 10) === version)
      candidates.push({ version, url: url.href });
  }
  candidates.sort((a, b) => b.version.localeCompare(a.version));
  if (!candidates[0])
    throw new Error(
      "No public RxNorm CPC monthly release found; do not use a UMLS login",
    );
  return candidates[0];
}

export async function acquireRelease(
  dataDir = dataDirectory(),
  dependencies: FetchDependencies = {},
): Promise<AcquiredRelease> {
  const page = await fetchToCache(filesPage, {
    ...dependencies,
    source: "nlm-rxnorm-files",
    dataDir,
    allowHosts: ["www.nlm.nih.gov"],
    expectedContent: "binary",
    maxBytes: 2 * 1024 ** 2,
  });
  if (page.outcome === "not_modified")
    throw new Error("Files page body required");
  const release = discoverRelease(await readFile(page.path, "utf8"));
  // Reuse only a matching dated URL, and let fetchToCache verify the actual cached hash.
  let expectedSha256: string | undefined;
  // Sidecars are read through the fetch cache's store, local or remote.
  for (const name of await sidecarNames(dataDir, sourceId).catch(
    () => [] as string[],
  )) {
    const metadata = JSON.parse(
      await readCachedText(dataDir, sourceId, name),
    ) as SnapshotMetadata;
    if (metadata.url === release.url) {
      expectedSha256 = metadata.sha256;
      break;
    }
  }
  const archive = await fetchToCache(release.url, {
    ...dependencies,
    source: sourceId,
    dataDir,
    allowHosts: ["download.nlm.nih.gov"],
    expectedContent: "zip",
    expectedSha256,
    maxBytes: 1024 ** 3,
    zipLimits: { maxUncompressedBytes: 4 * 1024 ** 3 },
  });
  if (archive.outcome === "not_modified")
    throw new Error("Archive body required");
  return { ...release, path: archive.path, metadata: archive.metadata };
}
