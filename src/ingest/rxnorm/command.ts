import type { Database } from "../../db/database.js";
import { migrate, migrationsDirectory } from "../../db/migrate.js";
import { acquireRelease } from "./acquire.js";
import { importRxnorm } from "./import.js";

export async function runRxnorm(
  args: string[],
  openDatabase: () => Database,
  output: { out(message: string): void; error(message: string): void },
  directory = migrationsDirectory,
): Promise<number> {
  if (args.length) {
    output.error("Usage: worker ingest rxnorm");
    return 1;
  }
  let db: Database | undefined,
    code = 0;
  try {
    db = openDatabase();
    await migrate(db, directory);
    const release = await acquireRelease();
    output.out(JSON.stringify(await importRxnorm(db, release)));
  } catch {
    output.error(
      "worker ingest rxnorm failed; check database, public CPC files page and cache; never use a UMLS login",
    );
    code = 1;
  } finally {
    try {
      await db?.close();
    } catch {
      output.error("worker database shutdown failed");
      code = 1;
    }
  }
  return code;
}
