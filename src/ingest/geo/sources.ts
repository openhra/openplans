import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { createInflateRaw } from "node:zlib";
import {
  fetchToCache,
  inspectZip,
  readCachedText,
  sidecarNames,
} from "../../fetch/index.js";
import type { FetchOptions, SnapshotMetadata } from "../../fetch/index.js";
import { dataDirectory } from "../../config/access.js";

export const GEO_SOURCES = {
  relationship: {
    source: "census-zcta-county-2020",
    publisher: "US Census Bureau",
    url: "https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt",
    expectedContent: "csv",
    maxBytes: 20 * 1024 * 1024,
  },
  centroids: {
    source: "census-zcta-gazetteer-2021",
    publisher: "US Census Bureau",
    url: "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2021_Gazetteer/2021_Gaz_zcta_national.zip",
    expectedContent: "zip",
    maxBytes: 5 * 1024 * 1024,
  },
  ratingAreas: {
    source: "cms-rating-areas",
    publisher: "Centers for Medicare & Medicaid Services",
    url: "https://www.cms.gov/cciio/programs-and-initiatives/health-insurance-market-reforms/tx-gra",
    expectedContent: "binary",
    maxBytes: 2 * 1024 * 1024,
  },
} as const;
export function geoSources(state = "TX") {
  if (!/^[A-Z]{2}$/.test(state)) throw new TypeError("Invalid geography state");
  return {
    ...GEO_SOURCES,
    ratingAreas: {
      ...GEO_SOURCES.ratingAreas,
      url: GEO_SOURCES.ratingAreas.url.replace(
        "tx-gra",
        `${state.toLowerCase()}-gra`,
      ),
    },
  };
}
export type GeoKind = keyof typeof GEO_SOURCES;
export interface GeoFile {
  path: string;
  metadata: SnapshotMetadata;
  zipped?: boolean;
}
export type GeoFiles = Record<GeoKind, GeoFile>;
export interface AcquisitionOptions {
  dataDir?: string;
  state?: string;
  /** Re-fetch the publisher URLs instead of reusing the newest cached snapshot for each URL. */
  refresh?: boolean;
  fetchOptions?: Pick<FetchOptions, "lookup" | "transport" | "maxAttempts">;
}
export { dataDirectory };

export async function cachedHash(
  directory: string,
  source: string,
  url: string,
): Promise<string | undefined> {
  // Read through the fetch cache's store, so a remote store's snapshots count too.
  const matches: SnapshotMetadata[] = [];
  for (const name of await sidecarNames(directory, source)) {
    const metadata = JSON.parse(
      await readCachedText(directory, source, name),
    ) as SnapshotMetadata;
    if (metadata.source === source && metadata.url === url)
      matches.push(metadata);
  }
  return matches.sort((a, b) => b.fetched_at.localeCompare(a.fetched_at))[0]
    ?.sha256;
}

export async function acquireGeo(
  options: AcquisitionOptions = {},
): Promise<GeoFiles> {
  const dataDir = options.dataDir ?? dataDirectory();
  const files = {} as GeoFiles;
  const sources = geoSources(options.state);
  for (const kind of Object.keys(GEO_SOURCES) as GeoKind[]) {
    const source = sources[kind];
    const result = await fetchToCache(source.url, {
      ...options.fetchOptions,
      source: source.source,
      expectedContent: source.expectedContent,
      allowHosts: [new URL(source.url).hostname],
      dataDir,
      maxBytes: source.maxBytes,
      expectedSha256: options.refresh
        ? undefined
        : await cachedHash(dataDir, source.source, source.url),
    });
    if (result.outcome === "not_modified")
      throw new Error("Geography source has no cached body");
    files[kind] = {
      path: result.path,
      metadata: result.metadata,
      zipped: kind === "centroids",
    };
  }
  return files;
}

/** The Gazetteer ZIP has one text member. Inspect all limits before streaming its payload. */
export async function* centroidStream(file: GeoFile): AsyncGenerator<Buffer> {
  if (!file.zipped) {
    yield* createReadStream(file.path);
    return;
  }
  const archive = await inspectZip(file.path, {
    maxMembers: 1,
    maxUncompressedBytes: 10 * 1024 * 1024,
  });
  const member = archive.members[0];
  if (
    !member ||
    member.name !== "2021_Gaz_zcta_national.txt" ||
    ![0, 8].includes(member.compressionMethod)
  ) {
    throw new Error("Unexpected Gazetteer archive member");
  }
  const handle = await open(file.path, "r");
  let offset: number;
  try {
    const header = Buffer.alloc(30);
    const { bytesRead } = await handle.read(header, 0, 30, 0);
    if (bytesRead !== 30 || header.readUInt32LE(0) !== 0x04034b50)
      throw new Error("Invalid Gazetteer local header");
    offset = 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  } finally {
    await handle.close();
  }
  const compressed = createReadStream(file.path, {
    start: offset,
    end: offset + member.compressedBytes - 1,
  });
  const stream =
    member.compressionMethod === 8
      ? compressed.pipe(createInflateRaw())
      : compressed;
  const forwardError = (error: Error) => stream.destroy(error);
  compressed.on("error", forwardError);
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      bytes += chunk.length;
      if (bytes > member.uncompressedBytes)
        throw new Error("Gazetteer inflated size exceeds declaration");
      yield chunk as Buffer;
    }
    if (bytes !== member.uncompressedBytes)
      throw new Error("Truncated Gazetteer member");
  } finally {
    compressed.off("error", forwardError);
    stream.destroy();
    compressed.destroy();
  }
}
