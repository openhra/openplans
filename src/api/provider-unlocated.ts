import type { SqlSession } from "../db/database.js";
import { isQueryTimeout } from "../services/errors.js";
import { SEARCH_KEY_SOURCES } from "./provider-search-keys.js";

/**
 * Exact unlocated counts for identity radius searches without current search keys, one per
 * provider data revision and filter.
 *
 * The count covers every candidate practice address in the database, not only the radius, so
 * it can take longer than one request may wait once many states are loaded. It runs on the
 * database's background connection, outside the request pool, with its own longer limit, and
 * only one count runs at a time. A request that cannot wait for it answers without the count
 * (null, marked unknown); the count keeps running, and the next request for the same filter and
 * revisions reads it. Current search keys (provider-search-keys.ts) give the same count within
 * the search itself.
 */
const COUNT_TIMEOUT_MS = 120_000;
/**
 * A count that ran past its limit is not retried for this long, so it does not run again on
 * every search. Searches meanwhile answer the count as unknown. Other failures are not kept.
 */
const RETRY_AFTER_MS = 600_000;
/** Distinct filter sets kept at once; the oldest goes first. */
const KEPT = 256;

/**
 * Tables a count reads: the search key sources, plus the taxonomy names a specialty filter
 * matches and the geocode attempts operator points join. Writes to any other table, such as
 * plan catalog or fallback writes, leave kept counts and paused retries in place.
 */
export const COUNT_SOURCES = [
  ...SEARCH_KEY_SOURCES,
  "geocode_attempt",
  "provider_taxonomy",
] as const;

/** Revisions of the count's source tables, and the database's own identity row. */
export async function countRevisions(db: SqlSession): Promise<string> {
  const { rows } = await db.query<{ revisions: string | null }>(
    `SELECT string_agg(table_name || ':' || revision::text, ',' ORDER BY table_name) AS revisions
    FROM api_data_generation WHERE table_name IN (${COUNT_SOURCES.map((t) => `'${t}'`).join(",")})
      OR table_name LIKE '\\_\\_database\\_\\_:%'`,
  );
  if (!rows[0]?.revisions)
    throw new Error("Provider data revisions unavailable");
  return rows[0].revisions;
}

interface Kept {
  count: Promise<number>;
  failedAt?: number;
}
interface Counts {
  kept: Map<string, Kept>;
  /** The one count running on the background connection, if any. */
  running?: Promise<unknown>;
}
/** Kept per database object, so two databases in one process never share a count. */
const kept = new WeakMap<SqlSession, Counts>();

export interface UnlocatedCount {
  /** Filter identity: everything the count's SQL depends on besides the data. */
  key: string;
  /** SQL returning one row with an integer `unlocated` column. */
  sql: string;
  parameters: unknown[];
}

/** The exact count, or null when it is not known within `waitMs`. */
export async function cachedUnlocated(
  db: SqlSession,
  count: UnlocatedCount,
  waitMs: number,
): Promise<number | null> {
  const root = db.background ?? db;
  let counts = kept.get(root);
  if (!counts) kept.set(root, (counts = { kept: new Map<string, Kept>() }));
  const key = `${await countRevisions(db)}\n${count.key}`;
  const known = counts.kept;
  let entry = known.get(key);
  if (entry?.failedAt !== undefined) {
    if (Date.now() - entry.failedAt < RETRY_AFTER_MS) return null;
    known.delete(key);
    entry = undefined;
  }
  if (!entry) {
    // Another filter's count holds the background connection: answer unknown and keep
    // nothing, so a later search starts this count once the connection is free.
    if (counts.running) return null;
    const started: Kept = {
      count: root
        .query<{ unlocated: number }>(count.sql, count.parameters, {
          timeoutMs: COUNT_TIMEOUT_MS,
        })
        .then(({ rows }) => Number(rows[0]!.unlocated)),
    };
    entry = started;
    known.set(key, started);
    const running = started.count.then(
      () => {},
      (error: unknown) => {
        if (isQueryTimeout(error)) started.failedAt = Date.now();
        else if (known.get(key) === started) known.delete(key);
      },
    );
    counts.running = running;
    const owner = counts;
    void running.then(() => {
      if (owner.running === running) owner.running = undefined;
    });
    while (known.size > KEPT) known.delete(known.keys().next().value!);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      entry.count,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), waitMs);
      }),
    ]);
  } catch (error) {
    if (isQueryTimeout(error)) return null;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
