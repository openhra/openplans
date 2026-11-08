import { runSbe } from '../ingest/sbe/command.js';
import { runState } from '../ingest/state/command.js';
import { runBootstrap } from './bootstrap.js';
import { runQhpProviders } from '../ingest/qhp/provider-command.js';
import { runGeocode } from '../ingest/geocode/command.js';
import { runQhpFormulary } from '../ingest/qhp/formulary-command.js';
import { runNppes } from '../ingest/nppes/command.js';
import { runQhpDiscover } from '../ingest/qhp/discover-command.js';
import { runRxnorm } from '../ingest/rxnorm/command.js';
import { runPufImport } from '../ingest/puf/import-command.js';
import { runGeo } from '../ingest/geo/command.js';
import { coverageManifest } from '../db/availability.js';
import type { Database } from '../db/database.js';
import { migrate, migrationsDirectory } from '../db/migrate.js';
import { runPufAcquire } from '../ingest/puf/acquire.js';
import { runRatingRules } from '../ingest/rating-rules/command.js';
import { runTaxonomy } from '../ingest/taxonomy/command.js';

const usage = 'Usage: worker migrate | status | ingest puf|qhp|nppes|rxnorm|taxonomy|geo';
const ingesters = new Set(['puf', 'qhp', 'nppes', 'rxnorm', 'taxonomy', 'geo']);

export interface WorkerOutput {
  out(message: string): void;
  error(message: string): void;
}

export async function runWorker(
  args: string[],
  openDatabase: (connectionString?: string) => Database,
  output: WorkerOutput,
  directory = migrationsDirectory,
): Promise<number> {
  if (args[0] === 'ingest' && args[1] === 'sbe') return runSbe(args.slice(2), () => openWithQueryTimeout(openDatabase, 300_000), output, directory);
  if (args[0] === 'bootstrap') return runBootstrap(args.slice(1), openDatabase, output, directory);
  if (args[0] === 'ingest' && args[1] === 'state') {
    return runState(args.slice(2), openDatabase, output, directory);
  }
  if (args[0] === 'ingest' && args[1] === 'qhp' && args[2] === 'providers') {
    return runQhpProviders(args.slice(3), openDatabase, output, directory);
  }
  if (args[0] === 'ingest' && args[1] === 'geocode') {
    return runGeocode(args.slice(2), openDatabase, output, directory);
  }
  if (args[0] === 'ingest' && args[1] === 'qhp' && args[2] === 'formulary') {
    return runQhpFormulary(args.slice(3), openDatabase, output, directory);
  }
  if (args[0] === 'ingest' && args[1] === 'qhp' && args[2] === 'discover') {
    return runQhpDiscover(args.slice(3), openDatabase, output, directory);
  }
  if (args[0] === 'ingest' && args[1] === 'nppes') {
    return runNppes(args.slice(2), openDatabase, output, directory);
  }
  if (args[0] === 'ingest' && args[1] === 'rxnorm') {
    return runRxnorm(args.slice(2), openDatabase, output, directory);
  }
  if (args[0] === 'ingest' && args[1] === 'taxonomy') {
    return runTaxonomy(args.slice(2), openDatabase, output, directory);
  }
  if (args[0] === 'ingest' && args[1] === 'rating-rules') {
    return runRatingRules(args.slice(2), openDatabase, output, directory);
  }
  if (args[0] === 'ingest' && args[1] === 'puf' && args[2] === 'import') {
    // National reconciliation scans exceed the API's five-second read timeout.
    return runPufImport(args.slice(3), () => openWithQueryTimeout(openDatabase, 300_000), output, directory);
  }
  if (args[0] === 'ingest' && args[1] === 'puf' && args[2] === 'acquire') {
    return runPufAcquire(args.slice(3), output);
  }
  if (args[0] === 'ingest' && args[1] === 'geo') {
    return runGeo(args.slice(2), openDatabase, output, directory);
  }
  if (args.length === 2 && args[0] === 'ingest' && ingesters.has(args[1]!)) {
    output.error(`ingest ${args[1]}: not implemented`);
    return 1;
  }
  const command = args[0];
  if (args.length !== 1 || (command !== 'migrate' && command !== 'status')) {
    output.error(usage);
    return 1;
  }
  let db: Database | undefined;
  let exitCode = 0;
  try {
    // Index builds on a populated database take minutes (740 on TX: 6m28s).
    db = command === 'migrate' ? openWithQueryTimeout(openDatabase, 3_600_000) : openDatabase();
    if (command === 'migrate') {
      const applied = await migrate(db, directory);
      output.out(JSON.stringify({ applied }));
    } else {
      output.out(JSON.stringify(await coverageManifest(db)));
    }
  } catch {
    // Driver errors can contain credentials, URLs or source-record contents.
    output.error(`worker ${command} failed; check database connectivity and migration files`);
    exitCode = 1;
  } finally {
    try {
      await db?.close();
    } catch {
      output.error('worker database shutdown failed');
      exitCode = 1;
    }
  }
  return exitCode;
}

// pg accepts query_timeout in the connection URI and it overrides the pool's five-second default;
// an operator's explicit setting wins.
function openWithQueryTimeout(openDatabase: (connectionString?: string) => Database, milliseconds: number): Database {
  const connection = process.env.DATABASE_URL;
  if (!connection) return openDatabase();
  const url = new URL(connection);
  if (!url.searchParams.has('query_timeout')) url.searchParams.set('query_timeout', String(milliseconds));
  return openDatabase(url.href);
}
