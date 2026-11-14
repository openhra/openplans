import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildProviderSearchKeys } from "../../src/api/provider-search-keys.js";
import { createDatabase } from "../../src/db/database.js";
import type { Database, SqlSession } from "../../src/db/database.js";
import {
  BACKFILL_RUNNING,
  MaintenanceConflict,
  MIGRATION_LOCK,
  MIGRATION_RUNNING,
  PROVIDER_SEARCH_BUILD_LOCK,
  refuseDuringBackfill,
  refuseDuringMigration,
} from "../../src/db/maintenance-locks.js";
import { migrate } from "../../src/db/migrate.js";
import { POOL_MAX } from "../../src/db/scope.js";
import { runWorker } from "../../src/worker/commands.js";
import { testDatabase } from "../pglite.js";

// A provider-search backfill and a migration refuse to run at the
// same time, and the backfill refuses without 8 GB free on the database's disk. Synthetic
// databases only.

/** A session where another backend holds `held`; records every statement. */
function heldBy(held: number) {
  const seen: string[] = [];
  const session: SqlSession = {
    query: async (sql) => {
      seen.push(sql);
      return {
        rows: [{ free: !sql.includes(`pg_try_advisory_lock(${held})`) }],
      } as never;
    },
    exec: async () => {},
  };
  return { session, seen };
}

describe("maintenance lock checks", () => {
  it("refuse a migration while a backfill holds its key, and the reverse", async () => {
    await expect(
      refuseDuringBackfill(heldBy(PROVIDER_SEARCH_BUILD_LOCK).session),
    ).rejects.toThrow(new MaintenanceConflict(BACKFILL_RUNNING));
    await expect(
      refuseDuringMigration(heldBy(MIGRATION_LOCK).session),
    ).rejects.toThrow(new MaintenanceConflict(MIGRATION_RUNNING));
  });

  it("release the other job's key at once when it is free", async () => {
    const free = heldBy(0);
    await refuseDuringBackfill(free.session);
    await refuseDuringMigration(free.session);
    expect(free.seen).toEqual([
      `SELECT pg_try_advisory_lock(${PROVIDER_SEARCH_BUILD_LOCK}) AS free`,
      `SELECT pg_advisory_unlock(${PROVIDER_SEARCH_BUILD_LOCK})`,
      `SELECT pg_try_advisory_lock(${MIGRATION_LOCK}) AS free`,
      `SELECT pg_advisory_unlock(${MIGRATION_LOCK})`,
    ]);
  });
});

interface Run {
  code: number;
  out: string[];
  err: string[];
  opened: number;
}
async function worker(
  args: string[],
  open: () => Database = () => testDatabase(new PGlite()),
): Promise<Run> {
  const result: Run = { code: 0, out: [], err: [], opened: 0 };
  result.code = await runWorker(
    args,
    () => {
      result.opened += 1;
      return open();
    },
    { out: (line) => result.out.push(line), error: (l) => result.err.push(l) },
  );
  return result;
}

describe("backfill disk preflight", () => {
  const saved = process.env.DATABASE_URL;
  beforeAll(() => {
    process.env.DATABASE_URL = "postgres://synthetic@localhost:5432/synthetic";
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved;
  });

  it("refuses without a free-space measurement, before opening the database", async () => {
    const run = await worker(["backfill", "provider-search"]);
    expect(run.code).toBe(1);
    expect(run.opened).toBe(0);
    expect(run.err.join("\n")).toContain("needs 8 GB free");
  });

  it("refuses below 8 GB and names the measured space", async () => {
    const run = await worker([
      "backfill",
      "provider-search",
      "--free-gb",
      "7.9",
    ]);
    expect(run.code).toBe(1);
    expect(run.opened).toBe(0);
    expect(run.err[0]).toMatch(
      /^worker backfill provider-search refused: 7\.9 GB free, below 8 GB\./,
    );
  });

  it("refuses a disk path it cannot read and a malformed size", async () => {
    for (const args of [
      ["--disk", "/nonexistent/openplans-synthetic"],
      ["--free-gb", "lots"],
      ["--free-gb"],
      ["--other", "1"],
    ]) {
      const run = await worker(["backfill", "provider-search", ...args]);
      expect(run.code).toBe(1);
      expect(run.opened).toBe(0);
    }
  });

  it("starts the build at 8 GB or more", async () => {
    // An unmigrated database: the build itself fails, after the preflight passed.
    const run = await worker(["backfill", "provider-search", "--free-gb", "8"]);
    expect(run.opened).toBe(1);
    expect(run.err.join("\n")).toContain("run worker migrate first");
  });
});

// The refusals between sessions need a real server: PGlite has one backend, and a backend
// never conflicts with its own advisory locks. P3I_POSTGIS_URL names a disposable server whose
// role may create databases.
const serverUrl = process.env.P3I_POSTGIS_URL;

describe.skipIf(!serverUrl)(
  "maintenance locks across sessions (PostgreSQL)",
  () => {
    const name = `maint_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    let url: string;
    let db: Database;
    let other: pg.Client;
    beforeAll(async () => {
      const admin = new pg.Client({ connectionString: serverUrl });
      await admin.connect();
      await admin.query(`CREATE DATABASE ${name}`);
      await admin.end();
      const parsed = new URL(serverUrl!);
      parsed.pathname = `/${name}`;
      url = parsed.toString();
      db = createDatabase(url);
      await migrate(db);
      other = new pg.Client({ connectionString: url });
      await other.connect();
    });
    afterAll(async () => {
      await other?.end();
      await db?.close();
      const admin = new pg.Client({ connectionString: serverUrl });
      await admin.connect();
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    });

    it("migrate and its preflight refuse while a backfill holds its key", async () => {
      await other.query(
        `SELECT pg_advisory_lock(${PROVIDER_SEARCH_BUILD_LOCK})`,
      );
      try {
        await expect(migrate(db)).rejects.toThrow(BACKFILL_RUNNING);
        const saved = process.env.DATABASE_URL;
        process.env.DATABASE_URL = url;
        try {
          for (const args of [["migrate", "--check"], ["migrate"]]) {
            const run = await worker(args, () => createDatabase(url));
            expect(run.code).toBe(1);
            expect(run.err).toEqual([
              `worker migrate refused: ${BACKFILL_RUNNING}`,
            ]);
          }
        } finally {
          if (saved === undefined) delete process.env.DATABASE_URL;
          else process.env.DATABASE_URL = saved;
        }
      } finally {
        await other.query(
          `SELECT pg_advisory_unlock(${PROVIDER_SEARCH_BUILD_LOCK})`,
        );
      }
      // Once the backfill ends, migrate runs and leaves no key behind.
      await expect(migrate(db)).resolves.toEqual([]);
      const { rows } = await other.query(
        `SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND granted`,
      );
      expect(rows[0]).toEqual({ n: 0 });
    });

    it("the backfill refuses while a migration holds its key", async () => {
      await other.query(`SELECT pg_advisory_lock(${MIGRATION_LOCK})`);
      try {
        await expect(buildProviderSearchKeys(db)).rejects.toThrow(
          MIGRATION_RUNNING,
        );
      } finally {
        await other.query(`SELECT pg_advisory_unlock(${MIGRATION_LOCK})`);
      }
      // The refused build released its own key and built nothing.
      const { rows } = await other.query(
        `SELECT (SELECT count(*)::int FROM pg_locks WHERE locktype='advisory' AND granted) AS locks,
        (SELECT count(*)::int FROM provider_search_build) AS builds`,
      );
      expect(rows[0]).toEqual({ locks: 0, builds: 0 });
      await expect(buildProviderSearchKeys(db)).resolves.toMatchObject({
        slot: "a",
      });
    });

    it("runs background reads on their own connection while the request pool is busy", async () => {
      const busy = Array.from({ length: POOL_MAX }, () =>
        db.query("SELECT pg_sleep(1.5)", [], { timeoutMs: 10_000 }),
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      const started = Date.now();
      const { rows } = await db.background!.query("SELECT 1 AS one");
      expect(rows).toEqual([{ one: 1 }]);
      expect(Date.now() - started).toBeLessThan(1_000);
      await Promise.all(busy);
    });
  },
);
