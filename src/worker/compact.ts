import type { Database } from "../db/database.js";
import { compactDatabase } from "../db/compact.js";
import { MaintenanceConflict } from "../db/maintenance-locks.js";
import { databaseErrorDiagnostic } from "./database-error.js";
import type { WorkerOutput } from "./commands.js";

export async function runCompact(
  args: string[],
  open: () => Database,
  output: WorkerOutput,
): Promise<number> {
  if (args.length && !(args.length === 1 && args[0] === "--dry-run")) {
    output.error("Usage: worker compact [--dry-run]");
    return 1;
  }
  let db: Database | undefined;
  let exitCode = 0;
  try {
    db = open();
    output.out(
      JSON.stringify(await compactDatabase(db, args[0] === "--dry-run")),
    );
  } catch (error) {
    output.error(
      error instanceof MaintenanceConflict
        ? `worker compact refused: ${error.message}`
        : `worker compact failed${databaseErrorDiagnostic(error)}; check the database and finish all imports before retrying`,
    );
    exitCode = 1;
  } finally {
    try {
      await db?.close();
    } catch {
      output.error("worker database shutdown failed");
      exitCode = 1;
    }
  }
  return exitCode;
}
