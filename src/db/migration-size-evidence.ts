import type { SqlSession } from "./database.js";
import {
  smallTableBytes,
  smallTableRows,
  type MigrationTableSizes,
} from "./migrate-safety.js";

/** One public-schema relation as the read-only collector saw it. */
export interface MigrationRelationEvidence {
  name: string;
  /** pg_class.relkind: r table, p partitioned, f foreign, m materialized view, v view. */
  kind: "r" | "p" | "f" | "m" | "v";
  /** pg_total_relation_size: heap, indexes and TOAST. */
  bytes: number;
  /** Plain table without inheritance, partitions or row security. */
  countable: boolean;
  /** Exact count capped at smallTableRows + 1; null when the table was not counted. */
  countedRows: number | null;
  /** pg_class.reltuples; null when the table was never analyzed. Shown, never trusted. */
  estimatedRows: number | null;
  /** pg_stat_user_tables.n_live_tup; null when no statistics exist. Shown, never trusted. */
  liveTuples: number | null;
}

/** What `worker migrate --size-evidence` prints and `migrate --check` reports. */
export interface MigrationSizeEvidence {
  format: 1;
  collectedAt: string;
  serverVersionNum: number;
  transactionReadOnly: boolean;
  searchPath: string[];
  /** Applied journal rows as [name, sha256]; null when the journal table is absent. */
  journal: [string, string][] | null;
  relations: MigrationRelationEvidence[];
}

// query_to_xml runs one SELECT per table inside this statement, so the whole collector is a
// single read-only SELECT. Hex keeps the journal JSON intact inside the XML text.
const countSql = `format('SELECT count(*) AS n FROM (SELECT 1 FROM %I.%I LIMIT ${smallTableRows + 1}) AS bounded', n.nspname, c.relname)`;

/**
 * Reads catalog statistics, total relation sizes and capped exact counts. It runs SELECT only
 * and takes ACCESS SHARE locks only. Run it inside a READ ONLY transaction.
 */
export const sizeEvidenceSql = `SELECT json_build_object(
  'format', 1,
  'collectedAt', to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'serverVersionNum', current_setting('server_version_num')::int,
  'transactionReadOnly', current_setting('transaction_read_only') = 'on',
  'searchPath', to_json(current_schemas(false)::text[]),
  'journal', CASE WHEN to_regclass('public.schema_migrations') IS NULL THEN NULL ELSE
    convert_from(decode(substring(query_to_xml(
      'SELECT encode(convert_to(coalesce(json_agg(json_build_array(name, sha256) ORDER BY name), ''[]'')::text, ''UTF8''), ''hex'') AS j FROM public.schema_migrations',
      false, true, '')::text FROM '<j>([0-9a-f]*)</j>'), 'hex'), 'UTF8')::json END,
  'relations', coalesce((SELECT json_agg(json_build_object(
      'name', r.name, 'kind', r.kind, 'bytes', r.bytes, 'countable', r.countable,
      'countedRows', CASE WHEN r.countable AND r.bytes <= ${smallTableBytes} THEN
        substring(query_to_xml(r.count_sql, false, true, '')::text FROM '<n>([0-9]+)</n>')::bigint END,
      'estimatedRows', r.estimated_rows, 'liveTuples', r.live_tuples) ORDER BY r.name)
    FROM (SELECT c.relname::text AS name, c.relkind::text AS kind,
        pg_total_relation_size(c.oid) AS bytes,
        (c.relkind = 'r' AND NOT c.relrowsecurity AND NOT EXISTS
          (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid OR i.inhparent = c.oid)) AS countable,
        CASE WHEN c.reltuples >= 0 THEN c.reltuples::bigint END AS estimated_rows,
        s.n_live_tup AS live_tuples,
        ${countSql} AS count_sql
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p','f','m','v')) AS r), '[]'::json)
)::text AS evidence`;

/** A psql script for an operator: one consistent read-only snapshot, then rollback. */
export const sizeEvidenceScript = `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '120s';
${sizeEvidenceSql};
ROLLBACK;
`;

/** Runs the collector in the caller's transaction, which must already be read-only. */
export async function collectSizeEvidence(
  tx: SqlSession,
): Promise<MigrationSizeEvidence> {
  const { rows } = await tx.query<{ evidence: string }>(sizeEvidenceSql);
  const evidence = parseSizeEvidence(rows[0]?.evidence);
  if (!evidence.transactionReadOnly)
    throw new Error(
      "Size evidence must be collected in a read-only transaction",
    );
  return evidence;
}

const count = (value: unknown, nullable = true) =>
  (nullable && value === null) ||
  (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);

/** Validates collector output, from the database or from a saved file. Throws when malformed. */
export function parseSizeEvidence(text: unknown): MigrationSizeEvidence {
  const value: unknown = typeof text === "string" ? JSON.parse(text) : text;
  const e = value as MigrationSizeEvidence;
  const valid =
    !!e &&
    typeof e === "object" &&
    e.format === 1 &&
    typeof e.collectedAt === "string" &&
    count(e.serverVersionNum, false) &&
    typeof e.transactionReadOnly === "boolean" &&
    Array.isArray(e.searchPath) &&
    e.searchPath.every((s) => typeof s === "string") &&
    (e.journal === null ||
      (Array.isArray(e.journal) &&
        e.journal.every(
          (row) =>
            Array.isArray(row) &&
            row.length === 2 &&
            row.every((cell) => typeof cell === "string"),
        ))) &&
    Array.isArray(e.relations) &&
    e.relations.every(
      (r) =>
        !!r &&
        typeof r.name === "string" &&
        ["r", "p", "f", "m", "v"].includes(r.kind) &&
        count(r.bytes, false) &&
        typeof r.countable === "boolean" &&
        count(r.countedRows) &&
        (r.countedRows === null || r.countable) &&
        count(r.estimatedRows) &&
        count(r.liveTuples),
    ) &&
    new Set(e.relations.map((r) => r.name)).size === e.relations.length;
  if (!valid) throw new Error("Invalid migration size evidence");
  return e;
}

export const relationKey = (name: string) =>
  '"public" . "' + name.replaceAll('"', '""') + '"';

/**
 * Turns evidence into classifier input. Only exact capped counts with total bytes can show a
 * table is small. Planner estimates are carried for reasons and never decide a verdict. A
 * search path other than public alone gives no size evidence.
 */
export function tableSizesFromEvidence(
  evidence: MigrationSizeEvidence,
): MigrationTableSizes | undefined {
  if (JSON.stringify(evidence.searchPath) !== '["public"]') return undefined;
  const sizes: MigrationTableSizes = {};
  for (const r of evidence.relations) {
    const estimatedRows = r.estimatedRows ?? r.liveTuples;
    let size: MigrationTableSizes[string] = null;
    if (r.countable && r.bytes <= smallTableBytes && r.countedRows !== null)
      size = { rows: r.countedRows, bytes: r.bytes, estimatedRows };
    else if (r.bytes > smallTableBytes)
      // A byte-budget failure is sufficient; no row scan is necessary.
      size = { rows: -1, bytes: r.bytes, estimatedRows };
    sizes[relationKey(r.name)] = size;
  }
  return sizes;
}
