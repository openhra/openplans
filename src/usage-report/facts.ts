import type { CoreConfig } from "../config/index.js";
import type { Database, SqlSession } from "../db/database.js";
import { checkMigrations } from "../db/migrate.js";
import {
  coreApplicationVersion,
  hostAvailability,
} from "../plugins/status-host.js";
import type { UsageReportFacts } from "./build.js";
import { readUsageReportState, schedulerSeen } from "./state.js";
import type { UsageReportState } from "./state.js";

const KINDS = [
  ["catalog", "catalog"],
  ["premium", "premium"],
  ["provider", "provider"],
  ["formulary", "formulary"],
] as const;

async function statusView(db: SqlSession): Promise<UsageReportFacts["status"]> {
  try {
    const rows = await hostAvailability(db);
    const counts = Object.fromEntries(
      KINDS.map(([kind, key]) => {
        const tally: Record<string, number> = {};
        for (const row of rows) tally[row[key]] = (tally[row[key]] ?? 0) + 1;
        return [kind, tally];
      }),
    ) as NonNullable<UsageReportFacts["status"]>["status_counts"];
    return {
      states: new Set(rows.map((row) => row.state)).size,
      years: [...new Set(rows.map((row) => row.year))].sort((a, b) => a - b),
      status_counts: counts,
    };
  } catch {
    return null;
  }
}

async function schemaState(db: Database): Promise<UsageReportFacts["schema"]> {
  try {
    return (await checkMigrations(db)).pending.length === 0
      ? "ready"
      : "pending";
  } catch {
    return "unknown";
  }
}

export interface Gathered {
  readonly facts: UsageReportFacts;
  readonly state: UsageReportState | null;
}

/**
 * Collects the facts for one report. Reads only. Without a database (the report is off, or it
 * cannot be reached) the database facts are null, unknown or false.
 */
export async function gatherUsageReportFacts(input: {
  config: CoreConfig;
  db: Database | null;
  now?: Date;
}): Promise<Gathered> {
  const { config, db } = input;
  const now = input.now ?? new Date();
  const state = db ? await readUsageReportState(db) : null;
  const on = config.usageReport.enabled;
  return {
    state,
    facts: {
      installId: on ? (state?.installId ?? null) : null,
      now,
      version: coreApplicationVersion() ?? "0.0.0",
      previousVersion: state?.previousVersion ?? null,
      arch: process.arch,
      nodeVersion: process.versions.node,
      uptimeMs: process.uptime() * 1000,
      config,
      status: db ? await statusView(db) : null,
      schema: db ? await schemaState(db) : "unknown",
      schedulerSeen: db ? await schedulerSeen(db, now) : false,
      telemetry: null,
    },
  };
}
