import type { SqlSession } from "./database.js";
import { buildOnlyTables } from "./table-classes.js";

export async function assertNoBuildEvidence(db: SqlSession): Promise<void> {
  const { rows } = await db.query<{ name: string }>(
    "SELECT tablename AS name FROM pg_tables WHERE schemaname='public' AND tablename=ANY($1::text[])",
    [buildOnlyTables],
  );
  if (rows.length)
    throw new Error("build-only table remains in generation artifact");
}

/** Called only after imports and compact, before either physical or logical export. */
export async function excludeBuildEvidence(db: SqlSession): Promise<string[]> {
  for (const name of buildOnlyTables)
    await db.exec(`DROP TABLE IF EXISTS public."${name}" RESTRICT`);
  await db.query(
    "DELETE FROM row_provenance_rule WHERE table_name=ANY($1::text[])",
    [buildOnlyTables],
  );
  await assertNoBuildEvidence(db);
  return [...buildOnlyTables];
}
