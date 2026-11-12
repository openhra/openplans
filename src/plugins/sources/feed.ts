import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  FEED_REASON_CODE,
  FEED_SOURCE_ID,
  FEED_TABLE_NAME,
  feedPlanSchema,
} from "@openplans/plugin-sdk";
import type {
  AcquiredFile,
  AdmittedFetch,
  EventRegistry,
  FeedContext,
  FeedPlan,
  FeedSource,
  SnapshotMetadata as SdkSnapshotMetadata,
} from "@openplans/plugin-sdk";
import type { Database, SqlSession } from "../../db/database.js";
import {
  AdmissionSession,
  checkedUrl,
  FetchError,
  fetchToCache,
  readCachedText,
  shippedManifestPaths,
  sidecarNames,
} from "../../fetch/index.js";
import type {
  FetchOptions,
  Lookup,
  SnapshotMetadata,
  Transport,
} from "../../fetch/index.js";
import { provenanceUrl } from "../../fetch/policy.js";
import { hostRefusal, readPublishers } from "../hosts.js";

/**
 * Core-only settings for one feed run. None of these reach the plugin, which sees only the
 * `FeedContext`. Tests inject a transport, a lookup and a manifest here.
 */
export interface FeedRunOptions {
  /**
   * The plugin's `capabilities.network` hosts. Every host the source lists must be one of them;
   * left out, the run is refused.
   */
  declaredHosts?: readonly string[];
  /** Data cache directory; defaults to `OPENPLANS_DATA_DIR`. */
  dataDir?: string;
  /** Reviewed access manifests; defaults to the shipped ones plus `OPENPLANS_ACCESS_MANIFEST`. */
  manifestPaths?: readonly string[];
  transport?: Transport;
  lookup?: Lookup;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Fetch attempts per file; defaults to the fetch layer's own default. */
  maxAttempts?: number;
  events?: EventRegistry;
  output?: { out(message: string): void; error(message: string): void };
  now?: () => Date;
}

/** One line on stdout after an activation. Ids and counts only. */
export interface FeedRunSummary {
  source: string;
  snapshot_ids: string[];
  rows: number;
}

/** A failure the core reports by code. Messages from plugin code are never printed. */
/** The database, or a function that opens it once the host checks and the plan have passed. */
export type FeedDatabase = Database | (() => Promise<Database>);

class FeedFailure extends Error {
  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

const SECRET_KEY =
  /authorization|credential|password|secret|token|api[-_]?key|cookie/i;
const consoleOutput = {
  out: (message: string) => console.log(message),
  error: (message: string) => console.error(message),
};
const noEvents: EventRegistry = Object.freeze({
  on() {
    throw new Error("Register event handlers during setup");
  },
  emit: () => Promise.reject(new Error("Events are not available here yet")),
});

const dataDirectory = () =>
  process.env.OPENPLANS_DATA_DIR ??
  join(homedir(), ".local", "share", "openplans");

function defaultManifests(): readonly string[] {
  const operator = process.env.OPENPLANS_ACCESS_MANIFEST;
  return [...shippedManifestPaths(), ...(operator ? [operator] : [])];
}

// The fetch layer validates zip containers; an xlsx workbook is one.
const fetchContent = (
  content: FeedPlan["files"][number]["expectedContent"],
): FetchOptions["expectedContent"] => (content === "xlsx" ? "zip" : content);

const reason = (code: unknown, fallback: string) =>
  typeof code === "string" && FEED_REASON_CODE.test(code) ? code : fallback;
const fetchReason = (error: unknown, fallback: string) =>
  error instanceof FetchError ? `fetch_${error.code}` : fallback;

const quoted = (table: string) =>
  table
    .split(".")
    .map((part) => `"${part}"`)
    .join(".");

function frozenFile(file: AcquiredFile): AcquiredFile {
  return Object.freeze({
    ...file,
    metadata: Object.freeze(structuredClone(file.metadata)),
  });
}

/**
 * The hash of the newest cached copy of `url` under this source, for a plan file with
 * `cache: "content"`. Any copy counts, whatever directory it was stored under.
 */
async function earlierCopy(
  dataDir: string,
  sourceId: string,
  url: string,
): Promise<string | undefined> {
  // Sidecars are read through the fetch cache's store, local or remote.
  let newest: SnapshotMetadata | undefined;
  for (const name of await sidecarNames(dataDir, sourceId).catch(
    () => [] as string[],
  )) {
    let meta: SnapshotMetadata;
    try {
      meta = JSON.parse(
        await readCachedText(dataDir, sourceId, name),
      ) as SnapshotMetadata;
    } catch {
      continue;
    }
    if (meta.source !== sourceId || meta.url !== url) continue;
    if (!newest || meta.fetched_at > newest.fetched_at) newest = meta;
  }
  // The fetch layer re-hashes the cached payload before it is reused.
  return newest?.sha256;
}

function checkShape(source: FeedSource): void {
  if (
    source?.kind !== "feed" ||
    typeof source.id !== "string" ||
    !FEED_SOURCE_ID.test(source.id) ||
    typeof source.publisher !== "string" ||
    !source.publisher.trim() ||
    !Array.isArray(source.hosts) ||
    !source.hosts.length ||
    !source.hosts.every((host) => typeof host === "string" && host) ||
    typeof source.plan !== "function" ||
    typeof source.stage !== "function" ||
    typeof source.validate !== "function"
  )
    throw new FeedFailure("feed_source_invalid");
}

/** Runs a plugin hook; anything it throws becomes `code`, without its message. */
async function hook<T>(code: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof FeedFailure) throw error;
    throw new FeedFailure(code);
  }
}

async function insertSource(db: SqlSession, source: FeedSource) {
  await db.query(
    `INSERT INTO source(source_id,publisher,source_kind) VALUES ($1,$2,'feed')
     ON CONFLICT(source_id) DO NOTHING`,
    [source.id, source.publisher],
  );
}

async function recordFetched(
  db: SqlSession,
  snapshotId: string,
  metadata: SdkSnapshotMetadata,
  path: string,
) {
  await db.query(
    `UPDATE snapshot SET final_url=$2, redirect_chain=$3::jsonb, retrieved_at=$4, http_status=$5, etag=$6,
       last_modified=$7, content_type=$8, compressed_bytes=$9, uncompressed_bytes=$10, sha256=$11, raw_path=$12,
       expected_children=1, fetched_children=1, validation_state='PARSED'
     WHERE snapshot_id=$1 AND validation_state='FETCHING'`,
    [
      snapshotId,
      metadata.final_url,
      JSON.stringify(metadata.redirect_chain),
      metadata.fetched_at,
      metadata.status,
      metadata.etag,
      metadata.last_modified,
      metadata.content_type,
      metadata.transferred_bytes ?? metadata.bytes,
      metadata.bytes,
      metadata.sha256,
      path,
    ],
  );
}

/** Core readiness (design 5.10.1). Every touched table needs its change trigger, and required tables need rows. */
async function readiness(
  tx: SqlSession,
  plan: FeedPlan,
  tables: readonly string[],
  snapshotIds: readonly string[],
) {
  for (const table of tables) {
    const { rows } = await tx.query<{ triggers: number | string }>(
      `SELECT count(*) AS triggers FROM pg_trigger
       WHERE tgrelid = to_regclass($1) AND tgname = 'api_data_changed' AND NOT tgisinternal
         AND tgenabled IN ('O','A') AND tgtype = 60 AND tgfoid = to_regproc('bump_api_data_generation')`,
      [table],
    );
    if (Number(rows[0]?.triggers ?? 0) < 1)
      throw new FeedFailure("readiness_change_trigger_missing");
  }
  for (const table of plan.requireRows ?? []) {
    if (!tables.includes(table))
      throw new FeedFailure("readiness_table_not_staged");
    const { rows } = await tx.query<{ present: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM ${quoted(table)} WHERE sourced_slug = ANY($1::text[])) AS present`,
      [snapshotIds],
    );
    if (rows[0]?.present !== true) throw new FeedFailure("readiness_no_rows");
  }
}

/**
 * Marks this run's snapshots QUARANTINED with one error issue each, so the snapshot trigger's
 * event carries the reason. Snapshots that are not this run's, the previous ACTIVE one among
 * them, are never touched.
 */
async function quarantine(
  db: Database,
  source: FeedSource,
  snapshotIds: readonly string[],
  reasonCode: string,
) {
  if (!snapshotIds.length) return;
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO quality_issue(source_id,snapshot_id,severity,issue_code,explanation)
       SELECT $1, id, 'error', $2, 'Feed run stopped before activation'
       FROM unnest($3::text[]) AS id`,
      [source.id, reasonCode, snapshotIds],
    );
    await tx.query(
      `UPDATE snapshot SET validation_state='QUARANTINED'
       WHERE snapshot_id = ANY($1::text[]) AND source_id = $2 AND validation_state IN ('FETCHING','PARSED')`,
      [snapshotIds, source.id],
    );
  });
}

/**
 * `worker ingest <source>` for one feed source (design 5.10.1): plan, fetch every file through
 * one admission session, record FETCHING then PARSED snapshots, then stage, validate, check
 * readiness, run `beforeActivate` and activate in one transaction. Any failure quarantines this
 * run's snapshots and returns 1.
 */
export async function runFeedSource(
  source: FeedSource,
  args: readonly string[],
  database: FeedDatabase,
  options: FeedRunOptions = {},
): Promise<number> {
  const output = options.output ?? consoleOutput;
  const now = options.now ?? (() => new Date());
  const id = typeof source?.id === "string" ? source.id : "unknown";
  // `detail` is only ever the core's own admission text, never plugin output.
  const fail = (code: string, detail?: string) => {
    output.error(
      JSON.stringify({
        source: id,
        code: "feed_run_failed",
        reason: code,
        ...(detail ? { detail } : {}),
      }),
    );
    return 1;
  };
  try {
    checkShape(source);
  } catch (error) {
    return fail((error as FeedFailure).reasonCode);
  }
  const parsed = source.command?.args?.safeParse?.([...args]);
  if (!parsed?.success) {
    output.error(source.command?.usage ?? "Usage: worker ingest");
    return 1;
  }

  const dataDir = options.dataDir ?? dataDirectory();
  const manifests = options.manifestPaths ?? defaultManifests();
  if (!manifests.length) return fail("admission_required");
  let admission: AdmissionSession;
  try {
    admission = new AdmissionSession(manifests);
  } catch (error) {
    return fail(fetchReason(error, "admission_invalid"));
  }
  const hosts = Object.freeze([...source.hosts]);

  // 0. Before any request or database use: every source host is one the plugin declared, and
  // each is allowed by the loaded manifests. The admission session still checks every URL.
  const declared = options.declaredHosts ?? [];
  if (hosts.some((host) => !declared.includes(host)))
    return fail("source_host_undeclared");
  const publishers = await readPublishers(manifests);
  if (!publishers) return fail("admission_invalid");
  for (const host of hosts) {
    const refusal = hostRefusal(host, publishers, Date.now());
    if (refusal) return fail("fetch_admission_denied", refusal.message);
  }

  const transport: Pick<
    FetchOptions,
    "admission" | "transport" | "lookup" | "sleep" | "maxAttempts" | "dataDir"
  > = {
    admission,
    dataDir,
    ...(options.transport ? { transport: options.transport } : {}),
    ...(options.lookup ? { lookup: options.lookup } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.maxAttempts ? { maxAttempts: options.maxAttempts } : {}),
  };

  let planning = true;
  const fetch: AdmittedFetch = async (url, request) => {
    if (!planning)
      throw new Error("Feed fetch is available only while planning");
    const result = await fetchToCache(url, {
      ...transport,
      source: `${source.id}-pages`,
      allowHosts: hosts,
      expectedContent: fetchContent(request.expectedContent),
      maxBytes: request.maxBytes,
      ...(request.expectedSha256
        ? { expectedSha256: request.expectedSha256 }
        : {}),
    });
    if (result.outcome === "not_modified")
      throw new Error("Feed fetch needs a response body");
    return frozenFile({
      url,
      path: result.path,
      sha256: result.metadata.sha256,
      bytes: result.metadata.bytes,
      snapshotId: result.snapshotId,
      metadata: result.metadata,
    });
  };
  const context: FeedContext = Object.freeze({
    source,
    dataDir,
    fetch,
    log: (entry: Record<string, string | number | boolean | null>) => {
      if (Object.keys(entry).some((key) => SECRET_KEY.test(key)))
        throw new Error("Feed log keys may not name credentials");
      output.error(JSON.stringify({ ...entry, source: source.id }));
    },
    events: options.events ?? noEvents,
  });

  // 1. Plan, then check every URL against the source's hosts and the reviewed manifests before
  // any file request is sent.
  let plan: FeedPlan;
  try {
    const proposed = await hook("plan_failed", () =>
      source.plan(context, parsed.data),
    );
    const checked = feedPlanSchema.safeParse(proposed);
    if (!checked.success) throw new FeedFailure("plan_invalid");
    plan = checked.data;
    for (const file of plan.files) {
      try {
        await admission.assertCurrent(checkedUrl(file.url, hosts));
      } catch (error) {
        throw new FeedFailure(fetchReason(error, "plan_url_refused"));
      }
    }
  } catch (error) {
    return fail(reason((error as FeedFailure).reasonCode, "plan_failed"));
  } finally {
    planning = false;
  }

  // 2. Source and snapshot receipts, then the files.
  let db: Database;
  try {
    db = typeof database === "function" ? await database() : database;
  } catch {
    return fail("database_unavailable");
  }
  const stamp = now()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const run = randomBytes(4).toString("hex");
  const snapshotIds = plan.files.map(
    (_, index) => `${source.id}.${stamp}.${run}.${index + 1}`,
  );
  const acquired: AcquiredFile[] = [];
  try {
    await db.transaction(async (tx) => {
      await insertSource(tx, source);
      for (const [index, file] of plan.files.entries())
        await tx.query(
          `INSERT INTO snapshot(snapshot_id,source_id,requested_url,validation_state,expected_children)
           VALUES ($1,$2,$3,'FETCHING',1)`,
          [snapshotIds[index], source.id, checkedUrl(file.url, hosts).href],
        );
    });
  } catch {
    return fail("snapshot_record_failed");
  }

  try {
    for (const [index, file] of plan.files.entries()) {
      const snapshotId = snapshotIds[index]!;
      // A content-addressed file is stored under its hash, and an earlier copy of the same URL is
      // reused. The plan's own hash comes first: an earlier copy with other content is not used.
      const content = file.cache === "content";
      const expectedSha256 =
        file.expectedSha256 ??
        (content
          ? await earlierCopy(
              dataDir,
              source.id,
              provenanceUrl(checkedUrl(file.url, hosts)),
            )
          : undefined);
      let result;
      try {
        result = await fetchToCache(file.url, {
          ...transport,
          source: source.id,
          ...(content ? {} : { snapshotId }),
          allowHosts: hosts,
          expectedContent: fetchContent(file.expectedContent),
          maxBytes: file.maxBytes,
          ...(expectedSha256 ? { expectedSha256 } : {}),
        });
      } catch (error) {
        throw new FeedFailure(fetchReason(error, "fetch_failed"));
      }
      if (result.outcome === "not_modified")
        throw new FeedFailure("fetch_not_modified");
      await recordFetched(db, snapshotId, result.metadata, result.path);
      acquired.push(
        frozenFile({
          url: file.url,
          path: result.path,
          sha256: result.metadata.sha256,
          bytes: result.metadata.bytes,
          snapshotId,
          metadata: result.metadata,
        }),
      );
    }

    // 3. One transaction: stage, validate, core readiness, beforeActivate, activation.
    const rows = await db.transaction(async (tx) => {
      const staged = await hook("stage_failed", () =>
        source.stage(
          context,
          Object.freeze([...acquired]) as AcquiredFile[],
          tx,
        ),
      );
      if (
        !Number.isSafeInteger(staged?.rows) ||
        staged.rows < 0 ||
        !Array.isArray(staged.tables) ||
        !staged.tables.every(
          (table) => typeof table === "string" && FEED_TABLE_NAME.test(table),
        )
      )
        throw new FeedFailure("stage_result_invalid");
      const tables = [...new Set(staged.tables)];
      const verdict = await hook("validate_failed", () =>
        source.validate(context, tx),
      );
      if (verdict?.ok !== true)
        throw new FeedFailure(
          reason(
            (verdict as { reasonCode?: unknown } | undefined)?.reasonCode,
            "validate_failed",
          ),
        );
      await readiness(tx, plan, tables, snapshotIds);
      if (source.beforeActivate)
        await hook("before_activate_failed", () =>
          source.beforeActivate!(context, tx, [...snapshotIds]),
        );
      const activated = await tx.query<{ snapshot_id: string }>(
        `UPDATE snapshot SET validation_state='ACTIVE', activated_at=now()
         WHERE snapshot_id = ANY($1::text[]) AND source_id = $2 AND validation_state = 'PARSED'
         RETURNING snapshot_id`,
        [snapshotIds, source.id],
      );
      if (activated.rows.length !== snapshotIds.length)
        throw new FeedFailure("activation_incomplete");
      return staged.rows;
    });
    const summary: FeedRunSummary = {
      source: source.id,
      snapshot_ids: snapshotIds,
      rows,
    };
    output.out(JSON.stringify(summary));
    return 0;
  } catch (error) {
    const code =
      error instanceof FeedFailure
        ? reason(error.reasonCode, "feed_failed")
        : "feed_failed";
    try {
      await quarantine(db, source, snapshotIds, code);
    } catch {
      output.error(
        JSON.stringify({ source: id, code: "feed_quarantine_failed" }),
      );
    }
    return fail(code);
  }
}
