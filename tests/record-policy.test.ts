import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Database } from "../src/db/database.js";
import { migrate } from "../src/db/migrate.js";
import { runWorker } from "../src/worker/commands.js";
import { coreMigrations, testDatabase } from "./pglite.js";
import { schemaViolations } from "./row-provenance.js";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

let db: Database;
let cleanup: () => Promise<void>;
let directory: string;
beforeEach(async () => {
  db = testDatabase(new PGlite());
  const core = await coreMigrations();
  cleanup = core.cleanup;
  directory = core.directory;
});
afterEach(async () => {
  await db.close();
  await cleanup();
});

// All identities and receipts in this file are synthetic.
async function receipt(id = "synthetic-policy", time = "2026-11-10T00:00:00Z") {
  await db.exec(
    "INSERT INTO source(source_id,publisher,source_kind) VALUES ('synthetic-policy','Synthetic','synthetic') ON CONFLICT DO NOTHING",
  );
  await db.query(
    "INSERT INTO snapshot(snapshot_id,source_id,retrieved_at) VALUES ($1,'cms-marketplace-api',$2) ON CONFLICT DO NOTHING",
    [id, time],
  );
}
async function coverage(value = "Covered", id = "synthetic-policy") {
  await db.query(
    `INSERT INTO cms_api_drug_coverage(plan_id,rxcui,plan_year,coverage,snapshot_id,source_row)
    VALUES ('00000TX0000000','0',2026,$1,$2,1)`,
    [value, id],
  );
}
async function row() {
  return (
    await db.query<{
      record_policy: string;
      record_ttl: string | null;
      expired_at: Date | null;
      expires_at: Date | null;
    }>(
      "SELECT record_policy,record_ttl::text,expired_at,expires_at FROM cms_api_drug_coverage",
    )
  ).rows[0]!;
}
async function command(args: string[]) {
  const messages: string[] = [];
  const code = await runWorker(
    ["record-policy", ...args],
    () => ({ ...db, close: async () => {} }),
    { out: (s) => messages.push(s), error: (s) => messages.push(s) },
  );
  return { code, messages };
}

it("installs eight columns on every table, including late tables", async () => {
  await migrate(db, directory);
  expect(await schemaViolations(db)).toEqual([]);
  await receipt();
  await writeFile(
    join(directory, "989_late_policy.sql"),
    "CREATE TABLE late_policy(id integer, snapshot_id text REFERENCES snapshot(snapshot_id)); INSERT INTO late_policy VALUES (0,'synthetic-policy');",
  );
  await migrate(db, directory);
  expect(await schemaViolations(db)).toEqual([]);
  await db.exec("INSERT INTO late_policy(id) VALUES (1)");
  expect(
    (
      await db.query(
        "SELECT record_policy,record_ttl,expired_at FROM late_policy WHERE id=1",
      )
    ).rows,
  ).toEqual([{ record_policy: "unknown", record_ttl: null, expired_at: null }]);
});
it("assigns app, official, fallback and no-data policies, clamps writers and mirrors the alias", async () => {
  await migrate(db, directory);
  await receipt();
  await coverage();
  expect(await row()).toMatchObject({
    record_policy: "cms_api_fallback",
    record_ttl: "7 days",
    expired_at: new Date("2026-11-17T00:00:00Z"),
  });
  expect((await row()).expires_at).toEqual((await row()).expired_at);
  await db.exec(
    "UPDATE cms_api_drug_coverage SET record_ttl='100 days',expired_at='2100-01-01'",
  );
  expect((await row()).expired_at).toEqual(new Date("2026-11-17T00:00:00Z"));
  await db.exec(
    "UPDATE cms_api_drug_coverage SET record_ttl='2 hours',expired_at=NULL",
  );
  expect((await row()).record_ttl).toBe("02:00:00");
  await db.exec("UPDATE cms_api_drug_coverage SET coverage='DataNotProvided'");
  expect(await row()).toMatchObject({
    record_policy: "cms_api_fallback_no_data",
    record_ttl: "1 day",
    expired_at: new Date("2026-11-11T00:00:00Z"),
  });
  await db.exec(
    "UPDATE cms_api_drug_coverage SET record_policy='app_state',record_ttl='200 days',expired_at='2100-01-01'",
  );
  expect((await row()).record_policy).toBe("cms_api_fallback_no_data");
  expect((await row()).expired_at).toEqual(new Date("2026-11-11T00:00:00Z"));
  expect(
    (
      await db.query(
        "SELECT record_policy,record_ttl,expired_at FROM source LIMIT 1",
      )
    ).rows[0],
  ).toMatchObject({
    record_policy: "app_state",
    record_ttl: null,
    expired_at: null,
  });
  expect(
    (
      await db.query(
        "SELECT record_policy,record_ttl,expired_at FROM snapshot LIMIT 1",
      )
    ).rows[0],
  ).toMatchObject({
    record_policy: "source_snapshot",
    record_ttl: null,
    expired_at: null,
  });
});
it("list/set/expire validate options, recompute rows, preserve narrower TTLs and filter by source time", async () => {
  await migrate(db, directory);
  await receipt();
  await coverage();
  expect((await command(["list"])).code).toBe(0);
  expect((await command(["list"])).messages[0]).toContain(
    "cms_api_fallback_no_data",
  );
  expect(
    (
      await command([
        "set",
        "cms_api_fallback",
        "--ttl",
        "2 days",
        "--stale",
        "3 hours",
      ])
    ).code,
  ).toBe(0);
  expect((await row()).expired_at).toEqual(new Date("2026-11-12T00:00:00Z"));
  expect(
    (await command(["set", "cms_api_fallback", "--ttl", "9 days"])).code,
  ).toBe(0);
  expect((await row()).record_ttl).toBe("9 days");
  await db.exec(
    "UPDATE cms_api_drug_coverage SET record_ttl='1 hour',expired_at=NULL",
  );
  await command(["set", "cms_api_fallback", "--ttl", "10 days"]);
  expect((await row()).record_ttl).toBe("01:00:00");
  const before = (await row()).expired_at;
  await command(["expire", "cms_api_fallback", "--before", "2020-01-01Z"]);
  expect((await row()).expired_at).toEqual(before);
  await command(["expire", "cms_api_fallback"]);
  expect((await row()).expired_at!.getTime()).toBeLessThanOrEqual(Date.now());
  expect((await row()).expires_at).toEqual((await row()).expired_at);
  for (const args of [
    ["set", "missing", "--ttl", "1 day"],
    ["set", "cms_api_fallback", "--ttl", "-1 day"],
    ["expire", "cms_api_fallback", "--before", "bad"],
    ["set", "cms_api_fallback", "--ttl"],
  ])
    expect((await command(args)).code).toBe(1);
  await command(["set", "cms_api_fallback", "--ttl", "none"]);
  // A writer's narrower one-hour TTL survives a no-expiry policy.
  expect((await row()).record_ttl).toBe("01:00:00");
});
it("backfills an already-provenanced fallback and is idempotent", async () => {
  const path = join(directory, "992_record_policy.sql");
  const sql = await readFile(path, "utf8");
  await writeFile(path, "SELECT 1;");
  // This pre-policy schema cannot include tables whose rules require policy_name.
  await rm(join(directory, "1000_plugin_events.sql"));
  await rm(join(directory, "1001_passthrough.sql"));
  await rm(join(directory, "1002_ingest_run_snapshot.sql"));
  await rm(join(directory, "1004_partd_unit_cost_key.sql"));
  await rm(join(directory, "1005_partd_staged_generation.sql"));
  await migrate(db, directory);
  await receipt();
  await db.query(`INSERT INTO cms_api_drug_coverage(plan_id,rxcui,plan_year,coverage,snapshot_id,source_row,expires_at)
    VALUES ('00000TX0000000','0',2026,'DataNotProvided','synthetic-policy',1,now())`);
  await db.exec(sql);
  expect((await row()).record_policy).toBe("cms_api_fallback_no_data");
  expect((await row()).record_ttl).toBe("1 day");
  expect(
    (
      await db.query(
        "SELECT backfill_row_provenance('cms_api_drug_coverage',0,2000) AS n",
      )
    ).rows[0]!.n,
  ).toBe(0);
});
it.each([
  [
    "missing column",
    "ADD COLUMN IF NOT EXISTS record_ttl interval",
    "ADD COLUMN IF NOT EXISTS broken_ttl interval",
  ],
  [
    "late expiry",
    "deadline := coalesce(NEW.sourced_at,NEW.created_at) + NEW.record_ttl;",
    "deadline := coalesce(NEW.sourced_at,NEW.created_at) + interval '100 days';",
  ],
  [
    "wrong no-data policy",
    "WHEN coverage_name='DataNotProvided'",
    "WHEN coverage_name='broken'",
  ],
])("planted mutant: %s is caught", async (kind, before, after) => {
  const path = join(directory, "992_record_policy.sql");
  const sql = await readFile(path, "utf8");
  expect(sql).toContain(before);
  await writeFile(path, sql.replace(before, after));
  if (kind === "missing column") {
    await expect(migrate(db, directory)).rejects.toThrow();
    return;
  }
  await migrate(db, directory);
  await receipt();
  await coverage(
    kind === "wrong no-data policy" ? "DataNotProvided" : "Covered",
  );
  if (kind === "late expiry") {
    await db.exec(
      "UPDATE cms_api_drug_coverage SET record_ttl='100 days',expired_at='2100-01-01'",
    );
    expect((await row()).expired_at).not.toEqual(
      new Date("2026-11-17T00:00:00Z"),
    );
  } else
    expect((await row()).record_policy).not.toBe("cms_api_fallback_no_data");
});

it("clamps calendar TTLs by their actual deadline and keeps operator policies on backfill", async () => {
  await migrate(db, directory);
  await receipt("synthetic-calendar", "2026-02-01T00:00:00Z");
  await db.exec(
    "UPDATE record_policy SET default_ttl='1 month' WHERE name='cms_api_fallback'",
  );
  await coverage("Covered", "synthetic-calendar");
  await db.exec(
    "UPDATE cms_api_drug_coverage SET record_ttl='30 days',expired_at='2100-01-01'",
  );
  expect((await row()).record_ttl).toBe("1 mon");
  expect((await row()).expired_at).toEqual(new Date("2026-03-01T00:00:00Z"));
  await db.exec(
    "INSERT INTO record_policy(name,description) VALUES ('synthetic_custom','Synthetic custom policy'); UPDATE source SET record_policy='synthetic_custom' WHERE source_id='synthetic-policy'",
  );
  await db.query("SELECT backfill_row_provenance('source',0,2000)");
  expect(
    (
      await db.query(
        "SELECT record_policy FROM source WHERE source_id='synthetic-policy'",
      )
    ).rows[0]!.record_policy,
  ).toBe("synthetic_custom");
});

it("supports no scheduled expiry and changes policy on a new source receipt", async () => {
  await migrate(db, directory);
  await receipt();
  await coverage();
  expect(
    (await command(["set", "cms_api_fallback", "--ttl", "none"])).code,
  ).toBe(0);
  expect(await row()).toMatchObject({
    record_ttl: null,
    expired_at: null,
    expires_at: null,
  });
  await command(["set", "cms_api_fallback", "--ttl", "3 days"]);
  await receipt("synthetic-new", "2026-12-01T00:00:00Z");
  await db.exec(
    "UPDATE cms_api_drug_coverage SET snapshot_id='synthetic-new',record_ttl='1 hour'",
  );
  expect(await row()).toMatchObject({
    record_ttl: "01:00:00",
    expired_at: new Date("2026-12-01T01:00:00Z"),
  });
  await command(["expire", "cms_api_fallback"]);
  expect((await row()).expired_at!.getTime()).toBeLessThanOrEqual(Date.now());
});

it("uses an edited table rule for new rows despite the original constant heap default", async () => {
  await migrate(db, directory);
  await db.exec(`INSERT INTO record_policy(name,default_ttl,description)
    VALUES ('synthetic_rule','2 hours','Synthetic table policy');
    UPDATE row_provenance_rule SET policy_name='synthetic_rule' WHERE table_name='source';
    INSERT INTO source(source_id,publisher,source_kind) VALUES ('synthetic-rule-source','Synthetic','synthetic')`);
  expect(
    (
      await db.query(`SELECT record_policy,record_ttl::text,
    expired_at=created_at+interval '2 hours' AS correct FROM source WHERE source_id='synthetic-rule-source'`)
    ).rows[0],
  ).toEqual({
    record_policy: "synthetic_rule",
    record_ttl: "02:00:00",
    correct: true,
  });
});
