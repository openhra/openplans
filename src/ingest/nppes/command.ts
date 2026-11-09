import type { Database } from "../../db/database.js";
import { migrate, migrationsDirectory } from "../../db/migrate.js";
import { acquireRelease, discoverCurrent } from "./acquire.js";
import type { Kind } from "./acquire.js";
import { importNppes } from "./import.js";

export async function runNppes(
  args: string[],
  openDatabase: () => Database,
  output: { out(message: string): void; error(message: string): void },
  directory = migrationsDirectory,
): Promise<number> {
  let state: string | undefined,
    kind: Kind | "all" = "all",
    hasKind = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--state" && !state && /^[A-Z]{2}$/.test(args[i + 1] ?? ""))
      state = args[++i];
    else if (
      args[i] === "--kind" &&
      !hasKind &&
      ["full", "weekly", "deactivation", "all"].includes(args[i + 1] ?? "")
    ) {
      kind = args[++i] as Kind | "all";
      hasKind = true;
    } else {
      output.error(
        "Usage: worker ingest nppes --state TX [--kind full|weekly|deactivation|all]",
      );
      return 1;
    }
  }
  if (!state) {
    output.error(
      "Usage: worker ingest nppes --state TX [--kind full|weekly|deactivation|all]",
    );
    return 1;
  }
  let db: Database | undefined,
    code = 0;
  try {
    db = openDatabase();
    await migrate(db, directory);
    const releases = await discoverCurrent();
    for (const next of ["full", "weekly", "deactivation"] as Kind[]) {
      if (kind !== "all" && kind !== next) continue;
      const release = releases.find((r) => r.kind === next);
      if (!release) {
        output.error(`NPPES ${next}: official V2 link unavailable`);
        code = 1;
        continue;
      }
      try {
        output.out(
          JSON.stringify(
            await importNppes(db, {
              ...(await acquireRelease(release)),
              state,
            }),
          ),
        );
      } catch {
        output.error(
          `NPPES ${next} failed; check publisher availability, cache and quarantined snapshots`,
        );
        code = 1;
      }
    }
  } catch {
    output.error(
      "worker ingest nppes failed; check database, CMS V2 page and cache",
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
