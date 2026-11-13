import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import {
  fetchToCache,
  FetchError,
  readCachedText,
  remoteSnapshotStore,
  sidecarNames,
  storeCachedText,
} from "../../fetch/index.js";
import type {
  FetchOptions,
  FetchResult,
  SnapshotMetadata,
} from "../../fetch/index.js";
import { inspectPufArchive } from "./acquire-archive.js";
import type { AcquiredMember } from "./acquire-archive.js";
import { dataDirectory } from "../../config/access.js";

export const PUF_LANDING_URL =
  "https://www.cms.gov/marketplace/resources/data/public-use-files";
export const PUF_KINDS = [
  "plan-attributes",
  "rate",
  "service-area",
  "network",
  "business-rules",
  "benefits-and-cost-sharing",
  "plan-id-crosswalk",
  "machine-readable-url",
] as const;
export type PufKind = (typeof PUF_KINDS)[number];
export const PUF_YEARS = [2026, 2027] as const;
export const SUPPORTED_PUF_YEARS = [2025, ...PUF_YEARS] as const;
const source = "cms-exchange-puf";
const allowHosts = [
  "www.cms.gov",
  "cms.gov",
  "download.cms.gov",
  "data.healthcare.gov",
];

export interface PufLink {
  year: number;
  kind: PufKind;
  url: string | null;
  status: "ok" | "not_published" | "discovery_conflict";
}
export interface PufRecord extends Omit<PufLink, "status"> {
  status: string;
  snapshot_id: string | null;
  sha256: string | null;
  bytes: number | null;
  members: AcquiredMember[];
  issues: string[];
  http_status?: number;
}
export interface PufManifest {
  schema_version: 1;
  publisher: "Centers for Medicare & Medicaid Services";
  created_at: string;
  dry_run: boolean;
  landing_page: SnapshotMetadata;
  files: PufRecord[];
}
export interface AcquireOptions {
  year?: number;
  dryRun?: boolean;
  dataDir?: string;
  /** Trusted offline injection; all production downloads use fetchToCache. */
  fetcher?: typeof fetchToCache;
  now?: () => Date;
}

function decodeHtml(value: string): string {
  return value.replace(
    /&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi,
    (match, entity: string) => {
      const named: Record<string, string> = {
        amp: "&",
        quot: '"',
        apos: "'",
        lt: "<",
        gt: ">",
        nbsp: " ",
      };
      if (!entity.startsWith("#")) return named[entity.toLowerCase()] ?? match;
      const number =
        entity[1]?.toLowerCase() === "x"
          ? parseInt(entity.slice(2), 16)
          : Number(entity.slice(1));
      return number > 0 && number <= 0x10ffff
        ? String.fromCodePoint(number)
        : match;
    },
  );
}
function visible(value: string): string {
  return decodeHtml(value.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}
function identify(value: string): PufKind | undefined {
  const normalized = value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "")
    .replace(/(?:zip|csv|xlsx)$/, "")
    .replace(/puf$/, "");
  return PUF_KINDS.find((kind) => kind.replace(/-/g, "") === normalized);
}

/** Only advertised archive hrefs inside explicit year sections. Never constructs a download URL. */
export function discoverPufs(
  html: string,
  years: readonly number[] = PUF_YEARS,
): PufLink[] {
  const found = new Map<string, Set<string>>();
  const clean = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  const tokens =
    /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>|<a\b([^>]*?)>([\s\S]*?)<\/a\s*>/gi;
  let section: { year: number; level: number } | undefined;
  for (const token of clean.matchAll(tokens)) {
    if (token[1]) {
      const level = Number(token[1]);
      const match = visible(token[2]!).match(
        /^(?:PY\s*)?(20\d{2})\s+Exchange\s+PUF\s+Datasets\b/i,
      );
      if (match) section = { year: Number(match[1]), level };
      else if (section && level <= section.level) section = undefined;
      continue;
    }
    if (!section || !years.includes(section.year)) continue;
    const href = token[3]!.match(
      /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i,
    );
    if (!href) continue;
    let url: URL;
    try {
      url = new URL(
        decodeHtml(href[1] ?? href[2] ?? href[3]!),
        PUF_LANDING_URL,
      );
    } catch {
      continue;
    }
    if (!/\.zip$/i.test(url.pathname)) continue;
    // File names are evidence too: a harmless link-label rename must not hide a published file.
    const labelKind = identify(visible(token[4]!));
    let pathKind: PufKind | undefined;
    try {
      pathKind = identify(decodeURIComponent(url.pathname.split("/").at(-1)!));
    } catch {
      continue;
    }
    const kind = labelKind ?? pathKind;
    if (!kind) continue;
    const key = `${section.year}/${kind}`;
    const candidates = found.get(key) ?? new Set<string>();
    // Explicit disagreement is quarantined, including an href advertising another plan year.
    const pathYears = url.pathname.match(/\b20\d{2}\b/g) ?? [];
    if (
      (labelKind && pathKind && labelKind !== pathKind) ||
      pathYears.some((year) => Number(year) !== section!.year)
    ) {
      candidates.add("conflict");
    } else candidates.add(url.href);
    found.set(key, candidates);
  }
  return years.flatMap((year) =>
    PUF_KINDS.map((kind): PufLink => {
      const urls = found.get(`${year}/${kind}`);
      if (!urls?.size)
        return { year, kind, url: null, status: "not_published" };
      if (urls.size !== 1 || urls.has("conflict"))
        return { year, kind, url: null, status: "discovery_conflict" };
      return { year, kind, url: [...urls][0]!, status: "ok" };
    }),
  );
}

function emptyRecord(link: PufLink): PufRecord {
  return {
    ...link,
    snapshot_id: null,
    sha256: null,
    bytes: null,
    members: [],
    issues: [],
  };
}

// Conditional requests discover CMS republications. On 304 the fetcher re-verifies the cached
// SHA before reuse; a 200 with the same bytes is deduplicated by fetchToCache itself.
async function cachedFetch(
  url: string,
  options: FetchOptions,
  fetcher: typeof fetchToCache,
): Promise<Exclude<FetchResult, { outcome: "not_modified" }>> {
  // Sidecars are read through the store `fetcher` writes to; nothing stored lists nothing.
  const read = { blobStore: options.blobStore };
  let prior: SnapshotMetadata | undefined;
  for (const entry of await sidecarNames(options.dataDir!, source, read)) {
    let metadata: SnapshotMetadata;
    try {
      metadata = JSON.parse(
        await readCachedText(options.dataDir!, source, entry, read),
      ) as SnapshotMetadata;
    } catch {
      throw new FetchError("cache_error", "Cached PUF metadata is unreadable");
    }
    if (
      metadata.url === url &&
      (!prior || metadata.fetched_at > prior.fetched_at)
    )
      prior = metadata;
  }
  const result = await fetcher(url, {
    ...options,
    conditional: prior
      ? {
          ...(prior.etag ? { etag: prior.etag } : {}),
          ...(prior.last_modified ? { lastModified: prior.last_modified } : {}),
        }
      : undefined,
  });
  if (result.outcome !== "not_modified") return result;
  if (!prior)
    throw new FetchError(
      "cache_error",
      "Publisher returned 304 without a prior snapshot",
    );
  const reused = await fetcher(url, {
    ...options,
    expectedSha256: prior.sha256,
  });
  if (reused.outcome === "not_modified")
    throw new FetchError(
      "cache_error",
      "Cached snapshot unavailable after 304",
    );
  return reused;
}

export async function acquirePufs(
  options: AcquireOptions = {},
): Promise<{ manifest: PufManifest; manifestPath: string | null }> {
  if (
    options.year !== undefined &&
    !(SUPPORTED_PUF_YEARS as readonly number[]).includes(options.year)
  ) {
    throw new FetchError(
      "invalid_options",
      "Supported PUF years are 2025, 2026 and 2027",
    );
  }
  const dataDir = options.dataDir ?? dataDirectory();
  if (!isAbsolute(dataDir))
    throw new FetchError(
      "invalid_options",
      "Data cache directory must be absolute",
    );
  const fetcher = options.fetcher ?? fetchToCache;
  const common: FetchOptions = {
    source,
    allowHosts,
    dataDir,
    expectedContent: "zip",
  };
  const landing = await cachedFetch(
    PUF_LANDING_URL,
    { ...common, expectedContent: "binary", maxBytes: 4 * 1024 ** 2 },
    fetcher,
  );
  if (landing.metadata.bytes > 4 * 1024 ** 2)
    throw new FetchError("too_large", "Landing page exceeds byte limit");
  const links = discoverPufs(
    await readFile(landing.path, "utf8"),
    options.year === undefined ? PUF_YEARS : [options.year],
  );
  const manifest: PufManifest = {
    schema_version: 1,
    publisher: "Centers for Medicare & Medicaid Services",
    created_at: (options.now ?? (() => new Date()))().toISOString(),
    dry_run: options.dryRun ?? false,
    landing_page: landing.metadata,
    files: [],
  };
  for (const link of links) {
    const record = emptyRecord(link);
    manifest.files.push(record);
    if (!link.url || options.dryRun) continue;
    try {
      const result = await cachedFetch(link.url, common, fetcher);
      record.snapshot_id = result.snapshotId;
      record.sha256 = result.metadata.sha256;
      record.bytes = result.metadata.bytes;
      record.members = await inspectPufArchive(result.path);
      if (
        !record.members.some(
          (member) => member.format === "csv" || member.format === "xlsx",
        )
      ) {
        record.issues.push("no_csv_or_xlsx_members");
      }
    } catch (error) {
      if (!(error instanceof FetchError)) throw error;
      record.status = error.code;
      if (error.status !== undefined) record.http_status = error.status;
    }
  }
  // Discovery mode snapshots the provenance page but never downloads archives or publishes a manifest.
  if (options.dryRun) return { manifest, manifestPath: null };
  const name = `manifest-${manifest.created_at.replace(/:/g, "-")}.json`;
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  // A manifest lives beside the snapshots it names: in a remote store when snapshots do, so
  // every host sharing the store imports the same set.
  const remote = remoteSnapshotStore(dataDir);
  if (remote)
    return {
      manifest,
      manifestPath: await storeCachedText(remote, source, name, text),
    };
  const directory = join(dataDir, "raw", source);
  await mkdir(directory, { recursive: true });
  const manifestPath = join(directory, name);
  const temporary = join(directory, `.manifest-${randomUUID()}.part`);
  await writeFile(temporary, text, { flag: "wx" });
  await rename(temporary, manifestPath);
  return { manifest, manifestPath };
}

/** Kept here so the shared command router only owns the puf acquire dispatch branch. */
export async function runPufAcquire(
  args: string[],
  output: { out(message: string): void; error(message: string): void },
): Promise<number> {
  const options: AcquireOptions = {};
  for (let at = 0; at < args.length; at++) {
    const flag = args[at];
    if (flag === "--dry-run" && options.dryRun === undefined)
      options.dryRun = true;
    else if (
      flag === "--year" &&
      options.year === undefined &&
      /^(2025|2026|2027)$/.test(args[at + 1] ?? "")
    )
      options.year = Number(args[++at]);
    else {
      output.error(
        "Usage: worker ingest puf acquire [--year 2025|2026|2027] [--dry-run]",
      );
      return 1;
    }
  }
  try {
    const result = await acquirePufs(options);
    output.out(JSON.stringify(result));
    return result.manifest.files.some(
      (file) => !["ok", "not_published"].includes(file.status),
    )
      ? 1
      : 0;
  } catch (error) {
    output.error(
      `worker ingest puf acquire failed: ${error instanceof FetchError ? error.code : "acquisition_error"}`,
    );
    return 1;
  }
}
