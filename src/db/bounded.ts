import type { SqlSession } from "./database.js";

/** Request deadline shared by MCP calls and public quotes. */
export const DEADLINE_MS = 15_000;

/** One bounded SQL scope per query; cancellation also forbids subsequent queries. */
export function boundedDatabase(
  db: SqlSession,
  signal: AbortSignal,
  options?: { readOnly?: boolean },
): SqlSession {
  return {
    background: db.background ?? db,
    async query<Row extends Record<string, unknown>>(
      sql: string,
      parameters?: unknown[],
    ) {
      signal.throwIfAborted();
      const result = db.withRequest
        ? await db.withRequest(
            signal,
            (session) => session.query<Row>(sql, parameters),
            options,
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
