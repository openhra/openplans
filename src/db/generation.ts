import type { SqlSession } from "./database.js";

/** The statement every generation read runs, so a readiness probe can share its one round trip. */
export const GENERATION_QUERY = `SELECT md5(string_agg(
    table_name || ':' || revision::text, ',' ORDER BY table_name COLLATE "C")) AS generation FROM api_data_generation`;

/** Read on every lookup: publication commits and the generation become visible together. */
export async function dataGeneration(db: SqlSession): Promise<string> {
  const { rows } = await db.query<{
    generation: string;
  }>(GENERATION_QUERY);
  if (!rows[0]?.generation) throw new Error("Data generation unavailable");
  return rows[0].generation;
}
