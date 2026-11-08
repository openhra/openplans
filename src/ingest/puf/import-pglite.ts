#!/usr/bin/env node
/** Developer runner for the real import without Docker. DB and reports stay in the shared cache. */
import { PGlite } from '@electric-sql/pglite';
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database, SqlSession } from '../../db/database.js';
import { migrationsDirectory } from '../../db/migrate.js';
import { runWorker } from '../../worker/commands.js';
import { plansForCounty } from './import.js';
import { importDataDirectory } from './import-source.js';

const dataDir = importDataDirectory(), directory = await mkdtemp(join(tmpdir(), 'openplans-puf-migrations-'));
let db: Database | undefined;
try {
  // PUF tables use portable SQL. This developer-only copy skips the unavailable PostGIS extension.
  for (const name of await readdir(migrationsDirectory)) {
    if (name.endsWith('.sql') && name !== '002_postgis.sql') await cp(join(migrationsDirectory, name), join(directory, name));
  }
  const dbPath = process.env.OPENPLANS_PUF_DB ?? join(dataDir, process.argv.includes('--all-states') ? 'puf-pglite-all-states' : 'puf-pglite-p1d');
  await mkdir(dataDir, { recursive: true });
  const messages: string[] = [];
  process.exitCode = await runWorker(process.argv.slice(2), () => {
    const pg = new PGlite(dbPath);
    const session: SqlSession = { query: (sql, args) => pg.query(sql, args), exec: async sql => { await pg.exec(sql); } };
    db = { ...session, close: () => pg.close(), transaction: run => pg.transaction(tx => run({
      query: (sql, args) => tx.query(sql, args), exec: async sql => { await tx.exec(sql); },
    })) };
    return { ...db, close: async () => {} };
  }, { out: message => { messages.push(message); console.log(message); }, error: message => console.error(message) }, directory);
  if (db && process.exitCode === 0) {
    const report = JSON.parse(messages.at(-1)!);
    const hasTexas = report.state === 'TX' || report.results?.some((result: { state: string; status: string }) => result.state === 'TX' && result.status === 'ACTIVE');
    const plans = hasTexas ? await plansForCounty(db, '48201', report.year, 'Individual') : [];
    const medical = plans.filter(plan => !plan.dental_only), onExchange = medical.filter(plan => plan.on_exchange);
    const summary = { database: 'PGlite file (portable SQL; no Docker/PostGIS needed for catalog)', dbPath,
      import: report, harris: { all_individual_medical: medical.length, on_exchange: onExchange.length,
        plan_ids: onExchange.map(plan => plan.base_plan_id),
        issuer_counts: Object.fromEntries([...new Set(onExchange.map(p => p.issuer_id))].sort().map(issuer => [issuer, onExchange.filter(p => p.issuer_id === issuer).length])),
        partial_county: onExchange.filter(plan => plan.zip_restricted).length } };
    const path = join(dataDir, 'reports', 'p1d-puf-realdata.json');
    await writeFile(path, `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify({ report: path, harris: summary.harris }));
  }
} catch {
  console.error('PUF PGlite run failed; check acquired manifest, local data and schema'); process.exitCode = 1;
} finally {
  await db?.close(); await rm(directory, { recursive: true, force: true });
}
