import type { Database } from '../../db/database.js';
import { migrate, migrationsDirectory } from '../../db/migrate.js';
import { importSbe } from './import.js';
import { importDataDirectory } from '../puf/import-source.js';
import { acquireSbe, sbePublications } from './source.js';

export async function runSbe(args: string[], openDatabase: () => Database,
  output: { out(message: string): void; error(message: string): void }, directory = migrationsDirectory): Promise<number> {
  const command = args[0];
  let year: number | undefined, state: string | undefined, all = false;
  for (let at = 1; at < args.length; at++) {
    if (args[at] === '--year' && !year && /^(2026|2027)$/.test(args[at + 1] ?? '')) year = Number(args[++at]);
    else if (args[at] === '--state' && !state && /^[A-Z]{2}$/.test(args[at + 1] ?? '')) state = args[++at];
    else if (args[at] === '--all-states' && !all) all = true;
    else { output.error('Usage: worker ingest sbe acquire|import --year 2026|2027 (--state XX | --all-states)'); return 1; }
  }
  if (!['acquire', 'import'].includes(command!) || !year || (!state && !all) || (state && all)) { output.error('Invalid SBE command/scope'); return 1; }
  let db: Database | undefined;
  try {
    const dataDir = importDataDirectory();
    const links = (await sbePublications(dataDir)).filter(l => l.year === year && (!state || l.state === state));
    if (!links.length) { output.out(JSON.stringify({ status: 'not_published', year, state: state ?? null })); return 1; }
    if (command === 'import') { db = openDatabase(); await migrate(db, directory); }
    let passed = true;
    for (const link of links) {
      try {
        const files = await acquireSbe(link, dataDir);
        const report = db ? await importSbe(db, { ...link, dataDir, files }) : { ...link, source: 'cms_sbe_puf', sha256: files[0]!.sha256, passed: true };
        passed &&= report.passed;
        output.out(JSON.stringify(report));
      } catch { passed = false; output.error(`SBE ${link.state} ${link.year} failed; check source metadata and reconciliation`); }
    }
    return passed ? 0 : 1;
  } catch { output.error('SBE failed; check publication, source cache and database'); return 1; }
  finally { await db?.close(); }
}
