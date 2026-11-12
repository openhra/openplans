import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { SqlSession } from "../db/database.js";
import type { McpDependencies } from "./server.js";
import { boundedDatabase, DEADLINE_MS } from "../db/bounded.js";
import { loadConfig } from "../config/index.js";
import type { CoreConfig } from "../config/index.js";

export { boundedDatabase, DEADLINE_MS };

export type McpEnvironment = Record<string, string | undefined>;
const processSecret = randomBytes(32);
export function authenticated(
  header: string | null,
  token: string | undefined,
): boolean {
  if (!token || !header?.startsWith("Bearer ")) return false;
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(header.slice(7)), digest(token));
}
/**
 * Household tools (quote_premiums, check_ichra_affordability) are open to anonymous callers
 * unless the operator sets OPENPLANS_MCP_TOKEN or OPENPLANS_PUBLIC_HOUSEHOLD=off.
 */
export function householdOpen(env: McpEnvironment): boolean {
  return configHouseholdOpen(loadConfig(env));
}
export function configHouseholdOpen(config: CoreConfig): boolean {
  return !config.tokens.mcp && config.public.household;
}
export function dependencies(
  db: SqlSession,
  env: McpEnvironment,
  granted: boolean,
  estimateGranted = false,
): McpDependencies {
  return configDependencies(db, loadConfig(env), granted, estimateGranted);
}
/**
 * `estimateGranted` is the Medicare drug-cost estimate grant. HTTP passes only a verified Bearer
 * token, never household openness; stdio passes its personalized-tool grant.
 */
export function configDependencies(
  db: SqlSession,
  config: CoreConfig,
  granted: boolean,
  estimateGranted = false,
): McpDependencies {
  return {
    ...(estimateGranted ? { medicareEstimateGrant: true } : {}),
    db,
    cursorSecret: config.tokens.mcpCursorSecret?.reveal() || processSecret,
    principal: granted ? { id: "personalized" } : undefined,
    policy: { canEstimate: (principal) => principal?.id === "personalized" },
    publicQuoting: config.public.quoting,
  };
}
export function requestDependencies(
  deps: McpDependencies,
  signal: AbortSignal,
): McpDependencies {
  return {
    ...deps,
    db: boundedDatabase(
      deps.db,
      AbortSignal.any([signal, AbortSignal.timeout(DEADLINE_MS)]),
    ),
  };
}
