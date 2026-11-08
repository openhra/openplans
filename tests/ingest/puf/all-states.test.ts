import { PGlite } from '@electric-sql/pglite';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { coreMigrations, testDatabase } from '../../pglite.js';
import { migrate } from '../../../src/db/migrate.js';
import type { Database, SqlSession } from '../../../src/db/database.js';
import { IMPORT_KINDS, importRows } from '../../../src/ingest/puf/import-source.js';
import type { ImportFile } from '../../../src/ingest/puf/import-source.js';
import { importAllStates, partitionPufs, pufStates } from '../../../src/ingest/puf/import-batch.js';
import { ingestRatingRules, ratingRule } from '../../../src/ingest/rating-rules/index.js';

const fixtures = fileURLToPath(new URL('../../fixtures/puf/import/', import.meta.url));
async function syntheticTwoStateFiles(directory: string): Promise<ImportFile[]> {
  return Promise.all(IMPORT_KINDS.map(async kind => {
    const original = await readFile(join(fixtures, `${kind}.csv`), 'utf8');
    // Labelled synthetic second state: clone the complete real TX cut; no fabricated premium values.
    const cut = original.trimEnd(), newline = cut.indexOf('\n');
    const copy = cut.slice(newline + 1).replaceAll('TX', 'AL');
    const body = `${cut}\n${copy}\n`, path = join(directory, `synthetic-two-state-${kind}.csv`);
    await writeFile(path, body);
    return { kind, path, format: 'csv', sha256: createHash('sha256').update(body).digest('hex'), bytes: Buffer.byteLength(body),
      retrievedAt: '2026-11-07T00:00:00Z', url: 'https://www.cms.gov/synthetic-test-cut' };
  }));
}
describe('publication-derived state batches', () => {
  it('preserves original physical row numbers in partitions and detects partition byte damage', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openplans-state-partitions-'));
    let partitions;
    try {
      const files = await syntheticTwoStateFiles(directory);
      expect(await pufStates(files, 2026)).toEqual(['AL', 'TX']);
      partitions = await partitionPufs(files, ['AL', 'TX'], 2026, directory);
      const sourceRows = [];
      for await (const row of importRows(files.find(f => f.kind === 'rate')!)) if (row.values.StateCode === 'AL') sourceRows.push(row.rowNumber);
      const file = partitions.states.get('AL')!.find(f => f.kind === 'rate')!;
      const actual = []; for await (const row of importRows(file)) actual.push(row.rowNumber);
      expect(actual).toEqual(sourceRows); expect(file.rowCache!.count).toBe(actual.length);
      await writeFile(file.rowCache!.path, 'mutant');
      const { verifyImportFile } = await import('../../../src/ingest/puf/import-source.js');
      await expect(verifyImportFile(file)).rejects.toThrow('partition integrity');
    } finally { await partitions?.cleanup(); await rm(directory, { recursive: true, force: true }); }
  });
  it('negative control: dropping AL last persisted rate fails its count check while the next state activates', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openplans-state-mutant-'));
    const pg = new PGlite(), db = testDatabase(pg), core = await coreMigrations();
    try {
      await migrate(db, core.directory);
      let tripped = false;
      const mutant: Database = { ...db, transaction: run => db.transaction(tx => {
        const session: SqlSession = { ...tx, query: async <Row extends Record<string, unknown>>(sql: string, args?: unknown[]) => {
          const result = await tx.query<Row>(sql, args);
          if (!tripped && sql.startsWith('UPDATE puf_import_file SET input_rows') && String(args?.[0]).includes('-AL-') && String(args?.[0]).endsWith(':rate')) {
            tripped = true;
            await tx.query('DELETE FROM rate WHERE snapshot_id=$1 AND source_row=(SELECT max(source_row) FROM rate WHERE snapshot_id=$1)', [args![0]]);
          }
          return result;
        } };
        return run(session);
      }) };
      const seen: string[] = [];
      const report = await importAllStates(mutant, { year: 2026, files: await syntheticTwoStateFiles(directory), dataDir: directory,
        onState: r => { seen.push(`${r.state}:${r.status}`); } });
      expect(tripped).toBe(true); expect(report.passed).toBe(false);
      expect(seen).toEqual(['AL:QUARANTINED', 'TX:ACTIVE']);
      expect(report.results[0]!.report!.checks).toContainEqual(expect.objectContaining({ code: 'state_source_row_count', count: 1, severity: 'error' }));
      expect((await db.query('SELECT state FROM puf_active_catalog ORDER BY state')).rows).toEqual([{ state: 'TX' }]);
      const manifest = JSON.parse(await readFile(join(directory, 'reports/puf-2026-all-states.json'), 'utf8'));
      expect(manifest.results.map((r: {state: string}) => r.state)).toEqual(['AL', 'TX']);
    } finally { await db.close(); await core.cleanup(); await rm(directory, { recursive: true, force: true }); }
  });
  it('activates explicitly selected complete year rules, keeping NY/VT unsupported and 2027 Oregon absent', async () => {
    const db = testDatabase(new PGlite()), core = await coreMigrations();
    try {
      await migrate(db, core.directory);
      for (const year of [2026, 2027]) {
        const path = fileURLToPath(new URL(`../../../data/rating-rules/${year}.json`, import.meta.url));
        const result = await ingestRatingRules(db, path);
        expect(result.rules).toBe(year === 2026 ? 32 : 31);
        for (const state of ['AL', 'AK', 'MS', 'UT', 'TX']) expect(await ratingRule(db, state, year, 'individual')).toMatchObject({ method: 'per_member', citation: expect.stringContaining('147.102(c)(1)') });
        for (const state of ['NY', 'VT']) expect(await ratingRule(db, state, year, 'individual')).toMatchObject({ method: 'unsupported' });
      }
      expect(await ratingRule(db, 'OR', 2026, 'individual')).toMatchObject({ method: 'per_member' });
      expect(await ratingRule(db, 'OR', 2027, 'individual')).toBeNull();
    } finally { await db.close(); await core.cleanup(); }
  });
  it('negative control: a NY per_member rules-file mutant is rejected before any database write', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openplans-ny-mutant-'));
    try {
      const document = JSON.parse(await readFile(new URL('../../../data/rating-rules/2026.json', import.meta.url), 'utf8'));
      const ny = document.rules.find((r: {state: string}) => r.state === 'NY');
      expect(ny.method).toBe('unsupported');
      Object.assign(ny, { method: 'per_member', member_rate_basis: 'filed_rate_rows', child_rule: 'three_oldest_covered_children_under_21' });
      const path = join(directory, 'synthetic-NY-per-member.json'); await writeFile(path, JSON.stringify(document));
      await expect(ingestRatingRules({ transaction: () => { throw new Error('must not write'); } } as unknown as Database, path)).rejects.toThrow('Unsupported per-member rule');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
