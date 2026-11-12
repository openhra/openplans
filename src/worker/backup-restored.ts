import { readFile } from "node:fs/promises";
import type { PassThroughSource, Question } from "@openplans/plugin-sdk";
import {
  CMS_API_EXPORT_EXCLUDED_TABLES,
  CMS_API_SOURCE,
} from "@openplans/source-cms-marketplace-api";
import type { Database, SqlSession } from "../db/database.js";
import { currentRegistries } from "../plugins/registries.js";
import { PASSTHROUGH_CORE_TABLES } from "../plugins/sources/passthrough.js";
import type { WorkerOutput } from "./commands.js";
import { databaseErrorDiagnostic } from "./database-error.js";

const usage = "Usage: worker backup-restored --manifest FILE|-";
/** The quality issue that names why a restored receipt is no longer ACTIVE. */
export const ANSWERS_EXCLUDED_FROM_BACKUP = "answers_excluded_from_backup";
/** `source.source_kind` of pass-through receipts; catalog and provider sources never use these. */
const PASS_THROUGH_KINDS = ["passthrough", "cms_marketplace_api"];

type Source = PassThroughSource<Question, unknown>;
const registered = (): Source[] =>
  currentRegistries()
    .sources.map((entry) => entry.spec)
    .filter((spec): spec is Source => spec.kind === "passthrough");

/** A source whose stored answers live in `tables`; the backup keeps its receipts in `snapshot`. */
export interface AnswerTables {
  sourceId: string;
  tables: readonly string[];
}

/**
 * The CMS Marketplace API source, which the core always knows, then each registered source that
 * stores answers and leaves them out of backups.
 */
export function answerTables(sources: readonly Source[]): AnswerTables[] {
  const found = new Map<string, readonly string[]>([
    [CMS_API_SOURCE, CMS_API_EXPORT_EXCLUDED_TABLES],
  ]);
  for (const source of sources)
    if (
      source.cache.level === "stored" &&
      source.cache.excludeFromBackups !== false &&
      !found.has(source.id)
    )
      found.set(
        source.id,
        source.storage?.excludedTables ?? PASSTHROUGH_CORE_TABLES,
      );
  return [...found].map(([sourceId, tables]) => ({ sourceId, tables }));
}

/**
 * The excluded table list of a backup manifest: `worker backup-args --manifest` output, or an
 * ops backup receipt, which nests the same list under `backup`.
 */
export function manifestExcludedTables(manifest: unknown): string[] {
  const record = manifest as {
    excluded_table_data?: unknown;
    backup?: { excluded_table_data?: unknown };
  } | null;
  const list =
    record?.excluded_table_data ?? record?.backup?.excluded_table_data;
  if (
    !Array.isArray(list) ||
    !list.every(
      (table) => typeof table === "string" && /^[a-z_][a-z0-9_]*$/.test(table),
    )
  )
    throw new Error("manifest has no excluded_table_data list");
  return [...new Set(list as string[])];
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

export interface RestoreResult {
  /** Receipts changed from ACTIVE to QUARANTINED by this run, per source. */
  quarantined: Record<string, number>;
  /** Sources whose answers the backup kept, so their receipts were left alone. */
  kept: string[];
}

/**
 * After restoring a backup that left stored pass-through answers out, mark each ACTIVE receipt of
 * those sources QUARANTINED with an `answers_excluded_from_backup` error. Only receipts with no
 * answer row left are touched, only from sources of a pass-through kind, and a second run
 * changes nothing.
 */
export async function quarantineExcludedAnswers(
  db: SqlSession,
  excluded: readonly string[],
  sources: readonly AnswerTables[],
): Promise<RestoreResult> {
  const result: RestoreResult = { quarantined: {}, kept: [] };
  const left = new Set(excluded);
  for (const { sourceId, tables } of sources) {
    const missing = tables.filter((table) => !left.has(table));
    if (missing.length === tables.length) {
      result.kept.push(sourceId);
      continue;
    }
    // Half a source's tables would leave receipts and answers out of step.
    if (missing.length)
      throw new Error(`manifest excludes only part of ${sourceId}'s tables`);
    const linked = (
      await db.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.columns
        WHERE table_schema=current_schema() AND column_name='snapshot_id'
          AND table_name=ANY($1::text[]) ORDER BY table_name`,
        [tables],
      )
    ).rows.map((row) => row.table_name);
    const orphaned = linked
      .map(
        (table) =>
          `NOT EXISTS (SELECT 1 FROM ${quote(table)} a WHERE a.snapshot_id=s.snapshot_id)`,
      )
      .join(" AND ");
    const candidates = `SELECT s.snapshot_id FROM snapshot s JOIN source r USING(source_id)
      WHERE s.source_id=$1 AND s.validation_state='ACTIVE'
        AND r.source_kind=ANY($2::text[])${orphaned ? ` AND ${orphaned}` : ""}`;
    // The issue goes first: the snapshot event trigger reads it as the reason code.
    await db.query(
      `INSERT INTO quality_issue(source_id,snapshot_id,severity,issue_code,explanation)
      SELECT $1,c.snapshot_id,'error',$3,
        'The backup left this source''s stored answers out; the API asks again when it needs them.'
      FROM (${candidates}) c
      WHERE NOT EXISTS (SELECT 1 FROM quality_issue q
        WHERE q.snapshot_id=c.snapshot_id AND q.issue_code=$3)`,
      [sourceId, PASS_THROUGH_KINDS, ANSWERS_EXCLUDED_FROM_BACKUP],
    );
    const changed = await db.query<{ snapshot_id: string }>(
      `UPDATE snapshot SET validation_state='QUARANTINED'
      WHERE snapshot_id IN (${candidates}) RETURNING snapshot_id`,
      [sourceId, PASS_THROUGH_KINDS],
    );
    result.quarantined[sourceId] = changed.rows.length;
  }
  return result;
}

/** `worker backup-restored --manifest FILE|-`: run once after `pg_restore`, before the API starts. */
export async function runBackupRestored(
  args: string[],
  openDatabase: () => Database,
  output: WorkerOutput,
  sources: readonly Source[] = registered(),
  read: (path: string) => Promise<string> = (path) =>
    path === "-" ? readStdin() : readFile(path, "utf8"),
): Promise<number> {
  if (args.length !== 2 || args[0] !== "--manifest" || !args[1]) {
    output.error(usage);
    return 1;
  }
  let excluded: string[];
  try {
    excluded = manifestExcludedTables(JSON.parse(await read(args[1])));
  } catch {
    output.error(
      "worker backup-restored failed; the manifest must be JSON with an excluded_table_data list",
    );
    return 1;
  }
  let db: Database | undefined;
  try {
    db = openDatabase();
    const result = await db.transaction((session) =>
      quarantineExcludedAnswers(session, excluded, answerTables(sources)),
    );
    output.out(JSON.stringify(result));
    return 0;
  } catch (error) {
    output.error(
      `worker backup-restored failed${databaseErrorDiagnostic(error)}; check the manifest matches this installation`,
    );
    return 1;
  } finally {
    await db?.close();
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
