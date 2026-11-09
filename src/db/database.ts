import pg from "pg";

export interface SqlSession {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: unknown[],
  ): Promise<{ rows: Row[] }>;
  exec(sql: string): Promise<void>;
  /** Read-only request scope, with server timeout and active SQL cancellation. */
  withRequest?<T>(
    signal: AbortSignal,
    run: (session: SqlSession) => Promise<T>,
  ): Promise<T>;
}

export interface Database extends SqlSession {
  transaction<T>(run: (session: SqlSession) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function session(
  client: pg.Pool | pg.PoolClient,
  queryTimeout?: number,
): SqlSession {
  return {
    query: (sql, parameters) =>
      queryTimeout === undefined
        ? client.query(sql, parameters)
        : client.query({
            text: sql,
            values: parameters,
            query_timeout: queryTimeout,
          } as pg.QueryConfig),
    exec: async (sql) => {
      await client.query(sql);
    },
  };
}

export function createDatabase(
  connectionString = process.env.DATABASE_URL,
): Database {
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const pool = new pg.Pool({
    connectionString,
    connectionTimeoutMillis: 2_000,
    query_timeout: 5_000,
    max: 5,
  });
  // Cancellation must not queue behind the work it needs to stop.
  const cancelPool = new pg.Pool({
    connectionString,
    connectionTimeoutMillis: 2_000,
    query_timeout: 2_000,
    max: 1,
  });
  cancelPool.on("error", () => {});
  // An idle connection can fail after a DB restart. Do not log connection details.
  pool.on("error", () => {});

  return {
    ...session(pool),
    async withRequest(signal, run) {
      signal.throwIfAborted();
      const client = await pool.connect();
      let cancellation: Promise<unknown> | undefined;
      let discard = false;
      const cancel = () => {
        // A separate connection remains available even during parallel plan reads.
        cancellation ??= cancelPool
          .query("SELECT pg_cancel_backend($1)", [
            (client as pg.PoolClient & { processID: number }).processID,
          ])
          .catch(() => {
            discard = true;
          });
      };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        signal.throwIfAborted();
        await client.query("BEGIN READ ONLY");
        await client.query("SET LOCAL statement_timeout = '5s'");
        // Let the server enforce 5s first; the client fallback only covers a broken connection.
        const scoped = session(client, 6_000);
        const value = await run({
          query: (sql, parameters) => {
            signal.throwIfAborted();
            return scoped.query(sql, parameters);
          },
          exec: (sql) => {
            signal.throwIfAborted();
            return scoped.exec(sql);
          },
        });
        signal.throwIfAborted();
        await client.query("COMMIT");
        return value;
      } catch (error) {
        await cancellation;
        try {
          await client.query("ROLLBACK");
        } catch {
          discard = true;
        }
        throw error;
      } finally {
        signal.removeEventListener("abort", cancel);
        await cancellation;
        client.release(discard);
      }
    },
    async transaction(run) {
      const client = await pool.connect();
      let discard = false;
      try {
        await client.query("BEGIN");
        const value = await run(session(client));
        await client.query("COMMIT");
        return value;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          discard = true;
        }
        throw error;
      } finally {
        client.release(discard);
      }
    },
    close: async () => {
      await Promise.all([pool.end(), cancelPool.end()]);
    },
  };
}
