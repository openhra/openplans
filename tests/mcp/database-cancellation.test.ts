import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  sql: [] as string[],
  released: false,
  failRollback: false,
  cancel: undefined as (() => void) | undefined,
}));
vi.mock("pg", () => ({
  default: {
    Pool: class {
      on() {}
      async connect() {
        return {
          processID: 123,
          release: () => {
            state.released = true;
          },
          query: async (
            input: string | { text: string; query_timeout: number },
          ) => {
            const sql = typeof input === "string" ? input : input.text;
            if (typeof input !== "string")
              expect(input.query_timeout).toBe(6000);
            state.sql.push(sql);
            if (sql === "SELECT synthetic_slow()")
              await new Promise((_, reject) => {
                state.cancel = () => reject(new Error("cancelled SQL"));
              });
            if (sql === "ROLLBACK" && state.failRollback)
              throw new Error("synthetic broken connection");
            return { rows: [] };
          },
        };
      }
      async query(sql: string, parameters: unknown[]) {
        expect(parameters).toEqual([123]);
        state.sql.push(sql);
        state.cancel?.();
        return { rows: [] };
      }
      async end() {}
    },
  },
}));
import { createDatabase } from "../../src/db/database.js";

beforeEach(() => {
  state.sql = [];
  state.released = false;
  state.failRollback = false;
  state.cancel = undefined;
});
it("real database adapter applies server statement_timeout, sends backend cancel, rolls back before release", async () => {
  const db = createDatabase("synthetic-connection"),
    controller = new AbortController();
  const work = db.withRequest!(controller.signal, (session) =>
    session.query("SELECT synthetic_slow()"),
  );
  while (!state.cancel) await Promise.resolve();
  expect(state.released).toBe(false);
  controller.abort();
  await expect(work).rejects.toThrow("cancelled SQL");
  expect(state.sql).toEqual([
    "BEGIN READ ONLY",
    "SET LOCAL statement_timeout = '5s'",
    "SELECT synthetic_slow()",
    "SELECT pg_cancel_backend($1)",
    "ROLLBACK",
  ]);
  expect(state.released).toBe(true);
  await db.close();
});
it("successful SQL commits and pre-aborted requests never acquire a client", async () => {
  const db = createDatabase("synthetic-connection"),
    controller = new AbortController();
  await db.withRequest!(controller.signal, (session) =>
    session.query("SELECT 1"),
  );
  expect(state.sql.at(-1)).toBe("COMMIT");
  controller.abort();
  const before = state.sql.length;
  await expect(
    db.withRequest!(controller.signal, (session) => session.query("SELECT 1")),
  ).rejects.toThrow();
  expect(state.sql).toHaveLength(before);
  await db.close();
});
