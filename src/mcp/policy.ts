import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { SqlSession } from "../db/database.js";
import type { McpDependencies } from "./server.js";

export type McpEnvironment = Record<string, string | undefined>;
const processSecret = randomBytes(32);
export const DEADLINE_MS = 15_000;
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
  };
}
/** One bounded SQL scope per query; cancellation also forbids subsequent queries. */
export function boundedDatabase(
  db: SqlSession,
  signal: AbortSignal,
): SqlSession {
  return {
    async query<Row extends Record<string, unknown>>(
      sql: string,
      parameters?: unknown[],
    ) {
      signal.throwIfAborted();
      const result = db.withRequest
        ? await db.withRequest(signal, (session) =>
            session.query<Row>(sql, parameters),
          )
        : await db.query<Row>(sql, parameters);
      signal.throwIfAborted();
      return result;
    },
    async exec(sql) {
      signal.throwIfAborted();
      await this.query(sql);
    },
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
