import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "../../src/db/database.js";
import { importMutant, withMutantFile } from "../mutant-file.js";
import { replaceSyntax } from "../source-mutation.js";

// READ_TIMEOUT_POSTGRES_URL, if set, names a disposable PostgreSQL database. The test only
// runs pg_sleep and reads pg_stat_activity; it creates no tables.
const url = process.env.READ_TIMEOUT_POSTGRES_URL;
const databaseSource = new URL("../../src/db/database.ts", import.meta.url);
const READ_TIMEOUT_MS = 1_000;
// Timeout, cancellation round trip and the readiness check, with room for a busy host.
const MARGIN_MS = 2_500;

describe.skipIf(!url)("read timeouts stop the statement at the server", () => {
  let observer: pg.Client;
  const timedUrl = () => {
    const u = new URL(url!);
    u.searchParams.set("query_timeout", String(READ_TIMEOUT_MS));
    return u.href;
  };
  const running = async (marker: string) =>
    Number(
      (
        await observer.query(
          `SELECT count(*) AS n FROM pg_stat_activity
            WHERE state = 'active' AND pid <> pg_backend_pid() AND query LIKE $1`,
          [`%${marker}%`],
        )
      ).rows[0].n,
    );
  beforeAll(async () => {
    observer = new pg.Client({ connectionString: url });
    await observer.connect();
  });
  afterAll(async () => {
    await observer?.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE pid <> pg_backend_pid() AND query LIKE '%qcancel-%'`,
    );
    await observer?.end();
  });

  async function slowQueryOutcome(create: typeof createDatabase) {
    const db = create(timedUrl()),
      marker = `qcancel-${randomUUID()}`;
    try {
      const before = await db.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      const started = Date.now();
      await expect(
        db.query(`SELECT pg_sleep(30) /* ${marker} */`),
      ).rejects.toThrow("Query read timeout");
      const elapsed = Date.now() - started,
        stillRunning = await running(marker);
      const after = await db.query<{ pid: number; ok: number }>(
        "SELECT pg_backend_pid() AS pid, 1 AS ok",
      );
      return {
        elapsed,
        stillRunning,
        reused: after.rows[0]!.pid === before.rows[0]!.pid,
        ok: after.rows[0]!.ok,
      };
    } finally {
      await db.close();
    }
  }

  it("cancels pg_sleep shortly after the read timeout and reuses the connection", async () => {
    const outcome = await slowQueryOutcome(createDatabase);
    expect(outcome.elapsed).toBeGreaterThanOrEqual(READ_TIMEOUT_MS - 50);
    expect(outcome.elapsed).toBeLessThan(READ_TIMEOUT_MS + MARGIN_MS);
    expect(outcome).toMatchObject({ stillRunning: 0, reused: true, ok: 1 });
  });

  it("cancels a request-scoped statement when the request aborts", async () => {
    const db = createDatabase(url!),
      marker = `qcancel-${randomUUID()}`,
      signal = AbortSignal.timeout(500),
      started = Date.now();
    try {
      await expect(
        db.withRequest!(signal, (s) =>
          s.query(`SELECT pg_sleep(30) /* ${marker} */`),
        ),
      ).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(500 + MARGIN_MS);
      expect(await running(marker)).toBe(0);
      expect((await db.query("SELECT 1 AS ok")).rows).toEqual([{ ok: 1 }]);
    } finally {
      await db.close();
    }
  });

  it("planted mutant: without cancellation pg_sleep keeps running", async () => {
    const source = replaceSyntax(
      await readFile(databaseSource, "utf8"),
      "if (onReadTimeout && readTimedOut(error)) await onReadTimeout();",
      "",
    );
    await withMutantFile(databaseSource, source, async (file) => {
      const mutant = await importMutant<{
        createDatabase: typeof createDatabase;
      }>(file, "createDatabase");
      const outcome = await slowQueryOutcome(mutant.createDatabase);
      expect(outcome.stillRunning).toBe(1);
      expect(outcome.reused).toBe(false);
    });
  });
});
