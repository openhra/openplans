import type { SqlSession } from "./database.js";

/**
 * Advisory lock keys of the two long maintenance jobs, and the check that keeps them apart.
 *
 * A provider-search backfill holds a long REPEATABLE READ snapshot. A concurrent index build
 * waits for every snapshot older than itself, so a migration that runs during a backfill stalls
 * past its lock limit and leaves an invalid index behind. Each job holds its own key for its
 * whole run and refuses to start while the other's key is held.
 */
export const MIGRATION_LOCK = 1869636974;
export const PROVIDER_SEARCH_BUILD_LOCK = 1869636975;

/** One job found the other running. The message is safe to print as is. */
export class MaintenanceConflict extends Error {
  override name = "MaintenanceConflict";
}

export const BACKFILL_RUNNING =
  "worker backfill provider-search is running on this database. Its long snapshot would stall a concurrent index build until the build gives up and leaves an invalid index. Run worker migrate again after the backfill ends.";
export const MIGRATION_RUNNING =
  "worker migrate is running on this database. Run worker backfill provider-search again after it finishes.";

/**
 * True when another session holds `key`. Takes and releases the key at once, so call it only
 * while holding your own job's key: a job that starts afterwards then finds that key held.
 */
async function heldElsewhere(session: SqlSession, key: number) {
  const { rows } = await session.query<{ free: boolean }>(
    `SELECT pg_try_advisory_lock(${key}) AS free`,
  );
  if (!rows[0]?.free) return true;
  await session.query(`SELECT pg_advisory_unlock(${key})`);
  return false;
}

/** For a migration holding MIGRATION_LOCK: refuse while a backfill runs. */
export async function refuseDuringBackfill(session: SqlSession) {
  if (await heldElsewhere(session, PROVIDER_SEARCH_BUILD_LOCK))
    throw new MaintenanceConflict(BACKFILL_RUNNING);
}

/** For a backfill holding PROVIDER_SEARCH_BUILD_LOCK: refuse while a migration runs. */
export async function refuseDuringMigration(session: SqlSession) {
  if (await heldElsewhere(session, MIGRATION_LOCK))
    throw new MaintenanceConflict(MIGRATION_RUNNING);
}

/**
 * Whether a backfill holds its key, read from pg_locks without taking any lock, for the
 * migration preflight. A bigint advisory key below 2^32 is classid 0, objid key, objsubid 1.
 */
export async function backfillRunning(session: SqlSession): Promise<boolean> {
  const { rows } = await session.query<{ running: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND granted
      AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
      AND classid=0 AND objid=${PROVIDER_SEARCH_BUILD_LOCK} AND objsubid=1
      AND pid<>pg_backend_pid()) AS running`,
  );
  return rows[0]?.running === true;
}
