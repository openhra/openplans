import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertClassifiedTables } from "../../src/db/compact.js";
import {
  assertStagingTables,
  stagingTables,
  tableClasses,
} from "../../src/db/table-classes.js";
import { loadMigrations } from "../../src/db/migrate.js";
import { migratedTemplate } from "../pglite.js";

// qhp_provider_plan was renamed in 480; the old name now identifies a view.
const historicalNames = new Map([
  ["qhp_provider_plan", "qhp_provider_plan_legacy"],
]);
function checkMigrationTables(sql: string) {
  const tables = [
    ...sql.matchAll(
      /\bCREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z_][a-z_0-9]*)"?/gi,
    ),
  ].map((m) => historicalNames.get(m[1]!) ?? m[1]!);
  assertClassifiedTables(tables);
}

describe("core table retention inventory", () => {
  let template: Awaited<ReturnType<typeof migratedTemplate>>;
  beforeAll(async () => {
    template = await migratedTemplate();
  });
  afterAll(async () => {
    await template?.close();
  });

  it("classifies every table in every migration and the migrated database", async () => {
    expect(new Set(tableClasses.map((t) => t.name)).size).toBe(
      tableClasses.length,
    );
    for (const migration of await loadMigrations())
      checkMigrationTables(migration.sql);
    const db = await template.fresh();
    try {
      const { rows } = await db.query<{ name: string }>(
        `SELECT tablename AS name FROM pg_tables WHERE schemaname='public'`,
      );
      expect(() =>
        assertClassifiedTables(rows.map((r) => r.name)),
      ).not.toThrow();
      // Every inventory entry must exist except the extension table omitted offline.
      expect(
        tableClasses
          .map((t) => t.name)
          .filter((n) => n !== "spatial_ref_sys")
          .sort(),
      ).toEqual(
        rows
          .map((r) => r.name)
          .filter((n) => n !== "spatial_ref_sys")
          .sort(),
      );
    } finally {
      await db.close();
    }
  });

  it("negative control: an unclassified table in a disposable migration fails", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "openplans-compact-inventory-"),
    );
    try {
      const path = join(directory, "20261119000000_synthetic.sql");
      await writeFile(
        path,
        'CREATE TABLE public."synthetic_unclassified" (id integer);',
      );
      expect(() =>
        checkMigrationTables("CREATE TABLE geocode_tx_input (id integer)"),
      ).not.toThrow();
      const sql = await readFile(path, "utf8");
      expect(() => checkMigrationTables(sql)).toThrow("unclassified");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("negative control: a served or evidence table cannot enter the truncate list", () => {
    expect(
      tableClasses.find((t) => t.name === "annual_data_admission"),
    ).toEqual({
      name: "annual_data_admission",
      class: "ledger",
      yearBound: true,
    });
    expect(() => assertStagingTables(stagingTables)).not.toThrow();
    for (const table of tableClasses.filter((t) => t.class !== "staging"))
      expect(() => assertStagingTables([...stagingTables, table.name])).toThrow(
        "not a classified staging table",
      );
  });
});
