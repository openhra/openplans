import { homedir } from "node:os";
import { join } from "node:path";
import { type Environment, loadConfig } from "./index.js";

/** Where the data cache lives when neither the environment nor the config file names one. */
export const defaultDataDirectory = (): string =>
  join(homedir(), ".local", "share", "openplans");

/**
 * The data cache directory from `OPENPLANS_DATA_DIR`, else `access.dataDir` in the config file.
 * Undefined when neither sets it, so a runner can keep its own default.
 */
export const configuredDataDirectory = (
  env: Environment = process.env,
): string | undefined => loadConfig(env).access.dataDir;

/** The data cache directory, defaulting to `~/.local/share/openplans`. */
export const dataDirectory = (env: Environment = process.env): string =>
  configuredDataDirectory(env) ?? defaultDataDirectory();

/**
 * The declared egress country from `OPENPLANS_EGRESS_COUNTRY`, else `access.egressCountry` in the
 * config file. An empty value counts as unset.
 */
export const egressCountry = (
  env: Environment = process.env,
): string | undefined => loadConfig(env).access.egressCountry || undefined;
