import pg from 'pg';

export interface SqlSession {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: unknown[],
  ): Promise<{ rows: Row[] }>;
  exec(sql: string): Promise<void>;
}

export interface Database extends SqlSession {
  transaction<T>(run: (session: SqlSession) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function session(client: pg.Pool | pg.PoolClient): SqlSession {
  return {
    query: (sql, parameters) => client.query(sql, parameters),
    exec: async (sql) => { await client.query(sql); },
  };
}

export function createDatabase(connectionString = process.env.DATABASE_URL): Database {
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const pool = new pg.Pool({
    connectionString,
    connectionTimeoutMillis: 2_000,
    query_timeout: 5_000,
    max: 5,
  });
  // An idle connection can fail after a DB restart. Do not log connection details.
  pool.on('error', () => {});

  return {
    ...session(pool),
    async transaction(run) {
      const client = await pool.connect();
      let discard = false;
      try {
        await client.query('BEGIN');
        const value = await run(session(client));
        await client.query('COMMIT');
        return value;
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { discard = true; }
        throw error;
      } finally {
        client.release(discard);
      }
    },
    close: () => pool.end(),
  };
}
