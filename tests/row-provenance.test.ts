import { PGlite } from "@electric-sql/pglite";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../src/db/database.js";
import { migrate } from "../src/db/migrate.js";
import { importNppes } from "../src/ingest/nppes/import.js";
import { sourceId } from "../src/ingest/nppes/acquire.js";
import { runWorker } from "../src/worker/commands.js";
import { coreMigrations, testDatabase } from "./pglite.js";
import {
  NON_ROW_OBJECTS,
  coverage,
  receiptViolations,
  schemaViolations,
} from "./row-provenance.js";

const MIGRATION = "990_row_provenance.sql";
const fixtures = fileURLToPath(new URL("fixtures/nppes/", import.meta.url));

let db: Database;
let directory: string;
let cleanup: () => Promise<void>;

/** Copy the real migrations, optionally changing the row provenance migration. */
async function migrations(
  mutate?: (sql: string) => string,
  omit = false,
): Promise<string> {
  const core = await coreMigrations();
  cleanup = core.cleanup;
  const path = join(core.directory, MIGRATION);
  if (omit) {
    await rm(path);
    await rm(join(core.directory, "992_record_policy.sql"));
    await rm(join(core.directory, "994_cms_api_attempt_provenance.sql"));
    await rm(join(core.directory, "1000_plugin_events.sql"));
    await rm(join(core.directory, "1001_passthrough.sql"));
    await rm(join(core.directory, "1002_ingest_run_snapshot.sql"));
    await rm(join(core.directory, "1004_partd_unit_cost_key.sql"));
  } else if (mutate) {
    const before = await readFile(path, "utf8");
    const after = mutate(before);
    expect(after).not.toBe(before);
    await writeFile(path, after);
  }
  return core.directory;
}

function replaceAll(sql: string, before: string, after: string): string {
  expect(sql.includes(before)).toBe(true);
  return sql.replaceAll(before, after);
}

async function syntheticReceipt(id: string, retrievedAt: string | null) {
  await db.query(
    `INSERT INTO source(source_id,publisher,source_kind) VALUES ('synthetic-source','Synthetic test publisher','synthetic')
     ON CONFLICT DO NOTHING`,
  );
  await db.query(
    "INSERT INTO snapshot(snapshot_id,source_id,retrieved_at) VALUES ($1,'synthetic-source',$2)",
    [id, retrievedAt],
  );
}

async function nppesImport() {
  const content = await readFile(join(fixtures, "providers-v2.csv"), "utf8");
  const secondary = await readFile(
    join(fixtures, "practice-locations.csv"),
    "utf8",
  );
  const provenance = JSON.parse(
    await readFile(join(fixtures, "provenance.json"), "utf8"),
  ) as { source: string; data_date: string };
  const sha256 = createHash("sha256").update(content).digest("hex");
  const path = join(directory, `${sha256}.csv`);
  await writeFile(path, content);
  async function* text(value: string) {
    yield Buffer.from(value);
  }
  return importNppes(db, {
    kind: "full",
    state: "TX",
    path,
    url: provenance.source,
    metadata: {
      snapshot_id: "fixture",
      source: sourceId,
      url: provenance.source,
      final_url: provenance.source,
      redirect_chain: [],
      status: 200,
      content_type: "text/csv",
      etag: null,
      last_modified: null,
      sha256,
      bytes: Buffer.byteLength(content),
      fetched_at: "2026-11-07T00:00:00Z",
    },
    fixture: {
      dataDate: provenance.data_date,
      input: {
        main: () => createReadStream(path),
        secondary: () => text(secondary),
      },
    },
  });
}

/** Update one row of each trigger kind and report what the trigger got wrong. */
async function updateProblems(): Promise<string[]> {
  await syntheticReceipt("synthetic-u", "2026-01-01T00:00:00Z");
  await db.query(
    `INSERT INTO zcta_centroid(zcta,latitude,longitude,snapshot_id,source_row)
     VALUES ('00009',1,1,'synthetic-u',2)`,
  );
  const targets = [
    ["zcta_centroid", "latitude=2", "zcta='00009'"],
    ["snapshot", "etag='x'", "snapshot_id='synthetic-u'"],
    ["cms_zip_budget", "daily_requests=daily_requests", "singleton"],
  ] as const;
  const problems: string[] = [];
  for (const [table, set, where] of targets) {
    const before = (
      await db.query<{ created_at: Date; updated_at: Date }>(
        `SELECT created_at, updated_at FROM ${table} WHERE ${where}`,
      )
    ).rows[0]!;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await db.query(
      `UPDATE ${table} SET ${set}, created_at='2000-01-01' WHERE ${where}`,
    );
    const after = (
      await db.query<{ created_at: Date; updated_at: Date }>(
        `SELECT created_at, updated_at FROM ${table} WHERE ${where}`,
      )
    ).rows[0]!;
    if (after.created_at.getTime() !== before.created_at.getTime())
      problems.push(`${table}: created_at changed`);
    if (!(after.updated_at.getTime() > before.updated_at.getTime()))
      problems.push(`${table}: updated_at not bumped`);
  }
  return problems;
}

beforeEach(async () => {
  db = testDatabase(new PGlite());
  directory = await mkdtemp(join(tmpdir(), "openplans-row-provenance-"));
  vi.stubEnv("OPENPLANS_DATA_DIR", directory);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await db?.close();
  await cleanup?.();
  await rm(directory, { recursive: true, force: true });
});

describe("row provenance schema", () => {
  it("gives every table the eight columns and the trigger; other objects are listed with a reason", async () => {
    await migrate(db, await migrations());
    expect(await schemaViolations(db)).toEqual([]);
    const { rows: views } = await db.query<{ name: string }>(
      `SELECT relname AS name FROM pg_class WHERE relnamespace=current_schema()::regnamespace
       AND relkind IN ('v','m') ORDER BY relname`,
    );
    expect(views.length).toBeGreaterThan(0);
    for (const { name } of views) expect(NON_ROW_OBJECTS[name]).toBeTruthy();
  });

  it("covers a lane's table that merges below 990 after 990 has run", async () => {
    const dir = await migrations();
    await migrate(db, dir);
    await writeFile(
      join(dir, "989_late_lane.sql"),
      `CREATE TABLE late_lane (id integer PRIMARY KEY,
         snapshot_id text NOT NULL REFERENCES snapshot(snapshot_id));
       CREATE TABLE late_app_state (id integer PRIMARY KEY);`,
    );
    expect(await migrate(db, dir)).toEqual(["989_late_lane.sql"]);
    // late_app_state names no receipt, so the test asks for an explicit rule.
    expect(await schemaViolations(db)).toEqual([
      "late_app_state: no receipt reference; add a row_provenance_rule",
    ]);
    await syntheticReceipt("synthetic-late", "2026-01-02T03:04:05Z");
    await db.query("INSERT INTO late_lane VALUES (1,'synthetic-late')");
    const { rows } = await db.query<Record<string, unknown>>(
      "SELECT sourced_by, sourced_at::text, sourced_slug FROM late_lane",
    );
    expect(rows).toEqual([
      {
        sourced_by: "synthetic-source",
        sourced_at: "2026-01-02 03:04:05+00",
        sourced_slug: "synthetic-late",
      },
    ]);
  });
});

describe("row provenance values", () => {
  it("copies the receipt on insert, keeps created_at and bumps updated_at on update", async () => {
    await migrate(db, await migrations());
    await syntheticReceipt("synthetic-a", "2026-01-01T00:00:00Z");
    await syntheticReceipt("synthetic-b", null);
    await db.query(
      `INSERT INTO zcta_centroid(zcta,latitude,longitude,snapshot_id,source_row)
       VALUES ('00001',1,1,'synthetic-a',2)`,
    );
    const read = async () =>
      (
        await db.query<{
          created_at: Date;
          updated_at: Date;
          sourced_by: string;
          sourced_at: string | null;
          sourced_slug: string;
        }>(
          "SELECT created_at, updated_at, sourced_by, sourced_at::text, sourced_slug FROM zcta_centroid",
        )
      ).rows[0]!;
    const inserted = await read();
    expect(inserted).toMatchObject({
      sourced_by: "synthetic-source",
      sourced_at: "2026-01-01 00:00:00+00",
      sourced_slug: "synthetic-a",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await db.query(
      "UPDATE zcta_centroid SET latitude=2, created_at='2000-01-01', sourced_by='forged'",
    );
    const updated = await read();
    expect(updated.created_at).toEqual(inserted.created_at);
    expect(updated.updated_at.getTime()).toBeGreaterThan(
      inserted.updated_at.getTime(),
    );
    expect(updated.sourced_by).toBe("synthetic-source");
    // A new reference re-derives; a receipt without a retrieval time stays NULL (unknown).
    await db.query("UPDATE zcta_centroid SET snapshot_id='synthetic-b'");
    expect(await read()).toMatchObject({
      sourced_by: "synthetic-source",
      sourced_at: null,
      sourced_slug: "synthetic-b",
    });
    // App state carries its fixed value; an unresolvable reference stays unknown.
    const { rows } = await db.query(
      "SELECT sourced_by, sourced_at, sourced_slug FROM cms_zip_budget",
    );
    expect(rows).toEqual([
      {
        sourced_by: "openplans",
        sourced_at: null,
        sourced_slug: "app:cms-zip-budget",
      },
    ]);
    await db.query(
      `INSERT INTO geocode_tx_county(county_fips,name,south,north,west,east,rings,snapshot_id)
       VALUES ('48001','Synthetic',30,31,-100,-99,'[]','synthetic-missing')`,
    );
    expect(
      (
        await db.query(
          "SELECT sourced_by, sourced_at, sourced_slug FROM geocode_tx_county",
        )
      ).rows,
    ).toEqual([
      {
        sourced_by: "unknown",
        sourced_at: null,
        sourced_slug: "synthetic-missing",
      },
    ]);
    expect(await receiptViolations(db)).toEqual([]);
    expect(await updateProblems()).toEqual([]);
  });

  it("fills rows that existed before the migration, in block batches", async () => {
    const dir = await migrations(undefined, true);
    await migrate(db, dir);
    await syntheticReceipt("synthetic-old", "2025-12-31T00:00:00Z");
    await db.query(
      "UPDATE snapshot SET created_at='2026-01-01T00:00:00Z' WHERE snapshot_id='synthetic-old'",
    );
    await db.query(
      `INSERT INTO zcta_centroid(zcta,latitude,longitude,snapshot_id,source_row)
       SELECT lpad(i::text,5,'0'),1,1,'synthetic-old',i+1 FROM generate_series(1,500) i`,
    );
    await db.query(
      `INSERT INTO geocode_tx_county(county_fips,name,south,north,west,east,rings,snapshot_id)
       VALUES ('48001','Synthetic',30,31,-100,-99,'[]','synthetic-missing')`,
    );
    const full = await migrations();
    expect(await migrate(db, full)).toEqual([
      MIGRATION,
      "992_record_policy.sql",
      "994_cms_api_attempt_provenance.sql",
      "1000_plugin_events.sql",
      "1001_passthrough.sql",
      "1002_ingest_run_snapshot.sql",
      "1004_partd_unit_cost_key.sql",
    ]);
    expect(await receiptViolations(db)).toEqual([]);
    const { rows } = await db.query(
      `SELECT count(*)::int AS rows, min(created_at)::text AS created, bool_and(updated_at=created_at) AS same
       FROM zcta_centroid WHERE sourced_slug='synthetic-old'`,
    );
    expect(rows).toEqual([
      { rows: 500, created: "2026-01-01 00:00:00+00", same: true },
    ]);
    // The batched command path: clear, then fill a block range at a time.
    await db.query(
      "SELECT set_config('openplans.row_provenance_backfill','on',false)",
    );
    await db.query(
      "UPDATE zcta_centroid SET sourced_by='unknown', sourced_at=NULL, sourced_slug='unknown'",
    );
    await db.query(
      "SELECT set_config('openplans.row_provenance_backfill','off',false)",
    );
    const out: string[] = [];
    const errors: string[] = [];
    expect(
      await runWorker(
        [
          "backfill",
          "row-provenance",
          "--table",
          "zcta_centroid",
          "--blocks",
          "1",
        ],
        // The worker closes what it opens; keep this test's database open.
        () => ({ ...db, close: async () => {} }),
        { out: (m) => out.push(m), error: (m) => errors.push(m) },
      ),
    ).toBe(0);
    expect({ out, errors }).toEqual({
      out: [JSON.stringify({ table: "zcta_centroid", rows: 500 })],
      errors: [],
    });
    expect(await receiptViolations(db)).toEqual([]);
    expect(
      (await coverage(db)).find((row) => row.table === "zcta_centroid"),
    ).toEqual({ table: "zcta_centroid", rows: 500, known: 500 });
  });

  it("a real ingest path (NPPES fixture) writes the receipt on every row", async () => {
    await migrate(db, await migrations());
    await nppesImport();
    expect(await receiptViolations(db)).toEqual([]);
    const { rows } = await db.query<{ sourced_by: string; sourced_at: string }>(
      "SELECT DISTINCT sourced_by, sourced_at::text FROM npi_address",
    );
    expect(rows).toEqual([
      { sourced_by: "cms-nppes", sourced_at: "2026-11-07 00:00:00+00" },
    ]);
  });
});

describe("plugin event migration", () => {
  async function activate() {
    await db.query(`UPDATE snapshot SET validation_state='ACTIVE',
      expected_children=1, fetched_children=1, sha256=repeat('a',64), activated_at=now()
      WHERE snapshot_id='synthetic-event'`);
  }

  async function assertSingleActivation() {
    const { rows } = await db.query(
      `SELECT event_type, idempotency_key, schema_version, emitted_by, payload
       FROM plugin_event_outbox WHERE idempotency_key='snapshot:synthetic-event:ACTIVE'`,
    );
    expect(rows).toEqual([
      {
        event_type: "snapshot.activated",
        idempotency_key: "snapshot:synthetic-event:ACTIVE",
        schema_version: 1,
        emitted_by: "db",
        payload: {
          sourceId: "synthetic-source",
          snapshotId: "synthetic-event",
          rows: null,
        },
      },
    ]);
  }

  it("installs metadata for all plugin tables and emits one activation on repeated updates", async () => {
    await migrate(db, await migrations());
    expect(await schemaViolations(db)).toEqual([]);
    await syntheticReceipt("synthetic-event", "2026-01-01T00:00:00Z");
    expect((await db.query("SELECT * FROM plugin_event_outbox")).rows).toEqual(
      [],
    );
    await activate();
    await assertSingleActivation();
    await activate();
    await assertSingleActivation();
    const { rows: events } = await db.query<{ event_id: string }>(
      "SELECT event_id FROM plugin_event_outbox",
    );
    expect(events[0]!.event_id).toMatch(/^[0-9a-f-]{36}$/);
    await db.query(
      "INSERT INTO plugin_event_delivery(event_id, subscriber) VALUES ($1,'synthetic-subscriber')",
      [events[0]!.event_id],
    );
    await db.query(
      "INSERT INTO plugin_state(plugin,key,value) VALUES ('synthetic-plugin','cursor','{}')",
    );
    for (const table of [
      "plugin_event_outbox",
      "plugin_event_delivery",
      "plugin_state",
    ]) {
      expect(
        (
          await db.query(
            `SELECT sourced_by,sourced_at,sourced_slug,record_policy,record_ttl,expired_at FROM ${table}`,
          )
        ).rows,
      ).toEqual([
        {
          sourced_by: "openplans",
          sourced_at: null,
          sourced_slug: `app:${table}`,
          record_policy: "app_state",
          record_ttl: null,
          expired_at: null,
        },
      ]);
    }
    expect(await receiptViolations(db)).toEqual([]);
    await db.query("DELETE FROM plugin_event_outbox");
    expect(
      (await db.query("SELECT * FROM plugin_event_delivery")).rows,
    ).toEqual([]);
  });

  it("emits quarantine codes or unknown, ignores intermediate states and retains per-state idempotency", async () => {
    await migrate(db, await migrations());
    await syntheticReceipt("synthetic-event", "2026-01-01T00:00:00Z");
    await db.query(
      "UPDATE snapshot SET validation_state='PARSED' WHERE snapshot_id='synthetic-event'",
    );
    expect((await db.query("SELECT * FROM plugin_event_outbox")).rows).toEqual(
      [],
    );
    await activate();
    await db.query(`INSERT INTO quality_issue(snapshot_id,severity,issue_code,explanation)
      VALUES ('synthetic-event','warning','synthetic_warning','Synthetic warning'),
        ('synthetic-event','error','synthetic_invalid','Synthetic error')`);
    await db.query(
      "UPDATE snapshot SET validation_state='QUARANTINED' WHERE snapshot_id='synthetic-event'",
    );
    await db.query(
      "UPDATE snapshot SET validation_state='QUARANTINED' WHERE snapshot_id='synthetic-event'",
    );
    expect(
      (
        await db.query(
          `SELECT payload,emitted_by,idempotency_key FROM plugin_event_outbox WHERE event_type='snapshot.quarantined'`,
        )
      ).rows,
    ).toEqual([
      {
        payload: {
          sourceId: "synthetic-source",
          snapshotId: "synthetic-event",
          reasonCode: "synthetic_invalid",
        },
        emitted_by: "db",
        idempotency_key: "snapshot:synthetic-event:QUARANTINED",
      },
    ]);
    await activate();
    await assertSingleActivation();
    await syntheticReceipt("synthetic-unknown", null);
    await db.query(
      "UPDATE snapshot SET validation_state='QUARANTINED' WHERE snapshot_id='synthetic-unknown'",
    );
    expect(
      (
        await db.query(
          "SELECT payload->>'reasonCode' AS reason FROM plugin_event_outbox WHERE idempotency_key='snapshot:synthetic-unknown:QUARANTINED'",
        )
      ).rows,
    ).toEqual([{ reason: "unknown" }]);
  });

  it("rolls back the snapshot change and its event together", async () => {
    await migrate(db, await migrations());
    await syntheticReceipt("synthetic-event", "2026-01-01T00:00:00Z");
    const marker = Error("synthetic rollback");
    await expect(
      db.transaction(async (tx) => {
        await tx.query(
          "UPDATE snapshot SET validation_state='QUARANTINED' WHERE snapshot_id='synthetic-event'",
        );
        expect(
          (await tx.query("SELECT event_id FROM plugin_event_outbox")).rows,
        ).toHaveLength(1);
        throw marker;
      }),
    ).rejects.toBe(marker);
    expect((await db.query("SELECT * FROM plugin_event_outbox")).rows).toEqual(
      [],
    );
    expect(
      (
        await db.query(
          "SELECT validation_state FROM snapshot WHERE snapshot_id='synthetic-event'",
        )
      ).rows,
    ).toEqual([{ validation_state: "DISCOVERED" }]);
  });

  it("mutant: removing idempotency uniqueness fails the duplicate-event assertion", async () => {
    const dir = await migrations();
    const path = join(dir, "1000_plugin_events.sql");
    const sql = await readFile(path, "utf8");
    await writeFile(
      path,
      replaceAll(
        sql,
        "idempotency_key text NOT NULL UNIQUE",
        "idempotency_key text NOT NULL",
      ),
    );
    await migrate(db, dir);
    await syntheticReceipt("synthetic-event", "2026-01-01T00:00:00Z");
    await activate();
    await assertSingleActivation();
    await activate();
    await expect(assertSingleActivation()).rejects.toThrow();
    expect(
      (await db.query("SELECT event_id FROM plugin_event_outbox")).rows,
    ).toHaveLength(2);
  });
});

describe("row provenance mutants", () => {
  it("mutant: a table missing a column fails the schema test", async () => {
    await migrate(db, await migrations());
    await db.query("ALTER TABLE rate DROP COLUMN sourced_at");
    await db.query("CREATE TABLE out_of_band (id integer)");
    expect(await schemaViolations(db)).toEqual([
      "out_of_band: missing created_at",
      "out_of_band: missing updated_at",
      "out_of_band: missing sourced_by",
      "out_of_band: missing sourced_at",
      "out_of_band: missing sourced_slug",
      "out_of_band: missing record_policy",
      "out_of_band: missing record_ttl",
      "out_of_band: missing expired_at",
      "out_of_band: no zz_record_policy trigger",
      "out_of_band: no row_provenance trigger",
      "rate: missing sourced_at",
    ]);
  });

  it("mutant: an ingest path that does not set sourced_at fails", async () => {
    await migrate(
      db,
      await migrations((sql) =>
        replaceAll(sql, "NEW.sourced_at := receipt_time;", ""),
      ),
    );
    await nppesImport();
    const problems = await receiptViolations(db);
    for (const table of ["npi_provider", "npi_address", "npi_taxonomy"])
      expect(problems.some((p) => p.startsWith(`${table}:`))).toBe(true);
  });

  it("mutant: an update that does not bump updated_at fails", async () => {
    await migrate(
      db,
      await migrations((sql) =>
        replaceAll(sql, "NEW.updated_at := now();", "NULL;"),
      ),
    );
    expect(await updateProblems()).toEqual([
      "zcta_centroid: updated_at not bumped",
      "snapshot: updated_at not bumped",
      "cms_zip_budget: updated_at not bumped",
    ]);
  });
});
