import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { IncomingHttpHeaders } from "node:http";
import { Transform } from "node:stream";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";
import { FetchError } from "./errors.js";
import type { FetchEvidence } from "./errors.js";
import {
  checkedUrl,
  provenanceUrl,
  resolvePublic,
  systemLookup,
} from "./policy.js";
import type { Lookup } from "./policy.js";
import { httpsTransport } from "./transport.js";
import type { FetchResponse, Transport } from "./transport.js";
import { inspectZip } from "./zip.js";
import type { ZipLimits } from "./zip.js";
import {
  AdmissionSession,
  absentRobotsStatuses,
  assertObservedHostAllowed,
} from "./admission.js";
import type { AdmissionReceipt, PolicyDocument } from "./admission.js";
import { leaseHost } from "./limiter.js";
import { shippedManifestPaths } from "./shipped.js";
import {
  asFetchBlobStore,
  hostBlobStore,
  LocalBlobStore,
} from "./blob/index.js";
import type { FetchBlobStore } from "./blob/index.js";
import type { BlobStore } from "@openplans/plugin-sdk";
import { scopeForbidsStorage } from "../plugins/request-scope.js";
import {
  dataDirectory,
  egressCountry,
  operatorManifest,
  projectUrl as configuredProjectUrl,
} from "../config/access.js";

export interface SnapshotMetadata {
  snapshot_id: string;
  source: string;
  url: string;
  final_url: string;
  redirect_chain: string[];
  status: number;
  content_type: string | null;
  etag: string | null;
  last_modified: string | null;
  sha256: string;
  bytes: number;
  /** Present for HTTP-compressed responses; payload/hash/bytes describe decoded content. */
  content_encoding?: "gzip" | "deflate" | "br";
  transferred_bytes?: number;
  fetched_at: string;
  access_policy?: AdmissionReceipt;
}
export interface FetchOptions {
  /** One reviewed session per collection job; required for native network requests. */
  admission?: AdmissionSession;
  source: string;
  allowHosts: readonly string[];
  expectedContent: "json" | "csv" | "zip" | "binary";
  dataDir?: string;
  snapshotId?: string;
  /** Enables a cache hit before making any request. A downloaded body must match this hash. */
  expectedSha256?: string;
  conditional?: { etag?: string; lastModified?: string };
  /** Maximum bytes transferred before HTTP content decoding. */
  maxBytes?: number;
  /** Maximum decoded payload bytes; defaults to maxBytes (1 GiB by default). */
  maxDecompressedBytes?: number;
  maxRedirects?: number;
  connectTimeoutMs?: number;
  readTimeoutMs?: number;
  maxAttempts?: number;
  maxRetryDelayMs?: number;
  /** Public contact page; defaults to OPENPLANS_PROJECT_URL or the project contact page. */
  projectUrl?: string;
  zipLimits?: ZipLimits;
  /** Trusted dependency injection, principally for offline tests. URL policy always runs first. */
  lookup?: Lookup;
  transport?: Transport;
  /**
   * Sends the data request as a POST with this body, for publisher APIs that take an upload (the
   * Census batch geocoder). Policy reads stay GET. A body is never resent to a redirect target.
   */
  requestBody?: RequestBody;
  /** Called before each data request is sent (not for robots or terms reads), e.g. to count batches. */
  onRequest?: (url: URL) => void;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  /**
   * Where payloads, `meta.json` and sidecars go (design 5.7). Defaults to the store the entry
   * point selected from `blobs.provider`, else the `local` store rooted at `dataDir`, which
   * writes the tree this cache always wrote. Leases, quarantine markers and readmissions stay
   * plain files next to the store's source directory.
   */
  blobStore?: BlobStore;
}
export interface RequestBody {
  contentType: string;
  body: Buffer;
}
export type FetchResult = (
  | {
      outcome: "downloaded" | "reused";
      snapshotId: string;
      path: string;
      metadataPath: string;
      metadata: SnapshotMetadata;
    }
  | {
      outcome: "not_modified";
      status: 304;
      url: string;
      final_url: string;
      redirect_chain: string[];
    }
) & { admission?: AdmissionReceipt };

type Cached = Exclude<FetchResult, { outcome: "not_modified" }>;
const transientStatuses = new Set([408, 429, 500, 502, 503, 504]);
const transientCodes = new Set([
  "dns_error",
  "connect_timeout",
  "read_timeout",
  "network_error",
  "truncated",
]);
const identifier = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

function header(
  headers: IncomingHttpHeaders,
  name: string,
): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value.join(", ") : value;
}
function positive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
function projectUrl(options: FetchOptions): string {
  // Read outside the try, so a config file error keeps its own message.
  const configured = options.projectUrl ?? configuredProjectUrl();
  try {
    const url = new URL(configured);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.href.includes("@") ||
      /%40/i.test(url.href)
    )
      throw new Error();
    return url.href;
  } catch {
    throw new FetchError(
      "invalid_options",
      "Project URL must be an HTTPS contact page without credentials or query values",
    );
  }
}
function validateOptions(options: FetchOptions): void {
  projectUrl(options);
  if (
    !identifier.test(options.source) ||
    (options.snapshotId !== undefined &&
      !identifier.test(options.snapshotId)) ||
    !Array.isArray(options.allowHosts) ||
    !options.allowHosts.length ||
    !["json", "csv", "zip", "binary"].includes(options.expectedContent) ||
    (options.expectedSha256 !== undefined &&
      !/^[a-f0-9]{64}$/.test(options.expectedSha256)) ||
    ![
      options.maxBytes ?? 1024 ** 3,
      options.connectTimeoutMs ?? 10_000,
      options.readTimeoutMs ?? 30_000,
      options.maxRetryDelayMs ?? 60_000,
    ].every(positive) ||
    !Number.isSafeInteger(options.maxBytes ?? 1024 ** 3) ||
    !Number.isSafeInteger(
      options.maxDecompressedBytes ?? options.maxBytes ?? 1024 ** 3,
    ) ||
    (options.maxDecompressedBytes ?? options.maxBytes ?? 1024 ** 3) <= 0 ||
    !Number.isInteger(options.maxAttempts ?? 3) ||
    (options.maxAttempts ?? 3) < 1 ||
    (options.maxAttempts ?? 3) > 10 ||
    !Number.isInteger(options.maxRedirects ?? 5) ||
    (options.maxRedirects ?? 5) < 0 ||
    (options.maxRedirects ?? 5) > 20 ||
    (options.requestBody !== undefined &&
      (!Buffer.isBuffer(options.requestBody.body) ||
        !/^[\w.+-]+\/[\w.+-]+(?:;[ -~]*)?$/.test(
          options.requestBody.contentType,
        ) ||
        (options.maxRedirects ?? 5) !== 0))
  ) {
    throw new FetchError("invalid_options", "Invalid fetch options");
  }
}

const quarantineMarker = "QUARANTINE.json";

async function readOptionalJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new FetchError("cache_error", "Cache policy file is unreadable");
  }
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Blob keys: `raw/<source>` holds `<snapshot>/payload`, `<snapshot>/meta.json` and sidecars. */
const sourceKey = (source: string) => `raw/${source}`;
const snapshotKey = (source: string, snapshotId: string) =>
  `${sourceKey(source)}/${snapshotId}`;

function storeOf(options: FetchOptions): FetchBlobStore {
  return asFetchBlobStore(
    options.blobStore ??
      hostBlobStore() ??
      new LocalBlobStore(options.dataDir!),
    options.dataDir!,
  );
}

async function* single(bytes: Buffer): AsyncGenerator<Buffer> {
  yield bytes;
}
const asBuffer = (chunk: Uint8Array) =>
  Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

/**
 * A store whose keys are not local files copies the snapshot down through its verifying `get`
 * before the cache hands out `path` and `metadataPath`. A local store has nothing to do.
 */
async function localCopies(
  store: FetchBlobStore,
  cached: Cached,
  fresh = false,
): Promise<void> {
  if (!store.materialize) return;
  const key = snapshotKey(cached.metadata.source, cached.snapshotId);
  await store.materialize(
    `${key}/payload`,
    { bytes: cached.metadata.bytes, sha256: cached.metadata.sha256 },
    fresh,
  );
  await store.materialize(`${key}.meta.json`, undefined, fresh);
}

/** A whole blob, or undefined when the key does not exist. */
async function readBlob(
  store: FetchBlobStore,
  key: string,
): Promise<Buffer | undefined> {
  const body = await store.get(key);
  if (!body) return;
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(asBuffer(chunk));
  return Buffer.concat(chunks);
}

/**
 * Snapshots fetched before admission existed are listed in a per-source QUARANTINE.json marker.
 * One is reused only with `<id>.readmitted.json` naming the same bytes and a stored admission
 * receipt (matching hash) that admits the snapshot's host.
 */
async function assertNotQuarantined(
  sourceDir: string,
  metadata: SnapshotMetadata,
  freshReceipt?: AdmissionReceipt,
): Promise<void> {
  const marker = (await readOptionalJson(join(sourceDir, quarantineMarker))) as
    { snapshots?: unknown } | undefined;
  if (
    !marker ||
    !Array.isArray(marker.snapshots) ||
    !marker.snapshots.includes(metadata.snapshot_id)
  )
    return;
  const denied = () =>
    new FetchError(
      "admission_denied",
      "Snapshot quarantined pending admission",
    );
  const readmissionPath = join(
    sourceDir,
    `${metadata.snapshot_id}.readmitted.json`,
  );
  if (freshReceipt)
    await writeReadmission(readmissionPath, metadata, freshReceipt);
  const readmission = (await readOptionalJson(readmissionPath)) as
    Record<string, unknown> | undefined;
  if (
    !readmission ||
    readmission.snapshot_id !== metadata.snapshot_id ||
    readmission.sha256 !== metadata.sha256 ||
    readmission.bytes !== metadata.bytes ||
    typeof readmission.admissionReceipt !== "string" ||
    !isAbsolute(readmission.admissionReceipt) ||
    typeof readmission.admissionReceiptSha256 !== "string"
  )
    throw denied();
  let receiptBytes: Buffer;
  try {
    receiptBytes = await readFile(readmission.admissionReceipt);
  } catch {
    throw denied();
  }
  if (sha256Hex(receiptBytes) !== readmission.admissionReceiptSha256)
    throw denied();
  let receipt: AdmissionReceipt;
  try {
    receipt = JSON.parse(receiptBytes.toString("utf8")) as AdmissionReceipt;
  } catch {
    throw denied();
  }
  const host = new URL(metadata.url).hostname;
  if (
    !Array.isArray(receipt.hosts) ||
    !receipt.hosts.some(
      (entry) => entry.host === host && entry.state === "allowed",
    )
  )
    throw denied();
}

/**
 * The quarantine rule for readers that open cached snapshots without fetchToCache, such as the
 * bootstrap's cached release pages: a listed snapshot needs a matching readmission and receipt.
 */
export async function assertSnapshotAdmissible(
  dataDir: string,
  metadata: SnapshotMetadata,
): Promise<void> {
  if (!identifier.test(metadata.source))
    throw new FetchError("cache_error", "Cached snapshot source is invalid");
  await assertNotQuarantined(join(dataDir, "raw", metadata.source), metadata);
}

/**
 * A download made now under a current admission that produced the very bytes of a quarantined
 * snapshot is its re-admission evidence: the receipt is stored next to it and referenced by hash.
 * An existing readmission is never overwritten.
 */
async function writeReadmission(
  readmissionPath: string,
  metadata: SnapshotMetadata,
  receipt: AdmissionReceipt,
): Promise<void> {
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  const receiptSha256 = sha256Hex(receiptBytes);
  const receiptPath = readmissionPath.replace(
    /\.readmitted\.json$/,
    `.admission-${receiptSha256.slice(0, 16)}.json`,
  );
  try {
    await writeFile(receiptPath, receiptBytes, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const readmission = {
    snapshot_id: metadata.snapshot_id,
    sha256: metadata.sha256,
    bytes: metadata.bytes,
    admissionReceipt: receiptPath,
    admissionReceiptSha256: receiptSha256,
    decision: "fresh admitted download with identical bytes",
    readmittedAt: new Date().toISOString(),
  };
  try {
    await writeFile(
      readmissionPath,
      `${JSON.stringify(readmission, null, 2)}\n`,
      { flag: "wx" },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

async function findSnapshot(
  store: FetchBlobStore,
  source: string,
  sha256: string,
  freshReceipt?: AdmissionReceipt,
): Promise<Cached | undefined> {
  const prefix = sourceKey(source);
  const sourceDir = store.controlDir?.(prefix) ?? store.localPath(prefix);
  for await (const entry of store.list(prefix)) {
    const name = entry.slice(prefix.length + 1).replace(/\/$/, "");
    if (!identifier.test(name)) continue;
    let metadata: SnapshotMetadata;
    try {
      const bytes = await readBlob(
        store,
        `${snapshotKey(source, name)}/meta.json`,
      );
      if (!bytes) continue;
      metadata = JSON.parse(bytes.toString("utf8")) as SnapshotMetadata;
    } catch {
      throw new FetchError(
        "cache_error",
        "Cached snapshot metadata is unreadable",
      );
    }
    if (metadata.sha256 !== sha256) continue;
    if (
      metadata.snapshot_id !== name ||
      metadata.source !== source ||
      !Number.isSafeInteger(metadata.bytes)
    ) {
      throw new FetchError(
        "cache_error",
        "Cached snapshot metadata is inconsistent",
      );
    }
    await assertNotQuarantined(sourceDir, metadata, freshReceipt);
    const key = snapshotKey(source, name);
    const payload = await store.stat(`${key}/payload`);
    // A missing payload fails as an unexpected cache error, as a failed stat always did.
    if (!payload) throw new Error("Cached snapshot payload is missing");
    if (payload.bytes !== metadata.bytes)
      throw new FetchError(
        "cache_error",
        "Cached snapshot size is inconsistent",
      );
    await store.alias(`${key}/meta.json`, `${key}.meta.json`);
    return {
      outcome: "reused",
      snapshotId: name,
      path: store.localPath(`${key}/payload`),
      metadataPath: store.localPath(`${key}.meta.json`),
      metadata,
    };
  }
}

function retryDelay(
  response: FetchResponse | undefined,
  attempt: number,
  options: FetchOptions,
): number | undefined {
  const maximum = options.maxRetryDelayMs ?? 60_000;
  const value = response && header(response.headers, "retry-after");
  let minimum = 0;
  if (value !== undefined) {
    minimum = /^\d+$/.test(value.trim())
      ? Number(value) * 1000
      : Math.max(0, Date.parse(value) - Date.now());
    if (!Number.isFinite(minimum)) minimum = 0;
    // A delay beyond the configured retry budget terminates instead of retrying earlier than requested.
    if (minimum > maximum) return;
  }
  const random = Math.max(0, Math.min(1, (options.random ?? Math.random)()));
  return Math.min(
    maximum,
    Math.max(minimum, 250 * 2 ** attempt * (0.5 + random)),
  );
}

async function requestChain(
  initial: URL,
  options: FetchOptions,
  evidence: FetchEvidence,
  policyProbe: boolean,
  probeDelayMs: number,
): Promise<{
  response: FetchResponse;
  url: URL;
  chain: string[];
  release?: () => Promise<void>;
}> {
  let url = initial;
  let previous: URL | undefined;
  const chain: string[] = [];
  for (;;) {
    evidence.final_url = provenanceUrl(url);
    evidence.redirect_chain = [...chain];
    evidence.response_headers = {};
    delete evidence.address;
    url = checkedUrl(url, options.allowHosts);
    assertObservedHostAllowed(url);
    const admission = options.admission;
    const delayMs =
      admission && !policyProbe
        ? await admission.authorize(
            url,
            (policyUrl, delay) =>
              readPublisherPolicy(policyUrl, options, delay),
            previous,
          )
        : probeDelayMs;
    const dataDir = options.dataDir!;
    const address = await resolvePublic(
      url,
      options.lookup ?? systemLookup,
      options.connectTimeoutMs ?? 10_000,
    );
    evidence.address = address.address;
    const headers: Record<string, string> = {
      "accept-encoding": "identity",
      "user-agent": `openplans/0.4.6 (public health-plan source discovery; +${projectUrl(options)})`,
    };
    if (options.expectedContent === "json")
      headers.accept = "application/json, */*;q=0.1";
    // Conditional validators must not leak to delegated redirect hosts.
    if (url.origin === initial.origin) {
      if (options.conditional?.etag)
        headers["if-none-match"] = options.conditional.etag;
      if (options.conditional?.lastModified)
        headers["if-modified-since"] = options.conditional.lastModified;
    }
    let response: FetchResponse;
    const release = admission
      ? await leaseHost(
          dataDir,
          url.hostname,
          delayMs,
          policyProbe ? undefined : admission.pacingFloorMs(url),
        )
      : undefined;
    try {
      if (admission && !policyProbe) await admission.assertCurrent(url);
      admission?.reserveRequest(url);
      const upload = policyProbe ? undefined : options.requestBody;
      if (upload) headers["content-type"] = upload.contentType;
      if (!policyProbe) options.onRequest?.(url);
      // Only the transport sees a keyed API's credential; `url` stays key-free for evidence.
      const sent =
        admission && !policyProbe ? admission.credentialUrl(url) : url;
      response = await (options.transport ?? httpsTransport)(sent, {
        address,
        headers,
        connectTimeoutMs: options.connectTimeoutMs ?? 10_000,
        readTimeoutMs: options.readTimeoutMs ?? 30_000,
        ...(upload && { method: "POST" as const, body: upload.body }),
      });
    } catch (error) {
      await release?.();
      if (error instanceof FetchError) throw error;
      throw new FetchError("network_error", "Publisher connection failed");
    }
    // Deliberate allowlist: never retain cookies, authentication challenges or arbitrary headers.
    evidence.status = response.status;
    for (const name of [
      "content-type",
      "content-length",
      "server",
      "date",
      "retry-after",
      "x-cache",
      "cf-ray",
    ]) {
      const value = header(response.headers, name);
      if (value !== undefined)
        evidence.response_headers[name] = value.slice(0, 1024);
    }
    if (![301, 302, 303, 307, 308].includes(response.status))
      return { response, url, chain, release };
    response.body.destroy();
    await release?.();
    if (chain.length >= (options.maxRedirects ?? 5))
      throw new FetchError(
        "too_many_redirects",
        "Publisher redirect limit exceeded",
      );
    const location = header(response.headers, "location");
    if (!location)
      throw new FetchError(
        "invalid_redirect",
        "Publisher redirect has no location",
      );
    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      throw new FetchError("invalid_redirect", "Invalid publisher redirect");
    }
    chain.push(provenanceUrl(next));
    previous = url;
    url = next;
  }
}

async function readPublisherPolicy(
  url: URL,
  options: FetchOptions,
  delayMs: number,
): Promise<PolicyDocument> {
  try {
    const result = await acquire(
      url,
      {
        ...options,
        source: "publisher-policy",
        allowHosts: [url.hostname],
        expectedContent: "binary",
        snapshotId: undefined,
        expectedSha256: undefined,
        conditional: undefined,
        requestBody: undefined,
        maxBytes: 512 * 1024,
        maxDecompressedBytes: 512 * 1024,
        maxAttempts: 1,
      },
      true,
      delayMs,
    );
    if (result.outcome === "not_modified")
      throw new FetchError(
        "admission_denied",
        "Publisher policy returned no content",
      );
    return {
      status: 200,
      sha256: result.metadata.sha256,
      text: (await readBlob(
        storeOf(options),
        `${snapshotKey("publisher-policy", result.snapshotId)}/payload`,
      ))!.toString("utf8"),
      contentType: result.metadata.content_type,
    };
  } catch (error) {
    // A 404 reached through a redirect is another location's answer, not this host's robots file.
    if (
      url.pathname === "/robots.txt" &&
      error instanceof FetchError &&
      error.code === "http_status" &&
      absentRobotsStatuses.includes(error.status ?? 0) &&
      error.evidence?.redirect_chain.length === 0
    )
      return { status: error.status!, sha256: null, text: "", absent: true };
    // A keyed API answers robots with 401; the session decides whether its manifest recorded that.
    if (
      url.pathname === "/robots.txt" &&
      error instanceof FetchError &&
      error.code === "http_status" &&
      error.status === 401 &&
      error.evidence?.redirect_chain.length === 0
    )
      return {
        status: 401,
        sha256: null,
        text: "",
        unauthorized: true,
        failure: error,
      };
    throw error;
  }
}

async function nextChunk(
  iterator: AsyncIterator<unknown>,
  body: Readable,
  timeoutMs: number,
): Promise<IteratorResult<unknown>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new FetchError("read_timeout", "Publisher body timed out"));
          body.destroy();
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function contentLength(response: FetchResponse): number | undefined {
  const value = header(response.headers, "content-length");
  if (value === undefined) return;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new FetchError("truncated", "Invalid Content-Length");
  return Number(value);
}

function htmlProbe(enabled: boolean): (chunk: Buffer) => void {
  let leading = "";
  const decoder = new StringDecoder("utf8");
  return (chunk) => {
    if (!enabled || leading.length >= 64) return;
    leading = (leading + decoder.write(chunk)).trimStart().slice(0, 64);
    if (/^(?:<!doctype\b|<html\b)/i.test(leading)) {
      throw new FetchError(
        "html_error_page",
        "Publisher returned an HTML error page",
      );
    }
  };
}

function challengeProbe(): (chunk: Buffer) => void {
  const maximumProbeCharacters = 64 * 1024;
  let leading = "";
  const decoder = new StringDecoder("utf8");
  return (chunk) => {
    if (leading.length >= maximumProbeCharacters) return;
    leading = (leading + decoder.write(chunk)).slice(0, maximumProbeCharacters);
    if (
      /verify (?:that )?you are human|<title>\s*(?:just a moment|access denied|attention required)|\/cdn-cgi\/challenge-platform|(?:class|id)=["'](?:g-recaptcha|h-captcha)|<form[^>]+(?:login|sign-in)|<title>[^<]*(?:sign in|log in|paywall)/i.test(
        leading,
      )
    )
      throw new FetchError(
        "challenge_detected",
        "Publisher returned an access challenge",
      );
  };
}

async function checkRetryChallenge(
  response: FetchResponse,
  url: URL,
  options: FetchOptions,
): Promise<void> {
  if (
    header(response.headers, "content-encoding") &&
    header(response.headers, "content-encoding") !== "identity"
  )
    throw new FetchError(
      "unsupported_encoding",
      "Encoded error response requires policy review",
    );
  const probe = challengeProbe();
  const iterator = response.body[Symbol.asyncIterator]();
  const probeLimit = Math.min(64 * 1024, options.maxBytes ?? 1024 ** 3);
  let bytes = 0;
  try {
    while (bytes < probeLimit) {
      const item = await nextChunk(
        iterator,
        response.body,
        options.readTimeoutMs ?? 30_000,
      );
      if (item.done) break;
      const chunk = Buffer.isBuffer(item.value)
        ? item.value
        : Buffer.from(item.value as Uint8Array);
      options.admission?.transferred(url, chunk.length);
      bytes += chunk.length;
      if (bytes > (options.maxBytes ?? 1024 ** 3))
        throw new FetchError(
          "too_large",
          "Publisher error body exceeds byte limit",
        );
      probe(chunk);
    }
  } finally {
    response.body.destroy();
  }
  if (
    /(?:text\/html|application\/xhtml\+xml)/i.test(
      header(response.headers, "content-type") ?? "",
    )
  )
    throw new FetchError(
      "html_error_page",
      "Publisher returned an HTML error page",
    );
}
function checkContentType(
  type: string | null,
  expected: FetchOptions["expectedContent"],
): void {
  if (
    expected !== "binary" &&
    type &&
    /(?:text\/html|application\/xhtml\+xml)/i.test(type)
  ) {
    throw new FetchError(
      "html_error_page",
      "Publisher returned an HTML error page",
    );
  }
}
async function validateCacheHit(
  cached: Cached,
  options: FetchOptions,
): Promise<void> {
  if (
    (cached.metadata.transferred_bytes ?? cached.metadata.bytes) >
      (options.maxBytes ?? 1024 ** 3) ||
    cached.metadata.bytes >
      (options.maxDecompressedBytes ?? options.maxBytes ?? 1024 ** 3)
  )
    throw new FetchError("too_large", "Cached body exceeds byte limit");
  checkContentType(cached.metadata.content_type, options.expectedContent);
  const probe = htmlProbe(options.expectedContent !== "binary");
  const probeChallenge = challengeProbe();
  const hash = createHash("sha256");
  const store = storeOf(options);
  await localCopies(store, cached);
  const body = store.materialize
    ? createReadStream(cached.path)
    : await store.get(
        `${snapshotKey(cached.metadata.source, cached.snapshotId)}/payload`,
      );
  if (!body) throw new Error("Cached snapshot payload is missing");
  for await (const item of body) {
    const chunk = asBuffer(item);
    probeChallenge(chunk);
    probe(chunk);
    hash.update(chunk);
  }
  if (hash.digest("hex") !== cached.metadata.sha256)
    throw new FetchError("cache_error", "Cached snapshot hash is inconsistent");
  if (options.expectedContent === "zip")
    await inspectZip(cached.path, {
      ...options.zipLimits,
      maxCompressedBytes: Math.min(
        options.maxDecompressedBytes ?? options.maxBytes ?? 1024 ** 3,
        options.zipLimits?.maxCompressedBytes ?? 1024 ** 3,
      ),
    });
}

async function validateSnapshotAdmission(
  cached: Cached,
  initial: URL,
  options: FetchOptions,
): Promise<void> {
  let previous: URL | undefined;
  for (const destination of [
    initial.href,
    cached.metadata.url,
    ...cached.metadata.redirect_chain,
    cached.metadata.final_url,
  ]) {
    let url = new URL(destination);
    assertObservedHostAllowed(url);
    if (options.admission) {
      if (
        destination === initial.href ||
        destination === provenanceUrl(initial)
      )
        url = initial;
      else if (url.search)
        throw new FetchError(
          "admission_denied",
          "Cached redirect query requires a fresh policy review",
        );
      url = checkedUrl(url, options.allowHosts);
      await options.admission.authorize(
        url,
        (policyUrl, delay) => readPublisherPolicy(policyUrl, options, delay),
        previous,
      );
    }
    previous = url;
  }
}

async function saveBody(
  initial: URL,
  url: URL,
  chain: string[],
  response: FetchResponse,
  store: FetchBlobStore,
  options: FetchOptions,
  policyProbe: boolean,
): Promise<Cached> {
  const limit = options.maxBytes ?? 1024 ** 3;
  const decodedLimit = options.maxDecompressedBytes ?? limit;
  let output: Readable | undefined;
  let transfer: Promise<void> | undefined;
  let staging: string | undefined;
  try {
    const encoding = (
      header(response.headers, "content-encoding") ?? "identity"
    )
      .trim()
      .toLowerCase();
    if (!["identity", "gzip", "deflate", "br"].includes(encoding))
      throw new FetchError(
        "unsupported_encoding",
        "Unsupported HTTP content encoding",
      );
    const expectedLength = contentLength(response);
    if (expectedLength !== undefined && expectedLength > limit)
      throw new FetchError("too_large", "Publisher body exceeds byte limit");
    const type = header(response.headers, "content-type") ?? null;
    checkContentType(type, options.expectedContent);
    const probe = htmlProbe(options.expectedContent !== "binary");
    const probeChallenge = challengeProbe();
    staging = await store.stage(sourceKey(options.source));
    const partial = `${staging}/payload.part`;
    let bytes = 0,
      transferredBytes = 0;
    let written: { bytes: number; sha256: string };
    {
      const wire = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          try {
            options.admission?.transferred(url, chunk.length);
          } catch (error) {
            return callback(error as Error);
          }
          transferredBytes += chunk.length;
          if (transferredBytes > limit)
            return callback(
              new FetchError(
                "too_large",
                "Publisher transfer exceeds byte limit",
              ),
            );
          if (expectedLength !== undefined && transferredBytes > expectedLength)
            return callback(
              new FetchError(
                "truncated",
                "Publisher body differs from Content-Length",
              ),
            );
          callback(null, chunk);
        },
      });
      // The store writes what this yields; a throw here makes `put` remove the partial key.
      // The body starts flowing only once the store has opened its partial key, as before.
      async function* checked(): AsyncGenerator<Buffer> {
        let decoder;
        if (encoding === "gzip") {
          decoder = createGunzip();
        } else if (encoding === "deflate") {
          decoder = createInflate();
        } else if (encoding === "br") {
          decoder = createBrotliDecompress();
        } else {
          decoder = undefined;
        }
        output = decoder ?? wire;
        transfer = decoder
          ? pipeline(response.body, wire, decoder)
          : pipeline(response.body, wire);
        // The reader observes pipeline failures; attach immediately to avoid an unhandled rejection.
        void transfer.catch(() => {});
        const reading = output;
        const iterator = reading[Symbol.asyncIterator]();
        for (;;) {
          let item: IteratorResult<unknown>;
          try {
            item = await nextChunk(
              iterator,
              reading,
              options.readTimeoutMs ?? 30_000,
            );
          } catch (error) {
            if (error instanceof FetchError) throw error;
            if (encoding !== "identity")
              throw new FetchError(
                "truncated",
                "Publisher compressed body is invalid or incomplete",
              );
            if (
              expectedLength !== undefined &&
              transferredBytes < expectedLength
            )
              throw new FetchError(
                "truncated",
                "Publisher closed before Content-Length",
              );
            throw new FetchError("network_error", "Publisher stream failed");
          }
          if (item.done) break;
          const chunk = Buffer.isBuffer(item.value)
            ? item.value
            : Buffer.from(item.value as Uint8Array);
          bytes += chunk.length;
          if (bytes > decodedLimit)
            throw new FetchError(
              "too_large",
              "Publisher decoded body exceeds byte limit",
            );
          probeChallenge(chunk);
          probe(chunk);
          yield chunk;
        }
        await transfer;
        if (expectedLength !== undefined && transferredBytes !== expectedLength)
          throw new FetchError(
            "truncated",
            "Publisher body differs from Content-Length",
          );
      }
      written = await store.put(partial, checked(), {});
    }
    const sha256 = written.sha256;
    if (
      options.expectedSha256 !== undefined &&
      sha256 !== options.expectedSha256
    ) {
      throw new FetchError(
        "snapshot_conflict",
        "Downloaded hash differs from expected snapshot hash",
      );
    }
    if (options.expectedContent === "zip")
      await inspectZip(store.localPath(partial), {
        ...options.zipLimits,
        maxCompressedBytes: Math.min(
          decodedLimit,
          options.zipLimits?.maxCompressedBytes ?? decodedLimit,
        ),
      });
    if (options.admission && !policyProbe) {
      for (const destination of [initial.href, ...chain])
        await options.admission.assertReady(
          checkedUrl(destination, options.allowHosts),
        );
    }
    const existing = await findSnapshot(
      store,
      options.source,
      sha256,
      options.admission && !policyProbe
        ? options.admission.receipt()
        : undefined,
    );
    if (existing) {
      if (!policyProbe)
        await validateSnapshotAdmission(existing, initial, options);
      await validateCacheHit(existing, options);
      return existing;
    }
    const snapshotId = options.snapshotId ?? sha256;
    const metadata: SnapshotMetadata = {
      snapshot_id: snapshotId,
      source: options.source,
      url: provenanceUrl(initial),
      final_url: provenanceUrl(url),
      redirect_chain: chain,
      status: response.status,
      content_type: type,
      etag: header(response.headers, "etag") ?? null,
      last_modified: header(response.headers, "last-modified") ?? null,
      sha256,
      bytes,
      fetched_at: new Date().toISOString(),
      ...(options.admission && !policyProbe
        ? { access_policy: options.admission.receipt() }
        : {}),
      ...(encoding === "identity"
        ? {}
        : {
            content_encoding: encoding as "gzip" | "deflate" | "br",
            transferred_bytes: transferredBytes,
          }),
    };
    await store.put(
      `${staging}/meta.json`,
      single(Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`)),
      {},
    );
    await store.publish(partial, `${staging}/payload`);
    const destination = snapshotKey(options.source, snapshotId);
    try {
      await store.publish(staging, destination);
    } catch (error) {
      if (
        ["EEXIST", "ENOTEMPTY"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      ) {
        const concurrent = await findSnapshot(store, options.source, sha256);
        if (concurrent) {
          await localCopies(store, concurrent);
          return concurrent;
        }
        throw new FetchError(
          "snapshot_conflict",
          "Snapshot ID already contains different content",
        );
      }
      throw error;
    }
    staging = undefined;
    await store.alias(`${destination}/meta.json`, `${destination}.meta.json`);
    const downloaded: Cached = {
      outcome: "downloaded",
      snapshotId,
      path: store.localPath(`${destination}/payload`),
      metadataPath: store.localPath(`${destination}.meta.json`),
      metadata,
    };
    // Read back what the store now holds, so the path never names bytes it did not keep.
    await localCopies(store, downloaded, true);
    return downloaded;
  } finally {
    output?.destroy();
    response.body.destroy();
    await transfer?.catch(() => {});
    if (staging) await store.discard(staging);
  }
}

const policyAllowanceBytes = 4 * 512 * 1024;
const defaultSessionLimits = {
  maxRequests: 200,
  maxTransferBytes: 50 * 1024 ** 2,
};

/**
 * A session created for one fetch call may move that call's own byte cap plus its policy reads.
 * Each host's reviewed `jobCaps` still bound it, so a large reviewed file such as the national NPPES
 * archive is not refused by the 50 MiB default meant for multi-file jobs.
 */
function implicitSession(
  paths: readonly string[],
  options: FetchOptions,
): AdmissionSession {
  return new AdmissionSession(
    paths,
    {
      maxRequests: defaultSessionLimits.maxRequests,
      maxTransferBytes: Math.max(
        defaultSessionLimits.maxTransferBytes,
        (options.maxBytes ?? 1024 ** 3) + policyAllowanceBytes,
      ),
    },
    { egressCountry: egressCountry() },
  );
}

/**
 * Admission order: an explicit session; else `OPENPLANS_ACCESS_MANIFEST` layered over the shipped
 * manifests; else, for a network cache miss only, the shipped manifests alone. Cache hits without an
 * explicit session or operator manifest stay offline, as hash-pinned imports always have.
 */
export async function fetchToCache(
  input: string | URL,
  options: FetchOptions,
): Promise<FetchResult> {
  // Design 5.10.4: inside a `none` or `request` scope nothing touches disk; use fetchTransient.
  if (scopeForbidsStorage())
    throw new FetchError(
      "storage_forbidden",
      "The request's cache level forbids storing a payload",
    );
  const shipped = shippedManifestPaths();
  const operator = operatorManifest();
  const admission =
    options.admission ??
    (operator ? implicitSession([...shipped, operator], options) : undefined);
  const fallback =
    !admission && !options.transport && shipped.length
      ? implicitSession(shipped, options)
      : undefined;
  const result = await acquire(input, {
    ...options,
    admission,
    fallbackAdmission: fallback,
  });
  const used = admission ?? (fallback?.active ? fallback : undefined);
  return used ? { ...result, admission: used.receipt() } : result;
}

interface AcquireOptions extends FetchOptions {
  /** Used only once a network request is needed and no other session applies. */
  fallbackAdmission?: AdmissionSession;
}

async function acquire(
  input: string | URL,
  options: AcquireOptions,
  policyProbe = false,
  probeDelayMs = 5000,
): Promise<FetchResult> {
  validateOptions(options);
  const initial = checkedUrl(input, options.allowHosts);
  assertObservedHostAllowed(initial);
  // Built from components to keep the configurable external data cache independent of a checkout path.
  const dataDir = options.dataDir ?? dataDirectory();
  if (!isAbsolute(dataDir))
    throw new FetchError(
      "invalid_options",
      "Data cache directory must be absolute",
    );
  const store = storeOf({ ...options, dataDir });
  options = { ...options, dataDir, blobStore: store };
  try {
    if (options.expectedSha256) {
      const existing = await findSnapshot(
        store,
        options.source,
        options.expectedSha256,
      );
      if (existing) {
        await validateSnapshotAdmission(existing, initial, options);
        await validateCacheHit(existing, options);
        if (options.admission) {
          await options.admission.assertReady(initial);
          const final =
            existing.metadata.final_url === provenanceUrl(initial)
              ? initial
              : checkedUrl(existing.metadata.final_url, options.allowHosts);
          await options.admission.assertReady(final);
        }
        return existing;
      }
    }
    if (!options.admission && !options.transport) {
      if (!options.fallbackAdmission)
        throw new FetchError(
          "admission_required",
          "Native collection requires a reviewed publisher manifest",
        );
      options = { ...options, admission: options.fallbackAdmission };
    }
    for (let attempt = 0; attempt < (options.maxAttempts ?? 3); attempt++) {
      let response: FetchResponse | undefined;
      let release: (() => Promise<void>) | undefined;
      const evidence: FetchEvidence = {
        requested_url: provenanceUrl(initial),
        final_url: provenanceUrl(initial),
        redirect_chain: [],
        response_headers: {},
        attempts: attempt + 1,
        connect_timeout_ms: options.connectTimeoutMs ?? 10_000,
      };
      try {
        const result = await requestChain(
          initial,
          options,
          evidence,
          policyProbe,
          probeDelayMs,
        );
        release = result.release;
        response = result.response;
        if (response.status === 304) {
          response.body.destroy();
          if (options.admission && !policyProbe)
            await options.admission.assertReady(result.url);
          return {
            outcome: "not_modified",
            status: 304,
            url: provenanceUrl(initial),
            final_url: provenanceUrl(result.url),
            redirect_chain: result.chain,
          };
        }
        if (response.status !== 200) {
          if (transientStatuses.has(response.status))
            await checkRetryChallenge(response, result.url, options);
          response.body.destroy();
          throw new FetchError(
            "http_status",
            "Publisher returned an unsuccessful HTTP status",
            response.status,
          );
        }
        return await saveBody(
          initial,
          result.url,
          result.chain,
          response,
          store,
          options,
          policyProbe,
        );
      } catch (error) {
        response?.body.destroy();
        if (!(error instanceof FetchError)) throw error;
        if (error.connection) evidence.connection = error.connection;
        if (error.evidence && error.evidence !== evidence)
          evidence.policy = error.evidence;
        error.evidence = evidence;
        const transient =
          transientCodes.has(error.code) ||
          (error.code === "http_status" &&
            transientStatuses.has(error.status ?? 0));
        if (!transient || attempt + 1 >= (options.maxAttempts ?? 3))
          throw error;
        const delay = retryDelay(response, attempt, options);
        if (delay === undefined) throw error;
        await release?.();
        release = undefined;
        await (
          options.sleep ??
          ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
        )(delay);
      } finally {
        await release?.();
      }
    }
    throw new FetchError("network_error", "Publisher retry budget exhausted");
  } catch (error) {
    if (!policyProbe) options.admission?.stop();
    if (error instanceof FetchError) throw error;
    throw new FetchError("cache_error", "Snapshot acquisition failed");
  }
}
