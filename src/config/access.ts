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

/**
 * The Postgres connection string from `DATABASE_URL`, else `db.connectionString` in the config
 * file. Callers pass it straight to the driver and never log it.
 */
export const databaseUrl = (
  env: Environment = process.env,
): string | undefined => loadConfig(env).db.connectionString?.reveal();

/** Whether the response cache is on: `OPENPLANS_API_CACHE`, else `cache.enabled` (default on). */
export const responseCacheEnabled = (env: Environment = process.env): boolean =>
  loadConfig(env).cache.enabled;

/**
 * The operator admission manifest from `OPENPLANS_ACCESS_MANIFEST`, else
 * `access.operatorManifest`. An empty value counts as unset.
 */
export const operatorManifest = (
  env: Environment = process.env,
): string | undefined => loadConfig(env).access.operatorManifest || undefined;

/** The project URL in the fetcher identity: `OPENPLANS_PROJECT_URL`, else `access.projectUrl`. */
export const projectUrl = (env: Environment = process.env): string =>
  loadConfig(env).access.projectUrl;

/** The anonymous access switches: `OPENPLANS_PUBLIC_*`, else the file's `public` section. */
export const publicAccess = (
  env: Environment = process.env,
): { quoting: boolean; household: boolean; compat: boolean } => {
  const { quoting, household, compat } = loadConfig(env).public;
  return { quoting, household, compat };
};

/** The household REST bearer token: `OPENPLANS_API_TOKEN`, else `tokens.api`. Never log it. */
export const apiToken = (env: Environment = process.env): string | undefined =>
  loadConfig(env).tokens.api?.reveal();

/** The compatibility API key: `OPENPLANS_COMPAT_API_KEY`, else `tokens.compatKey`. Never log it. */
export const compatApiKey = (
  env: Environment = process.env,
): string | undefined => loadConfig(env).tokens.compatKey?.reveal();

/**
 * The extra compatibility credential header name: `OPENPLANS_COMPAT_KEY_HEADER`, else
 * `tokens.compatKeyHeader`. The loader refuses a value that is not an RFC 7230 token.
 */
export const compatKeyHeaderName = (
  env: Environment = process.env,
): string | undefined => loadConfig(env).tokens.compatKeyHeader || undefined;

/** Socket peers that may supply forwarded addresses: `OPENPLANS_TRUST_PROXY`, else `trustProxy`. */
export const trustedProxies = (env: Environment = process.env): string[] => [
  ...loadConfig(env).trustProxy,
];
