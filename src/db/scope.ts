import type { SqlSession } from "./database.js";

/** Connections in the API pool; one request never runs more queries than this at once. */
export const POOL_MAX = 5;

export interface RequestScopeOptions {
  /** Most queries this scope runs at the same time. */
  concurrency: number;
  /** Read-only statements whose answer is shared by every caller in the scope. */
  shared: ReadonlySet<string>;
}

/**
 * One request's view of the database. Shared lookups run once per distinct
 * statement and parameters, and every caller gets its own copy of the rows.
 * Other queries wait in this scope instead of in the connection pool.
 */
export function requestScope(
  db: SqlSession,
  options: RequestScopeOptions,
): SqlSession {
  const answers = new Map<
    string,
    Promise<{ rows: Record<string, unknown>[] }>
  >();
  const waiting: (() => void)[] = [];
  let running = 0;
  async function limited<T>(run: () => Promise<T>): Promise<T> {
    // A released slot passes straight to the next waiter, so a newcomer cannot take it first.
    if (running >= options.concurrency)
      await new Promise<void>((resolve) => waiting.push(resolve));
    else running++;
    try {
      return await run();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running--;
    }
  }
  return {
    async query<Row extends Record<string, unknown>>(
      sql: string,
      parameters?: unknown[],
    ) {
      if (!options.shared.has(sql))
        return limited(() => db.query<Row>(sql, parameters));
      const key = JSON.stringify([sql, parameters ?? []]);
      let answer = answers.get(key);
      if (!answer) {
        answer = limited(() => db.query(sql, parameters));
        answers.set(key, answer);
        // A failed lookup is not reused.
        answer.catch(() => answers.delete(key));
      }
      const { rows } = await answer;
      return { rows: rows.map((row) => ({ ...row })) as Row[] };
    },
    exec: (sql) => limited(() => db.exec(sql)),
  };
}
