import { requireAnnualDocument, reportImportSkip } from "../data-window.js";
import type { Database } from "../../db/database.js";
import { migrate, migrationsDirectory } from "../../db/migrate.js";
import { ingestRatingRules, defaultRulesFile } from "./index.js";

export async function runRatingRules(
  args: string[],
  openDatabase: () => Database,
  output: { out(message: string): void; error(message: string): void },
  directory = migrationsDirectory,
): Promise<number> {
  const dryRun = args.includes("--dry-run");
  if (args.filter((arg) => arg === "--dry-run").length > 1) {
    output.error("Duplicate --dry-run");
    return 1;
  }
  args = args.filter((arg) => arg !== "--dry-run");
  if (args.length && !(args.length === 2 && args[0] === "--file" && args[1])) {
    output.error("Usage: worker ingest rating-rules [--file path]");
    return 1;
  }
  let db: Database | undefined,
    code = 0;
  try {
    const year = await requireAnnualDocument(
      args[1] ?? defaultRulesFile,
      "rating-rules",
    );
    if (dryRun) {
      output.out(
        JSON.stringify({
          planned: [{ dataset: "rating-rules", year }],
          skipped: [],
        }),
      );
      return 0;
    }
    db = openDatabase();
    await migrate(db, directory);
    output.out(JSON.stringify(await ingestRatingRules(db, args[1])));
  } catch (error) {
    if (reportImportSkip(error, output)) return 0;
    output.error(
      "worker ingest rating-rules failed; check cited rules document and database",
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
