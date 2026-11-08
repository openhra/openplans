import type { Database } from '../../db/database.js';
import { migrate, migrationsDirectory } from '../../db/migrate.js';
import { ingestRatingRules } from './index.js';

export async function runRatingRules(args: string[], openDatabase: () => Database,
  output: { out(message: string): void; error(message: string): void }, directory = migrationsDirectory): Promise<number> {
  if (args.length && !(args.length === 2 && args[0] === '--file' && args[1])) {
    output.error('Usage: worker ingest rating-rules [--file path]'); return 1;
  }
  let db: Database | undefined, code = 0;
  try {
    db = openDatabase();
    await migrate(db, directory);
    output.out(JSON.stringify(await ingestRatingRules(db, args[1])));
  } catch {
    output.error('worker ingest rating-rules failed; check cited rules document and database'); code = 1;
  } finally {
    try { await db?.close(); } catch { output.error('worker database shutdown failed'); code = 1; }
  }
  return code;
}
