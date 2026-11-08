#!/usr/bin/env node
/** Developer real-data runner. npm run build; node dist/ingest/rxnorm/pglite.js */
import { PGlite } from '@electric-sql/pglite';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database, SqlSession } from '../../db/database.js';
import { migrate, migrationsDirectory } from '../../db/migrate.js';
import { acquireRelease, dataDirectory } from './acquire.js';
import { importRxnorm } from './import.js';
import type { DrugConcept } from './repository.js';
import { createRxnormRepository } from './repository.js';

const dataDir = dataDirectory(), directory = await mkdtemp(join(tmpdir(), 'openplans-rxnorm-migrations-'));
let db: Database | undefined;
try {
  // Portable RxNorm SQL; only this developer copy omits PostGIS, never production migrations.
  for (const name of await readdir(migrationsDirectory)) {
    if (name.endsWith('.sql') && name !== '002_postgis.sql') await cp(join(migrationsDirectory, name), join(directory, name));
  }
  await mkdir(dataDir, { recursive: true });
  const dbPath = join(dataDir, 'rxnorm-pglite-p2a'), pg = new PGlite(dbPath);
  const session: SqlSession = { query: (sql, args) => pg.query(sql, args), exec: async sql => { await pg.exec(sql); } };
  db = { ...session, close: () => pg.close(), transaction: run => pg.transaction(tx => run({
    query: (sql, args) => tx.query(sql, args), exec: async sql => { await tx.exec(sql); },
  })) };
  await migrate(db, directory);
  const release = await acquireRelease(dataDir);
  console.log(JSON.stringify({ acquired: release.version, sha256: release.metadata.sha256 }));
  const report = await importRxnorm(db, release);
  console.log(JSON.stringify(report));
  const noOp = await importRxnorm(db, release);
  const repo = createRxnormRepository(db);
  const searches = [];
  for (const query of ['metformin', 'lisinopril', 'lipitor']) {
    const results: DrugConcept[] = []; let offset = 0;
    for (;;) {
      const page = await repo.searchDrugs(query, { limit: 1000, offset });
      results.push(...page); if (page.length < 1000) break; offset += page.length;
    }
    const referenceDirectory = process.env.OPENPLANS_REFERENCE_CAPTURES_DIR;
    const referenceCaptures: { file: string; total: unknown; captured: number }[] = [];
    if (referenceDirectory) {
      for (const file of await readdir(join(referenceDirectory, 'drugs'))) {
        if (!file.endsWith('.json') || !file.toLowerCase().includes(query)) continue;
        const fixture = JSON.parse(await readFile(join(referenceDirectory, 'drugs', file), 'utf8'));
        referenceCaptures.push({ file, total: fixture.meta?.total, captured: fixture.drugs?.length ?? 0 });
      }
    }
    searches.push({ query, candidates: results.length, rxcuis: new Set(results.map(row => row.rxcui)).size,
      by_tty: Object.fromEntries([...new Set(results.map(row => row.tty))].sort().map(tty => [tty, results.filter(row => row.tty === tty).length])),
      examples: results.slice(0, 3), reference_captures: referenceCaptures });
  }
  const summary = { dbPath, import: report, repeat: noOp, searches,
    count_interpretation: 'RxNorm name/TTY candidates (distinct RxCUI/name/TTY/suppress), not NDC products. The commercial reference API meta.total counts NDC products. Sources and release dates also differ.',
    reference_status: process.env.OPENPLANS_REFERENCE_CAPTURES_DIR ? 'compared' : 'skipped: OPENPLANS_REFERENCE_CAPTURES_DIR unset' };
  await mkdir(join(dataDir, 'reports'), { recursive: true });
  const path = join(dataDir, 'reports', 'p2a-rxnorm-realdata.json');
  await writeFile(path, JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify({ report: path, searches }));
} finally {
  await db?.close(); await rm(directory, { recursive: true, force: true });
}
