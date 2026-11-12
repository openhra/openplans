import type {
  AcquiredFile,
  AdmittedFetch,
  AdmittedPostRequest,
  PluginManifest,
} from "@openplans/plugin-sdk";
import { AdmissionSession } from "../fetch/admission.js";
import { fetchToCache } from "../fetch/cache.js";
import type { FetchOptions } from "../fetch/cache.js";
import { FetchError } from "../fetch/errors.js";
import { checkedUrl, provenanceUrl } from "../fetch/policy.js";
import { fetchTransient } from "../fetch/transient.js";
import type { TransientFetchOptions } from "../fetch/transient.js";
import { httpsTransport } from "../fetch/transport.js";
import type { Transport } from "../fetch/transport.js";
import { scopeForbidsStorage } from "./request-scope.js";

/** Deadline for one plugin POST, from start to the last response byte. */
export const POST_DEADLINE_MS = 5_000;
const RESPONSE_MAX_BYTES = 64 * 1024;
/** One worker command run shares one admission session and this budget across its GETs. */
export const COMMAND_FETCH_BUDGET = Object.freeze({
  maxRequests: 200,
  maxTransferBytes: 512 * 1024 ** 2,
});

export interface PluginFetchSettings {
  /** Reviewed admission manifests: the shipped ones plus the operator's. */
  manifestPaths: readonly string[];
  dataDir?: string;
  projectUrl?: string;
  egressCountry?: string;
  /** Tests only: a transport and a DNS lookup. */
  testing?: Pick<TransientFetchOptions, "transport" | "lookup">;
}

const unavailable = () =>
  Promise.reject(new Error("Not available to plugin event handlers"));
const aborted = () =>
  new FetchError("aborted", "The worker command stopped the request");

/**
 * A transport that `signal` stops: the connection closes, a pending response is refused and a
 * response body still streaming ends with `aborted`. It does not rely on the wrapped transport
 * honouring the signal.
 */
export function abortableTransport(
  base: Transport,
  signal: AbortSignal,
): Transport {
  return (url, context) => {
    if (signal.aborted) return Promise.reject(aborted());
    return new Promise((resolve, reject) => {
      let settled = false;
      const refuse = () => {
        if (settled) return;
        settled = true;
        reject(aborted());
      };
      signal.addEventListener("abort", refuse, { once: true });
      base(url, { ...context, signal }).then(
        (response) => {
          signal.removeEventListener("abort", refuse);
          if (settled) return void response.body.destroy();
          settled = true;
          const end = () => response.body.destroy(aborted());
          signal.addEventListener("abort", end, { once: true });
          response.body.once("close", () =>
            signal.removeEventListener("abort", end),
          );
          resolve(response);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", refuse);
          if (settled) return;
          settled = true;
          reject(signal.aborted ? aborted() : error);
        },
      );
    });
  };
}

/** Rejects with `aborted` as soon as `signal` aborts, also while a host lease is pending. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(aborted());
    signal.addEventListener("abort", stop, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", stop));
  });
}

function declaredHosts(manifest: PluginManifest): readonly string[] {
  return Object.freeze([...(manifest.capabilities?.network ?? [])]);
}

function postFor(
  manifest: PluginManifest,
  settings: PluginFetchSettings,
  signal?: AbortSignal,
): NonNullable<AdmittedFetch["post"]> {
  const hosts = declaredHosts(manifest);
  const transport =
    signal &&
    abortableTransport(settings.testing?.transport ?? httpsTransport, signal);
  return async (url: string, request: AdmittedPostRequest) => {
    if (hosts.length === 0 || settings.manifestPaths.length === 0)
      throw new FetchError(
        "admission_required",
        "Plugin declared no admitted network host",
      );
    if (signal?.aborted) throw aborted();
    // A fresh session per post: it reads the manifest and holds no state between deliveries.
    const admission = new AdmissionSession(
      settings.manifestPaths,
      { maxRequests: 1, maxTransferBytes: 16 * 1024 ** 2 },
      { egressCountry: settings.egressCountry },
    );
    const result = await fetchTransient(url, {
      ...settings.testing,
      ...(transport && { transport }),
      purpose: "delivery",
      admission,
      allowHosts: hosts,
      dataDir: settings.dataDir,
      projectUrl: settings.projectUrl,
      expectedContent: "binary",
      maxBytes: RESPONSE_MAX_BYTES,
      maxRedirects: 0,
      maxAttempts: 1,
      deadlineMs: POST_DEADLINE_MS,
      requestBody: {
        contentType: request.contentType,
        body: Buffer.from(request.body),
      },
      ...(request.headers && { requestHeaders: request.headers }),
    });
    return { status: result.status };
  };
}

/**
 * The fetch a plugin's event handlers receive. `post` is a delivery to an operator-declared
 * endpoint, not data collection: `fetchTransient` with `purpose: "delivery"` skips the robots and
 * terms reads and the per-host pacing. It still goes only to the plugin's declared network hosts,
 * each `allowed` in the manifest, with no redirect, one attempt (the outbox retries) and a 5 s
 * deadline. Bodies, URLs and headers are never logged here.
 */
export function pluginFetch(
  manifest: PluginManifest,
  settings: PluginFetchSettings,
): AdmittedFetch {
  const fetch: AdmittedFetch = () => unavailable();
  fetch.post = postFor(manifest, settings);
  return Object.freeze(fetch);
}

const contents = {
  csv: { memory: "csv", stored: "csv" },
  json: { memory: "json", stored: "json" },
  binary: { memory: "binary", stored: "binary" },
  // Kept in memory a ZIP is never unpacked, so it is plain bytes there. A stored one is checked.
  zip: { memory: "binary", stored: "zip" },
  xlsx: { memory: "binary", stored: "zip" },
} as const;

/** Cache directory name for a plugin's stored GETs: `plugin-` and the name in safe characters. */
export function commandCacheSource(name: string): string {
  return `plugin-${name.replace(/^@/, "").replace(/[^a-z0-9._-]/gi, "-")}`.slice(
    0,
    128,
  );
}

/**
 * The fetch one plugin worker command run receives (`ctx.fetch`). A GET goes only to the
 * plugin's declared `capabilities.network` hosts; any other host is refused before a manifest
 * read, DNS lookup or connection. It then takes the full collection path: the reviewed admission
 * manifest, robots.txt and terms, per-host pacing and the shared byte budget of the run.
 *
 * A plugin that declared `capabilities.writes` with "cache" stores its GETs with `fetchToCache`
 * under `raw/plugin-<name>/`. Every other GET, and any GET inside a `none` or `request` scope,
 * uses `fetchTransient`: the body comes back in memory and nothing but the host lease's pacing
 * state is written. `signal` (the run's `ctx.signal`) stops a request in flight. `post` keeps the
 * delivery rules of `pluginFetch`, and `signal` stops it too.
 */
export function pluginCommandFetch(
  manifest: PluginManifest,
  settings: PluginFetchSettings,
  signal: AbortSignal,
): AdmittedFetch {
  const hosts = declaredHosts(manifest);
  const stores = manifest.capabilities?.writes?.includes("cache") ?? false;
  const transport = abortableTransport(
    settings.testing?.transport ?? httpsTransport,
    signal,
  );
  const lookup = settings.testing?.lookup;
  const source = commandCacheSource(manifest.name);
  let admission: AdmissionSession | undefined;

  const inMemory = async (
    url: string,
    target: URL,
    content: keyof typeof contents,
    request: Parameters<AdmittedFetch>[1],
    session: AdmissionSession,
    allowHosts: readonly string[],
  ): Promise<AcquiredFile> => {
    const result = await fetchTransient(target, {
      transport,
      ...(lookup && { lookup }),
      admission: session,
      allowHosts,
      dataDir: settings.dataDir,
      projectUrl: settings.projectUrl,
      expectedContent: contents[content].memory,
      maxBytes: request.maxBytes,
    });
    if (
      request.expectedSha256 !== undefined &&
      result.sha256 !== request.expectedSha256
    )
      throw new FetchError(
        "snapshot_conflict",
        "Downloaded hash differs from expected snapshot hash",
      );
    return Object.freeze({
      url,
      path: "",
      sha256: result.sha256,
      bytes: result.body.length,
      snapshotId: result.sha256,
      metadata: Object.freeze({
        snapshot_id: result.sha256,
        source,
        url: provenanceUrl(target),
        final_url: result.finalUrl,
        redirect_chain: Object.freeze([...result.redirectChain]) as string[],
        status: result.status,
        content_type: result.headers["content-type"] ?? null,
        // Not among the headers an in-memory fetch keeps: unknown, not absent.
        etag: null,
        last_modified: null,
        sha256: result.sha256,
        bytes: result.body.length,
        fetched_at: new Date().toISOString(),
        access_policy: structuredClone(result.admission),
      }),
      body: result.body,
    });
  };

  const stored = async (
    url: string,
    target: URL,
    content: keyof typeof contents,
    request: Parameters<AdmittedFetch>[1],
    session: AdmissionSession,
    allowHosts: readonly string[],
  ): Promise<AcquiredFile> => {
    const options: FetchOptions = {
      transport,
      ...(lookup && { lookup }),
      admission: session,
      allowHosts,
      source,
      dataDir: settings.dataDir,
      projectUrl: settings.projectUrl,
      expectedContent: contents[content].stored,
      maxBytes: request.maxBytes,
      ...(request.expectedSha256 !== undefined && {
        expectedSha256: request.expectedSha256,
      }),
    };
    const result = await fetchToCache(target, options);
    if (result.outcome === "not_modified")
      throw new FetchError("cache_error", "A stored GET needs a response body");
    return Object.freeze({
      url,
      path: result.path,
      sha256: result.metadata.sha256,
      bytes: result.metadata.bytes,
      snapshotId: result.snapshotId,
      metadata: Object.freeze(structuredClone(result.metadata)),
    });
  };

  const fetch: AdmittedFetch = async (url, request) => {
    if (signal.aborted) throw aborted();
    const allowHosts = hosts;
    if (allowHosts.length === 0)
      throw new FetchError(
        "admission_required",
        "Plugin declared no admitted network host",
      );
    // Refused here, before the manifest, DNS or any connection.
    const target = checkedUrl(url, allowHosts);
    const content = request?.expectedContent;
    if (
      typeof content !== "string" ||
      !Object.hasOwn(contents, content) ||
      !Number.isSafeInteger(request.maxBytes) ||
      request.maxBytes <= 0 ||
      (request.expectedSha256 !== undefined &&
        !/^[a-f0-9]{64}$/.test(request.expectedSha256))
    )
      throw new FetchError("invalid_options", "Invalid plugin fetch options");
    if (settings.manifestPaths.length === 0)
      throw new FetchError(
        "admission_required",
        "Plugin fetch requires a reviewed publisher manifest",
      );
    admission ??= new AdmissionSession(
      settings.manifestPaths,
      { ...COMMAND_FETCH_BUDGET },
      { egressCountry: settings.egressCountry },
    );
    // The request scope's cache level wins over the plugin's declaration.
    const acquire = stores && !scopeForbidsStorage() ? stored : inMemory;
    return untilAborted(
      acquire(url, target, content, request, admission, allowHosts),
      signal,
    );
  };
  fetch.post = postFor(manifest, settings, signal);
  return Object.freeze(fetch);
}
