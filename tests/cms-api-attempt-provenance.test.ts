import { PGlite } from "@electric-sql/pglite";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../src/db/database.js";
import { migrate, migrationsDirectory } from "../src/db/migrate.js";
import { classifyMigration } from "../src/db/migrate-safety.js";
import { coreMigrations, testDatabase } from "./pglite.js";
import { receiptViolations, schemaViolations } from "./row-provenance.js";

const MIGRATION = "994_cms_api_attempt_provenance.sql";
const FALLBACK = {
  sourced_by: "openplans",
  sourced_at: null,
  sourced_slug: "cache:cms-api-attempt",
};

let db: Database;
let cleanup: () => Promise<void>;

beforeEach(() => {
  db = testDatabase(new PGlite());
});
afterEach(async () => {
  await db?.close();
  await cleanup?.();
});

async function migrated(omit = false) {
  const core = await coreMigrations();
  cleanup = core.cleanup;
  if (omit) await rm(join(core.directory, MIGRATION));
  await migrate(db, core.directory);
}

// Synthetic receipt for the test; no real API response is stored.
async function receipt(id: string) {
  await db.query(
    `INSERT INTO source(source_id,publisher,source_kind)
     VALUES ('synthetic-cms-api','Synthetic test publisher','synthetic') ON CONFLICT DO NOTHING`,
  );
  await db.query(
    `INSERT INTO snapshot(snapshot_id,source_id,retrieved_at)
     VALUES ($1,'synthetic-cms-api','2026-01-02T03:04:05Z')`,
    [id],
  );
}

async function attempt(
  outcome: string,
  snapshotId: string | null,
  claimed?: { by: string; slug: string },
) {
  const { rows } = await db.query<Record<string, unknown>>(
    `INSERT INTO cms_api_attempt(endpoint,plan_year,pairs,snapshot_id,outcome,http_status,
       sourced_by,sourced_slug)
     VALUES ('drugs/covered',2026,1,$1,$2,503,$3,$4)
     RETURNING sourced_by, sourced_at::text, sourced_slug, record_policy`,
    [snapshotId, outcome, claimed?.by ?? "unknown", claimed?.slug ?? "unknown"],
  );
  return rows[0]!;
}

async function failedZipAttempt() {
  const { rows } = await db.query<Record<string, unknown>>(
    `INSERT INTO cms_zip_attempt(zip,plan_year,outcome,http_status,requested_url)
     VALUES ('75001',2026,'failed',503,'synthetic://zip')
     RETURNING sourced_by, sourced_at::text, sourced_slug, record_policy`,
  );
  return rows[0]!;
}

describe("cms_api_attempt row provenance", () => {
  it("labels a failed attempt as OpenPlans' call log, like cms_zip_attempt", async () => {
    await migrated();
    const failed = await attempt("failed", null);
    expect(failed).toMatchObject(FALLBACK);
    const zip = await failedZipAttempt();
    expect(failed.sourced_at).toBe(zip.sourced_at);
    expect(failed.record_policy).toBe(zip.record_policy);
    // A refusal never reached the API either.
    expect(await attempt("refused", null)).toMatchObject(FALLBACK);
    // Values a caller passes are ignored.
    expect(
      await attempt("failed", null, { by: "cms-marketplace-api", slug: "x" }),
    ).toMatchObject(FALLBACK);
    expect(await schemaViolations(db)).toEqual([]);
  });

  it("keeps the receipt of an attempt that got a response, also on update", async () => {
    await migrated();
    await receipt("synthetic-cms-api-1");
    expect(await attempt("absorbed", "synthetic-cms-api-1")).toMatchObject({
      sourced_by: "synthetic-cms-api",
      sourced_at: "2026-01-02 03:04:05+00",
      sourced_slug: "synthetic-cms-api-1",
    });
    await attempt("failed", null);
    await db.query("UPDATE cms_api_attempt SET latency_ms = 5");
    const { rows } = await db.query<Record<string, unknown>>(
      `SELECT outcome, sourced_by, sourced_at::text, sourced_slug FROM cms_api_attempt
       ORDER BY attempt_id`,
    );
    expect(rows).toEqual([
      {
        outcome: "absorbed",
        sourced_by: "synthetic-cms-api",
        sourced_at: "2026-01-02 03:04:05+00",
        sourced_slug: "synthetic-cms-api-1",
      },
      { outcome: "failed", ...FALLBACK },
    ]);
    expect(await receiptViolations(db)).toEqual([]);
  });

  it("mutant: without the migration a failed attempt says unknown", async () => {
    await migrated(true);
    expect(await attempt("failed", null)).toMatchObject({
      sourced_by: "unknown",
      sourced_slug: "unknown",
    });
  });

  it("is additive-safe with or without table size evidence", async () => {
    const sql = await readFile(join(migrationsDirectory, MIGRATION), "utf8");
    expect(classifyMigration(sql)).toEqual({
      classification: "additive-safe",
      reasons: [],
    });
    expect(sql).not.toContain("openplans-migration-allow");
    // Planted mutant: rebuilding the existing trigger needs review.
    expect(
      classifyMigration(
        sql + "\nSELECT install_row_provenance('cms_api_attempt');",
      ).classification,
    ).toBe("risky");
  });
});
