#!/usr/bin/env node
/** Opt-in: combine two PRIVATE cache copies, never downloads or modifies source caches.
 * Target starts as a copy of P3d's real provider DB. Source is a copy of P4a's
 * real full catalog DB. Retains all source rows/snapshots; publishes its catalog pointer.
 */
import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
const targetPath = process.env.OPENPLANS_PGLITE_DIR, catalogPath = process.env.OPENPLANS_COMPAT_CATALOG_COPY;
assert.ok(targetPath && catalogPath && isAbsolute(targetPath) && isAbsolute(catalogPath) && targetPath !== catalogPath,
  'Set distinct absolute OPENPLANS_PGLITE_DIR and OPENPLANS_COMPAT_CATALOG_COPY to private cache copies');
const target = new PGlite(targetPath), catalog = new PGlite(catalogPath);
try {
  // Existing target provenance/geo/provider data remain intact. Small batches keep
  // the full Rate PUF bounded in memory; no source bytes enter the repository.
  for (const table of ['source', 'snapshot', 'puf_import', 'puf_import_file', 'issuer', 'plan_attribute', 'plan',
    'plan_variant', 'service_area', 'service_area_county', 'network', 'rate', 'plan_benefit', 'business_rule',
    'state_rating_rule', 'rating_rule_document', 'zcta_county', 'zcta_centroid', 'rating_area']) {
    let count = 0;
    await catalog.exec(`BEGIN; DECLARE copy_rows NO SCROLL CURSOR FOR SELECT * FROM ${table}`);
    for (;;) {
      const { rows } = await catalog.query('FETCH FORWARD 2000 FROM copy_rows');
      if (!rows.length) break;
      await target.query(`INSERT INTO ${table} SELECT * FROM jsonb_populate_recordset(NULL::${table},$1::jsonb) ON CONFLICT DO NOTHING`, [JSON.stringify(rows)]);
      count += rows.length;
    }
    await catalog.exec('CLOSE copy_rows; COMMIT');
    console.log(JSON.stringify({ copied: table, rows: count }));
  }
  await target.transaction(async tx => {
    for (const table of ['puf_active_catalog', 'rating_rule_set', 'geo_import']) {
      const { rows } = await catalog.query(`SELECT * FROM ${table}`);
      await tx.exec(`DELETE FROM ${table}`);
      if (rows.length) await tx.query(`INSERT INTO ${table} SELECT * FROM jsonb_populate_recordset(NULL::${table},$1::jsonb)`, [JSON.stringify(rows)]);
    }
  });
  await target.exec('ANALYZE');
  console.log('PASS: combined private real catalog/provider PGlite');
} finally { await catalog.close(); await target.close(); }
