import { describe, expect, it, vi } from "vitest";
import type { SqlSession } from "../src/db/database.js";
import { backfillRowProvenance } from "../src/db/row-provenance.js";
import { runWorker } from "../src/worker/commands.js";

function backfillDatabase() {
  return {
    query: vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("FROM row_provenance_rule"))
        return { rows: [{ table_name: "plan_benefit" }] };
      if (sql.includes("pg_relation_size")) return { rows: [{ blocks: "9" }] };
      return { rows: [{ filled: "1" }] };
    }),
    exec: vi.fn().mockResolvedValue(undefined),
    transaction: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe("worker maintenance", () => {
  it("backfill vacuums without parallel workers at the same batch intervals", async () => {
    const db = backfillDatabase();
    const events: string[] = [];
    db.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM row_provenance_rule"))
        return { rows: [{ table_name: "plan_benefit" }] };
      if (sql.includes("pg_relation_size")) return { rows: [{ blocks: "9" }] };
      events.push("batch");
      return { rows: [{ filled: "1" }] };
    });
    db.exec.mockImplementation(async (sql: string) => {
      events.push(sql);
    });
    expect(
      await backfillRowProvenance(db, { blocks: 2, vacuumEvery: 2 }),
    ).toEqual([{ table: "plan_benefit", rows: 5 }]);
    expect(events).toEqual([
      "batch",
      "batch",
      'VACUUM (PARALLEL 0) "plan_benefit"',
      "batch",
      "batch",
      'VACUUM (PARALLEL 0) "plan_benefit"',
      "batch",
      'VACUUM (PARALLEL 0) "plan_benefit"',
    ]);
  });

  it("keeps vacuumEvery=0 and identifier quoting", async () => {
    const db = backfillDatabase();
    await backfillRowProvenance(db, { vacuumEvery: 0 });
    expect(db.exec).not.toHaveBeenCalled();
    db.query.mockResolvedValueOnce({
      rows: [{ table_name: 'synthetic"table' }],
    });
    await backfillRowProvenance(db);
    expect(db.exec).toHaveBeenCalledWith(
      'VACUUM (PARALLEL 0) "synthetic""table"',
    );
  });

  it("negative control: a disposable VACUUM mutant is rejected on 64 MiB shared memory", async () => {
    const db = backfillDatabase();
    const rejectParallelVacuum = async (sql: string) => {
      if (!sql.startsWith("VACUUM (PARALLEL 0) "))
        throw new Error(
          "parallel VACUUM exceeds synthetic shared-memory budget",
        );
    };
    db.exec.mockImplementation(rejectParallelVacuum);
    await expect(backfillRowProvenance(db)).resolves.toHaveLength(1);
    // Mutate only SQL emitted through this disposable session, never the source.
    const mutant: SqlSession = {
      ...db,
      exec: (sql) => rejectParallelVacuum(sql.replace(" (PARALLEL 0)", "")),
    };
    await expect(backfillRowProvenance(mutant)).rejects.toThrow(
      "parallel VACUUM exceeds synthetic shared-memory budget",
    );
  });

  it.each([["backfill", "row-provenance"], ["migrate"], ["status"]])(
    "reports the PostgreSQL resource code and message for %j without driver metadata",
    async (...args) => {
      const db = backfillDatabase();
      const error = Object.assign(
        new Error(
          'could not resize shared memory segment "/PostgreSQL.3353134050" to 106991392 bytes: No space left on device',
        ),
        {
          code: "53100",
          detail: "synthetic-row-secret",
          hint: "postgresql://synthetic:synthetic-password@invalid/db",
          where: "synthetic-environment-secret",
        },
      );
      db.query.mockRejectedValue(error);
      db.transaction.mockRejectedValue(error);
      const output = { out: vi.fn(), error: vi.fn() };
      expect(await runWorker(args, () => db, output)).toBe(1);
      expect(output.error).toHaveBeenCalledOnce();
      expect(output.error).toHaveBeenCalledWith(
        expect.stringContaining(
          "PostgreSQL 53100: could not resize shared memory segment [redacted] to 106991392 bytes: No space left on device",
        ),
      );
      expect(output.error.mock.calls.flat().join("\n")).not.toContain(
        "synthetic-",
      );
      expect(db.close).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["22P02", 'invalid input syntax for type integer: "synthetic-row-secret"'],
    [
      "28P01",
      'password authentication failed for user "synthetic-user-secret"',
    ],
    ["P0001", "synthetic-environment-secret"],
    ["XX000", "postgresql://synthetic:synthetic-password@invalid/db"],
    ["XX000", "password=synthetic-password host=synthetic-host"],
    ["XX000", "out of memory\nsynthetic-row-secret"],
    ["not-a-code synthetic-secret", "out of memory"],
  ])("withholds sensitive values in error %s", async (code, message) => {
    const db = backfillDatabase();
    db.query.mockRejectedValue(Object.assign(new Error(message), { code }));
    const errors: string[] = [];
    expect(
      await runWorker(["backfill", "row-provenance"], () => db, {
        out: () => {},
        error: (message) => errors.push(message),
      }),
    ).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).not.toContain("synthetic");
    expect(errors[0]).not.toContain("postgresql://");
    if (/^[0-9A-Z]{5}$/.test(code))
      expect(errors[0]).toContain(`PostgreSQL ${code}:`);
  });
});
