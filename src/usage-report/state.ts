import type { SqlSession } from "../db/database.js";

/** The one `usage_report_state` row. */
export interface UsageReportState {
  readonly installId: string | null;
  readonly version: string;
  readonly previousVersion: string | null;
  readonly lastSentDay: string | null;
  readonly lastStatus: number | null;
}

/** Read only. Null when there is no row yet, or the table does not exist (migrations pending). */
export async function readUsageReportState(
  db: SqlSession,
): Promise<UsageReportState | null> {
  try {
    const { rows } = await db.query<{
      install_id: string | null;
      version: string;
      previous_version: string | null;
      last_sent_day: string | null;
      last_status: number | null;
    }>(
      `SELECT install_id::text AS install_id, version, previous_version,
              last_sent_day::text AS last_sent_day, last_status
         FROM usage_report_state`,
    );
    const row = rows[0];
    if (!row) return null;
    return {
      installId: row.install_id,
      version: row.version,
      previousVersion: row.previous_version,
      lastSentDay: row.last_sent_day,
      lastStatus: row.last_status,
    };
  } catch {
    return null;
  }
}

/**
 * Records the running version. When it differs from the stored one, the stored one becomes the
 * previous version. Called only while the report is on, at start; never from `show`.
 */
export async function recordUsageReportVersion(
  db: SqlSession,
  version: string,
): Promise<void> {
  await db.query(
    `INSERT INTO usage_report_state (singleton, version) VALUES (true, $1)
     ON CONFLICT (singleton) DO UPDATE SET
       previous_version = CASE WHEN usage_report_state.version <> EXCLUDED.version
         THEN usage_report_state.version ELSE usage_report_state.previous_version END,
       version = EXCLUDED.version`,
    [version],
  );
}

/** `worker usage-report reset`: forgets the install id, the previous version and the last send. */
export async function resetUsageReportState(db: SqlSession): Promise<boolean> {
  try {
    const { rows } = await db.query(
      "DELETE FROM usage_report_state RETURNING singleton",
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

/** The core scheduler records a tick in `plugin_state` each time it runs a schedule. */
export async function schedulerSeen(
  db: SqlSession,
  now: Date,
  withinMs = 3 * 86_400_000,
): Promise<boolean> {
  try {
    const { rows } = await db.query<{ tick: string | null }>(
      `SELECT max(value->>'tick') AS tick FROM plugin_state
        WHERE plugin = 'openplans' AND key LIKE 'core:schedule:%'`,
    );
    const tick = rows[0]?.tick;
    const at = tick ? new Date(tick).getTime() : Number.NaN;
    return Number.isFinite(at) && now.getTime() - at <= withinMs;
  } catch {
    return false;
  }
}
