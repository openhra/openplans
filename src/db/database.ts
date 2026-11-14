import pg from "pg";
import { POOL_MAX } from "./scope.js";
import { databaseUrl } from "../config/access.js";

export interface QueryOptions {
  /** Client read limit for this query, in place of the pool's 5 seconds. */
  timeoutMs?: number;
}

export interface SqlSession {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: unknown[],
    options?: QueryOptions,
  ): Promise<{ rows: Row[] }>;
  /**
   * The unscoped database behind a request-scoped session, for a read that may outlive the
   * request (an exact count kept per data generation). Absent on the database itself.
   */
  readonly background?: SqlSession;
  exec(sql: string): Promise<void>;
  /** Request scope with server timeout and cancellation; read-only unless explicitly writable. */
  withRequest?<T>(
    signal: AbortSignal,
    run: (session: SqlSession) => Promise<T>,
    options?: { readOnly?: boolean },
  ): Promise<T>;
}

export interface Database extends SqlSession {
  transaction<T>(run: (session: SqlSession) => Promise<T>): Promise<T>;
  /** Run on one connection, including autocommit statements. Discard it on failure. */
  withSession?<T>(run: (session: SqlSession) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  /** Clients queued for a pooled connection; undefined where there is no pool. */
  poolWaiting?(): number;
}

function session(
  client: pg.Pool | pg.PoolClient,
  queryTimeout?: number,
  onReadTimeout?: () => Promise<unknown>,
): SqlSession {
  const run = async <Row extends Record<string, unknown>>(
    sql: string,
    parameters?: unknown[],
    options?: QueryOptions,
  ): Promise<{ rows: Row[] }> => {
    const timeout = options?.timeoutMs ?? queryTimeout;
    try {
      return timeout === undefined
        ? await client.query<Row>(sql, parameters)
        : await client.query<Row>({
            text: sql,
            values: parameters,
            query_timeout: timeout,
          } as pg.QueryConfig);
    } catch (error) {
      if (onReadTimeout && readTimedOut(error)) await onReadTimeout();
      throw error;
    }
  };
  return {
    query: run,
    exec: async (sql) => {
      await run(sql);
    },
  };
}

/** pg's client read timeout only stops waiting; the statement keeps running on the server. */
function readTimedOut(error: unknown): boolean {
  return error instanceof Error && error.message === "Query read timeout";
}

/** The `pg` database provider (design 5.7); `src/plugins/providers.ts` registers it. */
export function createDatabase(
  connectionString: string | undefined = databaseUrl(),
): Database {
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const pool = new pg.Pool({
    connectionString,
    connectionTimeoutMillis: 2_000,
    query_timeout: 5_000,
    max: POOL_MAX,
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

  const processID = (client: pg.PoolClient) =>
    (client as pg.PoolClient & { processID: number }).processID;
  /**
   * Cancel a statement whose client read timeout fired, then wait for the connection to
   * answer again. False means the connection may still be busy and must be discarded.
   */
  const stopStatement = async (client: pg.PoolClient): Promise<boolean> => {
    try {
      await cancelPool.query("SELECT pg_cancel_backend($1)", [
        processID(client),
      ]);
      // Queued behind the cancelled statement, so it returns once the server is idle.
      await client.query({
        text: "SELECT 1",
        query_timeout: 2_000,
      } as pg.QueryConfig);
      return true;
    } catch {
      return false;
    }
  };
  /** A session whose read timeouts cancel the statement; `stopped` reports the outcome. */
  const cancelling = (client: pg.PoolClient) => {
    const state: { stopped?: boolean; session: SqlSession } = {
      session: session(client, undefined, async () => {
        state.stopped = await stopStatement(client);
      }),
    };
    return state;
  };
  /** Autocommit SQL on its own connection, like pool.query, which discards on any error. */
  const autocommit = async <T>(run: (s: SqlSession) => Promise<T>) => {
    const client = await pool.connect();
    const scope = cancelling(client);
    let discard = false;
    try {
      return await run(scope.session);
    } catch (error) {
      // A cancelled statement leaves the connection idle and reusable.
      discard = scope.stopped !== true;
      throw error;
    } finally {
      client.release(discard);
    }
  };

  return {
    query: (sql, parameters, options) =>
      autocommit((s) => s.query(sql, parameters, options)),
    exec: (sql) => autocommit((s) => s.exec(sql)),
    poolWaiting: () => pool.waitingCount,
    async withRequest(signal, run, options) {
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
        await client.query(
          options?.readOnly === false ? "BEGIN" : "BEGIN READ ONLY",
        );
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
    async withSession(run) {
      const client = await pool.connect();
      let discard = false;
      try {
        return await run(cancelling(client).session);
      } catch (error) {
        discard = true;
        throw error;
      } finally {
        client.release(discard);
      }
    },
    async transaction(run) {
      const client = await pool.connect();
      let discard = false;
      try {
        await client.query("BEGIN");
        const value = await run(cancelling(client).session);
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
