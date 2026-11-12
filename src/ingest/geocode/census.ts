import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { mkdir, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import {
  fetchToCache,
  readCachedText,
  remoteSnapshotStore,
  storeCachedText,
} from "../../fetch/index.js";
import type {
  AdmissionSession,
  FetchOptions,
  FetchResult,
  RequestBody,
  Transport,
} from "../../fetch/index.js";
/** Request identities (input CSV and index) kept beside the cached responses. */
const requestSource = "census-geocoder-requests";
export const endpoint =
  "https://geocoding.geo.census.gov/geocoder/locations/addressbatch";
export const geographyEndpoint =
  "https://geocoding.geo.census.gov/geocoder/geographies/addressbatch";
export const documentation =
  "https://geocoding.geo.census.gov/geocoder/Geocoding_Services_API.html";
export const dataDirectory = () =>
  process.env.OPENPLANS_DATA_DIR ??
  join(homedir(), ".local", "share", "openplans");
export type BatchFile = Exclude<FetchResult, { outcome: "not_modified" }>;
export interface CensusOptions {
  dataDir?: string;
  sleep?: (ms: number) => Promise<void>;
  /** A shared session for a multi-batch job; otherwise each batch gets its own admission. */
  admission?: AdmissionSession;
  /** Trusted offline test injection only; production requests use the native POST transport. */
  transport?: Transport;
  lookup?: FetchOptions["lookup"];
  geographies?: boolean;
}
/**
 * The batch API takes a multipart upload. The body goes through fetchToCache's native POST support,
 * so the request passes the same admission session as every other download: robots, reviewed terms,
 * host pacing, job caps and a receipt. The response is content addressed like any snapshot.
 */
export function batchUpload(csv: string, geographies = false): RequestBody {
  const boundary = `------------------------${createHash("sha256").update(csv).digest("hex").slice(0, 24)}`;
  const vintage = geographies
    ? `--${boundary}\r\nContent-Disposition: form-data; name="vintage"\r\n\r\n4\r\n`
    : "";
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="addressFile"; filename="addresses.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}\r\nContent-Disposition: form-data; name="benchmark"\r\n\r\n4\r\n${vintage}--${boundary}--\r\n`,
    ),
  };
}
export async function acquireBatch(
  csv: string,
  options: CensusOptions = {},
): Promise<{ file: BatchFile; requests: number }> {
  const records = csv.trimEnd().split("\n").length;
  if (!csv.trim() || records > 10_000)
    throw new TypeError("Census batch must contain 1–10000 records");
  const target = options.geographies ? geographyEndpoint : endpoint;
  const dataDir = options.dataDir ?? dataDirectory(),
    requestHash = createHash("sha256")
      .update(
        (options.geographies
          ? "Public_AR_Current/Current_Current\n"
          : "Public_AR_Current\n") + csv,
      )
      .digest("hex");
  const requestDir = join(dataDir, "raw", requestSource);
  const index = join(requestDir, `${requestHash}.json`);
  let sha256: string | undefined;
  try {
    // The request index sits beside the snapshots, in the fetch cache's store.
    sha256 = (
      JSON.parse(
        await readCachedText(dataDir, requestSource, `${requestHash}.json`),
      ) as { sha256: string }
    ).sha256;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let requests = 0;
  const injected = options.transport;
  const file = await fetchToCache(target, {
    source: "census-geocoder-batch",
    allowHosts: ["geocoding.geo.census.gov"],
    expectedContent: "csv",
    dataDir,
    expectedSha256: sha256,
    maxBytes: 16 * 1024 ** 2,
    maxRedirects: 0,
    readTimeoutMs: 180_000,
    maxAttempts: 3,
    maxRetryDelayMs: 60_000,
    sleep: options.sleep,
    lookup: options.lookup,
    admission: options.admission,
    requestBody: batchUpload(csv, options.geographies),
    onRequest: () => {
      requests++;
    },
    transport: injected,
  });
  if (file.outcome === "not_modified")
    throw new Error("Unexpected Census conditional response");
  const entry = JSON.stringify({
    requestHash,
    benchmark: "Public_AR_Current",
    vintage: options.geographies ? "Current_Current" : null,
    sha256: file.metadata.sha256,
    records,
  });
  const remote = remoteSnapshotStore(dataDir);
  if (remote) {
    // With a remote store the input and index go there too, so another host reuses the answer.
    await storeCachedText(remote, requestSource, `${requestHash}.csv`, csv);
    await storeCachedText(remote, requestSource, `${requestHash}.json`, entry);
    return { file, requests };
  }
  await mkdir(requestDir, { recursive: true });
  // Input is retained with the request identity; raw response bytes are content addressed by fetchToCache.
  await writeFile(join(requestDir, `${requestHash}.csv`), csv, { flag: "w" });
  const temp = `${index}.${process.pid}.part`;
  await writeFile(temp, entry);
  await rename(temp, index);
  return { file, requests };
}
