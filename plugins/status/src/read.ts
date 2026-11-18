import { eventPayloadSchemas } from "@openplans/plugin-sdk";
import type {
  CacheLevel,
  CoreConfigView,
  HostPluginEntry,
  SqlSession,
  StatusHost as SdkStatusHost,
} from "@openplans/plugin-sdk";
import { healthStateSchema } from "./probe.js";
import type { HealthEntry } from "./probe.js";
import { AVAILABILITY_STATUSES } from "./views.js";

type AvailabilityStatus = (typeof AVAILABILITY_STATUSES)[number];

/** Values only the host knows; the host supplies them through `createStatusPlugin({ host })`. */
export type StatusHost = SdkStatusHost;
export type PluginEntry = HostPluginEntry;

export interface AvailabilityRow {
  state: string;
  year: number;
  market: string | null;
  issuer_id: string | null;
  catalog: AvailabilityStatus;
  premium: AvailabilityStatus;
  provider: AvailabilityStatus;
  formulary: AvailabilityStatus;
  snapshot_id: string | null;
}

export interface PassthroughRow {
  id: string;
  /** null when unknown: the budget row outlives the plugin that made it. */
  enabled: boolean | null;
  level: CacheLevel | "unknown";
  /** null when the budget row could not be read. */
  exhausted: boolean | null;
  dailyRequests: number;
  maxDailyRequests: number;
  blockedUntil: Date | null;
  hitRate: number | null;
}

/**
 * Where a source's publisher date came from. `latest_of_files` is a rollup snapshot with no date
 * of its own: the latest date of the file snapshots it records, given only when every one of
 * them has a date.
 */
export type PublishedFrom =
  "release_date" | "last_modified" | "latest_of_files";

export interface SourceRow {
  id: string;
  /** When OpenPlans downloaded this copy. */
  retrieved: Date | null;
  snapshotId: string;
  /** The publisher's date for this copy, `YYYY-MM-DD`; null when none was recorded. */
  published: string | null;
  publishedFrom: PublishedFrom | null;
  /** How many file snapshots a `latest_of_files` date was taken from; absent otherwise. */
  publishedFiles?: number;
}

/** The snapshot columns a publisher date can come from, as the source query reads them. */
export interface SnapshotDates {
  /** `publisher_updated_at` as a calendar date: a release date, version date or data date. */
  publisher_date: string | null;
  /** The HTTP Last-Modified header the publisher's server sent with the file. */
  last_modified: string | null;
  /** The UTC calendar date of `retrieved_at`. */
  retrieved_date: string | null;
  schema_version: string | null;
}

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;
// Medicare release snapshots imported before the fix stored the retrieval date as the release
// date when the file name carried no date and the server sent no Last-Modified. That date is
// ours, not the publisher's. New imports store null in that case; this guard covers older rows,
// which are never rewritten.
const RETRIEVAL_STANDS_IN = /^cms-medicare-/;

/**
 * The publisher's date for one snapshot, from what the import recorded. A release or data date
 * comes first, then the Last-Modified header. Nothing is inferred: with neither, it is null.
 */
export function publisherDate(row: SnapshotDates): {
  published: string | null;
  publishedFrom: PublishedFrom | null;
} {
  const release = row.publisher_date;
  const standIn =
    RETRIEVAL_STANDS_IN.test(row.schema_version ?? "") &&
    !row.last_modified &&
    release === row.retrieved_date;
  if (release && CALENDAR_DATE.test(release) && !standIn)
    return { published: release, publishedFrom: "release_date" };
  const modified = row.last_modified ? Date.parse(row.last_modified) : NaN;
  if (!Number.isNaN(modified))
    return {
      published: new Date(modified).toISOString().slice(0, 10),
      publishedFrom: "last_modified",
    };
  return { published: null, publishedFrom: null };
}

/**
 * The publisher date for a snapshot that may be a rollup. `files` are the file snapshots the
 * data records under it (`puf_import_file`, `state_community_rate`). A snapshot's own date always
 * wins. Without one, a rollup takes the latest date of its files, but only when every file has
 * a date: one undated file makes the rollup unknown, never a partial maximum.
 */
export function rollupPublisherDate(
  row: SnapshotDates,
  files: readonly SnapshotDates[],
): Pick<SourceRow, "published" | "publishedFrom" | "publishedFiles"> {
  const own = publisherDate(row);
  if (own.published !== null || !files.length) return own;
  const known = files
    .map((file) => publisherDate(file).published)
    .filter((published): published is string => published !== null);
  if (known.length < files.length) return own;
  return {
    published: known.sort().at(-1)!,
    publishedFrom: "latest_of_files",
    publishedFiles: files.length,
  };
}

/** One read of everything the status page shows. Both serialisers work from this. */
export interface StatusData {
  now: Date;
  version: string | null;
  db: "ok" | "down";
  poolWaiting: number | null;
  availability: AvailabilityRow[] | null;
  sources: SourceRow[] | null;
  ingests:
    | {
        source: string;
        lastSuccess: Date | null;
        reasonCodes: string[];
        durationsMs: number[];
      }[]
    | null;
  cache: {
    enabled: boolean;
    backend: string;
    stats: {
      hits: number | null;
      misses: number | null;
      bypasses: number | null;
      bytes: number | null;
    } | null;
  };
  passthrough: PassthroughRow[] | null;
  plugins: PluginEntry[];
  events: { type: string; time: Date; payload: unknown }[] | null;
  health: { lastChange: Date | null; history: HealthEntry[] } | null;
}

export interface ReadSettings {
  config: Readonly<CoreConfigView>;
  host: StatusHost;
  /** The plugin_state owner, the plugin's manifest name. */
  plugin: string;
  now: Date;
}

/** The core's CMS fallback; it keeps one budget row in `cms_api_budget`. */
export const CMS_FALLBACK_ID = "cms-marketplace-api";
const CACHE_LEVELS: readonly CacheLevel[] = [
  "none",
  "request",
  "memory",
  "stored",
];
const RECENT_EVENTS = 20;
const INGEST_DETAIL = 5;
const INGEST_SCAN = 1000;
const NPM_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

function date(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const parsed = new Date(value as string);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function status(value: unknown): AvailabilityStatus {
  return (AVAILABILITY_STATUSES as readonly unknown[]).includes(value)
    ? (value as AvailabilityStatus)
    : "unknown";
}

function finite(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function count(value: number | undefined): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : null;
}

const SHA256 = /^[a-f0-9]{64}$/;
const NPM_VERSION = /^[0-9A-Za-z.+-]{1,64}$/;

/** Host entries pass only names, versions and hashes that cannot carry a location. */
function hostPlugins(entries: readonly PluginEntry[]): PluginEntry[] {
  return entries.map((entry) => ({
    name: NPM_NAME.test(entry.name) ? entry.name : "local plugin",
    version:
      entry.version && NPM_VERSION.test(entry.version) ? entry.version : null,
    apiVersion:
      entry.apiVersion && NPM_VERSION.test(entry.apiVersion)
        ? entry.apiVersion
        : null,
    sha256: entry.sha256 && SHA256.test(entry.sha256) ? entry.sha256 : null,
    enabled: entry.enabled === true,
  }));
}

async function attempt<T>(run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch {
    return null;
  }
}

// Strings that could name a file, a host or a mailbox never reach the page, even in payloads.
const LOCATION_LIKE = /[/\\@]|:\/\/|\.(?:com|org|net|io|local|internal)\b/i;
export function redactLocations(value: unknown): unknown {
  if (typeof value === "string")
    return LOCATION_LIKE.test(value) ? "<redacted>" : value;
  if (Array.isArray(value)) return value.map(redactLocations);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        redactLocations(child),
      ]),
    );
  return value;
}

function eventPayload(type: string, payload: unknown): unknown {
  const schema = (
    eventPayloadSchemas as Record<
      string,
      (typeof eventPayloadSchemas)[keyof typeof eventPayloadSchemas]
    >
  )[type];
  const parsed = schema?.safeParse(payload);
  return parsed?.success ? redactLocations(parsed.data) : null;
}

function configuredPlugins(config: Readonly<CoreConfigView>): PluginEntry[] {
  return config.plugins
    .filter((entry) => entry.enabled)
    .map((entry) => ({
      // A local plugin is named by its path; the page shows only that it is local.
      name: NPM_NAME.test(entry.package) ? entry.package : "local plugin",
      version: null,
      apiVersion: null,
      sha256: null,
      enabled: true,
    }));
}

function hostPluginList(host: StatusHost): PluginEntry[] | undefined {
  const entries = host.plugins?.();
  return entries ? hostPlugins(entries) : undefined;
}

// The snapshot columns `publisherDate` reads, selected from `snapshot`.
const SNAPSHOT_DATES = `snapshot.publisher_updated_at::date::text AS publisher_date,
  snapshot.last_modified, snapshot.schema_version,
  to_char(snapshot.retrieved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS retrieved_date`;
const text = (value: unknown) => (typeof value === "string" ? value : null);
const snapshotDates = (row: Record<string, unknown>): SnapshotDates => ({
  publisher_date: text(row.publisher_date),
  last_modified: text(row.last_modified),
  retrieved_date: text(row.retrieved_date),
  schema_version: text(row.schema_version),
});

const SOURCE_PROJECTION_MAX_ROWS = 4096;
const SOURCE_PROJECTION_MAX_BYTES = 1024 * 1024;

interface SourceProjection {
  rows: SourceRow[];
  complete: boolean;
}

type SourceRead = (db: SqlSession) => Promise<SourceProjection>;

async function readSources(db: SqlSession): Promise<SourceProjection> {
  const { rows } = await db.query(`
      SELECT DISTINCT ON (source_id) source_id, retrieved_at, snapshot_id,
        ${SNAPSHOT_DATES}
      FROM snapshot WHERE validation_state = 'ACTIVE'
      ORDER BY source_id, retrieved_at DESC NULLS LAST, snapshot_id`);
  const undated = rows
    .filter((row) => publisherDate(snapshotDates(row)).published === null)
    .map((row) => String(row.snapshot_id));
  // The file snapshots behind each undated rollup. If they cannot be read, the rows keep
  // their own (unknown) dates.
  const files = new Map<string, SnapshotDates[]>();
  let complete = true;
  if (undated.length) {
    const children = await attempt(() =>
      db.query(
        `WITH edge AS (
            SELECT import_id AS parent, snapshot_id AS child FROM puf_import_file
            WHERE import_id = ANY($1::text[])
            UNION SELECT import_id, publication_snapshot_id FROM state_community_rate
            WHERE import_id = ANY($1::text[]))
          SELECT edge.parent, ${SNAPSHOT_DATES}
          FROM edge LEFT JOIN snapshot ON snapshot.snapshot_id = edge.child`,
        [undated],
      ),
    );
    complete = children !== null;
    for (const row of children?.rows ?? []) {
      const parent = String(row.parent);
      const dates = files.get(parent) ?? [];
      dates.push(snapshotDates(row));
      files.set(parent, dates);
    }
  }
  return {
    complete,
    rows: rows.map((row): SourceRow => ({
      id: String(row.source_id),
      retrieved: date(row.retrieved_at),
      snapshotId: String(row.snapshot_id),
      ...rollupPublisherDate(
        snapshotDates(row),
        files.get(String(row.snapshot_id)) ?? [],
      ),
    })),
  };
}

/** One bounded source projection, invalidated by freshly read publication revisions. */
export function sourceDateMemo(): SourceRead {
  let memo:
    { generation: string; projection: Promise<SourceProjection> } | undefined;
  return async (db) => {
    const revision = await attempt(() =>
      db.query(`
      SELECT md5(string_agg(table_name || ':' || revision::text, ','
        ORDER BY table_name COLLATE "C")) AS generation
      FROM api_data_generation
      WHERE table_name IN ('snapshot', 'puf_import_file', 'state_community_rate')
        OR starts_with(table_name, '__database__:')
      HAVING count(*) = 4`),
    );
    const generation = text(revision?.rows[0]?.generation);
    if (!generation) {
      memo = undefined;
      return readSources(db);
    }
    let entry = memo;
    const shared = entry?.generation === generation;
    if (!entry || !shared) {
      const fresh = { generation, projection: readSources(db) };
      memo = entry = fresh;
      fresh.projection.then(
        (result) => {
          if (
            memo === fresh &&
            (!result.complete ||
              result.rows.length > SOURCE_PROJECTION_MAX_ROWS ||
              Buffer.byteLength(JSON.stringify(result.rows)) >
                SOURCE_PROJECTION_MAX_BYTES)
          )
            memo = undefined;
        },
        () => {
          if (memo === fresh) memo = undefined;
        },
      );
    }
    let result: SourceProjection;
    try {
      result = await entry.projection;
    } catch (error) {
      if (!shared) throw error;
      result = await readSources(db);
    }
    return {
      ...result,
      rows: result.rows.map((row) => ({
        ...row,
        retrieved: row.retrieved && new Date(row.retrieved.getTime()),
      })),
    };
  };
}

/** Reads the status once. A part that cannot be read is `null`; the page still renders. */
export async function readStatus(
  db: SqlSession,
  settings: ReadSettings,
  sourceRead: SourceRead = readSources,
): Promise<StatusData> {
  const { config, host, now } = settings;
  const up = (await attempt(() => db.query("SELECT 1"))) !== null;
  const read = <T>(run: () => Promise<T>) =>
    up ? attempt(run) : Promise.resolve(null);

  // The host's availability service applies every derived status `/v1/data-availability`
  // serves. The plugin never reads the stored table itself; without the service it cannot tell.
  const service = host.dataAvailability;
  const availability = service
    ? await read(async () =>
        (await service(db)).map((row): AvailabilityRow => ({
          state: String(row.state),
          year: Number(row.year),
          market: row.market === null ? null : String(row.market),
          issuer_id: row.issuer_id === null ? null : String(row.issuer_id),
          catalog: status(row.catalog),
          premium: status(row.premium),
          provider: status(row.provider),
          formulary: status(row.formulary),
          snapshot_id:
            row.snapshot_id === null ? null : String(row.snapshot_id),
        })),
      )
    : null;

  const sources = await read(async () => (await sourceRead(db)).rows);

  const ingests = await read(async () => {
    const { rows } = await db.query(
      `SELECT event_type, emitted_at, payload->>'sourceId' AS source,
              payload->>'reasonCode' AS reason, payload->>'durationMs' AS duration
       FROM plugin_event_outbox
       WHERE event_type IN ('ingest.completed', 'ingest.failed')
       ORDER BY emitted_at DESC, event_id
       LIMIT ${INGEST_SCAN}`,
    );
    const bySource = new Map<
      string,
      NonNullable<StatusData["ingests"]>[number]
    >();
    for (const row of rows) {
      if (typeof row.source !== "string") continue;
      const entry = bySource.get(row.source) ?? {
        source: row.source,
        lastSuccess: null,
        reasonCodes: [],
        durationsMs: [],
      };
      bySource.set(row.source, entry);
      if (row.event_type === "ingest.completed") {
        entry.lastSuccess ??= date(row.emitted_at);
        const duration = Number(row.duration);
        if (
          Number.isSafeInteger(duration) &&
          duration >= 0 &&
          entry.durationsMs.length < INGEST_DETAIL
        )
          entry.durationsMs.push(duration);
      } else if (
        typeof row.reason === "string" &&
        entry.reasonCodes.length < INGEST_DETAIL
      )
        entry.reasonCodes.push(String(redactLocations(row.reason)));
    }
    return [...bySource.values()].sort((a, b) =>
      a.source.localeCompare(b.source),
    );
  });

  const today = now.toISOString().slice(0, 10);
  const budgetRow = (
    id: string,
    row: Record<string, unknown> | undefined,
    enabled: boolean | null,
    level: PassthroughRow["level"],
  ): PassthroughRow => {
    const blocked = date(row?.blocked_until);
    const daily = Number(row?.daily_requests ?? 0);
    const max = Number(row?.max_daily_requests ?? 0);
    return {
      id,
      enabled,
      level,
      exhausted: row
        ? (row.day === today && daily >= max) ||
          (blocked !== null && blocked.getTime() > now.getTime())
        : null,
      dailyRequests: daily,
      maxDailyRequests: max,
      // The column defaults to the epoch, which means "never blocked".
      blockedUntil: blocked && blocked.getTime() > 0 ? blocked : null,
      hitRate: finite(host.passthroughHitRate?.(id)),
    };
  };
  const cms = await read(async () => {
    const { rows } = await db.query(
      `SELECT day_start::text AS day, daily_requests, max_daily_requests, blocked_until
       FROM cms_api_budget WHERE singleton`,
    );
    // The fallback writes its answers to tables.
    return [
      budgetRow(CMS_FALLBACK_ID, rows[0], config.cmsFallback.enabled, "stored"),
    ];
  });
  // Pass-through sources get a budget row on their first call. The level is the one their
  // last call used; the configured override stands in when no call is recorded.
  const overrides = new Map<string, CacheLevel>();
  for (const entry of config.plugins)
    for (const [id, source] of Object.entries(entry.sources))
      if (source.cacheLevel) overrides.set(id, source.cacheLevel);
  const plugged = await read(async () => {
    const { rows } = await db.query(
      `SELECT b.source_id, b.day_start::text AS day, b.daily_requests, b.max_daily_requests,
              b.blocked_until,
              (SELECT a.level FROM passthrough_attempt a WHERE a.source_id = b.source_id
                ORDER BY a.attempt_id DESC LIMIT 1) AS level
       FROM passthrough_budget b ORDER BY b.source_id`,
    );
    return rows.map((row) => {
      const id = String(row.source_id);
      const level = CACHE_LEVELS.includes(row.level as CacheLevel)
        ? (row.level as CacheLevel)
        : (overrides.get(id) ?? "unknown");
      return budgetRow(id, row, host.passthroughEnabled?.(id) ?? null, level);
    });
  });
  const passthrough =
    cms || plugged ? [...(cms ?? []), ...(plugged ?? [])] : null;

  const events = await read(async () => {
    const { rows } = await db.query(
      `SELECT event_type, emitted_at, payload FROM plugin_event_outbox
       ORDER BY emitted_at DESC, event_id LIMIT ${RECENT_EVENTS}`,
    );
    return rows.map((row) => ({
      type: String(row.event_type),
      time: date(row.emitted_at) ?? new Date(0),
      payload: eventPayload(String(row.event_type), row.payload),
    }));
  });

  const health = await read(async () => {
    const { rows } = await db.query(
      "SELECT value FROM plugin_state WHERE plugin = $1 AND key = 'health'",
      [settings.plugin],
    );
    const parsed = healthStateSchema.safeParse(rows[0]?.value);
    if (!parsed.success) return { lastChange: null, history: [] };
    const history = parsed.data.history;
    return { lastChange: date(history[0]?.at ?? null), history };
  });

  const stats = host.cacheStats?.();
  return {
    now,
    version: host.version?.() ?? null,
    db: up ? "ok" : "down",
    poolWaiting: count(host.poolWaiting?.()),
    availability,
    sources,
    ingests,
    cache: {
      enabled: config.cache.enabled,
      backend: config.cache.provider,
      stats: stats
        ? {
            hits: count(stats.hits),
            misses: count(stats.misses),
            bypasses: count(stats.bypasses),
            bytes: count(stats.bytes),
          }
        : null,
    },
    passthrough,
    plugins: hostPluginList(host) ?? configuredPlugins(config),
    events,
    health,
  };
}
