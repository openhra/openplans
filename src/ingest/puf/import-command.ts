import type { Database } from "../../db/database.js";
import { migrate, migrationsDirectory } from "../../db/migrate.js";
import { importPufs } from "./import.js";
import { importAllStates } from "./import-batch.js";
import { importPlanLineage } from "./import-lineage.js";

export async function runPufImport(
  args: string[],
  openDatabase: () => Database,
  output: { out(message: string): void; error(message: string): void },
  directory = migrationsDirectory,
): Promise<number> {
  let year: number | undefined, state: string | undefined;
  let allStates = false;
  for (let at = 0; at < args.length; at++) {
    if (
      args[at] === "--year" &&
      year === undefined &&
      /^(2026|2027)$/.test(args[at + 1] ?? "")
    )
      year = Number(args[++at]);
    else if (
      args[at] === "--state" &&
      state === undefined &&
      /^[A-Z]{2}$/.test(args[at + 1] ?? "")
    )
      state = args[++at];
    else if (args[at] === "--all-states" && !allStates) allStates = true;
    else {
      output.error(
        "Usage: worker ingest puf import --year 2026|2027 (--state XX | --all-states)",
      );
      return 1;
    }
  }
  if (
    year === undefined ||
    (state === undefined && !allStates) ||
    (state !== undefined && allStates)
  ) {
    output.error(
      "Usage: worker ingest puf import --year 2026|2027 (--state XX | --all-states)",
    );
    return 1;
  }
  let db: Database | undefined,
    code = 0;
  try {
    db = openDatabase();
    await migrate(db, directory);
    const report = allStates
      ? await importAllStates(db, {
          year,
          onState: (result) => output.out(JSON.stringify(result)),
        })
      : await importPufs(db, { year, state: state! });
    output.out(JSON.stringify(report));
    code = report.passed ? 0 : 1;
  } catch {
    output.error(
      "worker ingest puf import failed; check acquired manifest, data cache and database",
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

/** worker ingest puf lineage --year 2026|2027: the acquired Plan ID Crosswalk PUF. */
export async function runPufLineage(
  args: string[],
  openDatabase: () => Database,
  output: { out(message: string): void; error(message: string): void },
  directory = migrationsDirectory,
): Promise<number> {
  if (
    args.length !== 2 ||
    args[0] !== "--year" ||
    !/^(2026|2027)$/.test(args[1] ?? "")
  ) {
    output.error("Usage: worker ingest puf lineage --year 2026|2027");
    return 1;
  }
  let db: Database | undefined,
    code = 0;
  try {
    db = openDatabase();
    await migrate(db, directory);
    const report = await importPlanLineage(db, { year: Number(args[1]) });
    output.out(JSON.stringify(report));
    code = report.passed ? 0 : 1;
  } catch {
    output.error(
      "worker ingest puf lineage failed; check acquired manifest, data cache and database",
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
