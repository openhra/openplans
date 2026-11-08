import type { Database } from '../../db/database.js';
import { migrate, migrationsDirectory } from '../../db/migrate.js';
import { acquireRelease } from './acquire.js';
import { importTaxonomy } from './import.js';

export async function runTaxonomy(args: string[], openDatabase: () => Database,
  output: { out(message: string): void; error(message: string): void }, directory = migrationsDirectory): Promise<number> {
  if (args.length !== 1 || args[0] !== '--accept-nucc-terms') {
    output.error('Usage: worker ingest taxonomy --accept-nucc-terms (review NUCC licensing terms before importing)'); return 1;
  }
  let db: Database | undefined, code = 0;
  try { db = openDatabase(); await migrate(db, directory); output.out(JSON.stringify(await importTaxonomy(db, await acquireRelease()))); }
  catch { output.error('worker ingest taxonomy failed; check NUCC source availability and cache'); code = 1; }
  finally { try { await db?.close(); } catch { output.error('worker database shutdown failed'); code = 1; } }
  return code;
}
