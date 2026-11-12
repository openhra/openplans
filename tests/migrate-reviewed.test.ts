import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import {
  classifyMigration,
  classifyMigrationBatch,
  migrationStatementHash,
  migrationStatements,
  missingContractNotes,
} from "../src/db/migrate-safety.js";

// Synthetic SQL only. These comments grant no approval to shipped migrations.
const drop = "ALTER TABLE synthetic DROP COLUMN old;";
const annotate = (
  sql: string,
  reason = "Retained readers use the replacement; lock budget rehearsed",
) =>
  `-- openplans-migration-allow: ${migrationStatementHash(migrationStatements(sql)[0]!)} ${reason}\n${sql}`;

describe("statement-scoped migration reviews", () => {
  it.each([
    "CREATE VIEW synthetic AS SELECT id FROM rate;",
    'CREATE VIEW public."synthetic" ("id") AS SELECT id FROM rate;',
    "CREATE VIEW synthetic AS WITH x AS (SELECT id FROM rate) SELECT * FROM x;",
    "COMMENT ON TABLE rate IS 'DROP COLUMN old; -- only prose';",
    "COMMENT ON COLUMN rate.amount IS NULL;",
    "COMMENT ON FUNCTION synthetic() IS 'Document the deferred body';",
    "CREATE TABLE synthetic(id int); ALTER TABLE synthetic ADD COLUMN name text NOT NULL;",
    "CREATE TABLE synthetic(id int); ALTER TABLE synthetic ALTER COLUMN id SET NOT NULL;",
    "-- ordinary comment only\n/* nested /* comment */ */",
  ])("accepts additive definitions and comments: %s", (sql) => {
    expect(classifyMigration(sql)).toEqual({
      classification: "additive-safe",
      reasons: [],
    });
  });

  it.each([
    "CREATE OR REPLACE VIEW synthetic AS SELECT id FROM rate;",
    "CREATE MATERIALIZED VIEW synthetic AS SELECT id FROM rate;",
    "CREATE VIEW synthetic AS SELECT * INTO stolen FROM rate;",
    "CREATE VIEW synthetic AS SELECT id FROM rate; ALTER TABLE rate DROP COLUMN id;",
    "COMMENT ON TABLE rate IS 'safe'; ALTER TABLE rate RENAME COLUMN id TO old;",
    "COMMENT ON TABLE rate IS 'safe'; ALTER TABLE rate ALTER COLUMN id SET NOT NULL;",
    "CREATE OR REPLACE FUNCTION synthetic() RETURNS int LANGUAGE sql AS 'SELECT 1';",
    "ALTER TABLE synthetic ALTER COLUMN id TYPE smallint;",
    "ALTER TABLE synthetic ADD COLUMN name text NOT NULL;",
    "CREATE TABLE IF NOT EXISTS synthetic(id int); ALTER TABLE synthetic ALTER COLUMN id SET NOT NULL;",
    "CREATE TABLE synthetic(id int); INSERT INTO synthetic(id) VALUES (NULL); ALTER TABLE synthetic ALTER COLUMN id SET NOT NULL;",
  ])(
    "keeps replacement, materialization and breaking tails risky: %s",
    (sql) => {
      expect(classifyMigration(sql).classification).toBe("risky");
    },
  );

  it("records reviewed risk distinctly and binds the comment to one statement", () => {
    const reviewed = annotate(drop);
    const result = classifyMigration(reviewed);
    expect(result.classification).toBe("reviewed-exception");
    expect(result.reasons[0]).toContain("Reviewed exception: Retained readers");
    expect(result.reasons[0]).toContain(
      "Destructive or compatibility-changing",
    );
    for (const tail of [
      "ALTER TABLE synthetic DROP COLUMN other;",
      "ALTER TABLE synthetic RENAME COLUMN value TO old;",
      "ALTER TABLE synthetic ALTER COLUMN value SET NOT NULL;",
    ]) {
      expect(classifyMigration(reviewed + tail).classification).toBe("risky");
      expect(
        classifyMigration(reviewed.replace(drop, tail)).classification,
      ).toBe("risky");
    }
    expect(
      classifyMigration(reviewed + annotate("SELECT synthetic_installer();"))
        .classification,
    ).toBe("reviewed-exception");
  });

  it("does not waive malformed SQL, concurrent execution rules, or contract notes", () => {
    const concurrent =
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS synthetic ON rate(id);";
    expect(classifyMigration(annotate(concurrent)).classification).toBe(
      "risky",
    );
    expect(
      classifyMigration(
        annotate("SELECT synthetic_installer();") +
          "CREATE INDEX CONCURRENTLY synthetic ON rate(id);",
      ).classification,
    ).toBe("risky");
    expect(
      classifyMigration(annotate(drop) + "/* unfinished").classification,
    ).toBe("risky");
    expect(
      classifyMigration(
        annotate(
          "DO $$ BEGIN CREATE INDEX CONCURRENTLY synthetic ON rate(id); END $$;",
        ),
      ).classification,
    ).toBe("risky");
    expect(
      classifyMigration(
        annotate("DO $$ BEGIN CREATE TABLE synthetic(; END $$;"),
      ).classification,
    ).toBe("risky");
    expect(
      missingContractNotes(
        [
          {
            name: "9999_synthetic.sql",
            sql: annotate(drop),
            sha256: "synthetic",
          },
        ],
        {},
        "",
      ),
    ).toEqual(["9999_synthetic.sql"]);
  });

  it("rejects missing reasons, wrong digests, stale, duplicate, misplaced and orphan annotations", () => {
    const valid = annotate(drop);
    const header = valid.split("\n")[0]!;
    const mutants = [
      annotate(drop, ""),
      annotate(drop, "too short"),
      valid.replace(/: [a-f0-9]{64}/, ": " + "0".repeat(64)),
      header + "\n" + valid,
      "ALTER TABLE synthetic -- " + header.slice(3) + "\n DROP COLUMN old;",
      header,
      header + "\n;",
      header + "\nCREATE TABLE synthetic(id int);",
      "DO $$ BEGIN " + valid + " END $$;",
    ];
    for (const sql of mutants)
      expect(classifyMigration(sql).classification).toBe("risky");
    expect(classifyMigration(`/* ${header} */ ${drop}`).classification).toBe(
      "risky",
    );
    expect(
      classifyMigration(
        `CREATE FUNCTION synthetic() RETURNS void LANGUAGE sql AS $$ ${header} $$; ${drop}`,
      ).classification,
    ).toBe("risky");
  });

  it("hashes quoted values and opaque bodies, while ignoring ordinary formatting", () => {
    const installer =
      "DO $$ BEGIN EXECUTE 'ALTER TABLE synthetic DROP COLUMN old'; END $$;";
    expect(
      classifyMigration(
        annotate("DO $$ BEGIN ALTER TABLE synthetic DROP COLUMN old; END $$;"),
      ).classification,
    ).toBe("reviewed-exception");
    expect(classifyMigration(annotate(installer)).classification).toBe(
      "reviewed-exception",
    );
    expect(
      classifyMigration(
        annotate(installer).replace("DROP COLUMN old", "DROP COLUMN other"),
      ).classification,
    ).toBe("risky");
    expect(
      classifyMigration(
        annotate(drop).replace(
          drop,
          "alter table synthetic\n drop column old;",
        ),
      ).classification,
    ).toBe("reviewed-exception");
    expect(
      classifyMigration(annotate(drop).replace("COLUMN old", 'COLUMN "OLD"'))
        .classification,
    ).toBe("risky");
  });

  it("invalidates size evidence after reviewed or malformed execution across files", () => {
    const sizes = { plan: { rows: 1, bytes: 1024 } };
    for (const first of [
      annotate("SELECT synthetic_installer();"),
      "ALTER TABLE plan (",
    ]) {
      expect(
        classifyMigrationBatch(
          [first, "CREATE INDEX synthetic ON plan(id);"],
          sizes,
        )[1]?.classification,
      ).toBe("risky");
    }
  });

  it("cannot copy a review between Unicode identifiers with colliding JS uppercase forms", () => {
    const sql = "ALTER TABLE synthetic DROP COLUMN ß;";
    expect(classifyMigration(annotate(sql)).classification).toBe(
      "reviewed-exception",
    );
    expect(
      classifyMigration(annotate(sql).replace("COLUMN ß", "COLUMN ss"))
        .classification,
    ).toBe("risky");
    expect(migrationStatementHash(migrationStatements(sql)[0]!)).not.toBe(
      migrationStatementHash(migrationStatements(sql.replace("ß", "ss"))[0]!),
    );
  });

  it("creates a plain view without executing the referenced function", async () => {
    const pg = new PGlite();
    try {
      await pg.exec(
        "CREATE FUNCTION synthetic() RETURNS int LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic negative control'; END $$;",
      );
      await pg.exec("CREATE VIEW synthetic_view AS SELECT synthetic() AS id;");
      await expect(pg.query("SELECT * FROM synthetic_view")).rejects.toThrow(
        "synthetic negative control",
      );
    } finally {
      await pg.close();
    }
  });
});
