import type { PGlite } from "@electric-sql/pglite";
import type { Database, SqlSession } from "../src/db/database.js";

/**
 * Simulated concurrent sessions over one PGlite connection. PGlite has a single session, so two
 * real transactions cannot overlap. Here each `transaction` is a logical session: statements run
 * one by one, and the row locks PostgreSQL would hold are modelled for the delivery table and for
 * transaction-scoped advisory locks:
 *
 * - `FOR UPDATE ... SKIP LOCKED` skips `plugin_event_delivery` rows another session holds;
 * - `FOR UPDATE` without `SKIP LOCKED` waits until the holder ends, then re-reads;
 * - a query without `FOR UPDATE` takes no lock at all;
 * - `pg_try_advisory_xact_lock` returns false while another session holds the key.
 *
 * Statements are not rolled back with their logical transaction. Tests that need rollback use
 * `testDatabase` from ./pglite.js.
 */
export function concurrentSessions(pg: PGlite): Database & {
  heldBy(): Map<string, number>;
} {
  const held = new Map<string, number>();
  let released: Array<() => void> = [];
  let next = 0;
  const waitForRelease = () =>
    new Promise<void>((resolve) => released.push(resolve));
  const release = (session: number) => {
    for (const [key, owner] of held) if (owner === session) held.delete(key);
    const waiting = released;
    released = [];
    for (const wake of waiting) wake();
  };
  const othersHold = (session: number) =>
    [...held].filter(([, owner]) => owner !== session).map(([key]) => key);
  const rowKey = (row: Record<string, unknown>) =>
    `delivery:${String(row.event_id)}|${String(row.subscriber)}`;

  async function hidingLocked<Row>(
    keys: string[],
    sql: string,
    parameters: unknown[] | undefined,
  ): Promise<{ rows: Row[] }> {
    const pairs = keys
      .filter((key) => key.startsWith("delivery:"))
      .map((key) => key.slice("delivery:".length));
    let result: { rows: Row[] } | undefined;
    const rollback = new Error("simulated rollback");
    try {
      await pg.transaction(async (tx) => {
        // Make held rows invisible to this statement only, then undo.
        await tx.query(
          `UPDATE plugin_event_delivery SET delivered_at = 'epoch'
            WHERE event_id || '|' || subscriber = ANY($1::text[])`,
          [pairs],
        );
        result = (await tx.query(sql, parameters)) as { rows: Row[] };
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
    return result!;
  }

  function session(id: number): SqlSession {
    return {
      async query<Row extends Record<string, unknown>>(
        sql: string,
        parameters?: unknown[],
      ) {
        if (/pg_try_advisory_xact_lock/.test(sql)) {
          const { rows } = await pg.query<{ key: number }>(
            "SELECT hashtext('schedule:' || $1) AS key",
            parameters,
          );
          const key = `advisory:${rows[0]!.key}`;
          const owner = held.get(key);
          if (owner !== undefined && owner !== id)
            return { rows: [{ locked: false }] as unknown as Row[] };
          held.set(key, id);
          return { rows: [{ locked: true }] as unknown as Row[] };
        }
        if (!/\bFOR UPDATE\b/.test(sql))
          return (await pg.query(sql, parameters)) as { rows: Row[] };
        for (;;) {
          const others = othersHold(id);
          const result = /\bSKIP LOCKED\b/.test(sql)
            ? await hidingLocked<Row>(others, sql, parameters)
            : ((await pg.query(sql, parameters)) as { rows: Row[] });
          if (result.rows.some((row) => others.includes(rowKey(row)))) {
            await waitForRelease();
            continue;
          }
          for (const row of result.rows) held.set(rowKey(row), id);
          return result;
        }
      },
      exec: async (sql: string) => {
        await pg.exec(sql);
      },
    };
  }

  return {
    query: (sql, parameters) => pg.query(sql, parameters),
    exec: async (sql) => {
      await pg.exec(sql);
    },
    async transaction(run) {
      const id = ++next;
      try {
        return await run(session(id));
      } finally {
        release(id);
      }
    },
    close: () => pg.close(),
    heldBy: () => held,
  };
}
