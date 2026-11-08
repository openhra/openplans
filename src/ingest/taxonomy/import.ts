import { createReadStream } from 'node:fs';
import { readCsv } from '../csv/index.js';
import type { Database } from '../../db/database.js';
import type { AcquiredRelease } from './acquire.js';

export async function importTaxonomy(db: Database, release: AcquiredRelease) {
  const clientRows: { code: string; display_name: string; classification: string; specialization: string | null }[] = [];
  const stream = createReadStream(release.path);
  let headersChecked = false;
  for await (const row of readCsv(stream, { maxRecordLength: 1024 * 1024 })) {
    const v = row.values;
    if (!headersChecked) {
      for (const field of ['Code','Classification','Specialization','Display Name']) if (!(field in v)) throw new Error(`NUCC missing ${field}`);
      headersChecked = true;
    }
    const code = v.Code!.trim().toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(code)) throw new Error(`Invalid NUCC taxonomy code at row ${row.rowNumber}`);
    if (!v['Display Name']!.trim() || !v.Classification!.trim()) throw new Error(`Incomplete NUCC taxonomy row ${row.rowNumber}`);
    clientRows.push({ code, display_name: v['Display Name']!.trim(), classification: v.Classification!.trim(), specialization: v.Specialization!.trim() || null });
  }
  if (!headersChecked || !clientRows.length) throw new Error('Empty NUCC taxonomy CSV');
  await db.transaction(async tx => {
    await tx.query(`INSERT INTO source(source_id,publisher,source_kind) VALUES ('nucc-provider-taxonomy','National Uniform Claim Committee','taxonomy')
      ON CONFLICT(source_id) DO NOTHING`);
    await tx.query(`INSERT INTO snapshot(snapshot_id,source_id,requested_url,final_url,retrieved_at,http_status,content_type,
      compressed_bytes,uncompressed_bytes,sha256,raw_path,schema_version,expected_children,fetched_children,validation_state,activated_at)
      VALUES ($1,'nucc-provider-taxonomy',$2,$2,now(),200,'text/csv',$3,$3,$1,$4,$5,1,1,'ACTIVE',now()) ON CONFLICT(snapshot_id) DO NOTHING`,
      [release.metadata.sha256,release.url,release.metadata.bytes,release.path,release.version]);
    await tx.query('DELETE FROM provider_taxonomy');
    for (let i = 0; i < clientRows.length; i += 500) {
      const batch = clientRows.slice(i, i + 500), values: unknown[] = [];
      const tuples = batch.map(row => {
        values.push(row.code,row.display_name,row.classification,row.specialization,release.version,release.metadata.sha256);
        const j = values.length - 5;
        return `($${j},$${j+1},$${j+2},$${j+3},$${j+4},$${j+5})`;
      });
      await tx.query(`INSERT INTO provider_taxonomy(code,display_name,classification,specialization,version,snapshot_id) VALUES ${tuples.join(',')}
        ON CONFLICT(code) DO UPDATE SET display_name=excluded.display_name,classification=excluded.classification,
          specialization=excluded.specialization,version=excluded.version,snapshot_id=excluded.snapshot_id`, values);
    }
  });
  return { version: release.version, source_url: release.url, snapshot_id: release.metadata.sha256, codes: clientRows.length };
}
