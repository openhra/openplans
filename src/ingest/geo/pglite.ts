#!/usr/bin/env node
// Developer entry point: npm run build, then node dist/ingest/geo/pglite.js ingest geo --state TX.
// Requires dev dependencies. Real downloads, DB files and reports remain in OPENPLANS_DATA_DIR.
import { PGlite } from '@electric-sql/pglite';
import { mkdtemp, cp, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database, SqlSession } from '../../db/database.js';
import { migrationsDirectory } from '../../db/migrate.js';
import { runGeo } from './command.js';
import { dataDirectory } from './sources.js';
import { createGeoRepository } from './repository.js';

const args = process.argv.slice(2);
if (args[0] !== 'ingest' || args[1] !== 'geo') {
  console.error('Usage: node dist/ingest/geo/pglite.js ingest geo [--state TX]'); process.exitCode = 1;
} else {
  const dataDir = dataDirectory();
  const directory = await mkdtemp(join(tmpdir(), 'openplans-geo-migrations-'));
  let pg: PGlite | undefined;
  let db: Database | undefined;
  try {
    // PGlite has no PostGIS. Geo uses portable SQL; production migrate never skips extensions.
    for (const name of await readdir(migrationsDirectory)) {
      if (name.endsWith('.sql') && name !== '002_postgis.sql') await cp(join(migrationsDirectory, name), join(directory, name));
    }
    const dbPath = join(dataDir, 'geo-pglite');
    const output: string[] = [];
    process.exitCode = await runGeo(args.slice(2), () => {
      pg = new PGlite(dbPath);
      const session: SqlSession = {
        query: (sql, parameters) => pg!.query(sql, parameters), exec: async (sql) => { await pg!.exec(sql); },
      };
      db = { ...session, close: () => pg!.close(), transaction: (run) => pg!.transaction((tx) => run({
        query: (sql, parameters) => tx.query(sql, parameters), exec: async (sql) => { await tx.exec(sql); },
      })) };
      // Keep the developer DB open for the public geography report below.
      return { ...db, close: async () => {} };
    }, { out: (message) => { output.push(message); console.log(message); }, error: (message) => console.error(message) }, directory);
    if (process.exitCode === 0 && db) {
      const multiCounty = await createGeoRepository(db).zipToCounties('75034');
      const report = { database: 'PGlite file', dbPath, import: output.length === 1 ? JSON.parse(output[0]!) : output.map(message => JSON.parse(message)), multiCounty };
      await mkdir(join(dataDir, 'reports'), { recursive: true });
      const reportPath = join(dataDir, 'reports', 'p1b-geo-realdata.json');
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
      console.log(JSON.stringify({ reportPath }));
    }
  } catch {
    console.error('geography PGlite run failed; inspect source schema, cache and geography schema'); process.exitCode = 1;
  } finally {
    await db?.close(); await rm(directory, { recursive: true, force: true });
  }
}
