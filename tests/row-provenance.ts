import type { SqlSession } from "../src/db/database.js";

/** Objects that hold no rows of their own, or that OpenPlans does not own. */
export const NON_ROW_OBJECTS: Record<string, string> = {
  qhp_provider_plan_all:
    "view: union of qhp_provider_plan_legacy and the shared plan groups",
  qhp_provider_plan: "view: qhp_provider_plan_all limited to ACTIVE shards",
  vt_hios_sbe_catalog: "view: eligible Vermont SBE bundles",
  state_vt_hios_current: "view: current rows of state_vt_hios_match",
  spatial_ref_sys: "PostGIS extension table of spatial reference systems",
  geometry_columns: "PostGIS catalog view",
  geography_columns: "PostGIS catalog view",
};

const COLUMNS = {
  created_at: { type: "timestamp with time zone", notNull: true },
  updated_at: { type: "timestamp with time zone", notNull: true },
  sourced_by: { type: "text", notNull: true },
  sourced_at: { type: "timestamp with time zone", notNull: false },
  sourced_slug: { type: "text", notNull: true },
} as const;

/** Every table needs the five columns and the row trigger; other objects need a reason. */
export async function schemaViolations(db: SqlSession): Promise<string[]> {
  const problems: string[] = [];
  const { rows: objects } = await db.query<{
    name: string;
    kind: string;
    extension: boolean;
  }>(`SELECT c.relname AS name, c.relkind::text AS kind,
      EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass
        AND d.objid=c.oid AND d.deptype='e') AS extension
    FROM pg_class c WHERE c.relnamespace=current_schema()::regnamespace
      AND c.relkind IN ('r','p','v','m','f') ORDER BY c.relname`);
  const { rows: columns } = await db.query<{
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
  }>(
    `SELECT table_name, column_name, data_type, is_nullable
    FROM information_schema.columns WHERE table_schema=current_schema()
      AND column_name = ANY($1::text[])`,
    [Object.keys(COLUMNS)],
  );
  const { rows: triggers } = await db.query<{ table_name: string }>(
    `SELECT c.relname AS table_name FROM pg_trigger g JOIN pg_class c ON c.oid=g.tgrelid
     WHERE g.tgname='row_provenance' AND g.tgenabled <> 'D'
       AND c.relnamespace=current_schema()::regnamespace`,
  );
  const triggered = new Set(triggers.map((row) => row.table_name));
  const { rows: unresolved } = await db.query<{ table_name: string }>(
    `SELECT table_name FROM row_provenance_rule
     WHERE reason LIKE 'inferred: no receipt reference%' ORDER BY table_name`,
  );
  for (const object of objects) {
    const table = object.kind === "r" || object.kind === "p";
    if (!table || object.extension) {
      if (!NON_ROW_OBJECTS[object.name])
        problems.push(
          `${object.name}: ${table ? "extension table" : `relkind ${object.kind}`} needs a NON_ROW_OBJECTS reason`,
        );
      continue;
    }
    if (NON_ROW_OBJECTS[object.name]) continue;
    for (const [name, expected] of Object.entries(COLUMNS)) {
      const column = columns.find(
        (row) => row.table_name === object.name && row.column_name === name,
      );
      if (!column) problems.push(`${object.name}: missing ${name}`);
      else if (column.data_type !== expected.type)
        problems.push(`${object.name}.${name}: ${column.data_type}`);
      else if (expected.notNull && column.is_nullable !== "NO")
        problems.push(`${object.name}.${name}: nullable`);
    }
    if (!triggered.has(object.name))
      problems.push(`${object.name}: no row_provenance trigger`);
  }
  for (const row of unresolved)
    problems.push(
      `${row.table_name}: no receipt reference; add a row_provenance_rule`,
    );
  return problems;
}

/**
 * Rows that point at a known receipt must carry that receipt's source, retrieval time and
 * id; app rows must carry their fixed values.
 */
export async function receiptViolations(db: SqlSession): Promise<string[]> {
  const problems: string[] = [];
  const { rows: rules } = await db.query<{
    table_name: string;
    reference_columns: string[];
    fixed_by: string | null;
    fixed_slug: string | null;
  }>(
    "SELECT table_name, reference_columns, fixed_by, fixed_slug FROM row_provenance_rule ORDER BY table_name",
  );
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
  for (const rule of rules) {
    const table = quote(rule.table_name);
    if (rule.table_name === "snapshot") {
      const { rows } = await db.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM snapshot WHERE sourced_by IS DISTINCT FROM source_id
         OR sourced_at IS DISTINCT FROM retrieved_at OR sourced_slug IS DISTINCT FROM snapshot_id`,
      );
      if (rows[0]!.count) problems.push(`snapshot: ${rows[0]!.count} rows`);
      continue;
    }
    const ref = rule.reference_columns.length
      ? `coalesce(${rule.reference_columns.map((c) => `t.${quote(c)}::text`).join(",")}, NULL)`
      : "NULL::text";
    if (rule.reference_columns.length) {
      const { rows } = await db.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM ${table} t JOIN snapshot s ON s.snapshot_id=${ref}
         WHERE t.sourced_by IS DISTINCT FROM s.source_id
           OR t.sourced_at IS DISTINCT FROM s.retrieved_at
           OR t.sourced_slug IS DISTINCT FROM s.snapshot_id`,
      );
      if (rows[0]!.count)
        problems.push(
          `${rule.table_name}: ${rows[0]!.count} rows differ from their receipt`,
        );
    }
    if (rule.fixed_by) {
      const { rows } = await db.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM ${table} t WHERE ${ref} IS NULL
           AND (t.sourced_by IS DISTINCT FROM $1 OR t.sourced_slug IS DISTINCT FROM $2
             OR t.sourced_at IS NOT NULL)`,
        [rule.fixed_by, rule.fixed_slug],
      );
      if (rows[0]!.count)
        problems.push(
          `${rule.table_name}: ${rows[0]!.count} app rows without ${rule.fixed_slug}`,
        );
    }
  }
  return problems;
}

/** Share of rows per table whose sourced_by is known. */
export async function coverage(
  db: SqlSession,
): Promise<{ table: string; rows: number; known: number }[]> {
  const { rows: tables } = await db.query<{ table_name: string }>(
    "SELECT table_name FROM row_provenance_rule ORDER BY table_name",
  );
  const result = [];
  for (const { table_name } of tables) {
    const { rows } = await db.query<{ rows: number; known: number }>(
      `SELECT count(*)::int AS rows, count(*) FILTER (WHERE sourced_by <> 'unknown')::int AS known
       FROM "${table_name.replaceAll('"', '""')}"`,
    );
    result.push({ table: table_name, ...rows[0]! });
  }
  return result;
}
