import { PGlite } from "@electric-sql/pglite";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { copyMigrations } from "../../src/db/copy-migrations.js";
import { createDatabase, type Database } from "../../src/db/database.js";
import { loadMigrations, migrate } from "../../src/db/migrate.js";
import { testDatabase } from "../pglite.js";

const auditSql = await readFile(
  new URL("../../scripts/restore-function-audit.sql", import.meta.url),
  "utf8",
);
const fix = (await loadMigrations()).find(({ name }) =>
  name.endsWith("_restore_function_search_path.sql"),
)!;

type FunctionRow = { name: string; settings: string[] | null };
async function audit(db: Database) {
  const { rows } = await db.query<FunctionRow>(auditSql);
  return rows.filter(
    ({ settings }) => !settings?.includes("search_path=public, pg_catalog"),
  );
}

async function migrateBeforeFix(db: Database, postgis: boolean) {
  const directory = await mkdtemp(join(tmpdir(), "openplans-restore-path-"));
  try {
    await copyMigrations(directory, [
      fix.name,
      ...(postgis ? [] : ["002_postgis.sql"]),
    ]);
    await migrate(db, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("stored expression function audit", () => {
  it("audits CHECKs, defaults, generated columns and expression/partial indexes", async () => {
    const db = testDatabase(new PGlite());
    try {
      await migrateBeforeFix(db, process.env.OPENPLANS_TEST_DB === "postgres");
      expect((await audit(db)).map(({ name }) => name)).toEqual([
        "geocode_in_state",
        "provider_search_trigrams",
      ]);
      const mutant = fix.sql.replace(
        "SET search_path = public, pg_catalog AS $$",
        () => "AS $$",
      );
      expect(mutant).not.toBe(fix.sql);
      await db.exec(mutant);
      expect((await audit(db)).map(({ name }) => name)).toEqual([
        "geocode_in_state",
      ]);
      await db.exec(fix.sql);
      expect(await audit(db)).toEqual([]);
      const settings = await db.query<FunctionRow>(
        "SELECT proname AS name,proconfig AS settings FROM pg_proc WHERE proname='geocode_state_extent'",
      );
      expect(settings.rows[0]?.settings).toContain(
        "search_path=public, pg_catalog",
      );
      for (const [name, definition] of [
        [
          "check",
          "CREATE TABLE synthetic_check (n integer CHECK (synthetic_check_fn(n)>0))",
        ],
        [
          "default",
          "CREATE TABLE synthetic_default (n integer DEFAULT synthetic_default_fn(1))",
        ],
        [
          "generated",
          "CREATE TABLE synthetic_generated (n integer, g integer GENERATED ALWAYS AS (synthetic_generated_fn(n)) STORED)",
        ],
        [
          "index",
          "CREATE INDEX synthetic_index ON synthetic_check ((synthetic_index_fn(n)))",
        ],
        [
          "partial",
          "CREATE INDEX synthetic_partial ON synthetic_check (n) WHERE synthetic_partial_fn(n)>0",
        ],
      ]) {
        await db.exec(`CREATE FUNCTION synthetic_${name}_fn(n integer) RETURNS integer
          LANGUAGE sql IMMUTABLE AS 'SELECT n'; ${definition}`);
        expect((await audit(db)).map((row) => row.name)).toContain(
          `synthetic_${name}_fn`,
        );
        await db.exec(
          `ALTER FUNCTION synthetic_${name}_fn(integer) SET search_path = public, pg_catalog`,
        );
        expect(await audit(db)).toEqual([]);
      }
      // A dropped SET must fail even though the function body is schema-qualified.
      await db.exec(
        "ALTER FUNCTION public.geocode_in_state(text,float8,float8,float8,float8) RESET search_path",
      );
      expect((await audit(db)).map((row) => row.name)).toEqual([
        "geocode_in_state",
      ]);
    } finally {
      await db.close();
    }
  });
});

const serverUrl = process.env.P3I_POSTGIS_URL;
describe.skipIf(!serverUrl)("full pg_restore on disposable PostGIS", () => {
  it("fails with geocode rows before the fix and restores fully after it", async () => {
    const container = process.env.OPENPLANS_POSTGIS_CONTAINER!;
    expect(container).toMatch(
      /^openplans-(?:gate-postgis|fa14-nightly|postgis-tests)-/,
    );
    const admin = new pg.Client({ connectionString: serverUrl });
    await admin.connect();
    const source = `restore_source_${randomUUID().replaceAll("-", "")}`;
    const target = `restore_target_${randomUUID().replaceAll("-", "")}`;
    const command = (tool: string, args: string[], input?: Buffer) =>
      spawnSync(
        "docker",
        [
          // Docker context comes from DOCKER_CONTEXT (the gate sets the lanes context; CI uses its default).
          "exec",
          "-i",
          container,
          tool,
          "-U",
          "openplans",
          ...args,
        ],
        { input, maxBuffer: 64 * 1024 * 1024 },
      );
    let db: Database | undefined;
    try {
      await admin.query(`CREATE DATABASE ${source}`);
      const url = new URL(serverUrl!);
      url.pathname = `/${source}`;
      db = createDatabase(url.href);
      await migrateBeforeFix(db, true);
      // Synthetic geocode evidence only; no provider identities or source downloads.
      await db.exec(`INSERT INTO source(source_id,publisher,source_kind) VALUES('synthetic-restore','Synthetic','test');
        INSERT INTO snapshot(snapshot_id,source_id) VALUES('synthetic-restore','synthetic-restore');
        INSERT INTO geocode_tx_county(county_fips,name,south,north,west,east,rings,snapshot_id)
          VALUES('48201','Synthetic county',29,31,-96,-94,'[]','synthetic-restore');
        INSERT INTO geocode_tx_result(address_hash,normalized_address,match_status,match_quality,method,
          latitude,longitude,county_basis,county_fips,snapshot_id)
          VALUES(repeat('a',64),'Synthetic address','Match','Exact','census_geocoder',29.7,-95.3,
            'point_in_county','48201','synthetic-restore');`);
      const restore = async (success: boolean) => {
        const dump = command("pg_dump", ["-Fc", "-d", source]);
        expect(dump.status, dump.stderr.toString()).toBe(0);
        await admin.query(`CREATE DATABASE ${target}`);
        try {
          const result = command(
            "pg_restore",
            ["--exit-on-error", "--no-owner", "--no-privileges", "-d", target],
            dump.stdout,
          );
          if (success) {
            expect(result.status, result.stderr.toString()).toBe(0);
            url.pathname = `/${target}`;
            const restored = createDatabase(url.href);
            try {
              expect(
                (
                  await restored.query(
                    "SELECT count(*)::int AS n FROM geocode_tx_county",
                  )
                ).rows[0]?.n,
              ).toBe(1);
              expect(
                (
                  await restored.query(
                    "SELECT count(*)::int AS n FROM geocode_tx_result",
                  )
                ).rows[0]?.n,
              ).toBe(1);
              expect(await audit(restored)).toEqual([]);
              await restored.exec("SET search_path = ''");
              expect(
                (
                  await restored.query(
                    "SELECT public.geocode_in_state('48201',29,31,-96,-94) AS valid",
                  )
                ).rows[0]?.valid,
              ).toBe(true);
            } finally {
              await restored.close();
            }
          } else {
            expect(result.status).not.toBe(0);
            expect(result.stderr.toString()).toContain(
              "function geocode_state_extent(text) does not exist",
            );
            expect(result.stderr.toString()).toContain(
              "COPY geocode_tx_county",
            );
          }
        } finally {
          await admin.query(`DROP DATABASE ${target} WITH (FORCE)`);
        }
      };
      await restore(false);
      await db.exec(fix.sql);
      await restore(true);
    } finally {
      await db?.close();
      await admin.query(`DROP DATABASE IF EXISTS ${source} WITH (FORCE)`);
      await admin.end();
    }
  }, 60_000);
});
