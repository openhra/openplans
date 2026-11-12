import type { SqlSession } from "./database.js";

/**
 * The internal columns migrations 990 and 992 add to every table. They describe the database row, so API
 * responses leave them out.
 */
export const ROW_PROVENANCE_COLUMNS = [
  "created_at",
  "updated_at",
  "sourced_by",
  "sourced_at",
  "sourced_slug",
  "record_policy",
  "record_ttl",
  "expired_at",
] as const;

/** SQL for one table row as JSON without the row provenance columns. */
export const rowJson = (alias: string) =>
  `(to_jsonb(${alias})-'{${ROW_PROVENANCE_COLUMNS.join(",")}}'::text[])`;

/** A row selected with `alias.*`, without the row provenance columns. */
export function withoutRowProvenance<T extends Record<string, unknown>>(
  row: T,
): T {
  const copy = { ...row };
  for (const column of ROW_PROVENANCE_COLUMNS) delete copy[column];
  return copy;
}

export interface BackfillResult {
  table: string;
  rows: number;
}

/**
 * Fill created_at, updated_at and the sourced_* columns of rows written before migration 990.
 * Each block range commits on its own, so a large table never holds one long transaction and
 * an interrupted run resumes where it stopped (filled rows are skipped).
 */
export async function backfillRowProvenance(
  db: SqlSession,
  options: { table?: string; blocks?: number; vacuumEvery?: number } = {},
  progress: (result: BackfillResult) => void = () => {},
): Promise<BackfillResult[]> {
  const blocks = options.blocks ?? 2000;
  const vacuumEvery = options.vacuumEvery ?? 5;
  if (!Number.isSafeInteger(blocks) || blocks < 1)
    throw new Error("blocks must be a positive integer");
  const { rows: rules } = await db.query<{ table_name: string }>(
    `SELECT table_name FROM row_provenance_rule
     WHERE $1::text IS NULL OR table_name=$1 ORDER BY table_name`,
    [options.table ?? null],
  );
  if (options.table && !rules.length)
    throw new Error(`No row provenance rule for ${options.table}`);
  const results: BackfillResult[] = [];
  for (const { table_name } of rules) {
    const { rows: size } = await db.query<{ blocks: string }>(
      `SELECT pg_relation_size(to_regclass(quote_ident($1)))
         / current_setting('block_size')::bigint AS blocks`,
      [table_name],
    );
    const last = Number(size[0]?.blocks ?? 0);
    const result = { table: table_name, rows: 0 };
    for (let first = 0; first <= last; first += blocks) {
      const { rows } = await db.query<{ filled: string }>(
        "SELECT backfill_row_provenance($1,$2,$3) AS filled",
        [table_name, first, blocks],
      );
      result.rows += Number(rows[0]?.filled ?? 0);
      // Updated rows leave dead versions behind. Reclaiming them every few batches lets later
      // batches reuse the space, so the table grows by about one interval, not by its size.
      if (
        vacuumEvery &&
        ((first / blocks + 1) % vacuumEvery === 0 || first + blocks > last)
      )
        await db.exec(`VACUUM (PARALLEL 0) ${quoteIdentifier(table_name)}`);
    }
    results.push(result);
    progress(result);
  }
  return results;
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

const columns = new Set<string>(ROW_PROVENANCE_COLUMNS);

/**
 * Places where a response documents a field that shares a name with a row provenance
 * column. Anything else with one of those names is a table column that got out.
 */
function documented(key: string, path: string[], url: string): boolean {
  // The CMS Marketplace API fallback labels its answers. See src/ingest/cms-api/README.md.
  if (
    path.includes("cms_api") &&
    ["sourced_by", "sourced_at", "sourced_slug"].includes(key)
  )
    return true;
  // The compatibility plan object lists `updated_at`, always null.
  const parent = path.filter((part) => part !== "*").at(-1);
  return (
    key === "updated_at" &&
    url.includes("/compat/v1/") &&
    (parent === "plans" || parent === "plan")
  );
}

// Paths of row provenance columns in a response body; array items show as "*".
export function rowProvenanceLeaks(body: unknown, url = ""): string[] {
  const found = new Set<string>();
  const walk = (value: unknown, path: string[]) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, [...path, "*"]);
    } else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (columns.has(key) && !documented(key, path, url))
          found.add([...path, key].join("/"));
        walk(child, [...path, key]);
      }
    }
  };
  walk(body, []);
  return [...found].sort();
}
