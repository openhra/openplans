import { z } from "zod";
import type { SqlSession } from "../db/database.js";
import type { CurrentTelemetry } from "./aggregate.js";
import { BUCKET_MS } from "./aggregate.js";
import {
  alignedBucket,
  HOUR,
  SEVEN_DAYS,
  NINETY_DAYS,
  STORAGE_CAP_BYTES,
  STORED_ROW_BYTES,
} from "./retention.js";

const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const rowSchema = z
  .strictObject({
    transport: z.enum(["http", "mcp"]),
    operation: z.string().regex(/^[a-zA-Z0-9_.:-]{1,120}$/),
    owner: z
      .string()
      .max(120)
      .regex(/^(core|@[a-z0-9._-]+\/[a-z0-9._-]+)$/),
    outcome: z.enum(["completed", "cancelled", "timeout"]),
    statusClass: z.enum(["2xx", "3xx", "4xx", "429", "5xx"]),
    count: counter,
    durationBuckets: z.array(counter).length(12),
  })
  .refine(
    (row) => row.durationBuckets.reduce((sum, n) => sum + n, 0) === row.count,
  );
const histogramSums = Array.from(
  { length: 12 },
  (_, i) => `sum(duration_buckets[${i + 1}])::bigint`,
).join(",");
const columns =
  "boot_id,bucket_start,granularity,transport,operation,owner,outcome,status_class,sample_count,duration_buckets,last_flush_at,drops,flush_gap";

/** Called only inside the writer transaction, never from an observed request. */
export async function writeSnapshot(
  db: SqlSession,
  bootId: string,
  snapshot: CurrentTelemetry,
  now: number,
  gap: boolean,
): Promise<void> {
  z.uuid().parse(bootId);
  const rows = z.array(rowSchema).max(128).parse(snapshot.series);
  counter.parse(snapshot.drops);
  const since = Date.parse(snapshot.since ?? "");
  if (!Number.isFinite(since) || since > now || now - since > SEVEN_DAYS)
    throw new Error("Invalid telemetry interval");
  const bucket = alignedBucket(since, BUCKET_MS);
  for (const row of rows) {
    await db.query(
      `INSERT INTO plg_admin_telemetry (${columns})
      VALUES ($1,$2,'5m',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (boot_id,bucket_start,granularity,transport,operation,owner,outcome,status_class)
      DO UPDATE SET sample_count=EXCLUDED.sample_count,duration_buckets=EXCLUDED.duration_buckets,
        last_flush_at=EXCLUDED.last_flush_at,drops=EXCLUDED.drops,flush_gap=plg_admin_telemetry.flush_gap OR EXCLUDED.flush_gap`,
      [
        bootId,
        bucket,
        row.transport,
        row.operation,
        row.owner,
        row.outcome,
        row.statusClass,
        row.count,
        row.durationBuckets,
        new Date(now),
        snapshot.drops,
        gap,
      ],
    );
  }
  const hour = alignedBucket(since, HOUR);
  // Rebuild only this boot's affected hour. Source buckets are still within seven days.
  await db.query(
    `INSERT INTO plg_admin_telemetry (${columns})
    SELECT boot_id,$2::timestamptz,'1h',transport,operation,owner,outcome,status_class,
      sum(sample_count)::bigint,ARRAY[${histogramSums}],max(last_flush_at),max(drops),bool_or(flush_gap)
    FROM plg_admin_telemetry WHERE boot_id=$1 AND granularity='5m' AND bucket_start >= $2 AND bucket_start < $3
    GROUP BY boot_id,transport,operation,owner,outcome,status_class
    ON CONFLICT (boot_id,bucket_start,granularity,transport,operation,owner,outcome,status_class)
    DO UPDATE SET sample_count=EXCLUDED.sample_count,duration_buckets=EXCLUDED.duration_buckets,
      last_flush_at=EXCLUDED.last_flush_at,drops=EXCLUDED.drops,flush_gap=EXCLUDED.flush_gap`,
    [bootId, hour, new Date(hour.getTime() + HOUR)],
  );
}

export async function trimStorage(
  db: SqlSession,
  now: number,
  capBytes = STORAGE_CAP_BYTES,
): Promise<boolean> {
  if (
    !Number.isSafeInteger(capBytes) ||
    capBytes < STORED_ROW_BYTES ||
    capBytes > STORAGE_CAP_BYTES
  )
    throw new Error("Invalid telemetry storage cap");
  await db.query(
    `DELETE FROM plg_admin_telemetry WHERE
    (granularity='5m' AND bucket_start < $1) OR (granularity='1h' AND bucket_start < $2)`,
    [new Date(now - SEVEN_DAYS), new Date(now - NINETY_DAYS)],
  );
  // A fixed row allocation bounds every stored dimension, including boot metadata and indexes.
  await db.query(
    `DELETE FROM plg_admin_telemetry WHERE ctid IN
    (SELECT ctid FROM plg_admin_telemetry ORDER BY bucket_start DESC,granularity DESC,boot_id DESC,transport,operation,owner,outcome,status_class OFFSET $1)`,
    [Math.floor(capBytes / STORED_ROW_BYTES)],
  );
  const size = await db.query<{ bytes: string }>(
    "SELECT pg_total_relation_size('plg_admin_telemetry')::text AS bytes",
  );
  // DELETE cannot reclaim a PostgreSQL relation's allocated pages. Disposable history is
  // reset if the physical allocation (including indexes/TOAST) reaches the hard cap.
  if (Number(size.rows[0]?.bytes) > STORAGE_CAP_BYTES) {
    await db.exec("TRUNCATE plg_admin_telemetry");
    return true;
  }
  return false;
}

export async function readStored(
  db: SqlSession,
  now: number,
  window: "1h" | "24h" | "7d" | "90d",
) {
  const duration = {
    "1h": HOUR,
    "24h": 24 * HOUR,
    "7d": SEVEN_DAYS,
    "90d": NINETY_DAYS,
  }[window];
  const granularity = window === "90d" ? "1h" : "5m";
  const result = await db.query<{
    transport: "http" | "mcp";
    operation: string;
    owner: string;
    outcome: "completed" | "cancelled" | "timeout";
    status_class: "2xx" | "3xx" | "4xx" | "429" | "5xx";
    count: string;
    buckets: string[];
  }>(
    `SELECT transport,operation,owner,outcome,status_class,sum(sample_count)::text AS count,
    ARRAY[${histogramSums}] AS buckets
    FROM plg_admin_telemetry WHERE granularity=$1 AND bucket_start >= $2 AND bucket_start <= $3
    GROUP BY transport,operation,owner,outcome,status_class ORDER BY transport,operation,owner,outcome,status_class LIMIT 129`,
    [granularity, new Date(now - duration), new Date(now)],
    { timeoutMs: 5000 },
  );
  const metadata = await db.query<{
    since: Date;
    last_flush: Date;
    drops: string;
    instances: string;
    gap: boolean;
  }>(
    `WITH per_boot AS (
    SELECT boot_id,min(bucket_start) AS since,max(last_flush_at) AS last_flush,max(drops) AS drops,
      bool_or(flush_gap) OR count(DISTINCT bucket_start) < 1 + floor(extract(epoch FROM max(bucket_start)-min(bucket_start)) / $4) AS gap
    FROM plg_admin_telemetry WHERE granularity=$1 AND bucket_start >= $2 AND bucket_start <= $3 GROUP BY boot_id
  ) SELECT min(since) AS since,max(last_flush) AS last_flush,sum(drops)::text AS drops,
    count(*)::text AS instances,bool_or(gap) AS gap FROM per_boot`,
    [
      granularity,
      new Date(now - duration),
      new Date(now),
      granularity === "1h" ? 3600 : 300,
    ],
    { timeoutMs: 5000 },
  );
  // More than 128 historical combinations is partial; never return unbounded rows.
  return { rows: result.rows, meta: metadata.rows[0]! };
}
