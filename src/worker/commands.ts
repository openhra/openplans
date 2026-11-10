import { runRecordPolicy } from "./record-policy.js";
import { databaseErrorDiagnostic } from "./database-error.js";
import { runSbe } from "../ingest/sbe/command.js";
import { runState } from "../ingest/state/command.js";
import { runBootstrap } from "./bootstrap.js";
import { runQhpProviders } from "../ingest/qhp/provider-command.js";
import { runGeocode } from "../ingest/geocode/command.js";
import { runQhpFormulary } from "../ingest/qhp/formulary-command.js";
import { runNppes } from "../ingest/nppes/command.js";
import { runQhpDiscover } from "../ingest/qhp/discover-command.js";
import { runRxnorm } from "../ingest/rxnorm/command.js";
import { runMedicare } from "../ingest/medicare/command.js";
import { runPufImport, runPufLineage } from "../ingest/puf/import-command.js";
import { runGeo } from "../ingest/geo/command.js";
import { coverageManifest } from "../db/availability.js";
import type { Database } from "../db/database.js";
import { migrate, migrationsDirectory } from "../db/migrate.js";
import { backfillRowProvenance } from "../db/row-provenance.js";
import { runPufAcquire } from "../ingest/puf/acquire.js";
import { runRatingRules } from "../ingest/rating-rules/command.js";
import { runTaxonomy } from "../ingest/taxonomy/command.js";

const usage =
  "Usage: worker migrate | status | record-policy list|set|expire | backfill row-provenance [--table NAME] [--blocks N] | ingest puf|qhp|nppes|rxnorm|taxonomy|geo|medicare";
const ingesters = new Set(["puf", "qhp", "nppes", "rxnorm", "taxonomy", "geo"]);

export interface WorkerOutput {
  out(message: string): void;
  error(message: string): void;
}

export async function runWorker(
  args: string[],
  openDatabase: (connectionString?: string) => Database,
  output: WorkerOutput,
  directory = migrationsDirectory,
): Promise<number> {
  if (args[0] === "record-policy")
    return runRecordPolicy(
      args.slice(1),
      () => openWithQueryTimeout(openDatabase, 3_600_000),
      output,
    );
  if (args[0] === "ingest" && args[1] === "sbe")
    return runSbe(
      args.slice(2),
      () => openWithQueryTimeout(openDatabase, 300_000),
      output,
      directory,
    );
  if (args[0] === "backfill" && args[1] === "row-provenance")
    return runRowProvenanceBackfill(args.slice(2), openDatabase, output);
  if (args[0] === "bootstrap")
    return runBootstrap(args.slice(1), openDatabase, output, directory);
  if (args[0] === "ingest" && args[1] === "state") {
    return runState(args.slice(2), openDatabase, output, directory);
  }
  if (args[0] === "ingest" && args[1] === "qhp" && args[2] === "providers") {
    return runQhpProviders(args.slice(3), openDatabase, output, directory);
  }
  if (args[0] === "ingest" && args[1] === "geocode") {
    return runGeocode(args.slice(2), openDatabase, output, directory);
  }
  if (args[0] === "ingest" && args[1] === "qhp" && args[2] === "formulary") {
    return runQhpFormulary(args.slice(3), openDatabase, output, directory);
  }
  if (args[0] === "ingest" && args[1] === "qhp" && args[2] === "discover") {
    return runQhpDiscover(args.slice(3), openDatabase, output, directory);
  }
  if (args[0] === "ingest" && args[1] === "nppes") {
    return runNppes(args.slice(2), openDatabase, output, directory);
  }
  if (args[0] === "ingest" && args[1] === "rxnorm") {
    return runRxnorm(args.slice(2), openDatabase, output, directory);
  }
  if (args[0] === "ingest" && args[1] === "medicare") {
    // A PBP release inserts about 1.5 M rows in one transaction.
    return runMedicare(
      args.slice(2),
      () => openWithQueryTimeout(openDatabase, 3_600_000),
      output,
      directory,
    );
  }
  if (args[0] === "ingest" && args[1] === "taxonomy") {
    return runTaxonomy(args.slice(2), openDatabase, output, directory);
  }
  if (args[0] === "ingest" && args[1] === "rating-rules") {
    return runRatingRules(args.slice(2), openDatabase, output, directory);
  }
  if (args[0] === "ingest" && args[1] === "puf" && args[2] === "import") {
    // National reconciliation scans exceed the API's five-second read timeout.
    return runPufImport(
      args.slice(3),
      () => openWithQueryTimeout(openDatabase, 300_000),
      output,
      directory,
    );
  }
  if (args[0] === "ingest" && args[1] === "puf" && args[2] === "lineage") {
    return runPufLineage(
      args.slice(3),
      () => openWithQueryTimeout(openDatabase, 300_000),
      output,
      directory,
    );
  }
  if (args[0] === "ingest" && args[1] === "puf" && args[2] === "acquire") {
    return runPufAcquire(args.slice(3), output);
  }
  if (args[0] === "ingest" && args[1] === "geo") {
    return runGeo(args.slice(2), openDatabase, output, directory);
  }
  if (args.length === 2 && args[0] === "ingest" && ingesters.has(args[1]!)) {
    output.error(`ingest ${args[1]}: not implemented`);
    return 1;
  }
  const command = args[0];
  if (args.length !== 1 || (command !== "migrate" && command !== "status")) {
    output.error(usage);
    return 1;
  }
  let db: Database | undefined;
  let exitCode = 0;
  try {
    // Index builds on a populated database take minutes (740 on TX: 6m28s).
    db =
      command === "migrate"
        ? openWithQueryTimeout(openDatabase, 3_600_000)
        : openDatabase();
    if (command === "migrate") {
      const applied = await migrate(db, directory);
      output.out(JSON.stringify({ applied }));
    } else {
      output.out(JSON.stringify(await coverageManifest(db)));
    }
  } catch (error) {
    // Driver errors can contain credentials, URLs or source-record contents.
    output.error(
      `worker ${command} failed${databaseErrorDiagnostic(error)}; check database connectivity and migration files`,
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

async function runRowProvenanceBackfill(
  args: string[],
  openDatabase: (connectionString?: string) => Database,
  output: WorkerOutput,
): Promise<number> {
  let table: string | undefined, blocks: number | undefined;
  for (let i = 0; i < args.length; i += 2) {
    const value = args[i + 1] ?? "";
    if (
      args[i] === "--table" &&
      table === undefined &&
      /^[a-z_][a-z0-9_]*$/.test(value)
    )
      table = value;
    else if (
      args[i] === "--blocks" &&
      blocks === undefined &&
      /^[1-9][0-9]{0,6}$/.test(value)
    )
      blocks = Number(value);
    else {
      output.error(
        "Usage: worker backfill row-provenance [--table NAME] [--blocks N]",
      );
      return 1;
    }
  }
  let db: Database | undefined,
    code = 0;
  try {
    db = openWithQueryTimeout(openDatabase, 3_600_000);
    await backfillRowProvenance(db, { table, blocks }, (result) =>
      output.out(JSON.stringify(result)),
    );
  } catch (error) {
    output.error(
      `worker backfill row-provenance failed${databaseErrorDiagnostic(error)}; run worker migrate first and check the database`,
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

// pg accepts query_timeout in the connection URI and it overrides the pool's five-second default;
// an operator's explicit setting wins.
function openWithQueryTimeout(
  openDatabase: (connectionString?: string) => Database,
  milliseconds: number,
): Database {
  const connection = process.env.DATABASE_URL;
  if (!connection) return openDatabase();
  const url = new URL(connection);
  if (!url.searchParams.has("query_timeout"))
    url.searchParams.set("query_timeout", String(milliseconds));
  return openDatabase(url.href);
}
