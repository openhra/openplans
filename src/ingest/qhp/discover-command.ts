import type { Database } from "../../db/database.js";
import { migrate, migrationsDirectory } from "../../db/migrate.js";
import { discoverQhp } from "./discover.js";

export async function runQhpDiscover(
  args: string[],
  openDatabase: () => Database,
  output: { out(message: string): void; error(message: string): void },
  directory = migrationsDirectory,
): Promise<number> {
  let year: number | undefined, state: string | undefined;
  for (let at = 0; at < args.length; at++) {
    if (
      args[at] === "--year" &&
      year === undefined &&
      /^20\d\d$/.test(args[at + 1] ?? "")
    )
      year = Number(args[++at]);
    else if (
      args[at] === "--state" &&
      state === undefined &&
      /^[A-Z]{2}$/.test(args[at + 1] ?? "")
    )
      state = args[++at];
    else {
      output.error("Usage: worker ingest qhp discover --year YYYY --state ST");
      return 1;
    }
  }
  if (year === undefined || state === undefined) {
    output.error("Usage: worker ingest qhp discover --year YYYY --state ST");
    return 1;
  }
  let db: Database | undefined,
    code = 0;
  try {
    db = openDatabase();
    await migrate(db, directory);
    output.out(JSON.stringify(await discoverQhp(db, { year, state })));
  } catch {
    output.error(
      "worker ingest qhp discover failed; check acquired registry, cache and database",
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
