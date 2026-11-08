import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { Database } from '../../db/database.js';
import { cachedImportFiles, IMPORT_KINDS, importDataDirectory, importRows, verifyImportFile } from './import-source.js';
import type { ImportFile } from './import-source.js';
import { MissingPufColumnsError, parseImportRow, validateImportHeader } from './import-parse.js';
import { deriveCatalogRows, importIssue, insertImportRows, saveImportSnapshot } from './import-repository.js';
import { reconcileImport } from './import-reconcile.js';
import type { FileReconciliation, Reconciliation } from './import-reconcile.js';
export { createPufRepository, plansForCounty } from './import-repository.js';
export type { CountyPlan } from './import-repository.js';
export type { ImportFile, ImportKind } from './import-source.js';

export interface PufImportOptions {
  year: number;
  state: string;
  dataDir?: string;
  /** Trusted offline files, used by real-cut fixtures. Production always uses the newest acquired manifest. */
  files?: ImportFile[];
  manifestPath?: string | null;
  /** Stage protected supplemental catalogs without changing their serving pointer. */
  publish?: boolean;
}
export interface PufImportReport extends Reconciliation {
  import_id: string; state: string; year: number; status: 'ACTIVE' | 'QUARANTINED';
  source?: 'cms_sbe_puf'; serving?: boolean;
  manifest_path: string | null; wall_seconds: number; report_json: string; report_md: string;
}

export async function importPufs(db: Database, options: PufImportOptions): Promise<PufImportReport> {
  const started = Date.now(), { year, state } = options;
  const dataDir = options.dataDir ?? importDataDirectory();
  if (![2026, 2027].includes(year) || !/^[A-Z]{2}$/.test(state) || !isAbsolute(dataDir)) throw new TypeError('Invalid PUF import scope');
  const acquired = options.files ? { files: options.files, manifestPath: options.manifestPath ?? null } : await cachedImportFiles(dataDir, year);
  if (acquired.files.length !== IMPORT_KINDS.length || IMPORT_KINDS.some(kind => acquired.files.filter(file => file.kind === kind).length !== 1)) throw new Error('All six catalog files are required');
  const files = IMPORT_KINDS.map(kind => acquired.files.find(file => file.kind === kind)!);
  const id = `puf-${year}-${state}-${randomUUID()}`;
  const sbe = files.every(file => file.source === 'cms_sbe_puf');
  if (files.some(file => file.source === 'cms_sbe_puf') && !sbe) throw new Error('Mixed catalog sources');
  const source = `${sbe ? 'cms_sbe_puf' : 'cms-exchange-puf'}:${year}:${state}`;
  const reconciliationFiles: FileReconciliation[] = files.map(file => ({ kind: file.kind, snapshot_id: `${id}:${file.kind}`,
    sha256: file.sha256, ...(sbe ? { source: 'cms_sbe_puf' as const, member: file.member, bundle_url: file.url } : {}), expected_rows: file.rowCache?.count, input_rows: 0, stored_rows: 0, rejected_rows: 0 }));
  await db.transaction(async tx => {
    await saveImportSnapshot(tx, id, source);
    await tx.query('INSERT INTO puf_import(import_id,state,plan_year) VALUES($1,$2,$3)', [id, state, year]);
    if (sbe) {
      await tx.query("UPDATE source SET source_kind='cms_sbe_puf' WHERE source_id=$1", [source]);
      await tx.query("UPDATE snapshot SET parser_version='sbe-import-v1',schema_version='cms-sbe-puf-2026-observed' WHERE snapshot_id=$1", [id]);
      await tx.query('INSERT INTO sbe_catalog(import_id,bundle_url,bundle_sha256,serving) VALUES($1,$2,$3,$4)', [id, files[0]!.url, files[0]!.sha256, options.publish !== false]);
    }
    for (const file of files) {
      const snapshot = `${id}:${file.kind}`;
      await saveImportSnapshot(tx, snapshot, `${source}:${file.kind}`, file);
      await tx.query('INSERT INTO puf_import_file(import_id,kind,snapshot_id) VALUES($1,$2,$3)', [id, file.kind, snapshot]);
    }
  });
  for (const file of files) {
    const count = reconciliationFiles.find(row => row.kind === file.kind)!;
    try {
      await verifyImportFile(file);
      await db.transaction(async tx => {
        let batch: unknown[][] = [], headerValidated = false;
        for await (const row of importRows(file)) {
          if (!headerValidated) { validateImportHeader(file.kind, row.values, year); headerValidated = true; }
          if (row.values.StateCode !== state) continue;
          count.input_rows++;
          try {
            if (row.values.BusinessYear !== String(year)) throw new Error('Mismatched publication year');
            batch.push(parseImportRow(file.kind, row, count.snapshot_id));
          } catch {
            count.rejected_rows++;
            await importIssue(tx, count.snapshot_id, 'invalid_source_row', 'Invalid PUF identifier, geography, year or field value; source row retained in immutable input.', row.rowNumber);
          }
          if (batch.length >= 250) { await insertImportRows(tx, file.kind, batch); batch = []; }
        }
        await insertImportRows(tx, file.kind, batch);
        await deriveCatalogRows(tx, file.kind, count.snapshot_id);
        await tx.query('UPDATE puf_import_file SET input_rows=$2 WHERE snapshot_id=$1', [count.snapshot_id, count.input_rows]);
      });
    } catch (error) {
      if (error instanceof MissingPufColumnsError) count.error = error.message;
      // Roll back this file only. The staged set cannot be published; old active pointer is untouched.
      count.rejected_rows = Math.max(1, count.rejected_rows);
      await importIssue(db, count.snapshot_id, 'file_import_failed', count.error ?? 'PUF hash, archive, CSV schema or catalog constraints failed; file transaction rolled back.');
    }
  }
  const reconciliation = await reconcileImport(db, reconciliationFiles, { sbe });
  const status = reconciliation.passed ? 'ACTIVE' : 'QUARANTINED';
  await db.transaction(async tx => {
    // Serialize publication; concurrent imports keep independent immutable rows.
    await tx.query('SELECT pg_advisory_xact_lock(1869636976)');
    for (const check of reconciliation.checks.filter(check => check.count > 0)) {
      await importIssue(tx, id, check.code, JSON.stringify({ count: check.count, sample: check.sample }), undefined, check.severity);
    }
    for (const file of reconciliationFiles) await tx.query('UPDATE puf_import_file SET input_rows=$2,stored_rows=$3 WHERE snapshot_id=$1', [file.snapshot_id, file.input_rows, file.stored_rows]);
    const allIds = [id, ...reconciliationFiles.map(file => file.snapshot_id)];
    if (reconciliation.passed) {
      const digest = createHash('sha256').update(JSON.stringify(files.map(file => [file.kind, file.sha256]))).digest('hex');
      await tx.query('UPDATE snapshot SET sha256=$2,retrieved_at=$3,fetched_children=expected_children WHERE snapshot_id=$1', [id, digest, new Date().toISOString()]);
      for (const next of ['VALIDATED', 'RECONCILED', 'ACTIVE']) {
        await tx.query(`UPDATE snapshot SET validation_state=$2,activated_at=CASE WHEN $2='ACTIVE' THEN now() ELSE activated_at END WHERE snapshot_id=ANY($1::text[])`, [allIds, next]);
      }
      if (sbe) await tx.query(`INSERT INTO sbe_issuer_status(import_id,issuer_id) SELECT $1,issuer_id FROM issuer WHERE snapshot_id=$2`, [id, `${id}:plan-attributes`]);
      if (options.publish !== false) {
        await tx.query(`INSERT INTO puf_active_catalog(state,plan_year,import_id) VALUES($1,$2,$3)
          ON CONFLICT(state,plan_year) DO UPDATE SET import_id=EXCLUDED.import_id`, [state, year, id]);
        await tx.query(`INSERT INTO data_availability(state,plan_year,market,issuer_id,catalog_status,premium_status,snapshot_id)
          SELECT state,plan_year,market,issuer_id,'available','unsupported',$1 FROM plan WHERE snapshot_id=$2 GROUP BY state,plan_year,market,issuer_id
          ON CONFLICT(state,plan_year,market,issuer_id) DO UPDATE SET catalog_status=EXCLUDED.catalog_status,premium_status=EXCLUDED.premium_status,snapshot_id=EXCLUDED.snapshot_id`, [id, `${id}:plan-attributes`]);
      }
    } else {
      await tx.query("UPDATE snapshot SET validation_state='QUARANTINED' WHERE snapshot_id=ANY($1::text[])", [allIds]);
    }
  });
  const stem = join(dataDir, 'reports', id);
  const report: PufImportReport = { ...reconciliation, ...(sbe ? { source: 'cms_sbe_puf' as const, serving: reconciliation.passed && options.publish !== false } : {}), import_id: id, state, year, status, manifest_path: acquired.manifestPath,
    wall_seconds: (Date.now() - started) / 1000, report_json: `${stem}.json`, report_md: `${stem}.md` };
  await mkdir(join(dataDir, 'reports'), { recursive: true });
  await writeFile(report.report_json, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(report.report_md, `# CMS PUF ${state} PY${year}: ${status}\n\nImport: ${id}. Wall time: ${report.wall_seconds}s.\n\n| File | State input | Stored | Rejected |\n| --- | ---: | ---: | ---: |\n${report.files.map(f => `| ${f.kind} | ${f.input_rows} | ${f.stored_rows} | ${f.rejected_rows} |`).join('\n')}\n\n${report.checks.map(c => `- ${c.code}: ${c.count} (${c.severity})`).join('\n')}\n\nIdentifiers: ${JSON.stringify(report.identifiers)}. Rating methods remain unsupported without cited state rules.\n`);
  return report;
}
