import { readFile } from "node:fs/promises";
import { beforeEach, expect, it, vi } from "vitest";
import { importMutant, withMutantFile } from "../mutant-file.js";
import { replaceSyntax } from "../source-mutation.js";

// A stand-in pg driver: one slow statement fails the way pg reports a client read timeout.
const state = vi.hoisted(() => ({
  sql: [] as string[],
  released: [] as (boolean | undefined)[],
  failCancel: false,
}));
vi.mock("pg", () => ({
  default: {
    Pool: class {
      on() {}
      async connect() {
        return {
          processID: 456,
          release: (discard?: boolean) => {
            state.released.push(discard);
          },
          query: async (input: string | { text: string }) => {
            const sql = typeof input === "string" ? input : input.text;
            state.sql.push(sql);
            if (sql === "SELECT synthetic_slow()")
              throw new Error("Query read timeout");
            if (sql === "SELECT synthetic_broken()")
              throw new Error("synthetic SQL error");
            return { rows: [] };
          },
        };
      }
      // The separate cancellation pool.
      async query(sql: string, parameters: unknown[]) {
        expect(parameters).toEqual([456]);
        state.sql.push(sql);
        if (state.failCancel) throw new Error("synthetic cancel failure");
        return { rows: [] };
      }
      async end() {}
    },
  },
}));
import { createDatabase } from "../../src/db/database.js";

const databaseSource = new URL("../../src/db/database.ts", import.meta.url);

beforeEach(() => {
  state.sql = [];
  state.released = [];
  state.failCancel = false;
});

async function expectCancelledAndReused(create: typeof createDatabase) {
  const db = create("synthetic-connection");
  await expect(db.query("SELECT synthetic_slow()")).rejects.toThrow(
    "Query read timeout",
  );
  expect(state.sql).toEqual([
    "SELECT synthetic_slow()",
    "SELECT pg_cancel_backend($1)",
    "SELECT 1",
  ]);
  expect(state.released).toEqual([false]);
  await db.close();
}

it("a client read timeout cancels the statement and keeps the idle connection", async () => {
  await expectCancelledAndReused(createDatabase);
});

it("a failed cancellation discards the connection", async () => {
  state.failCancel = true;
  const db = createDatabase("synthetic-connection");
  await expect(db.exec("SELECT synthetic_slow()")).rejects.toThrow(
    "Query read timeout",
  );
  expect(state.sql).toEqual([
    "SELECT synthetic_slow()",
    "SELECT pg_cancel_backend($1)",
  ]);
  expect(state.released).toEqual([true]);
  await db.close();
});

it("other SQL errors cancel nothing and discard the connection", async () => {
  const db = createDatabase("synthetic-connection");
  await expect(db.query("SELECT synthetic_broken()")).rejects.toThrow(
    "synthetic SQL error",
  );
  expect(state.sql).toEqual(["SELECT synthetic_broken()"]);
  expect(state.released).toEqual([true]);
  await db.close();
});

it("a read timeout inside a transaction cancels before the rollback", async () => {
  const db = createDatabase("synthetic-connection");
  await expect(
    db.transaction((tx) => tx.query("SELECT synthetic_slow()")),
  ).rejects.toThrow("Query read timeout");
  expect(state.sql).toEqual([
    "BEGIN",
    "SELECT synthetic_slow()",
    "SELECT pg_cancel_backend($1)",
    "SELECT 1",
    "ROLLBACK",
  ]);
  expect(state.released).toEqual([false]);
  await db.close();
});

it("planted mutant: skipping the cancellation fails the check", async () => {
  const source = replaceSyntax(
    await readFile(databaseSource, "utf8"),
    "if (onReadTimeout && readTimedOut(error)) await onReadTimeout();",
    "",
  );
  await withMutantFile(databaseSource, source, async (file) => {
    const mutant = await importMutant<{
      createDatabase: typeof createDatabase;
    }>(file, "createDatabase");
    await expect(
      expectCancelledAndReused(mutant.createDatabase),
    ).rejects.toThrow();
  });
});
