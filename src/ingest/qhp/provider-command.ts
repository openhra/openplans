import type { Database } from "../../db/database.js";
import { migrate, migrationsDirectory } from "../../db/migrate.js";
import { ingestQhpBatch } from "./formulary-batch.js";

export async function runQhpProviders(
  args: string[],
  openDatabase: () => Database,
  output: { out(message: string): void; error(message: string): void },
  directory = migrationsDirectory,
): Promise<number> {
  const flags = new Map<string, string>();
  const usage =
    "Usage: worker ingest qhp providers --year YYYY --state ST (--issuer NNNNN | --all-readable)";
  for (let at = 0; at < args.length;) {
    const key = args[at++]!;
    if (
      flags.has(key) ||
      !["--year", "--state", "--issuer", "--all-readable"].includes(key)
    ) {
      output.error(usage);
      return 1;
    }
    const value = key === "--all-readable" ? "true" : args[at++];
    if (!value) {
      output.error(usage);
      return 1;
    }
    flags.set(key, value);
  }
  const year = flags.get("--year") ?? "",
    state = flags.get("--state") ?? "",
    issuer = flags.get("--issuer");
  if (
    !/^20\d\d$/.test(year) ||
    !/^[A-Z]{2}$/.test(state) ||
    (issuer
      ? !/^\d{5}$/.test(issuer) || flags.has("--all-readable")
      : !flags.has("--all-readable"))
  ) {
    output.error(usage);
    return 1;
  }
  let db: Database | undefined,
    code = 0;
  try {
    db = openDatabase();
    await migrate(db, directory);
    const report = await ingestQhpBatch(db, "providers", {
      year: Number(year),
      state,
      issuer,
    });
    output.out(JSON.stringify(issuer ? report.issuers[0] : report));
    if (report.issuers.some((r) => r.completeness !== "complete")) code = 1;
  } catch {
    output.error(
      "worker ingest qhp providers failed; check cached children, catalog and database",
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
