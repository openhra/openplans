import { randomUUID } from "node:crypto";
import type { Database } from "../db/database.js";
import type { CoreEvents } from "../plugins/worker.js";
import type { WorkerOutput } from "./commands.js";
import { databaseErrorDiagnostic } from "./database-error.js";

const usage =
  "Usage: worker record-policy list | set NAME --ttl INTERVAL [--stale INTERVAL] | expire NAME [--before TIMESTAMP]";

/** Operator changes use the same heap-block batching as row provenance backfills. */
export async function runRecordPolicy(
  args: string[],
  openDatabase: () => Database,
  output: WorkerOutput,
  events?: CoreEvents,
): Promise<number> {
  const [command, name, ...flags] = args;
  const options = new Map<string, string>();
  for (let i = 0; i < flags.length; i += 2) {
    const key = flags[i]!,
      value = flags[i + 1];
    if (!value || options.has(key)) {
      output.error(usage);
      return 1;
    }
    options.set(key, value);
  }
  if (!(
    (command === "list" && args.length === 1) ||
    (name &&
      /^[a-z][a-z0-9_]*$/.test(name) &&
      ((command === "set" &&
        options.has("--ttl") &&
        [...options.keys()].every((k) => ["--ttl", "--stale"].includes(k))) ||
        (command === "expire" &&
          [...options.keys()].every((k) => k === "--before"))))
  )) {
    output.error(usage);
    return 1;
  }
  let db: Database | undefined;
  try {
    db = openDatabase();
    if (command === "list") {
      output.out(
        JSON.stringify(
          (
            await db.query(
              "SELECT name,default_ttl::text,stale_window::text,description FROM record_policy ORDER BY name",
            )
          ).rows,
        ),
      );
      return 0;
    }
    const old = (
      await db.query<{ default_ttl: string | null }>(
        "SELECT default_ttl::text FROM record_policy WHERE name=$1",
        [name],
      )
    ).rows[0];
    if (!old) throw new Error("unknown policy");
    const ttl = options.get("--ttl");
    const noExpiry = ttl === "null" || ttl === "none";
    if (command === "set") {
      await db.query(
        `UPDATE record_policy SET default_ttl=$2::interval,
        stale_window=coalesce($3::interval,stale_window) WHERE name=$1`,
        [name, noExpiry ? null : ttl, options.get("--stale") ?? null],
      );
    }
    // Parse the cutoff before writing any rows. The database validates timezone and date.
    const cutoff =
      command === "expire" && options.has("--before")
        ? (
            await db.query<{ cutoff: string }>(
              "SELECT $1::timestamptz::text AS cutoff",
              [options.get("--before") ?? null],
            )
          ).rows[0]!.cutoff
        : null;
    const tables = (
      await db.query<{ table_name: string }>(
        "SELECT table_name FROM row_provenance_rule ORDER BY table_name",
      )
    ).rows;
    let changed = 0;
    for (const { table_name } of tables) {
      const table = `"${table_name.replaceAll('"', '""')}"`;
      const last = Number(
        (
          await db.query<{ blocks: string }>(
            "SELECT pg_relation_size(to_regclass(quote_ident($1)))/current_setting('block_size')::bigint AS blocks",
            [table_name],
          )
        ).rows[0]!.blocks,
      );
      for (let first = 0; first <= last; first += 2000) {
        const range = `ctid >= $2::tid AND ctid < $3::tid`;
        const parameters = [name, `(${first},0)`, `(${first + 2000},0)`];
        const result =
          command === "set"
            ? await db.query<{ count: string }>(
                `WITH changed AS (
          UPDATE ${table} SET record_ttl=CASE WHEN record_ttl IS NOT DISTINCT FROM $4::interval
            THEN $5::interval ELSE record_ttl END, expired_at=NULL
          WHERE record_policy=$1 AND ${range} RETURNING 1) SELECT count(*)::text FROM changed`,
                [...parameters, old.default_ttl, noExpiry ? null : ttl],
              )
            : await db.query<{ count: string }>(
                `WITH changed AS (
            UPDATE ${table} SET expired_at=now()
            WHERE record_policy=$1 AND ${range} AND ($4::timestamptz IS NULL OR coalesce(sourced_at,created_at)<=$4::timestamptz)
            RETURNING 1) SELECT count(*)::text FROM changed`,
                [...parameters, cutoff],
              );
        changed += Number(result.rows[0]!.count);
      }
      await db.exec(`VACUUM (PARALLEL 0) ${table}`);
    }
    if (command === "set" && events) await emitPolicyChanged(events, name!);
    output.out(JSON.stringify({ policy: name, command, rows: changed }));
    return 0;
  } catch (error) {
    output.error(
      `worker record-policy failed${databaseErrorDiagnostic(error)}; check policy name, interval and timestamp`,
    );
    return 1;
  } finally {
    await db?.close();
  }
}

/** Reads the stored values through the events connection, so the command's own queries stay as they were. */
async function emitPolicyChanged(
  events: CoreEvents,
  policy: string,
): Promise<void> {
  const row = (
    await events.read<{ ttl: string | null; stale_window: string }>(
      "SELECT default_ttl::text AS ttl, stale_window::text AS stale_window FROM record_policy WHERE name=$1",
      [policy],
    )
  )?.[0];
  if (!row) return;
  await events.emit({
    type: "record_policy.changed",
    idempotencyKey: `record_policy.changed:${randomUUID()}`,
    payload: { policy, ttl: row.ttl, staleWindow: row.stale_window },
  });
}
