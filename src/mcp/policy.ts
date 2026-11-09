import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { SqlSession } from "../db/database.js";
import type { McpDependencies } from "./server.js";
import { boundedDatabase, DEADLINE_MS } from "../db/bounded.js";
import { publicQuotingFromEnv } from "../api/quotes.js";

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
export function dependencies(
  db: SqlSession,
  env: McpEnvironment,
  granted: boolean,
): McpDependencies {
  return {
    db,
    cursorSecret: env.OPENPLANS_MCP_CURSOR_SECRET || processSecret,
    principal: granted ? { id: "personalized" } : undefined,
    policy: { canEstimate: (principal) => principal?.id === "personalized" },
    publicQuoting: publicQuotingFromEnv(env.OPENPLANS_PUBLIC_QUOTING),
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
