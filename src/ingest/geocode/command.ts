import type { Database } from "../../db/database.js";
import { migrate, migrationsDirectory } from "../../db/migrate.js";
import { ingestGeocode } from "./index.js";
import type { GeocodeOptions } from "./index.js";
export async function runGeocode(
  args: string[],
  openDatabase: () => Database,
  output: { out(message: string): void; error(message: string): void },
  directory = migrationsDirectory,
): Promise<number> {
  const options: GeocodeOptions = {};
  for (let i = 0; i < args.length; i++) {
    const value = args[i + 1];
    if (
      args[i] === "--county" &&
      !options.county &&
      /^48\d{3}$/.test(value ?? "")
    ) {
      options.county = value;
      i++;
    } else if (
      args[i] === "--zips" &&
      !options.zips &&
      /^\d{5}(,\d{5})*$/.test(value ?? "")
    ) {
      options.zips = value!.split(",");
      i++;
    } else if (
      args[i] === "--source" &&
      !options.source &&
      ["npi_address", "qhp_provider_address"].includes(value ?? "")
    ) {
      options.source = value as GeocodeOptions["source"];
      i++;
    } else if (args[i] === "--state" && value === "TX") i++;
    else {
      output.error(
        "Usage: worker ingest geocode [--state TX] [--county 48201] [--zips 77002,77030] [--source npi_address|qhp_provider_address]",
      );
      return 1;
    }
  }
  let db: Database | undefined,
    code = 0;
  try {
    db = openDatabase();
    await migrate(db, directory);
    output.out(JSON.stringify(await ingestGeocode(db, options)));
  } catch {
    output.error(
      "worker ingest geocode failed; check database, Census availability and cache",
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
