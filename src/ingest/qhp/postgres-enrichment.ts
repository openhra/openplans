/** Copy already validated real identity releases into the isolated developer database. */
import { PGlite } from '@electric-sql/pglite';
import { join } from 'node:path';
import type { Database } from '../../db/database.js';

/** The archive's observation state can differ from an identity already present in the DB. */
export async function seedLegacyNppesScopes(db: Database, rows: Record<string,unknown>[]) {
  if (!rows.length) return;
  await db.query(`INSERT INTO npi_state_scope(npi,state_filter,in_scope,data_date,snapshot_id)
    SELECT npi,state_filter,in_scope,data_date,snapshot_id
    FROM jsonb_populate_recordset(NULL::npi_state_scope,$1::jsonb) ON CONFLICT DO NOTHING`,[JSON.stringify(rows)]);
  await db.query(`UPDATE npi_provider p SET in_scope=EXISTS(
    SELECT 1 FROM npi_state_scope s WHERE s.npi=p.npi AND s.in_scope)
    WHERE p.npi=ANY($1::text[]) AND p.in_scope IS DISTINCT FROM EXISTS(
      SELECT 1 FROM npi_state_scope s WHERE s.npi=p.npi AND s.in_scope)`,[rows.map(r => r.npi)]);
}

export async function bootstrapEnrichment(db: Database, cache: string) {
  for (const [directory,tables] of [
    ['rxnorm-pglite-p2a',['source','snapshot','rx_release','rx_concept','rx_relation','rx_ndc']],
    ['nppes-pglite-p3a',['source','snapshot','npi_import_run','npi_provider','npi_taxonomy','npi_address','npi_deactivation']],
  ] as const) {
    const from = new PGlite(join(cache,directory));
    try {
      for (const table of tables) {
        let rows = 0;
        // A server cursor bounds both the source query and each destination insert.
        await from.transaction(async tx => {
          await tx.exec(`DECLARE enrichment_rows NO SCROLL CURSOR FOR SELECT * FROM ${table}`);
          for (;;) {
            const batch = (await tx.query<Record<string,unknown>>('FETCH 2000 FROM enrichment_rows')).rows;
            if (!batch.length) break;
            await db.query(`INSERT INTO ${table} OVERRIDING SYSTEM VALUE SELECT *
              FROM jsonb_populate_recordset(NULL::${table},$1::jsonb) ON CONFLICT DO NOTHING`,[JSON.stringify(batch)]);
            if (table === 'npi_provider') await seedLegacyNppesScopes(db,batch);
            rows += batch.length;
          }
          await tx.exec('CLOSE enrichment_rows');
        });
        await db.exec(`ANALYZE ${table}`);
        console.log(JSON.stringify({ enrichment: directory,table,rows }));
      }
    } finally { await from.close(); }
  }
}
