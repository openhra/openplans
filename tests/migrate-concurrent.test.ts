import { PGlite } from "@electric-sql/pglite";
import { testDatabase } from "./pglite.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Database, SqlSession } from "../src/db/database.js";
import { migrate } from "../src/db/migrate.js";

// Synthetic session tracks autocommit boundaries independently of the migration runner.
function fakeSession(failIndex = false) {
  const calls: string[] = [];
  const journal: { name: string; sha256: string }[] = [];
  let inTransaction = false;
  const exec = async (sql: string) => {
    calls.push(sql);
    if (sql === "BEGIN") inTransaction = true;
    if (sql === "COMMIT" || sql === "ROLLBACK") inTransaction = false;
    if (/CREATE INDEX CONCURRENTLY/.test(sql)) {
      expect(inTransaction).toBe(false);
      if (failIndex) throw new Error("Synthetic index failure");
    }
  };
  const query = async (sql: string, args?: unknown[]) => {
    calls.push(sql);
    if (sql.startsWith("SELECT name, sha256")) return { rows: [...journal] };
    if (sql.startsWith("INSERT INTO schema_migrations"))
      journal.push({ name: args![0] as string, sha256: args![1] as string });
    return { rows: [] };
  };
  const session = { exec, query } as SqlSession;
  const db: Database = {
    ...session,
    close: async () => {},
    transaction: async () => {
      throw new Error("Unexpected transaction path");
    },
    withSession: async (run) => run(session),
  };
  return { db, calls, journal };
}

describe("concurrent migration execution boundaries", () => {
  it("runs the real portable session adapter without wrapping the concurrent index in a transaction", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "openplans-concurrent-portable-"),
    );
    const pg = new PGlite();
    try {
      await writeFile(
        join(directory, "001_table.sql"),
        "CREATE TABLE synthetic(id integer);",
      );
      await writeFile(
        join(directory, "002_index.sql"),
        "CREATE INDEX CONCURRENTLY synthetic_idx ON synthetic(id);",
      );
      await writeFile(
        join(directory, "003_column.sql"),
        "ALTER TABLE synthetic ADD COLUMN value text;",
      );
      const db = testDatabase(pg);
      expect(await migrate(db, directory)).toEqual([
        "001_table.sql",
        "002_index.sql",
        "003_column.sql",
      ]);
      expect(
        (
          await pg.query(
            "SELECT indisvalid FROM pg_index WHERE indexrelid='synthetic_idx'::regclass",
          )
        ).rows,
      ).toEqual([{ indisvalid: true }]);
      expect(await migrate(db, directory)).toEqual([]);
    } finally {
      await pg.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("treats a bare PGlite adapter as pinned and refuses any other adapter without a session", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "openplans-concurrent-bare-"),
    );
    const pg = new PGlite();
    try {
      await writeFile(
        join(directory, "001_table.sql"),
        "CREATE TABLE synthetic(id integer);",
      );
      await writeFile(
        join(directory, "002_index.sql"),
        "CREATE INDEX CONCURRENTLY synthetic_idx ON synthetic(id);",
      );
      const { withSession: _unused, ...bare } = testDatabase(pg);
      expect(await migrate(bare as Database, directory)).toEqual([
        "001_table.sql",
        "002_index.sql",
      ]);
      // A server that is not PGlite, reached without a pinned session, must not build it.
      const { db } = fakeSession();
      const { withSession: _pooled, ...pooled } = db;
      await expect(
        migrate(
          {
            ...pooled,
            query: async (sql: string, args?: unknown[]) =>
              sql.includes("version()")
                ? { rows: [{ pglite: false }] }
                : db.query(sql, args),
          } as Database,
          directory,
        ),
      ).rejects.toThrow(
        "Concurrent indexes require a pinned PostgreSQL session",
      );
    } finally {
      await pg.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("holds a session lock, commits ordinary files, and builds indexes in autocommit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openplans-concurrent-"));
    const { db, calls, journal } = fakeSession();
    try {
      await writeFile(
        join(directory, "001_table.sql"),
        "CREATE TABLE synthetic(id integer);",
      );
      await writeFile(
        join(directory, "002_index.sql"),
        "CREATE INDEX CONCURRENTLY synthetic_idx ON synthetic(id);",
      );
      await writeFile(
        join(directory, "003_column.sql"),
        "ALTER TABLE synthetic ADD COLUMN value text;",
      );
      expect(await migrate(db, directory)).toEqual([
        "001_table.sql",
        "002_index.sql",
        "003_column.sql",
      ]);
      expect(journal).toHaveLength(3);
      expect(calls.indexOf("COMMIT")).toBeLessThan(
        calls.findIndex((s) => s.startsWith("CREATE INDEX CONCURRENTLY")),
      );
      expect(calls.indexOf("SELECT pg_advisory_lock(1869636974)")).toBeLessThan(
        calls.indexOf("BEGIN"),
      );
      expect(calls).toContain("SET lock_timeout = '2s'");
      expect(calls.slice(-3)).toEqual([
        "SELECT pg_advisory_unlock(1869636974)",
        "RESET lock_timeout",
        "RESET max_parallel_maintenance_workers",
      ]);
      expect(await migrate(db, directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("does not journal a failed index and always releases the advisory lock", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "openplans-concurrent-fail-"),
    );
    const { db, calls, journal } = fakeSession(true);
    try {
      await writeFile(
        join(directory, "001_index.sql"),
        "CREATE INDEX CONCURRENTLY synthetic_idx ON synthetic(id);",
      );
      await expect(migrate(db, directory)).rejects.toThrow(
        "Synthetic index failure",
      );
      expect(journal).toEqual([]);
      expect(calls).toContain("SELECT pg_advisory_unlock(1869636974)");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it.each([
    "CREATE TABLE synthetic(id integer); CREATE INDEX CONCURRENTLY synthetic_idx ON synthetic(id);",
    "CREATE INDEX CONCURRENTLY idx ON synthetic(id); CREATE INDEX CONCURRENTLY idx2 ON synthetic(value);",
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS synthetic_idx ON synthetic(id);",
  ])(
    "refuses mixed files or retries that could hide an invalid index: %s",
    async (sql) => {
      const directory = await mkdtemp(
        join(tmpdir(), "openplans-concurrent-mixed-"),
      );
      const { db, journal } = fakeSession();
      try {
        await writeFile(join(directory, "001_index.sql"), sql);
        await expect(migrate(db, directory)).rejects.toThrow(
          /standalone|inspection/,
        );
        expect(journal).toEqual([]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
