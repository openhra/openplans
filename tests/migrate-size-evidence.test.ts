import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { testDatabase } from "./pglite.js";
import { plantMutant } from "../src/plugins/testing/artifacts.js";
import type * as SafetyModule from "../src/db/migrate-safety.js";
import type * as EvidenceModule from "../src/db/migration-size-evidence.js";
import {
  classifyMigrationBatch,
  classifyMigrationBatchWithRules,
  sizeRules,
  smallTableBytes,
  smallTableRows,
  type MigrationTableSizes,
} from "../src/db/migrate-safety.js";
import {
  collectSizeEvidence,
  parseSizeEvidence,
  sizeEvidenceScript,
  sizeEvidenceSql,
  tableSizesFromEvidence,
  type MigrationSizeEvidence,
} from "../src/db/migration-size-evidence.js";
import {
  checkMigrations,
  checkMigrationsWithEvidence,
  loadMigrations,
  migrate,
} from "../src/db/migrate.js";
import { runWorker } from "../src/worker/commands.js";

// Every number below is synthetic. None is a measurement of a running database.
const synthetic = (
  relations: Partial<MigrationSizeEvidence["relations"][number]>[],
  searchPath = ["public"],
): MigrationSizeEvidence => ({
  format: 1,
  collectedAt: "2026-01-01T00:00:00Z",
  serverVersionNum: 160004,
  transactionReadOnly: true,
  searchPath,
  journal: [],
  relations: relations.map((r) => ({
    name: "synthetic",
    kind: "r",
    bytes: 65_536,
    countable: true,
    countedRows: 100,
    estimatedRows: 100,
    liveTuples: 100,
    ...r,
  })),
});

/** One case per rule: a statement, the tables it needs, and the evidence that clears it. */
const ruleCases = [
  {
    rule: "small-index",
    sql: ["CREATE INDEX synthetic_idx ON synthetic(id)"],
    small: { synthetic: { rows: 100, bytes: 65_536 } },
  },
  {
    rule: "small-constraint",
    sql: ["ALTER TABLE synthetic ADD CONSTRAINT synthetic_id CHECK (id > 0)"],
    small: { synthetic: { rows: 100, bytes: 65_536 } },
  },
  {
    rule: "small-insert",
    sql: ["INSERT INTO synthetic (id) VALUES (1), (2)"],
    small: { synthetic: { rows: 100, bytes: 65_536 } },
  },
  {
    rule: "small-update",
    sql: ["UPDATE synthetic SET state = 'retired'"],
    small: { synthetic: { rows: 100, bytes: 65_536 } },
  },
  {
    rule: "empty-not-null",
    sql: [
      "CREATE TABLE synthetic_new (id integer)",
      "ALTER TABLE synthetic_new ADD COLUMN state text NOT NULL",
    ],
    // Needs no database evidence: the table is new in the same batch.
    small: undefined,
    // An existing table of any size keeps the statement risky.
    existing: "ALTER TABLE synthetic ADD COLUMN state text NOT NULL",
  },
] as const;

describe("size evidence rules", () => {
  it("documents exactly the rules the classifier can name", async () => {
    const docs = await readFile(
      new URL("../docs/migrations.md", import.meta.url),
      "utf8",
    );
    expect(Object.keys(sizeRules).sort()).toEqual(
      ruleCases.map((c) => c.rule).sort(),
    );
    for (const rule of Object.keys(sizeRules))
      expect(docs).toContain("`" + rule + "`");
  });

  it.each(ruleCases)("$rule clears only with evidence", (c) => {
    const withEvidence = classifyMigrationBatchWithRules(
      [...c.sql],
      c.small as MigrationTableSizes | undefined,
    ).at(-1)!;
    expect(withEvidence.classification).toBe("additive-safe");
    expect(withEvidence.sizeRules.map((u) => u.rule)).toEqual([c.rule]);
    if ("existing" in c) {
      expect(withEvidence.sizeRules[0]!.tables[0]!.source).toBe(
        "pending-batch",
      );
      for (const sizes of [
        undefined,
        { synthetic: { rows: 0, bytes: 0 } },
        { synthetic: { rows: 5_000_000, bytes: 2_000_000_000 } },
      ])
        expect(classifyMigrationBatch([c.existing], sizes)[0]).toMatchObject({
          classification: "risky",
        });
      return;
    }
    expect(withEvidence.sizeRules[0]!.tables).toEqual([
      {
        table: '"public"."synthetic"',
        rows: 100,
        bytes: 65_536,
        source: "database",
      },
    ]);
    // No evidence, unknown size, and each budget exceeded by one stay risky.
    for (const sizes of [
      undefined,
      {},
      { synthetic: null },
      { synthetic: { rows: smallTableRows + 1, bytes: 1 } },
      { synthetic: { rows: 1, bytes: smallTableBytes + 1 } },
      { synthetic: { rows: -1, bytes: 1, estimatedRows: 5 } },
    ] as (MigrationTableSizes | undefined)[])
      expect(
        classifyMigrationBatch([...c.sql], sizes).at(-1)!.classification,
      ).toBe("risky");
  });

  it("never lets planner estimates stand in for a count", () => {
    for (const relation of [
      { countedRows: null, estimatedRows: 5, liveTuples: 5 },
      { countable: false, countedRows: null, estimatedRows: 5 },
      { kind: "p" as const, countable: false, countedRows: null },
    ]) {
      const sizes = tableSizesFromEvidence(synthetic([relation]));
      expect(
        classifyMigrationBatch(
          ["CREATE INDEX synthetic_idx ON synthetic(id)"],
          sizes,
        )[0]!.classification,
      ).toBe("risky");
    }
    // A stale low estimate does not hide a counted large table.
    const counted = tableSizesFromEvidence(
      synthetic([{ countedRows: smallTableRows + 1, estimatedRows: 0 }]),
    );
    expect(
      classifyMigrationBatch(
        ["CREATE INDEX synthetic_idx ON synthetic(id)"],
        counted,
      )[0]!.classification,
    ).toBe("risky");
    // A large table reports its estimate in the reason, for the reviewer.
    const large = tableSizesFromEvidence(
      synthetic([
        { bytes: 9_000_000_000, countedRows: null, estimatedRows: 41_000_000 },
      ]),
    );
    expect(
      classifyMigrationBatch(
        ["CREATE INDEX synthetic_idx ON synthetic(id)"],
        large,
      )[0]!.reasons,
    ).toEqual([
      'Statement 1: Non-concurrent index blocks writes: "public"."synthetic": rows not counted, about 41000000 rows by planner estimate, 9000000000 bytes; outside the small-table budget',
    ]);
    // Any search path but public alone gives no evidence.
    expect(
      tableSizesFromEvidence(synthetic([{}], ["synthetic_shadow", "public"])),
    ).toBeUndefined();
  });

  it("rejects malformed or inconsistent evidence", () => {
    const good = synthetic([{}]);
    expect(parseSizeEvidence(JSON.stringify(good))).toEqual(good);
    for (const bad of [
      { ...good, format: 2 },
      { ...good, relations: [{ ...good.relations[0], bytes: -1 }] },
      { ...good, relations: [{ ...good.relations[0], countedRows: 1.5 }] },
      {
        ...good,
        relations: [{ ...good.relations[0], countable: false, countedRows: 1 }],
      },
      { ...good, relations: [good.relations[0], good.relations[0]] },
      { ...good, journal: [["only-a-name"]] },
      { ...good, searchPath: "public" },
    ])
      expect(() => parseSizeEvidence(JSON.stringify(bad))).toThrow(
        "Invalid migration size evidence",
      );
  });

  it("keeps live-shaped synthetic numbers conservative for 910 through 1002", async () => {
    // Synthetic sizes shaped like an 80 GB catalog: provider and address tables large,
    // registries small. A replay of real collector output uses the same path.
    const large = (estimatedRows: number, bytes: number) => ({
      countedRows: null,
      estimatedRows,
      liveTuples: estimatedRows,
      bytes,
    });
    const evidence = synthetic([
      { name: "address_point", ...large(31_000_000, 12_000_000_000) },
      { name: "npi_provider", ...large(9_000_000, 7_000_000_000) },
      { name: "npi_address", ...large(14_000_000, 9_000_000_000) },
      {
        name: "provider_record_plan_group",
        ...large(60_000_000, 11_000_000_000),
      },
      { name: "provider_plan_group_edge", ...large(40_000_000, 6_000_000_000) },
      { name: "snapshot", countedRows: 2_400, bytes: 1_400_000 },
      { name: "source", countedRows: 40, bytes: 98_304 },
      { name: "api_data_generation", countedRows: 60, bytes: 49_152 },
      { name: "row_provenance_rule", countedRows: 90, bytes: 81_920 },
      { name: "cms_api_budget", countedRows: 1, bytes: 16_384 },
      { name: "sbe_catalog", countedRows: 30, bytes: 32_768 },
    ]);
    const migrations = (await loadMigrations()).filter(
      (m) => m.version >= 910 && m.version <= 1002,
    );
    const report = checkMigrationsWithEvidence(evidence, migrations);
    const risky = report.pending
      .filter((m) => m.classification === "risky")
      .map((m) => m.name);
    // The provider index files block writes on large tables, so they stay risky.
    for (const name of [
      "930_provider_search_covering_keys.sql",
      "931_provider_identity_count_keys.sql",
      "932_provider_identity_missing_keys.sql",
      "933_provider_location_page_keys.sql",
      "920_api_data_generation.sql",
      "934_provider_shard_radius.sql",
      "937_state_catalog_source.sql",
      "990_row_provenance.sql",
      "992_record_policy.sql",
    ])
      expect(risky).toContain(name);
    // Every cleared statement names its rule and only small database tables.
    for (const entry of report.pending)
      for (const use of entry.sizeRules)
        for (const table of use.tables) {
          expect(table.rows).toBeLessThanOrEqual(smallTableRows);
          expect(table.bytes).toBeLessThanOrEqual(smallTableBytes);
        }
    // Evidence only clears statements through a named rule; it never adds risk to a file
    // that is safe without it.
    const blind = classifyMigrationBatch(migrations.map((m) => m.sql));
    report.pending.forEach((entry, i) => {
      if (blind[i]!.classification === "additive-safe")
        expect(entry.classification).toBe("additive-safe");
      if (
        blind[i]!.classification === "risky" &&
        entry.classification === "additive-safe"
      )
        expect(entry.sizeRules.length).toBeGreaterThan(0);
    });
    // The journal in the evidence decides what is pending.
    const applied = checkMigrationsWithEvidence(
      {
        ...evidence,
        journal: migrations.slice(0, 3).map((m) => [m.name, m.sha256]),
      },
      migrations,
    );
    expect(applied.pending.map((m) => m.name)).toEqual(
      migrations.slice(3).map((m) => m.name),
    );
    expect(() =>
      checkMigrationsWithEvidence(
        { ...evidence, journal: [[migrations[0]!.name, "0".repeat(64)]] },
        migrations,
      ),
    ).toThrow("Applied migration missing or changed");
  });
});

describe("read-only size evidence collector", () => {
  it("is one SELECT that writes nothing", () => {
    expect(sizeEvidenceSql.startsWith("SELECT ")).toBe(true);
    const code = sizeEvidenceSql.replace(/'(?:[^']|'')*'/g, "''");
    expect(code).not.toMatch(
      /\b(?:INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|LOCK|GRANT|COPY|CALL|DO|VACUUM|ANALYZE|nextval|setval|pg_advisory\w*)\b|FOR (?:UPDATE|SHARE|NO KEY|KEY)/i,
    );
    expect(sizeEvidenceScript).toMatch(
      /^BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;\n/,
    );
    expect(sizeEvidenceScript.trim().endsWith("ROLLBACK;")).toBe(true);
  });

  it("collects counts, bytes and estimates under ACCESS SHARE locks only", async () => {
    const pg = new PGlite();
    const directory = await mkdtemp(join(tmpdir(), "openplans-evidence-"));
    try {
      await pg.exec(`CREATE TABLE synthetic_small(id int); INSERT INTO synthetic_small VALUES(1),(2),(3);
        CREATE TABLE synthetic_big(id int); INSERT INTO synthetic_big SELECT generate_series(1,${smallTableRows + 5});
        CREATE TABLE "synthetic odd""name"(id int);
        CREATE TABLE synthetic_rls(id int); ALTER TABLE synthetic_rls ENABLE ROW LEVEL SECURITY;
        CREATE TABLE synthetic_parent(id int); CREATE TABLE synthetic_child() INHERITS(synthetic_parent);
        CREATE VIEW synthetic_view AS SELECT 1 AS id;
        ANALYZE synthetic_big;`);
      await writeFile(
        join(directory, "1_small.sql"),
        "CREATE INDEX synthetic_small_idx ON synthetic_small(id)",
      );
      await migrate(testDatabase(pg), directory);
      await pg.exec("BEGIN READ ONLY");
      const evidence = await collectSizeEvidence(testDatabase(pg));
      const locks = await pg.query<{ mode: string; locktype: string }>(
        "SELECT mode, locktype FROM pg_locks WHERE pid = pg_backend_pid() AND locktype <> 'virtualxid'",
      );
      await pg.exec("ROLLBACK");
      expect(locks.rows.length).toBeGreaterThan(0);
      expect(
        locks.rows.every(
          (l) => l.mode === "AccessShareLock" && l.locktype === "relation",
        ),
      ).toBe(true);
      const byName = Object.fromEntries(
        evidence.relations.map((r) => [r.name, r]),
      );
      expect(evidence.transactionReadOnly).toBe(true);
      expect(evidence.searchPath).toEqual(["public"]);
      expect(evidence.journal?.map(([name]) => name)).toEqual(["1_small.sql"]);
      expect(byName.synthetic_small).toMatchObject({
        kind: "r",
        countable: true,
        countedRows: 3,
      });
      expect(byName.synthetic_big).toMatchObject({
        countedRows: smallTableRows + 1,
        estimatedRows: smallTableRows + 5,
      });
      expect(byName['synthetic odd"name']).toMatchObject({ countedRows: 0 });
      for (const name of [
        "synthetic_rls",
        "synthetic_parent",
        "synthetic_child",
      ])
        expect(byName[name]).toMatchObject({
          countable: false,
          countedRows: null,
        });
      expect(byName.synthetic_view).toMatchObject({ kind: "v" });
      expect(byName.schema_migrations).toBeDefined();
      // A writable transaction is refused.
      await expect(collectSizeEvidence(testDatabase(pg))).rejects.toThrow(
        "read-only transaction",
      );
      // The operator script returns the same document and leaves no transaction open.
      const results = await pg.exec(sizeEvidenceScript);
      const printed = results.find((r) => r.fields[0]?.name === "evidence");
      expect(
        parseSizeEvidence(printed?.rows[0]?.evidence).relations.length,
      ).toBe(evidence.relations.length);
      expect(
        (
          await pg.query(
            "SELECT current_setting('transaction_read_only') AS ro",
          )
        ).rows,
      ).toEqual([{ ro: "off" }]);
    } finally {
      await pg.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("worker migrate --size-evidence prints the document and --check embeds it", async () => {
    const pg = new PGlite();
    const directory = await mkdtemp(join(tmpdir(), "openplans-evidence-"));
    try {
      await pg.exec(
        "CREATE TABLE synthetic_small(id int); INSERT INTO synthetic_small VALUES(1);",
      );
      await writeFile(
        join(directory, "1_small.sql"),
        "CREATE INDEX synthetic_small_idx ON synthetic_small(id)",
      );
      const db = testDatabase(pg);
      const run = async (args: string[]) => {
        const out: string[] = [],
          errors: string[] = [];
        const code = await runWorker(
          args,
          () => ({ ...db, close: async () => {} }),
          { out: (l) => out.push(l), error: (l) => errors.push(l) },
          directory,
        );
        expect(errors).toEqual([]);
        expect(code).toBe(0);
        return JSON.parse(out[0]!);
      };
      const evidence = parseSizeEvidence(
        await run(["migrate", "--size-evidence"]),
      );
      expect(evidence.journal).toBeNull();
      const check = await run(["migrate", "--check"]);
      expect(check.pending).toMatchObject([
        {
          name: "1_small.sql",
          classification: "additive-safe",
          reasons: [],
          sizeRules: [
            {
              statement: "1",
              rule: "small-index",
              tables: [
                {
                  table: '"public"."synthetic_small"',
                  rows: 1,
                  source: "database",
                },
              ],
            },
          ],
        },
      ]);
      expect(parseSizeEvidence(check.sizeEvidence).relations).toEqual(
        evidence.relations,
      );
      expect(
        (await checkMigrations(db, directory)).pending[0]?.classification,
      ).toBe("additive-safe");
      expect(
        (await pg.query("SELECT to_regclass('schema_migrations') AS j")).rows,
      ).toEqual([{ j: null }]);
    } finally {
      await pg.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

// Planted mutants: each removes one rule's evidence check. The rule's case without evidence
// must then clear, proving the tests above would catch that change.
describe("planted mutants downgrade without evidence", () => {
  const mutants = [
    {
      rule: "small-index",
      find: "if (!concurrentIndex(statement) && !small(index[1]!))",
      replace: "if (!concurrentIndex(statement) && false)",
    },
    {
      rule: "small-constraint",
      find: "if (!small(target)) return false;",
      replace: "",
    },
    {
      rule: "small-insert",
      find: "if (!small(target) || (!literalValues && !simpleSelect))",
      replace: "if (!literalValues && !simpleSelect)",
    },
    {
      rule: "small-update",
      find: "!small(update[1]!) ||",
      replace: "",
    },
    {
      rule: "empty-not-null",
      find: "if (newEmptyTable && columnAddition(part, true))",
      replace: "if (columnAddition(part, true))",
    },
  ] as const;
  const source = new URL("../src/db/migrate-safety.ts", import.meta.url);

  it.each(mutants)("$rule mutant is caught", async (mutant) => {
    const planted = await plantMutant(source, mutant.find, mutant.replace);
    try {
      const loaded = (await import(
        pathToFileURL(planted.path).href
      )) as typeof SafetyModule;
      const c = ruleCases.find((r) => r.rule === mutant.rule)!;
      const sql = "existing" in c ? [c.existing] : [...c.sql];
      expect(loaded.classifyMigrationBatch(sql).at(-1)!.classification).toBe(
        "additive-safe",
      );
      expect(classifyMigrationBatch(sql).at(-1)!.classification).toBe("risky");
    } finally {
      await planted.cleanup();
    }
  });

  it("estimate mutant is caught", async () => {
    const planted = await plantMutant(
      new URL("../src/db/migration-size-evidence.ts", import.meta.url),
      "if (r.countable && r.bytes <= smallTableBytes && r.countedRows !== null)\n      size = { rows: r.countedRows, bytes: r.bytes, estimatedRows };",
      "if (r.countable && r.bytes <= smallTableBytes)\n      size = { rows: r.countedRows ?? estimatedRows ?? 0, bytes: r.bytes, estimatedRows };",
    );
    try {
      const loaded = (await import(
        pathToFileURL(planted.path).href
      )) as typeof EvidenceModule;
      const evidence = synthetic([{ countedRows: null, estimatedRows: 5 }]);
      const sql = ["CREATE INDEX synthetic_idx ON synthetic(id)"];
      expect(
        classifyMigrationBatch(sql, loaded.tableSizesFromEvidence(evidence))[0]!
          .classification,
      ).toBe("additive-safe");
      expect(
        classifyMigrationBatch(sql, tableSizesFromEvidence(evidence))[0]!
          .classification,
      ).toBe("risky");
    } finally {
      await planted.cleanup();
    }
  });
});
