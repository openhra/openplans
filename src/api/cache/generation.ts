import type { SqlSession } from '../../db/database.js';

/** Read on every lookup: publication commits and the generation become visible together. */
export async function dataGeneration(db: SqlSession): Promise<string> {
  const { rows } = await db.query<{ generation: string }>(`SELECT md5(string_agg(
    table_name || ':' || revision::text, ',' ORDER BY table_name)) AS generation FROM api_data_generation`);
  if (!rows[0]?.generation) throw new Error('Data generation unavailable');
  return rows[0].generation;
}
