import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import {
  classifyMigration,
  migrationStatements,
  missingContractNotes,
} from "../src/db/migrate-safety.js";
import { checkMigrations, loadMigrations } from "../src/db/migrate.js";
import type { Database, SqlSession } from "../src/db/database.js";
const history: Record<string, string> = JSON.parse(
  await readFile(new URL("./migrate-history.json", import.meta.url), "utf8"),
);

const safe = [
  "CREATE TABLE synthetic (name text CHECK (name LIKE 'x%'));",
  "CREATE FUNCTION synthetic() RETURNS int LANGUAGE sql AS 'SELECT 1';",
  "CREATE TABLE synthetic (id integer PRIMARY KEY, name text NOT NULL);",
  "CREATE TABLE synthetic (id integer); CREATE INDEX ON synthetic(id);",
  "ALTER TABLE synthetic ADD COLUMN description text;",
  "ALTER TABLE synthetic ADD COLUMN IF NOT EXISTS value numeric(10,2);",
  "ALTER TABLE synthetic ADD COLUMN n integer NOT NULL DEFAULT 0;",
  "ALTER TABLE synthetic ADD COLUMN s text DEFAULT 'a;--b', ADD COLUMN t timestamptz;",
  "ALTER TABLE synthetic ADD COLUMN s text DEFAULT 'unknown' NOT NULL;",
  "ALTER TABLE synthetic ADD COLUMN t timestamptz NOT NULL DEFAULT 'epoch';",
  "CREATE INDEX CONCURRENTLY synthetic_idx ON synthetic(id);",
  "CREATE UNIQUE INDEX CONCURRENTLY synthetic_idx ON public.synthetic(id);",
  "CREATE FUNCTION synthetic() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN DELETE FROM synthetic; RETURN NEW; END $body$;",
  "CREATE TRIGGER synthetic BEFORE INSERT ON synthetic FOR EACH ROW EXECUTE FUNCTION synthetic();",
  '-- synthetic comment with DROP TABLE;\n/* outer /* nested */ */ ALTER TABLE "synthetic" ADD COLUMN "new" text DEFAULT \'DROP TABLE x;\';',
];
const risky = [
  "CREATE FUNCTION synthetic() RETURNS int LANGUAGE unknown AS $$ opaque $$;",
  "ALTER TABLE synthetic ADD COLUMN n integer NOT NULL DEFAULT 0 CHECK (n >= 0);",
  "ALTER TABLE synthetic ADD COLUMN n integer NOT NULL;",
  "ALTER TABLE synthetic ADD COLUMN n integer NOT NULL DEFAULT NULL;",
  "ALTER TABLE synthetic ADD COLUMN n integer DEFAULT random();",
  "ALTER TABLE synthetic ADD COLUMN n timestamptz DEFAULT clock_timestamp();",
  "ALTER TABLE synthetic ADD COLUMN n timestamptz DEFAULT now();",
  "ALTER TABLE synthetic ADD COLUMN n integer GENERATED ALWAYS AS (1) STORED;",
  "ALTER TABLE synthetic ADD COLUMN n text REFERENCES other(id);",
  "ALTER TABLE synthetic ADD COLUMN n text UNIQUE;",
  "ALTER TABLE synthetic ADD COLUMN n text, DROP COLUMN old;",
  "ALTER TABLE synthetic ADD COLUMN n integer DEFAULT 1+2;",
  "ALTER TABLE synthetic ADD COLUMN n custom_domain;",
  "ALTER TABLE synthetic ALTER COLUMN n SET NOT NULL;",
  "ALTER TABLE synthetic DROP COLUMN n;",
  "ALTER TABLE synthetic RENAME COLUMN n TO m;",
  "ALTER TABLE synthetic ALTER COLUMN n TYPE bigint;",
  "ALTER TABLE synthetic ADD CONSTRAINT c CHECK (id > 0);",
  "CREATE INDEX synthetic_idx ON synthetic(id);",
  "CREATE INDEX CONCURRENTLY synthetic_idx ON synthetic(id); CREATE INDEX blocking ON synthetic(id);",
  "CREATE TABLE synthetic AS SELECT * FROM existing;",
  "CREATE TABLE synthetic(id integer) AS (SELECT 1);",
  "CREATE TABLE synthetic(id integer); CREATE INDEX CONCURRENTLY idx ON synthetic(id);",
  "CREATE TABLE IF NOT EXISTS synthetic(id integer); CREATE INDEX ON synthetic(id);",
  "CREATE OR REPLACE FUNCTION synthetic() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;",
  "DO $$ BEGIN ALTER TABLE synthetic DROP COLUMN id; END $$;",
  "SELECT install_row_provenance_all();",
  "UPDATE synthetic SET value = 1;",
  "INSERT INTO synthetic VALUES (1);",
  "DELETE FROM synthetic;",
  "LOCK TABLE synthetic IN ACCESS EXCLUSIVE MODE;",
  "VACUUM FULL synthetic;",
  "CLUSTER synthetic;",
  "SET lock_timeout = '0';",
  "unknown SQL;",
  "CREATE INDEX CONCURRENTLY synthetic_idx ON synthetic(id;",
  "CREATE INDEX CONCURRENTLY synthetic_idx ON synthetic(id));",
  "CREATE INDEX CONCURRENTLY synthetic_idx ON synthetic(id); /* unfinished",
  "ALTER TABLE synthetic ADD COLUMN value text DEFAULT 'unfinished",
];

describe("conservative migration preflight", () => {
  it.each(safe)("recognizes additive SQL: %s", (sql) => {
    expect(classifyMigration(sql)).toEqual({
      classification: "additive-safe",
      reasons: [],
    });
  });
  it.each(risky)("refuses risky or unknown SQL: %s", (sql) => {
    expect(classifyMigration(sql).classification).toBe("risky");
    expect(classifyMigration(sql).reasons.length).toBeGreaterThan(0);
  });
  it("splits statements without executing or inspecting quoted bodies", () => {
    expect(
      migrationStatements(`/* ; */ CREATE FUNCTION x() RETURNS text LANGUAGE sql AS $x$ SELECT ';'; $x$;
      ALTER TABLE x ADD COLUMN y text DEFAULT E'it\\'s;fine'; -- ;
      ALTER TABLE x DROP COLUMN y;`),
    ).toHaveLength(3);
    expect(
      classifyMigration(`CREATE TABLE synthetic(id integer); -- additive prefix
      /* nested /* safe */ comment */ DROP TABLE synthetic;`).classification,
    ).toBe("risky");
  });
  it("checks every new or changed risky file for an expand/contract note", async () => {
    const notes = await readFile(
      new URL("../docs/migrations.md", import.meta.url),
      "utf8",
    );
    expect(
      missingContractNotes(await loadMigrations(), history, notes),
    ).toEqual([]);
    const mutant = {
      name: "9999_synthetic.sql",
      sql: "ALTER TABLE synthetic DROP COLUMN id;",
      sha256: "planted",
    };
    expect(missingContractNotes([mutant], history, notes)).toEqual([
      mutant.name,
    ]);
    const note = `\n### ${mutant.name}\nStage: contract\nExpand release: synthetic release A\nCompatibility: synthetic release B uses the replacement\nForward fix: new additive repair migration\nLock budget: two seconds\n`;
    expect(
      missingContractNotes(
        [mutant],
        history,
        notes + "\n```text\n" + note + "\n```\n",
      ),
    ).toEqual([mutant.name]);
    expect(missingContractNotes([mutant], history, notes + note)).toEqual([]);
    expect(
      missingContractNotes(
        [mutant],
        history,
        notes + note.replace("Compatibility:", "Omitted:"),
      ),
    ).toEqual([mutant.name]);
    expect(
      missingContractNotes(
        [{ ...mutant, name: "991_cms_api_breaker.sql" }],
        history,
        notes,
      ),
    ).toEqual(["991_cms_api_breaker.sql"]);
  });
  it("reports the real 910..992 classifications without historical runtime exemptions", async () => {
    const actual = Object.fromEntries(
      (await loadMigrations())
        .filter(
          (m) => m.name in history && m.version >= 910 && m.version <= 992,
        )
        .map((m) => [m.name, classifyMigration(m.sql).classification]),
    );
    expect(actual).toEqual({
      "910_open_geocoder.sql": "additive-safe",
      "920_api_data_generation.sql": "risky",
      "930_provider_search_covering_keys.sql": "risky",
      "931_provider_identity_count_keys.sql": "risky",
      "932_provider_identity_missing_keys.sql": "risky",
      "933_provider_location_page_keys.sql": "risky",
      "934_provider_shard_radius.sql": "risky",
      "935_provider_search_execution.sql": "additive-safe",
      "936_provider_search_operator_points.sql": "additive-safe",
      "937_state_catalog_source.sql": "risky",
      "940_plan_lineage.sql": "risky",
      "941_market_catalog.sql": "risky",
      "945_medicare_catalog.sql": "risky",
      "946_geocode_all_states.sql": "risky",
      "950_partd_spuf.sql": "risky",
      "970_cms_api_fallback.sql": "risky",
      "990_row_provenance.sql": "risky",
      "991_cms_api_breaker.sql": "risky",
      "992_record_policy.sql": "risky",
    });
  });
  it("uses a read-only transaction and no write or installer even on an empty database", async () => {
    const queries: string[] = [];
    const session: SqlSession = {
      exec: vi.fn(async (sql) => {
        expect(sql).toBe("SET TRANSACTION READ ONLY");
      }),
      query: vi.fn(async (sql) => {
        queries.push(sql);
        return { rows: [] };
      }),
    };
    const db = {
      ...session,
      transaction: async (run) => run(session),
      close: async () => {},
    } as Database;
    const report = await checkMigrations(db);
    expect(report.format).toBe(1);
    expect(report.pending.length).toBe((await loadMigrations()).length);
    expect(queries).toEqual([
      "SELECT to_regclass('schema_migrations') IS NOT NULL AS present",
    ]);
    expect(session.exec).toHaveBeenCalledTimes(1);
    expect(
      report.pending.find((m) => m.name === "992_record_policy.sql")
        ?.classification,
    ).toBe("risky");
  });
});
