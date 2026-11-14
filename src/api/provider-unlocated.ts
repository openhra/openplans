import { dataGeneration } from "./cache/generation.js";
import type { SqlSession } from "../db/database.js";

/**
 * Exact unlocated counts for identity radius searches, one per data generation and filter.
 *
 * The count covers every candidate practice address in the database, not only the radius, so
 * it can take longer than one request may wait once many states are loaded. It runs on the
 * unscoped database with its own longer limit and is kept until the data generation changes.
 * A request that cannot wait for it answers a query timeout; the count keeps running, and the
 * next request for the same filter and generation reads it.
 */
const COUNT_TIMEOUT_MS = 120_000;
/** Distinct filter sets kept at once; the oldest goes first. */
const KEPT = 256;
/** Kept per database object, so two databases in one process never share a count. */
const kept = new WeakMap<SqlSession, Map<string, Promise<number>>>();

export interface UnlocatedCount {
  /** Filter identity: everything the count's SQL depends on besides the data. */
  key: string;
  /** SQL returning one row with an integer `unlocated` column. */
  sql: string;
  parameters: unknown[];
}

export class UnlocatedPending extends Error {
  constructor() {
    super("Query read timeout");
  }
}

export async function cachedUnlocated(
  db: SqlSession,
  count: UnlocatedCount,
  waitMs: number,
): Promise<number> {
  const root = db.background ?? db;
  let counts = kept.get(root);
  if (!counts) kept.set(root, (counts = new Map()));
  const key = `${await dataGeneration(db)}\n${count.key}`;
  let pending = counts.get(key);
  if (!pending) {
    pending = root
      .query<{ unlocated: number }>(count.sql, count.parameters, {
        timeoutMs: COUNT_TIMEOUT_MS,
      })
      .then(({ rows }) => Number(rows[0]!.unlocated));
    counts.set(key, pending);
    pending.catch(() => counts.delete(key));
    while (counts.size > KEPT) counts.delete(counts.keys().next().value!);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new UnlocatedPending()), waitMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
