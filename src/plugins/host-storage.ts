import type { CoreConfig } from "../config/index.js";
import type { Database } from "../db/database.js";
import { configureHostBlobStore } from "../fetch/blob/index.js";
import {
  CORE_PLUGIN_NAME,
  providerTables,
  selectBlobStore,
  selectDatabase,
  unknownProviders,
} from "./providers.js";
import type { ProviderTables } from "./providers.js";
import { currentRegistries } from "./registries.js";

export interface HostStorageOptions {
  /** Provider tables; defaults to the core providers plus the plugins this process loaded. */
  tables?: ProviderTables;
  writeLog?: (line: string) => void;
  exit?: (code: number) => never;
}

const hostTables = (options: HostStorageOptions) =>
  options.tables ?? providerTables(currentRegistries());

/**
 * Design 5.7, run by the API, worker and MCP stdio entry points once plugins have loaded. A
 * `db.provider` or `blobs.provider` that no table offers ends startup with the loader's
 * refusal line and exit code 1. With plugins enabled the loader has already refused it.
 *
 * The selected blob store becomes the fetch cache's default. The core `local` store is left
 * unset, so `fetchToCache` keeps writing under each call's own data directory.
 */
export function startHostStorage(
  config: CoreConfig,
  options: HostStorageOptions = {},
): void {
  const tables = hostTables(options);
  const [missing] = unknownProviders(config, tables).filter(
    (path) => path !== "cache.provider",
  );
  if (missing) {
    const writeLog =
      options.writeLog ?? ((line) => void process.stderr.write(`${line}\n`));
    writeLog(
      JSON.stringify({
        plugin: CORE_PLUGIN_NAME,
        code: "plugin_provider_unknown",
        reason: missing,
      }),
    );
    (options.exit ?? ((code) => process.exit(code)))(1);
    return;
  }
  configureHostBlobStore(
    config.blobs.provider === "local"
      ? undefined
      : selectBlobStore(config, tables),
  );
}

/** Opens `db.provider` (default `pg`, the core Postgres pool) through the registry. */
export function openHostDatabase(
  config: CoreConfig,
  connectionString: string | undefined = config.db.connectionString?.reveal(),
  options: Pick<HostStorageOptions, "tables"> = {},
): Database {
  return selectDatabase(
    config,
    hostTables(options),
    config.db.provider,
    connectionString,
  );
}
