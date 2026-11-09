import { homedir } from "node:os";
import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Database } from "../../db/database.js";
import { checkedUrl, fetchToCache, FetchError } from "../../fetch/index.js";
import type {
  FetchOptions,
  FetchResult,
  SnapshotMetadata,
} from "../../fetch/index.js";
import { provenanceUrl } from "../../fetch/policy.js";
import { JsonStreamError, readJsonValue } from "../json/index.js";
import {
  cachedRegistry,
  readRegistry,
  registryWorkbook,
  verifyRegistry,
} from "./discover-registry.js";
import type { RegistryInput } from "./discover-registry.js";
import {
  saveDiscoveryIndex,
  saveDiscoverySnapshot,
} from "./discover-repository.js";
import type { DiscoveryChild, DiscoveryIndex } from "./discover-repository.js";

export const qhpDataDirectory = () =>
  process.env.OPENPLANS_DATA_DIR ??
  join(homedir(), ".local", "share", "openplans");
const kinds = ["plan_urls", "provider_urls", "formulary_urls"] as const;
type Cached = Exclude<FetchResult, { outcome: "not_modified" }>;
export interface DiscoverOptions {
  year: number;
  state: string;
  dataDir?: string;
  /** Trusted test dependencies. Production always uses P1a's manifest and fetchToCache. */
  registry?: RegistryInput;
  fetcher?: typeof fetchToCache;
  fetchOptions?: Pick<
    FetchOptions,
    | "lookup"
    | "transport"
    | "maxAttempts"
    | "connectTimeoutMs"
    | "readTimeoutMs"
    | "sleep"
    | "random"
    | "projectUrl"
  >;
}
export interface IssuerDiscoveryReport {
  issuer: string;
  status: string;
  index_statuses: string[];
  plan_urls: number;
  provider_urls: number;
  formulary_urls: number;
  downloaded: number;
  child_failures: number;
}
export interface DiscoveryReport {
  discovery_id: string;
  year: number;
  state: string;
  registry_snapshot_id: string;
  issuers: IssuerDiscoveryReport[];
}
function errorStatus(error: unknown): string {
  if (
    error instanceof FetchError &&
    error.code === "http_status" &&
    error.status === 403
  )
    return "access_denied";
  if (error instanceof FetchError)
    return error.code === "http_status" &&
      [404, 410].includes(error.status ?? 0)
      ? "not_published"
      : error.code;
  if (error instanceof JsonStreamError) return error.code;
  if (error instanceof SyntaxError) return "invalid_json";
  return "invalid_index";
}
function host(input: string): string | null {
  try {
    return new URL(input).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
}
function safeUrl(input: string): string {
  try {
    return provenanceUrl(new URL(input));
  } catch {
    return "[invalid_url]";
  }
}
function publisherMetadata(
  input: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    [
      "last_updated_on",
      "last_updated",
      "version",
      "years",
      "plan_years",
      "plan_year",
    ]
      .filter((key) => Object.hasOwn(input, key))
      .map((key) => [key, input[key]]),
  );
}

/** Conditional refresh; a 304 re-verifies the content hash through fetchToCache. */
async function cachedFetch(
  url: string,
  options: FetchOptions,
  fetcher: typeof fetchToCache,
): Promise<Cached> {
  let entries: string[] = [];
  const directory = join(options.dataDir!, "raw", options.source);
  try {
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let prior: SnapshotMetadata | undefined;
  for (const entry of entries.filter((name) => name.endsWith(".meta.json"))) {
    const metadata = JSON.parse(
      await readFile(join(directory, entry), "utf8"),
    ) as SnapshotMetadata;
    if (
      !new URL(url).search &&
      metadata.url === safeUrl(url) &&
      (!prior || metadata.fetched_at > prior.fetched_at)
    )
      prior = metadata;
  }
  const conditional = prior
    ? {
        etag: prior.etag ?? undefined,
        lastModified: prior.last_modified ?? undefined,
      }
    : undefined;
  const result = await fetcher(url, { ...options, conditional });
  if (result.outcome !== "not_modified") return result;
  if (!prior)
    throw new FetchError("cache_error", "304 without a prior QHP snapshot");
  const reused = await fetcher(url, {
    ...options,
    expectedSha256: prior.sha256,
  });
  if (reused.outcome === "not_modified")
    throw new FetchError("cache_error", "QHP snapshot unavailable after 304");
  return reused;
}

function parseIndex(value: unknown): {
  children: (DiscoveryChild & { fetchUrl: string })[];
  metadata: Record<string, unknown>;
} {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_index");
  const index = value as Record<string, unknown>;
  if (!kinds.some((kind) => Array.isArray(index[kind])))
    throw new Error("invalid_index");
  const children: (DiscoveryChild & { fetchUrl: string })[] = [];
  for (const kind of kinds) {
    if (index[kind] === undefined) continue; // Absence is no claim of coverage/completeness.
    if (!Array.isArray(index[kind])) throw new Error("invalid_index");
    const seen = new Set<string>();
    for (const entry of index[kind]) {
      const record =
        typeof entry === "string"
          ? { url: entry }
          : (entry as Record<string, unknown> | null);
      if (!record || typeof record.url !== "string" || record.url.length > 8192)
        throw new Error("invalid_index");
      // Older indexes advertise HTTP. Request only the same resource over TLS, recording
      // both published and effective URLs; never follow or send a plaintext request.
      let fetchUrl = record.url;
      try {
        const upgraded = new URL(fetchUrl);
        if (upgraded.protocol === "http:" && !upgraded.port) {
          upgraded.protocol = "https:";
          fetchUrl = upgraded.href;
        }
      } catch {
        /* classified by checkedUrl below */
      }
      const url = safeUrl(fetchUrl);
      const urlSha256 = createHash("sha256").update(record.url).digest("hex");
      if (seen.has(urlSha256)) continue;
      seen.add(urlSha256);
      let status = "discovered";
      try {
        checkedUrl(fetchUrl, [host(fetchUrl) ?? ""]);
      } catch (error) {
        status = errorStatus(error);
      }
      children.push({
        kind,
        url,
        urlSha256,
        publishedUrl: safeUrl(record.url),
        fetchUrl,
        host: host(fetchUrl),
        snapshot: null,
        status,
        metadata: publisherMetadata(record),
      });
    }
  }
  return { children, metadata: publisherMetadata(index) };
}

export async function discoverQhp(
  db: Database,
  options: DiscoverOptions,
): Promise<DiscoveryReport> {
  if (
    !Number.isInteger(options.year) ||
    options.year < 2014 ||
    options.year > 2100 ||
    !/^[A-Z]{2}$/.test(options.state)
  )
    throw new Error("Invalid discovery scope");
  const dataDir = options.dataDir ?? qhpDataDirectory();
  if (!isAbsolute(dataDir)) throw new Error("Absolute data directory required");
  const registry =
    options.registry ?? (await cachedRegistry(dataDir, options.year));
  await verifyRegistry(registry);
  const rows = await readRegistry(
    await registryWorkbook(registry, dataDir),
    options.state,
  );
  const registryId = `qhp:registry:${registry.metadata.sha256}`;
  await saveDiscoverySnapshot(
    db,
    "qhp-registry",
    registryId,
    registry.metadata,
    registry.path,
    null,
    [registry.metadata.url],
    "PARSED",
    [host(registry.metadata.url)!],
  );
  const discovery = randomUUID(),
    fetcher = options.fetcher ?? fetchToCache;
  const report: DiscoveryReport = {
    discovery_id: discovery,
    year: options.year,
    state: options.state,
    registry_snapshot_id: registryId,
    issuers: [],
  };
  for (const issuer of [...new Set(rows.map((row) => row.issuer))].sort()) {
    const issuerRows = rows.filter((row) => row.issuer === issuer);
    const pufHosts = [
      ...new Set(
        issuerRows
          .map((row) => host(row.url))
          .filter((value): value is string => !!value),
      ),
    ].sort();
    const summary: IssuerDiscoveryReport = {
      issuer,
      status: "ok",
      index_statuses: [],
      plan_urls: 0,
      provider_urls: 0,
      formulary_urls: 0,
      downloaded: 0,
      child_failures: 0,
    };
    // A registry may submit several index URLs for one issuer; retain every source row.
    for (const row of issuerRows) {
      const index: DiscoveryIndex = {
        id: `${discovery}:${row.row}`,
        discovery,
        issuer,
        year: options.year,
        state: options.state,
        registrySnapshot: registryId,
        row: row.row,
        url: row.url ? safeUrl(row.url) : null,
        snapshot: null,
        status: row.url ? "ok" : "not_published",
        pufHosts,
        childHosts: [],
        metadata: {},
      };
      let children: (DiscoveryChild & { fetchUrl: string })[] = [];
      let result: Cached | undefined;
      if (row.url) {
        try {
          result = await cachedFetch(
            row.url,
            {
              connectTimeoutMs: 30_000,
              ...options.fetchOptions,
              source: `qhp-${issuer}-${options.year}-index`,
              dataDir,
              allowHosts: pufHosts,
              expectedContent: "json",
              maxBytes: 4 * 1024 ** 2,
            },
            fetcher,
          );
          index.httpStatus = result.metadata.status;
          index.snapshot = `qhp:${issuer}:${options.year}:index:${result.metadata.sha256}`;
          const parsed = parseIndex(
            await readJsonValue(createReadStream(result.path), {
              maxDepth: 32,
              maxElementBytes: 4 * 1024 ** 2,
            }),
          );
          children = parsed.children;
          index.metadata = parsed.metadata;
          index.childHosts = [
            ...new Set(
              children
                .map((child) => child.host)
                .filter((value): value is string => !!value),
            ),
          ].sort();
        } catch (error) {
          index.status = errorStatus(error);
          if (error instanceof FetchError) {
            index.httpStatus = error.status;
            index.metadata = {
              fetch_evidence: error.evidence ?? null,
              provider_status: "unknown",
              drug_status: "unknown",
            };
          }
        }
      }
      if (result && index.snapshot)
        await saveDiscoverySnapshot(
          db,
          `qhp-${issuer}-${options.year}-index`,
          index.snapshot,
          result.metadata,
          result.path,
          issuer,
          [{ registry_snapshot_id: registryId, row: row.row }],
          index.status === "ok" ? "PARSED" : "QUARANTINED",
          [...pufHosts, ...index.childHosts],
        );
      const allowHosts = [...new Set([...pufHosts, ...index.childHosts])];
      for (const child of children) {
        summary[child.kind]++;
        // This lane intentionally leaves provider shards alone. Downloaded children await adapter validation.
        if (
          issuer === "76589" &&
          child.kind !== "provider_urls" &&
          child.status === "discovered"
        ) {
          try {
            const cached = await cachedFetch(
              child.fetchUrl,
              {
                ...options.fetchOptions,
                source: `qhp-${issuer}-${options.year}-${child.kind}`,
                dataDir,
                allowHosts,
                expectedContent: "json",
                maxBytes: 2 * 1024 ** 3,
              },
              fetcher,
            );
            child.snapshot = `qhp:${issuer}:${options.year}:${child.kind}:${cached.metadata.sha256}`;
            await saveDiscoverySnapshot(
              db,
              `qhp-${issuer}-${options.year}-${child.kind}`,
              child.snapshot,
              cached.metadata,
              cached.path,
              issuer,
              [{ index_snapshot_id: index.snapshot, kind: child.kind }],
              "FETCHING",
              allowHosts,
            );
            child.httpStatus = cached.metadata.status;
            child.status = "downloaded";
            summary.downloaded++;
          } catch (error) {
            child.status = errorStatus(error);
            if (error instanceof FetchError) child.httpStatus = error.status;
          }
        }
        if (!["discovered", "downloaded"].includes(child.status))
          summary.child_failures++;
      }
      await db.transaction((tx) => saveDiscoveryIndex(tx, index, children));
      summary.index_statuses.push(index.status);
    }
    const failures = summary.index_statuses.filter((status) => status !== "ok");
    if (failures.length) {
      if (summary.index_statuses.length === 1) {
        summary.status = failures[0]!;
      } else {
        summary.status = "partial";
      }
    } else if (summary.child_failures) {
      summary.status = "child_failure";
    } else {
      summary.status = "ok";
    }
    report.issuers.push(summary);
  }
  return report;
}
