import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { Transform } from "node:stream";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";
import {
  AdmissionSession,
  absentRobotsStatuses,
  assertObservedHostAllowed,
} from "./admission.js";
import type { AdmissionReceipt, PolicyDocument } from "./admission.js";
import type { FetchOptions } from "./cache.js";
import { FetchError } from "./errors.js";
import type { FetchEvidence } from "./errors.js";
import { leaseHost } from "./limiter.js";
import {
  checkedUrl,
  provenanceUrl,
  resolvePublic,
  systemLookup,
} from "./policy.js";
import { shippedManifestPaths } from "./shipped.js";
import { httpsTransport } from "./transport.js";
import type { FetchResponse } from "./transport.js";

export interface TransientFetchOptions extends Pick<
  FetchOptions,
  | "admission"
  | "allowHosts"
  | "dataDir"
  | "maxBytes"
  | "maxDecompressedBytes"
  | "maxRedirects"
  | "connectTimeoutMs"
  | "readTimeoutMs"
  | "maxAttempts"
  | "maxRetryDelayMs"
  | "projectUrl"
  | "lookup"
  | "transport"
  | "requestBody"
  | "onRequest"
  | "sleep"
  | "random"
> {
  expectedContent?: "json" | "csv" | "binary";
  /** Total wall-clock budget, including admission, pacing, redirects and retries. */
  deadlineMs?: number;
  /**
   * Extra headers sent with an upload only, never with robots or terms reads. Names must match
   * `x-openplans-*` in lower case, so they cannot replace a header the fetch sets itself.
   */
  requestHeaders?: Readonly<Record<string, string>>;
  /**
   * `delivery`: one POST to an operator-declared endpoint, such as a plugin's event receiver. It
   * is not data collection, so it skips the robots and terms reads and the per-host pacing. The
   * host must still be `allowed` in the manifest, and the call must send a body with
   * `maxRedirects: 0`, `maxAttempts: 1` and `deadlineMs` of at most 5000. Default `collection`.
   */
  purpose?: "collection" | "delivery";
}
export interface TransientFetchResult {
  body: Buffer;
  sha256: string;
  admission: AdmissionReceipt;
  status: number;
  headers: Record<string, string>;
  /** Redacted like the evidence: query values are removed. */
  finalUrl: string;
  redirectChain: string[];
}

const defaultMaxBytes = 2 * 1024 ** 2;
const transientStatuses = new Set([408, 429, 500, 502, 503, 504]);
const transientCodes = new Set([
  "dns_error",
  "connect_timeout",
  "read_timeout",
  "network_error",
  "truncated",
]);
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
function projectUrl(options: TransientFetchOptions): string {
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
function retryDelay(
  response: FetchResponse | undefined,
  attempt: number,
  options: TransientFetchOptions,
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

function validateOptions(options: TransientFetchOptions): void {
  projectUrl(options);
  if (
    !Array.isArray(options.allowHosts) ||
    !options.allowHosts.length ||
    !["json", "csv", "binary"].includes(options.expectedContent ?? "binary") ||
    ![
      options.maxBytes ?? defaultMaxBytes,
      options.maxDecompressedBytes ?? options.maxBytes ?? defaultMaxBytes,
      options.connectTimeoutMs ?? 10_000,
      options.readTimeoutMs ?? 30_000,
      options.maxRetryDelayMs ?? 60_000,
      options.deadlineMs ?? 30_000,
    ].every(positive) ||
    !Number.isSafeInteger(options.maxBytes ?? defaultMaxBytes) ||
    !Number.isSafeInteger(
      options.maxDecompressedBytes ?? options.maxBytes ?? defaultMaxBytes,
    ) ||
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
        (options.maxRedirects ?? 5) !== 0)) ||
    (options.requestHeaders !== undefined &&
      (options.requestBody === undefined ||
        !Object.entries(options.requestHeaders).every(
          ([name, value]) =>
            /^x-openplans-[a-z0-9-]{1,48}$/.test(name) &&
            typeof value === "string" &&
            /^[\x20-\x7e]{1,512}$/.test(value),
        ))) ||
    ![undefined, "collection", "delivery"].includes(options.purpose) ||
    (options.purpose === "delivery" &&
      (options.requestBody === undefined ||
        options.maxRedirects !== 0 ||
        options.maxAttempts !== 1 ||
        options.deadlineMs === undefined ||
        options.deadlineMs > 5_000))
  )
    throw new FetchError("invalid_options", "Invalid transient fetch options");
}

/** Bounded admitted acquisition without payload, policy-document or snapshot persistence. */
export async function fetchTransient(
  input: string | URL,
  options: TransientFetchOptions,
): Promise<TransientFetchResult> {
  validateOptions(options);
  // Only a validated delivery skips the policy reads and pacing.
  const delivery = options.purpose === "delivery";
  options = {
    ...options,
    expectedContent: options.expectedContent ?? "binary",
  };
  const initial = checkedUrl(input, options.allowHosts);
  assertObservedHostAllowed(initial);
  const dataDir =
    options.dataDir ??
    process.env.OPENPLANS_DATA_DIR ??
    join(homedir(), ".local", "share", "openplans");
  if (!isAbsolute(dataDir))
    throw new FetchError(
      "invalid_options",
      "Data cache directory must be absolute",
    );
  const limit = options.maxBytes ?? defaultMaxBytes;
  const decodedLimit = options.maxDecompressedBytes ?? limit;
  const shipped = shippedManifestPaths();
  const operator = process.env.OPENPLANS_ACCESS_MANIFEST;
  const manifests = operator ? [...shipped, operator] : shipped;
  const admission =
    options.admission ??
    (manifests.length
      ? new AdmissionSession(
          manifests,
          {
            maxRequests: 200,
            maxTransferBytes: Math.max(50 * 1024 ** 2, limit + 4 * 512 * 1024),
          },
          { egressCountry: process.env.OPENPLANS_EGRESS_COUNTRY || undefined },
        )
      : undefined);
  if (!admission)
    throw new FetchError(
      "admission_required",
      "Transient collection requires a reviewed publisher manifest",
    );
  const endAt = Date.now() + (options.deadlineMs ?? 30_000);
  const remaining = () => {
    const ms = endAt - Date.now();
    if (ms <= 0)
      throw new FetchError("read_timeout", "Transient fetch deadline exceeded");
    return ms;
  };
  async function wait<T>(
    operation: Promise<T>,
    timeoutMs: number,
    late?: (value: T) => void | Promise<void>,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    try {
      return await Promise.race([
        operation.then(async (value) => {
          if (expired) await late?.(value);
          return value;
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => {
              expired = true;
              reject(
                new FetchError("read_timeout", "Transient fetch timed out"),
              );
            },
            Math.max(0, Math.min(endAt - Date.now(), timeoutMs)),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function readBody(
    response: FetchResponse,
    url: URL,
    cap: number,
    decodedCap: number,
    retryProbe = false,
    policy = false,
  ): Promise<Buffer> {
    let output: Readable | undefined;
    let transfer: Promise<void> | undefined;
    let transferred = 0;
    let expected: number | undefined;
    try {
      const encoding = (
        header(response.headers, "content-encoding") ?? "identity"
      )
        .trim()
        .toLowerCase();
      if (
        !["identity", "gzip", "deflate", "br"].includes(encoding) ||
        (retryProbe && encoding !== "identity")
      )
        throw new FetchError(
          "unsupported_encoding",
          "Unsupported HTTP content encoding",
        );
      expected = contentLength(response);
      if (expected !== undefined && expected > cap)
        throw new FetchError("too_large", "Publisher body exceeds byte limit");
      const type = header(response.headers, "content-type") ?? "";
      if (
        (retryProbe || (!policy && options.expectedContent !== "binary")) &&
        /(?:text\/html|application\/xhtml\+xml)/i.test(type) &&
        !retryProbe
      )
        throw new FetchError(
          "html_error_page",
          "Publisher returned an HTML error page",
        );
      const probeHtml = htmlProbe(
        !retryProbe && !policy && options.expectedContent !== "binary",
      );
      const probeChallenge = challengeProbe();
      let bytes = 0;
      const chunks: Buffer[] = [];
      const wire = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          try {
            remaining();
            admission!.transferred(url, chunk.length);
            transferred += chunk.length;
            if (transferred > cap)
              throw new FetchError(
                "too_large",
                "Publisher transfer exceeds byte limit",
              );
            if (expected !== undefined && transferred > expected)
              throw new FetchError(
                "truncated",
                "Publisher body differs from Content-Length",
              );
            callback(null, chunk);
          } catch (error) {
            callback(error as Error);
          }
        },
      });
      let decoder;
      if (encoding === "gzip") decoder = createGunzip();
      else if (encoding === "deflate") decoder = createInflate();
      else if (encoding === "br") decoder = createBrotliDecompress();
      output = decoder ?? wire;
      transfer = decoder
        ? pipeline(response.body, wire, decoder)
        : pipeline(response.body, wire);
      void transfer.catch(() => {});
      const iterator = output[Symbol.asyncIterator]();
      for (;;) {
        const item = await wait(
          iterator.next(),
          options.readTimeoutMs ?? 30_000,
        );
        if (item.done) break;
        const chunk = Buffer.isBuffer(item.value)
          ? item.value
          : Buffer.from(item.value as Uint8Array);
        bytes += chunk.length;
        if (bytes > decodedCap)
          throw new FetchError(
            "too_large",
            "Publisher decoded body exceeds byte limit",
          );
        probeChallenge(chunk);
        probeHtml(chunk);
        if (!retryProbe) chunks.push(chunk);
        if (retryProbe && bytes >= Math.min(64 * 1024, cap)) break;
      }
      if (!retryProbe) {
        await wait(transfer, options.readTimeoutMs ?? 30_000);
        if (expected !== undefined && transferred !== expected)
          throw new FetchError(
            "truncated",
            "Publisher body differs from Content-Length",
          );
      }
      if (retryProbe && /(?:text\/html|application\/xhtml\+xml)/i.test(type))
        throw new FetchError(
          "html_error_page",
          "Publisher returned an HTML error page",
        );
      return Buffer.concat(chunks, retryProbe ? 0 : bytes);
    } catch (error) {
      if (error instanceof FetchError) throw error;
      if (
        (header(response.headers, "content-encoding") ?? "identity") !==
        "identity"
      )
        throw new FetchError(
          "truncated",
          "Publisher compressed body is invalid or incomplete",
        );
      if (expected !== undefined && transferred < expected)
        throw new FetchError(
          "truncated",
          "Publisher closed before Content-Length",
        );
      throw new FetchError("network_error", "Publisher stream failed");
    } finally {
      output?.destroy();
      response.body.destroy();
      await transfer?.catch(() => {});
    }
  }

  async function readPolicy(url: URL, delay: number): Promise<PolicyDocument> {
    try {
      const result = await request(url, true, delay);
      return {
        status: result.status,
        sha256: result.sha256,
        text: result.body.toString("utf8"),
        contentType: result.headers["content-type"] ?? null,
      };
    } catch (error) {
      if (
        url.pathname === "/robots.txt" &&
        error instanceof FetchError &&
        error.code === "http_status" &&
        error.evidence?.redirect_chain.length === 0
      ) {
        if (absentRobotsStatuses.includes(error.status ?? 0))
          return {
            status: error.status!,
            sha256: null,
            text: "",
            absent: true,
          };
        if (error.status === 401)
          return {
            status: 401,
            sha256: null,
            text: "",
            unauthorized: true,
            failure: error,
          };
      }
      throw error;
    }
  }

  async function request(
    start: URL,
    policy = false,
    probeDelay = 5000,
  ): Promise<Omit<TransientFetchResult, "admission">> {
    const hosts = policy ? [start.hostname] : options.allowHosts;
    const cap = policy ? 512 * 1024 : limit;
    for (
      let attempt = 0;
      attempt < (policy ? 1 : (options.maxAttempts ?? 3));
      attempt++
    ) {
      let response: FetchResponse | undefined;
      let release: (() => Promise<void>) | undefined;
      let url = start,
        previous: URL | undefined;
      const destinations: URL[] = [start];
      const evidence: FetchEvidence = {
        requested_url: provenanceUrl(start),
        final_url: provenanceUrl(start),
        redirect_chain: [],
        response_headers: {},
        attempts: attempt + 1,
        connect_timeout_ms: options.connectTimeoutMs ?? 10_000,
      };
      try {
        for (;;) {
          remaining();
          evidence.final_url = provenanceUrl(url);
          evidence.response_headers = {};
          delete evidence.address;
          url = checkedUrl(url, hosts);
          assertObservedHostAllowed(url);
          let delay = probeDelay;
          // A delivery checks the manifest entry only: no robots or terms read.
          if (delivery) {
            await wait(admission!.assertCurrent(url), remaining());
            delay = 0;
          } else if (!policy)
            delay = await wait(
              admission!.authorize(url, readPolicy, previous),
              remaining(),
            );
          const address = await wait(
            resolvePublic(
              url,
              options.lookup ?? systemLookup,
              Math.min(remaining(), options.connectTimeoutMs ?? 10_000),
            ),
            remaining(),
          );
          evidence.address = address.address;
          release = delivery
            ? undefined
            : await wait(
                leaseHost(
                  dataDir,
                  url.hostname,
                  delay,
                  policy ? undefined : admission!.pacingFloorMs(url),
                ),
                remaining(),
                (unlock) => unlock(),
              );
          remaining();
          if (!policy) await wait(admission!.assertCurrent(url), remaining());
          admission!.reserveRequest(url);
          const headers: Record<string, string> = {
            "accept-encoding": "identity",
            "user-agent": `openplans/0.4.1 (public health-plan source discovery; +${projectUrl(options)})`,
          };
          if (!policy && options.expectedContent === "json")
            headers.accept = "application/json, */*;q=0.1";
          const upload = policy ? undefined : options.requestBody;
          if (upload) {
            headers["content-type"] = upload.contentType;
            Object.assign(headers, options.requestHeaders);
          }
          if (!policy) options.onRequest?.(url);
          remaining();
          const sent = policy ? url : admission!.credentialUrl(url);
          try {
            response = await wait(
              (options.transport ?? httpsTransport)(sent, {
                address,
                headers,
                connectTimeoutMs: Math.min(
                  remaining(),
                  options.connectTimeoutMs ?? 10_000,
                ),
                readTimeoutMs: Math.min(
                  remaining(),
                  options.readTimeoutMs ?? 30_000,
                ),
                ...(upload && { method: "POST" as const, body: upload.body }),
              }),
              remaining(),
              (late) => {
                late.body.destroy();
              },
            );
          } catch (error) {
            if (error instanceof FetchError) throw error;
            throw new FetchError(
              "network_error",
              "Publisher connection failed",
            );
          }
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
          if (![301, 302, 303, 307, 308].includes(response.status)) break;
          response.body.destroy();
          await release?.();
          release = undefined;
          if (evidence.redirect_chain.length >= (options.maxRedirects ?? 5))
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
            throw new FetchError(
              "invalid_redirect",
              "Invalid publisher redirect",
            );
          }
          evidence.redirect_chain.push(provenanceUrl(next));
          previous = url;
          url = next;
          destinations.push(next);
        }
        if (response.status < 200 || response.status >= 300) {
          if (transientStatuses.has(response.status))
            await readBody(response, url, cap, cap, true);
          throw new FetchError(
            "http_status",
            "Publisher returned an unsuccessful HTTP status",
            response.status,
          );
        }
        const body = await readBody(
          response,
          url,
          cap,
          policy ? cap : decodedLimit,
          false,
          policy,
        );
        if (!policy && !delivery)
          for (const destination of destinations)
            await wait(
              admission!.assertReady(checkedUrl(destination, hosts)),
              remaining(),
            );
        remaining();
        return {
          body,
          sha256: createHash("sha256").update(body).digest("hex"),
          status: response.status,
          headers: evidence.response_headers,
          finalUrl: evidence.final_url,
          redirectChain: [...evidence.redirect_chain],
        };
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
        if (
          policy ||
          !transient ||
          Date.now() >= endAt ||
          attempt + 1 >= (options.maxAttempts ?? 3)
        )
          throw error;
        const delay = retryDelay(response, attempt, options);
        if (delay === undefined) throw error;
        remaining();
        await release?.();
        release = undefined;
        await wait(
          (
            options.sleep ??
            ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
          )(Math.min(delay, remaining())),
          remaining(),
        );
      } finally {
        response?.body.destroy();
        await release?.();
      }
    }
    throw new FetchError("network_error", "Publisher retry budget exhausted");
  }
  try {
    return { ...(await request(initial)), admission: admission.receipt() };
  } catch (error) {
    admission.stop();
    if (error instanceof FetchError) throw error;
    throw new FetchError("network_error", "Transient acquisition failed");
  }
}
