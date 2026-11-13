import { describe, expect, it, vi } from "vitest";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { coreMigrations, testDatabase } from "./pglite.js";
import {
  classifyMigration,
  classifyMigrationBatch,
  smallTableRows,
  smallTableBytes,
  type MigrationTableSizes,
  migrationStatementHash,
  migrationStatements,
  missingContractNotes,
} from "../src/db/migrate-safety.js";
import { runWorker } from "../src/worker/commands.js";
import { checkMigrations, loadMigrations, migrate } from "../src/db/migrate.js";
import type { Database, SqlSession } from "../src/db/database.js";
import { sizeEvidenceSql } from "../src/db/migration-size-evidence.js";
const history: Record<string, string> = JSON.parse(
  await readFile(new URL("./migrate-history.json", import.meta.url), "utf8"),
);

const safe = [
  "CREATE TABLE synthetic (name text CHECK (name LIKE 'x%'));",
  "CREATE FUNCTION synthetic() RETURNS int LANGUAGE sql AS 'SELECT 1';",
  "CREATE TABLE synthetic (id integer PRIMARY KEY, name text NOT NULL);",
  "CREATE TABLE synthetic (id integer); CREATE INDEX ON synthetic(id);",
  "DO $$ BEGIN CREATE TABLE synthetic(id integer); CREATE INDEX ON synthetic(id); END $$;",
  "ALTER TABLE rate ADD COLUMN n integer NOT NULL DEFAULT 0;",
  "ALTER TABLE rate ADD COLUMN n text DEFAULT 'unknown' NOT NULL;",
  "ALTER TABLE synthetic ALTER COLUMN n DROP NOT NULL;",
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
  "CREATE TABLE synthetic(id integer",
  "DO $$ BEGIN CREATE TABLE synthetic(id integer); DROP TABLE rate; END $$;",
  "DO $$ BEGIN CREATE INDEX CONCURRENTLY synthetic_idx ON synthetic(id); END $$;",
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
  // Synthetic size scenario from the brief, not a measurement of a running database.
  const smallNames =
    "address_point provider_record_plan_group provider_plan_group_edge npi_provider npi_address sbe_catalog api_data_generation puf_active_catalog puf_import_file plan snapshot source cms_api_budget row_provenance_rule geocode_tx_run geocode_open_run geocode_tx_county geocode_tx_result qhp_provider_address cms_api_drug_coverage cms_api_provider_coverage";
  const tableSizes: MigrationTableSizes = {
    ...Object.fromEntries(
      smallNames.split(" ").map((name) => [name, { rows: 100, bytes: 65536 }]),
    ),
    rate: { rows: 1_600_000, bytes: 200_000_000 },
    plan_benefit: { rows: 900_000, bytes: 100_000_000 },
  };
  const regressionCases = [
    ["910_open_geocoder.sql", "additive-safe"],
    ["920_api_data_generation.sql", "risky"],
    ["930_provider_search_covering_keys.sql", "additive-safe"],
    ["931_provider_identity_count_keys.sql", "additive-safe"],
    ["932_provider_identity_missing_keys.sql", "additive-safe"],
    ["933_provider_location_page_keys.sql", "additive-safe"],
    ["934_provider_shard_radius.sql", "risky"],
    ["935_provider_search_execution.sql", "additive-safe"],
    ["936_provider_search_operator_points.sql", "additive-safe"],
    ["937_state_catalog_source.sql", "risky"],
    ["940_plan_lineage.sql", "additive-safe"],
    ["941_market_catalog.sql", "additive-safe"],
    ["945_medicare_catalog.sql", "additive-safe"],
    ["946_geocode_all_states.sql", "risky"],
    ["950_partd_spuf.sql", "additive-safe"],
    ["970_cms_api_fallback.sql", "additive-safe"],
    ["990_row_provenance.sql", "risky"],
    ["991_cms_api_breaker.sql", "additive-safe"],
    ["992_record_policy.sql", "risky"],
    ["993_rate_plan_count.sql", "additive-safe"],
    ["994_cms_api_attempt_provenance.sql", "additive-safe"],
    ["1000_plugin_events.sql", "additive-safe"],
    ["1001_passthrough.sql", "additive-safe"],
    ["1002_ingest_run_snapshot.sql", "additive-safe"],
  ] as const;
  it.each(regressionCases)(
    "pins %s as %s with explicit size evidence",
    async (name, expected) => {
      const migration = (await loadMigrations()).find((m) => m.name === name)!;
      if (
        ![
          "993_rate_plan_count.sql",
          "994_cms_api_attempt_provenance.sql",
          "1000_plugin_events.sql",
          "1001_passthrough.sql",
          "1002_ingest_run_snapshot.sql",
        ].includes(name)
      )
        expect(migration.sha256).toBe(history[name]);
      const expectedWithoutSizes = [
        "910_open_geocoder.sql",
        "935_provider_search_execution.sql",
        "936_provider_search_operator_points.sql",
        "993_rate_plan_count.sql",
        "994_cms_api_attempt_provenance.sql",
      ].includes(name)
        ? "additive-safe"
        : "risky";
      expect(classifyMigration(migration.sql).classification).toBe(
        expectedWithoutSizes,
      );
      const result = classifyMigration(migration.sql, tableSizes);
      expect(result.classification).toBe(expected);
      expect(result.reasons.length === 0).toBe(expected === "additive-safe");
      if (expected === "additive-safe") {
        for (const tail of [
          "ALTER TABLE synthetic DROP COLUMN old;",
          "ALTER TABLE synthetic RENAME COLUMN old TO replacement;",
          "ALTER TABLE synthetic ALTER COLUMN old SET NOT NULL;",
        ])
          expect(
            classifyMigration(migration.sql + "\n" + tail, tableSizes)
              .classification,
          ).toBe("risky");
      }
    },
  );
  it("pins the complete regression inventory and preserves unknown-size review", async () => {
    const migrations = (await loadMigrations()).filter(
      (m) => m.version >= 910 && m.version <= 1002,
    );
    expect(migrations.map((m) => m.name)).toEqual(
      regressionCases.map(([name]) => name),
    );
    expect(
      migrations.filter(
        (m) => classifyMigration(m.sql).classification === "risky",
      ),
    ).toHaveLength(19);
    expect(
      migrations.filter(
        (m) => classifyMigration(m.sql, tableSizes).classification === "risky",
      ),
    ).toHaveLength(6);
  });
  it("rates 1002 by its seed row, not its snapshot trigger, and needs no allow annotation", async () => {
    const migration = (await loadMigrations()).find(
      (m) => m.name === "1002_ingest_run_snapshot.sql",
    )!;
    // Without size evidence only the literal row_provenance_rule seed is held for review.
    expect(classifyMigration(migration.sql).reasons).toEqual([
      'Statement 2: Unbounded INSERT or source scan; "public"."row_provenance_rule" size is unknown',
    ]);
    // The AFTER trigger is accepted even when snapshot is large.
    const largeSnapshot = {
      ...tableSizes,
      snapshot: { rows: 5_000_000, bytes: 2_000_000_000 },
    };
    expect(classifyMigration(migration.sql, largeSnapshot)).toEqual({
      classification: "additive-safe",
      reasons: [],
    });
    // In one pending batch after 1000 and 1001 it stays additive-safe.
    const batch = (await loadMigrations()).filter(
      (m) => m.version >= 1000 && m.version <= 1002,
    );
    expect(batch.map((m) => m.name)).toEqual([
      "1000_plugin_events.sql",
      "1001_passthrough.sql",
      "1002_ingest_run_snapshot.sql",
    ]);
    expect(
      classifyMigrationBatch(
        batch.map((m) => m.sql),
        tableSizes,
      ).map((r) => r.classification),
    ).toEqual(["additive-safe", "additive-safe", "additive-safe"]);
    // An allow marker on the seed would turn the measured, safe case risky: none is added.
    const statements = migrationStatements(migration.sql);
    const marked = migration.sql.replace(
      "INSERT INTO row_provenance_rule",
      `-- openplans-migration-allow: ${migrationStatementHash(statements[1]!)} One literal seed row in a small registry table\nINSERT INTO row_provenance_rule`,
    );
    expect(classifyMigration(marked).classification).toBe("reviewed-exception");
    expect(classifyMigration(marked, tableSizes).classification).toBe("risky");
    expect(migration.sql).not.toContain("openplans-migration-allow");
    // Planted mutant: a seed copied from snapshot is caught once snapshot is large.
    const mutant = migration.sql.replace(
      "VALUES\n  ('ingest_run_snapshot', 'openplans', 'app:ingest_run_snapshot', 'application ingest run log', 'app_state');",
      "SELECT snapshot_id, 'openplans', 'app:x', 'x', 'app_state' FROM snapshot;",
    );
    expect(mutant).not.toBe(migration.sql);
    expect(classifyMigration(mutant, largeSnapshot).classification).toBe(
      "risky",
    );
  });
  it("rates 1004 by its two literal seeds, and a copy from a large pricing table as risky", async () => {
    const migration = (await loadMigrations()).find(
      (m) => m.name === "1004_partd_unit_cost_key.sql",
    )!;
    expect(classifyMigration(migration.sql).reasons).toEqual([
      'Statement 3: Unbounded INSERT or source scan; "public"."row_provenance_rule" size is unknown',
      'Statement 4: Unbounded INSERT or source scan; "public"."api_data_generation" size is unknown',
    ]);
    expect(classifyMigration(migration.sql, tableSizes)).toEqual({
      classification: "additive-safe",
      reasons: [],
    });
    // Planted mutant: copying the old rows in the migration is caught once that table is large.
    const mutant = `${migration.sql}
INSERT INTO partd_plan_unit_cost(release_key,days_supply,source_row,contract_id,plan_id,segment_id,ndc,unit_cost)
SELECT k.release_key,u.days_supply,u.source_row,u.contract_id,u.plan_id,u.segment_id,u.ndc,u.unit_cost
FROM partd_unit_cost u JOIN partd_pricing_release k ON k.snapshot_id = u.snapshot_id;`;
    expect(
      classifyMigration(mutant, {
        ...tableSizes,
        partd_unit_cost: { rows: 54_052_371, bytes: 29_600_000_000 },
      }).classification,
    ).toBe("risky");
  });
  it("worker migrate --check reports migration 1000 additive-safe on a PGlite copy", async () => {
    const core = await coreMigrations();
    const db = testDatabase(new PGlite());
    const path = join(core.directory, "1000_plugin_events.sql");
    try {
      const sql = await readFile(path, "utf8");
      await rm(path);
      await migrate(db, core.directory);
      await writeFile(path, sql);
      const out: string[] = [],
        errors: string[] = [];
      expect(
        await runWorker(
          ["migrate", "--check"],
          () => ({ ...db, close: async () => {} }),
          { out: (line) => out.push(line), error: (line) => errors.push(line) },
          core.directory,
        ),
      ).toBe(0);
      expect(errors).toEqual([]);
      expect(out).toHaveLength(1);
      expect(JSON.parse(out[0]!)).toMatchObject({
        format: 1,
        pending: [
          {
            name: "1000_plugin_events.sql",
            classification: "additive-safe",
            reasons: [],
          },
        ],
      });
      expect(
        (await db.query("SELECT to_regclass('plugin_event_outbox') AS present"))
          .rows,
      ).toEqual([{ present: null }]);
    } finally {
      await db.close();
      await core.cleanup();
    }
  });
  it("worker migrate --check reports migration 1001 additive-safe on a PGlite copy", async () => {
    const core = await coreMigrations();
    const db = testDatabase(new PGlite());
    const path = join(core.directory, "1001_passthrough.sql");
    try {
      const sql = await readFile(path, "utf8");
      await rm(path);
      await migrate(db, core.directory);
      await writeFile(path, sql);
      const out: string[] = [],
        errors: string[] = [];
      expect(
        await runWorker(
          ["migrate", "--check"],
          () => ({ ...db, close: async () => {} }),
          { out: (line) => out.push(line), error: (line) => errors.push(line) },
          core.directory,
        ),
      ).toBe(0);
      expect(errors).toEqual([]);
      expect(JSON.parse(out[0]!)).toMatchObject({
        format: 1,
        pending: [
          {
            name: "1001_passthrough.sql",
            classification: "additive-safe",
            reasons: [],
          },
        ],
      });
      expect(
        (await db.query("SELECT to_regclass('passthrough_answer') AS present"))
          .rows,
      ).toEqual([{ present: null }]);
    } finally {
      await db.close();
      await core.cleanup();
    }
  });
  it.each([
    "CREATE INDEX synthetic ON rate(id)",
    "CREATE INDEX synthetic ON plan_benefit(id)",
    "UPDATE rate SET amount=0",
    "ALTER TABLE rate ALTER COLUMN amount TYPE text USING amount::text",
    "ALTER TABLE rate ADD COLUMN n integer NOT NULL",
    "ALTER TABLE rate ADD COLUMN n integer NOT NULL DEFAULT NULL",
    "ALTER TABLE rate ADD COLUMN n integer DEFAULT random()",
    "ALTER TABLE rate ADD COLUMN n integer NOT NULL DEFAULT 0 CHECK(n>=0)",
    "ALTER TABLE rate DROP COLUMN amount",
    "ALTER TABLE rate RENAME COLUMN amount TO old_amount",
    "CREATE TABLE IF NOT EXISTS rate(id integer); CREATE INDEX synthetic ON rate(id)",
    "INSERT INTO api_data_generation(table_name) VALUES (evil())",
    'INSERT INTO api_data_generation(table_name) VALUES ("evil"())',
    "INSERT INTO api_data_generation(table_name) VALUES ('x'::evil)",
    "INSERT INTO api_data_generation(table_name) SELECT id FROM rate",
    "INSERT INTO api_data_generation(table_name) SELECT p.id FROM plan p, rate r",
    "DO $$ BEGIN EXECUTE 'UPDATE rate SET amount=0'; END $$",
    "SELECT install_record_policy_all()",
  ])(
    "keeps planted risky SQL risky despite small-table evidence: %s",
    (sql) => {
      expect(classifyMigration(sql, tableSizes).classification).toBe("risky");
    },
  );
  it.each([
    "CREATE INDEX synthetic ON plan(id)",
    "CREATE TABLE IF NOT EXISTS synthetic(id integer); CREATE INDEX synthetic ON synthetic(id)",
    "CREATE TABLE synthetic(id integer); INSERT INTO synthetic(id) VALUES(1),(2); CREATE INDEX synthetic ON synthetic(id)",
    "ALTER TABLE cms_api_budget ADD COLUMN n integer NOT NULL DEFAULT 0 CHECK(n>=0)",
    "ALTER TABLE snapshot ADD CONSTRAINT synthetic UNIQUE(snapshot_id, source_id)",
    "CREATE TABLE synthetic(id text PRIMARY KEY); INSERT INTO synthetic(id) VALUES('x'); ALTER TABLE row_provenance_rule ADD COLUMN n text REFERENCES synthetic(id)",
  ])("recognizes bounded additive SQL: %s", (sql) => {
    expect(classifyMigration(sql, tableSizes)).toEqual({
      classification: "additive-safe",
      reasons: [],
    });
  });
  it("does not reuse size evidence after opaque execution or through schema aliases", () => {
    const result = classifyMigrationBatch(
      [
        "INSERT INTO plan(id) SELECT id FROM rate",
        "CREATE INDEX synthetic ON public.plan(id)",
        "SELECT arbitrary_installer()",
        "CREATE TABLE IF NOT EXISTS missing(id int); CREATE INDEX synthetic ON missing(id)",
      ],
      tableSizes,
    );
    expect(result.map((r) => r.classification)).toEqual([
      "risky",
      "risky",
      "risky",
      "risky",
    ]);
    expect(
      classifyMigration('CREATE INDEX synthetic ON "Plan"(id)', tableSizes)
        .classification,
    ).toBe("risky");
    expect(
      classifyMigration(
        'CREATE INDEX synthetic ON "public.plan"(id)',
        tableSizes,
      ).classification,
    ).toBe("risky");
    expect(
      classifyMigration(
        "CREATE TABLE IF NOT EXISTS other.plan(id int); CREATE INDEX synthetic ON other.plan(id)",
        {},
      ).classification,
    ).toBe("risky");
  });
  it("invalidates size evidence after an expression can grow existing values", () => {
    expect(
      classifyMigrationBatch(
        [
          "UPDATE plan SET name=name||name||name||name",
          "CREATE INDEX synthetic ON public.plan(id)",
        ],
        tableSizes,
      ).map((r) => r.classification),
    ).toEqual(["risky", "risky"]);
  });
  it("keeps row and byte budget boundaries fail closed", () => {
    const sql = "CREATE INDEX synthetic ON plan(id)";
    expect(
      classifyMigration(sql, {
        plan: { rows: smallTableRows, bytes: smallTableBytes },
      }).classification,
    ).toBe("additive-safe");
    for (const size of [
      null,
      { rows: smallTableRows + 1, bytes: 1 },
      { rows: 1, bytes: smallTableBytes + 1 },
      { rows: -1, bytes: 1 },
      { rows: NaN, bytes: 1 },
    ]) {
      expect(classifyMigration(sql, { plan: size }).classification).toBe(
        "risky",
      );
    }
  });
  it("planted historical mutants change classification rather than inheriting a file exemption", async () => {
    const migration = (await loadMigrations()).find(
      (m) => m.name === "991_cms_api_breaker.sql",
    )!;
    expect(classifyMigration(migration.sql, tableSizes).classification).toBe(
      "additive-safe",
    );
    const mutants = [
      migration.sql.replace("cms_api_budget", "rate"),
      migration.sql.replace("DEFAULT 0", "DEFAULT random()"),
      migration.sql.replace("NOT NULL DEFAULT 0", "NOT NULL"),
      migration.sql + "\nCREATE INDEX synthetic ON rate(amount);",
      migration.sql + "\nALTER TABLE plan_benefit DROP COLUMN amount;",
    ];
    for (const sql of mutants)
      expect(classifyMigration(sql, tableSizes).classification).toBe("risky");
  });
  it("uses a read-only transaction and no write or installer even on an empty database", async () => {
    const queries: string[] = [];
    const session: SqlSession = {
      exec: vi.fn(async (sql) => {
        expect([
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
          "SET LOCAL lock_timeout = '2s'",
        ]).toContain(sql);
      }),
      query: vi.fn(async (sql) => {
        queries.push(sql);
        // Synthetic collector output for an empty database.
        return {
          rows: [
            {
              evidence: JSON.stringify({
                format: 1,
                collectedAt: "2026-01-01T00:00:00Z",
                serverVersionNum: 160000,
                transactionReadOnly: true,
                searchPath: ["public"],
                journal: null,
                relations: [],
              }),
            },
          ],
        } as never;
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
    expect(queries).toEqual([sizeEvidenceSql]);
    expect(queries.every((sql) => sql.startsWith("SELECT "))).toBe(true);
    expect(session.exec).toHaveBeenCalledTimes(2);
    expect(
      report.pending.find((m) => m.name === "992_record_policy.sql")
        ?.classification,
    ).toBe("risky");
  });
  it("reads exact capped counts and bytes without writing the database", async () => {
    const pg = new PGlite();
    const directory = await mkdtemp(join(tmpdir(), "openplans-safety-"));
    try {
      await pg.exec(`CREATE TABLE synthetic_small(id int); INSERT INTO synthetic_small VALUES(1);
        CREATE TABLE synthetic_big(id int); INSERT INTO synthetic_big SELECT generate_series(1,${smallTableRows + 1});
        CREATE TABLE synthetic_rls(id int); ALTER TABLE synthetic_rls ENABLE ROW LEVEL SECURITY;
        CREATE TABLE synthetic_parent(id int); CREATE TABLE synthetic_child() INHERITS(synthetic_parent);
        CREATE MATERIALIZED VIEW synthetic_mat AS SELECT 1 AS id;
        CREATE TABLE synthetic_wide(value text); INSERT INTO synthetic_wide SELECT string_agg(md5(i::text),'') FROM generate_series(1,1200000) i;`);
      await writeFile(
        join(directory, "1_small.sql"),
        "CREATE INDEX synthetic_small_idx ON synthetic_small(id)",
      );
      await writeFile(
        join(directory, "2_big.sql"),
        "CREATE INDEX synthetic_big_idx ON synthetic_big(id)",
      );
      await writeFile(
        join(directory, "3_wide.sql"),
        "CREATE INDEX synthetic_wide_idx ON synthetic_wide(value)",
      );
      for (const [i, name] of [
        "synthetic_rls",
        "synthetic_parent",
        "synthetic_child",
        "synthetic_mat",
      ].entries()) {
        await writeFile(
          join(directory, `${i + 4}_unknown.sql`),
          `CREATE INDEX ${name}_idx ON ${name}(id)`,
        );
      }
      const report = await checkMigrations(testDatabase(pg), directory);
      expect(report.pending.map((m) => m.classification)).toEqual([
        "additive-safe",
        "risky",
        "risky",
        "risky",
        "risky",
        "risky",
        "risky",
      ]);
      expect(report.pending[1]?.reasons.join()).toContain(
        `${smallTableRows + 1} bounded rows`,
      );
      expect(report.pending[2]?.reasons.join()).toContain("rows not counted");
      expect(
        (await pg.query("SELECT to_regclass('schema_migrations') AS journal"))
          .rows,
      ).toEqual([{ journal: null }]);
      expect(
        (
          await pg.query(
            "SELECT indexname FROM pg_indexes WHERE indexname LIKE 'synthetic_%'",
          )
        ).rows,
      ).toEqual([]);
      await pg.exec(
        "CREATE SCHEMA synthetic_shadow; SET search_path TO synthetic_shadow,public",
      );
      const unknownPath = await checkMigrations(testDatabase(pg), directory);
      expect(unknownPath.pending[0]?.classification).toBe("risky");
      expect(unknownPath.pending[0]?.reasons.join()).toContain(
        "size is unknown",
      );
    } finally {
      await pg.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
