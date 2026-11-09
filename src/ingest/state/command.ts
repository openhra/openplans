import type { Database } from "../../db/database.js";
import { migrate, migrationsDirectory } from "../../db/migrate.js";
import { ingestStateRates } from "./index.js";

export async function runState(
  args: string[],
  openDatabase: () => Database,
  output: { out(message: string): void; error(message: string): void },
  directory = migrationsDirectory,
): Promise<number> {
  const usage =
    "Usage: worker ingest state --state NY|VT --file /absolute/path/to/prepared-2026.json";
  let state: "NY" | "VT" | undefined, file: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (
      args[i] === "--state" &&
      !state &&
      ["NY", "VT"].includes(args[i + 1] ?? "")
    )
      state = args[++i] as "NY" | "VT";
    else if (args[i] === "--file" && !file && args[i + 1]) file = args[++i];
    else {
      output.error(usage);
      return 1;
    }
  }
  if (!state || !file) {
    output.error(usage);
    return 1;
  }
  let db: Database | undefined,
    code = 0;
  try {
    db = openDatabase();
    await migrate(db, directory);
    output.out(JSON.stringify(await ingestStateRates(db, file, state)));
  } catch {
    output.error(
      "State rate staging failed; check source artifacts and database. Prior staged import preserved.",
    );
    code = 1;
  } finally {
    try {
      await db?.close();
    } catch {
      code = 1;
    }
  }
  return code;
}
