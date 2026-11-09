import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
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
import { AdmissionSession, assertObservedHostAllowed } from "./admission.js";
import type { AdmissionReceipt, PolicyDocument } from "./admission.js";
import { leaseHost } from "./limiter.js";

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
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
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
  try {
    const url = new URL(
      options.projectUrl ??
        process.env.OPENPLANS_PROJECT_URL ??
        "https://plans.openhra.com/",
    );
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
    (options.maxRedirects ?? 5) > 20
  ) {
    throw new FetchError("invalid_options", "Invalid fetch options");
  }
}

async function findSnapshot(
  sourceDir: string,
  source: string,
  sha256: string,
): Promise<Cached | undefined> {
  let names: string[];
  try {
    names = await readdir(sourceDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const name of names) {
    if (!identifier.test(name)) continue;
    let metadata: SnapshotMetadata;
    try {
      metadata = JSON.parse(
        await readFile(join(sourceDir, name, "meta.json"), "utf8"),
      ) as SnapshotMetadata;
    } catch (error) {
      if (
        ["ENOENT", "ENOTDIR"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        continue;
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
    const path = join(sourceDir, name, "payload");
    if ((await stat(path)).size !== metadata.bytes)
      throw new FetchError(
        "cache_error",
        "Cached snapshot size is inconsistent",
      );
    const metadataPath = join(sourceDir, `${name}.meta.json`);
    try {
      await link(join(sourceDir, name, "meta.json"), metadataPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return {
      outcome: "reused",
      snapshotId: name,
      path,
      metadataPath,
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
      "user-agent": `openplans/0.1 (public health-plan source discovery; +${projectUrl(options)})`,
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
      ? await leaseHost(dataDir, url.hostname, delayMs)
      : undefined;
    try {
      if (admission && !policyProbe) await admission.assertCurrent(url);
      admission?.reserveRequest(url);
      response = await (options.transport ?? httpsTransport)(url, {
        address,
        headers,
        connectTimeoutMs: options.connectTimeoutMs ?? 10_000,
        readTimeoutMs: options.readTimeoutMs ?? 30_000,
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
      text: await readFile(result.path, "utf8"),
    };
  } catch (error) {
    if (
      url.pathname === "/robots.txt" &&
      error instanceof FetchError &&
      error.status === 404
    )
      return { status: 404, sha256: null, text: "" };
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
  for await (const chunk of createReadStream(cached.path)) {
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
      if (destination === provenanceUrl(initial)) url = initial;
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
  sourceDir: string,
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
    await mkdir(sourceDir, { recursive: true });
    staging = await mkdtemp(join(sourceDir, ".pending-"));
    const partial = join(staging, "payload.part");
    const file = await open(partial, "wx");
    let bytes = 0,
      transferredBytes = 0;
    const hash = createHash("sha256");
    try {
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
      const iterator = output[Symbol.asyncIterator]();
      for (;;) {
        let item: IteratorResult<unknown>;
        try {
          item = await nextChunk(
            iterator,
            output,
            options.readTimeoutMs ?? 30_000,
          );
        } catch (error) {
          if (error instanceof FetchError) throw error;
          if (encoding !== "identity")
            throw new FetchError(
              "truncated",
              "Publisher compressed body is invalid or incomplete",
            );
          if (expectedLength !== undefined && transferredBytes < expectedLength)
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
        hash.update(chunk);
        await file.writeFile(chunk);
      }
      await transfer;
      if (expectedLength !== undefined && transferredBytes !== expectedLength)
        throw new FetchError(
          "truncated",
          "Publisher body differs from Content-Length",
        );
      await file.sync();
    } finally {
      await file.close();
    }
    const sha256 = hash.digest("hex");
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
      await inspectZip(partial, {
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
    const existing = await findSnapshot(sourceDir, options.source, sha256);
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
    await writeFile(
      join(staging, "meta.json"),
      `${JSON.stringify(metadata, null, 2)}\n`,
      { flag: "wx" },
    );
    await rename(partial, join(staging, "payload"));
    const destination = join(sourceDir, snapshotId);
    try {
      await rename(staging, destination);
    } catch (error) {
      if (
        ["EEXIST", "ENOTEMPTY"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      ) {
        const concurrent = await findSnapshot(
          sourceDir,
          options.source,
          sha256,
        );
        if (concurrent) return concurrent;
        throw new FetchError(
          "snapshot_conflict",
          "Snapshot ID already contains different content",
        );
      }
      throw error;
    }
    staging = undefined;
    const metadataPath = join(sourceDir, `${snapshotId}.meta.json`);
    try {
      await link(join(destination, "meta.json"), metadataPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return {
      outcome: "downloaded",
      snapshotId,
      path: join(destination, "payload"),
      metadataPath,
      metadata,
    };
  } finally {
    output?.destroy();
    response.body.destroy();
    await transfer?.catch(() => {});
    if (staging) await rm(staging, { recursive: true, force: true });
  }
}

export async function fetchToCache(
  input: string | URL,
  options: FetchOptions,
): Promise<FetchResult> {
  const manifestPath = process.env.OPENPLANS_ACCESS_MANIFEST;
  const admission =
    options.admission ??
    (manifestPath ? new AdmissionSession(manifestPath) : undefined);
  const result = await acquire(input, { ...options, admission });
  return admission ? { ...result, admission: admission.receipt() } : result;
}

async function acquire(
  input: string | URL,
  options: FetchOptions,
  policyProbe = false,
  probeDelayMs = 5000,
): Promise<FetchResult> {
  validateOptions(options);
  const initial = checkedUrl(input, options.allowHosts);
  assertObservedHostAllowed(initial);
  // Built from components to keep the configurable external data cache independent of a checkout path.
  const dataDir =
    options.dataDir ??
    process.env.OPENPLANS_DATA_DIR ??
    join(homedir(), ".local", "share", "openplans");
  if (!isAbsolute(dataDir))
    throw new FetchError(
      "invalid_options",
      "Data cache directory must be absolute",
    );
  options = { ...options, dataDir };
  const sourceDir = join(dataDir, "raw", options.source);
  try {
    if (options.expectedSha256) {
      const existing = await findSnapshot(
        sourceDir,
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
    if (!options.admission && !options.transport)
      throw new FetchError(
        "admission_required",
        "Native collection requires a reviewed publisher manifest",
      );
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
          sourceDir,
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
