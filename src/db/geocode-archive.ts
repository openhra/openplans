import type { Database, SqlSession } from "./database.js";

/**
 * The data half of migration 20261120123130_geocode_match_archive.
 *
 * The migration only changes the catalog: it drops the address_point -> geocode_attempt foreign
 * key, creates the archive and adds both checks NOT VALID, so its locks last milliseconds. This
 * moves the existing `Match` attempts into the archive in small transactions, then validates the
 * checks. Nothing here takes a lock that conflicts with a reader's ACCESS SHARE:
 *
 * - each batch takes ROW EXCLUSIVE on geocode_attempt and the archive, and SHARE ROW EXCLUSIVE
 *   (DISABLE TRIGGER) on the archive and geocode_attempt for its own transaction;
 * - VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE.
 *
 * Readers of every version only read unresolved attempts (`Tie`, `No_Match`, rejected) and
 * address points, so their answers are the same before, during and after the move. A batch moves
 * rows with one DELETE ... RETURNING feeding the archive INSERT, so a row is in exactly one table
 * at every commit. Rerunning resumes: it moves whatever `Match` rows remain and skips archive rows
 * that already exist. Holds the geocoder advisory key, so no geocoder runs meanwhile.
 */

/** The statewide geocoders' key; compact takes it too. */
const GEOCODER_LOCK = 1869636988;
export const ARCHIVE_BATCH_ROWS = 5_000;
export const ARCHIVE_PAUSE_MS = 50;

export interface ArchiveBackfillOptions {
  /** Matched rows per transaction. */
  batchRows?: number;
  /** Sleep between batches, leaving the database to other sessions. */
  pauseMs?: number;
  onBatch?: (batch: { moved: number; total: number }) => void | Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  /** Test hook, inside every transaction just before its commit. */
  beforeCommit?: (session: SqlSession) => Promise<void>;
}

export interface ArchiveBackfillResult {
  moved: number;
  batches: number;
  validated: string[];
  elapsed_ms: number;
}

export class GeocodeArchivePending extends Error {
  override name = "GeocodeArchivePending";
}

export const ARCHIVE_PENDING =
  "Geocode archive backfill required; run worker migrate, then worker backfill geocode-archive, before geocoding";

const CHECKS = [
  ["geocode_attempt", "geocode_attempt_unresolved"],
  ["address_point", "address_point_source_identity"],
] as const;

const checkState = `SELECT c.conname AS name, c.convalidated AS valid FROM pg_constraint c
  WHERE c.contype='c' AND (c.conrelid,c.conname) IN (
    (to_regclass('public.geocode_attempt'),'geocode_attempt_unresolved'),
    (to_regclass('public.address_point'),'address_point_source_identity'))`;

/**
 * True once the archive migration ran and the backfill validated both checks; geocoders refuse
 * to write before then. Validation survives excluding the archive from an artifact.
 */
export async function geocodeArchiveReady(db: SqlSession): Promise<boolean> {
  const { rows } = await db.query<{ name: string; valid: boolean }>(checkState);
  return rows.length === CHECKS.length && rows.every((row) => row.valid);
}

/** Refuses a geocoder write before the backfill finished. */
export async function refuseGeocodeArchivePending(db: SqlSession) {
  if (!(await geocodeArchiveReady(db)))
    throw new GeocodeArchivePending(ARCHIVE_PENDING);
}

// Keyset order over the primary key: each batch starts after the last moved key, so it never
// rescans rows an earlier batch deleted.
const MOVE_SQL = `WITH batch AS (
    SELECT address_hash,source_table,source_row FROM geocode_attempt
    WHERE match_status='Match' AND (address_hash,source_table,source_row) > ($2,$3,$4)
    ORDER BY address_hash,source_table,source_row LIMIT $1
  ), moved AS (
    DELETE FROM geocode_attempt g USING batch b
    WHERE g.address_hash=b.address_hash AND g.source_table=b.source_table AND g.source_row=b.source_row
      AND g.match_status='Match'
    RETURNING g.*
  ), kept AS (
    INSERT INTO geocode_match_archive SELECT * FROM moved ON CONFLICT DO NOTHING RETURNING 1
  )
  SELECT count(*)::int AS moved, (SELECT count(*)::int FROM kept) AS archived,
    max(address_hash) AS hash,
    (array_agg(source_table ORDER BY address_hash DESC,source_table DESC,source_row DESC))[1] AS source_table,
    (array_agg(source_row ORDER BY address_hash DESC,source_table DESC,source_row DESC))[1] AS source_row
  FROM moved`;

async function inTransaction<T>(
  session: SqlSession,
  run: () => Promise<T>,
  beforeCommit?: (session: SqlSession) => Promise<void>,
): Promise<T> {
  await session.exec("BEGIN");
  try {
    const value = await run();
    await beforeCommit?.(session);
    await session.exec("COMMIT");
    return value;
  } catch (error) {
    await session.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Runs one move statement inside the caller's transaction with three triggers off, and turns
 * them back on before the commit. Disabling a trigger takes SHARE ROW EXCLUSIVE, which readers'
 * ACCESS SHARE does not wait for.
 *
 * - The archive's provenance and record-policy triggers would restamp the copied metadata.
 * - Removing matched attempts changes no answer (readers select unresolved attempts only), so
 *   a batch does not bump the API data generation; `finish` bumps it once.
 */
async function moving<T>(session: SqlSession, run: () => Promise<T>) {
  await session.exec(`ALTER TABLE geocode_match_archive DISABLE TRIGGER row_provenance;
    ALTER TABLE geocode_match_archive DISABLE TRIGGER zz_record_policy;
    ALTER TABLE geocode_attempt DISABLE TRIGGER api_data_changed`);
  const value = await run();
  await session.exec(`ALTER TABLE geocode_match_archive ENABLE TRIGGER row_provenance;
    ALTER TABLE geocode_match_archive ENABLE TRIGGER zz_record_policy;
    ALTER TABLE geocode_attempt ENABLE TRIGGER api_data_changed`);
  return value;
}

type Settings = Required<
  Pick<ArchiveBackfillOptions, "batchRows" | "pauseMs" | "sleep">
> &
  Pick<ArchiveBackfillOptions, "onBatch" | "beforeCommit">;

async function moveBatches(session: SqlSession, options: Settings) {
  let moved = 0,
    batches = 0,
    after = ["", "", ""];
  for (;;) {
    const row = await inTransaction(
      session,
      async () => {
        await session.exec("SET LOCAL lock_timeout = '2s'");
        const { rows } = await moving(session, () =>
          session.query<{
            moved: number;
            hash: string | null;
            source_table: string | null;
            source_row: string | null;
          }>(MOVE_SQL, [options.batchRows, ...after]),
        );
        return rows[0]!;
      },
      options.beforeCommit,
    );
    if (!row.moved) return { moved, batches };
    moved += row.moved;
    batches += 1;
    after = [row.hash!, row.source_table!, row.source_row!];
    await options.onBatch?.({ moved: row.moved, total: moved });
    if (options.pauseMs > 0) await options.sleep(options.pauseMs);
  }
}

async function finish(session: SqlSession, moved: number, options: Settings) {
  return inTransaction(
    session,
    async () => {
      await session.exec("SET LOCAL lock_timeout = '2s'");
      // A row written behind the keyset pass (none while the geocoders are stopped) moves now.
      const { rows } = await moving(session, () =>
        session.query<{ n: number }>(
          `WITH moved AS (DELETE FROM geocode_attempt WHERE match_status='Match' RETURNING *),
          kept AS (INSERT INTO geocode_match_archive SELECT * FROM moved ON CONFLICT DO NOTHING)
        SELECT count(*)::int n FROM moved`,
        ),
      );
      // One generation bump for the whole move. An empty install publishes no geocode revision.
      if (moved + rows[0]!.n > 0)
        await session.exec("DELETE FROM geocode_attempt WHERE false");
      const validated: string[] = [];
      const state = (
        await session.query<{ name: string; valid: boolean }>(checkState)
      ).rows;
      for (const [table, name] of CHECKS) {
        const check = state.find((row) => row.name === name);
        if (!check) throw new GeocodeArchivePending(ARCHIVE_PENDING);
        if (check.valid) continue;
        await session.exec(`ALTER TABLE ${table} VALIDATE CONSTRAINT ${name}`);
        validated.push(name);
      }
      return { finalMoved: rows[0]!.n, validated };
    },
    options.beforeCommit,
  );
}

/**
 * Moves the matched attempts into the archive and validates the archive checks. Safe to rerun;
 * a finished database answers with `moved: 0` and no validations.
 */
export async function backfillGeocodeArchive(
  db: Database,
  options: ArchiveBackfillOptions = {},
): Promise<ArchiveBackfillResult> {
  const started = Date.now();
  const settings: Settings = {
    ...options,
    batchRows: options.batchRows ?? ARCHIVE_BATCH_ROWS,
    pauseMs: options.pauseMs ?? ARCHIVE_PAUSE_MS,
    sleep:
      options.sleep ??
      ((ms: number) => new Promise<void>((done) => setTimeout(done, ms))),
  };
  if (!Number.isSafeInteger(settings.batchRows) || settings.batchRows < 1)
    throw new TypeError("batch rows must be a positive integer");
  if (!Number.isSafeInteger(settings.pauseMs) || settings.pauseMs < 0)
    throw new TypeError("pause must be a non-negative integer");
  const run = async (session: SqlSession) => {
    const { rows } = await session.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(${GEOCODER_LOCK}) AS locked`,
    );
    if (!rows[0]?.locked)
      throw new GeocodeArchivePending(
        "A geocoder or compact holds the geocode lock; run the backfill after it finishes",
      );
    try {
      const present = await session.query<{ ready: boolean }>(
        "SELECT to_regclass('public.geocode_match_archive') IS NOT NULL AS ready",
      );
      if (!present.rows[0]?.ready)
        throw new GeocodeArchivePending(
          "Geocode archive migration required; run worker migrate first",
        );
      const { moved, batches } = await moveBatches(session, settings);
      const { finalMoved, validated } = await finish(session, moved, settings);
      // The move leaves most of geocode_attempt dead and its statistics stale. Vacuum and analyze
      // it now, outside any transaction; VACUUM takes SHARE UPDATE EXCLUSIVE, which readers do
      // not wait for, so serving queries skip the dead rows and plan with fresh statistics.
      if (moved + finalMoved > 0) {
        await session.exec("VACUUM (ANALYZE) geocode_attempt");
        await session.exec("ANALYZE geocode_match_archive");
      }
      return { moved: moved + finalMoved, batches, validated };
    } finally {
      await session.query(`SELECT pg_advisory_unlock(${GEOCODER_LOCK})`);
    }
  };
  const result = db.withSession ? await db.withSession(run) : await run(db);
  return { ...result, elapsed_ms: Date.now() - started };
}
