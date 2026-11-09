import type { Database } from "../../db/database.js";
import { migrate, migrationsDirectory } from "../../db/migrate.js";
import { ingestGeoNames } from "./geonames.js";
import { ingestGeo } from "./index.js";
import {
  cachedImportFiles,
  importDataDirectory,
} from "../puf/import-source.js";
import { pufStates } from "../puf/import-batch.js";
import { STATE_FIPS } from "./states.js";

/** State/year geo dispatch, ready for the worker router to delegate here. */
export async function runGeo(
  args: string[],
  openDatabase: () => Database,
  output: { out(message: string): void; error(message: string): void },
  directory = migrationsDirectory,
): Promise<number> {
  if (args[0] === "--source" && args[1] === "geonames") {
    if (args.length !== 2) {
      output.error("Usage: worker ingest geo --source geonames");
      return 1;
    }
    let db: Database | undefined,
      code = 0;
    try {
      db = openDatabase();
      await migrate(db, directory);
      output.out(JSON.stringify(await ingestGeoNames(db)));
    } catch {
      output.error("GeoNames import failed; previous snapshot preserved");
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
  let state: string | undefined,
    year = 2026,
    yearSeen = false,
    all = false;
  const usage =
    "Usage: worker ingest geo [--year 2026|2027] [--state XX | --all-states]";
  for (let at = 0; at < args.length; at++) {
    if (
      args[at] === "--year" &&
      !yearSeen &&
      /^(2026|2027)$/.test(args[at + 1] ?? "")
    ) {
      year = Number(args[++at]);
      yearSeen = true;
    } else if (
      args[at] === "--state" &&
      !state &&
      STATE_FIPS[args[at + 1] ?? ""]
    )
      state = args[++at];
    else if (args[at] === "--all-states" && !all) all = true;
    else {
      output.error(usage);
      return 1;
    }
  }
  if (state && all) {
    output.error(usage);
    return 1;
  }
  let db: Database | undefined,
    code = 0;
  try {
    const states = all
      ? await pufStates(
          (await cachedImportFiles(importDataDirectory(), year)).files,
          year,
        )
      : [state ?? "TX"];
    db = openDatabase();
    await migrate(db, directory);
    for (const state of states) {
      try {
        output.out(
          JSON.stringify(await ingestGeo(db, { state, planYear: year })),
        );
      } catch {
        output.error(
          `Geography ${state} PY${year} failed; previous import preserved`,
        );
        code = 1;
      }
    }
  } catch {
    output.error(
      "worker ingest geo failed; check database, publication and geography sources",
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
