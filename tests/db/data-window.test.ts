import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { annualAdmissions } from "../../src/db/data-window.js";
import { testDatabase } from "../pglite.js";

// Synthetic receipt graph, with only the columns admission validation reads.
const db = testDatabase(new PGlite());
beforeAll(async () => {
  await db.exec(`
    CREATE TABLE annual_data_admission(domain text,coverage_year integer,manifest jsonb);
    CREATE TABLE snapshot(snapshot_id text,validation_state text);
    CREATE TABLE puf_import(import_id text,plan_year integer);
    CREATE TABLE puf_active_catalog(import_id text,plan_year integer);
    CREATE TABLE puf_import_file(import_id text,snapshot_id text);
    CREATE TABLE state_rate_import(import_id text,plan_year integer);
    CREATE TABLE state_rate_active(import_id text,plan_year integer);
    CREATE TABLE medicare_release(snapshot_id text,contract_year integer,family text);
    CREATE TABLE partd_release(snapshot_id text,contract_year integer);
    INSERT INTO snapshot VALUES ('synthetic-puf','ACTIVE'),('synthetic-file','ACTIVE'),
      ('synthetic-state','ACTIVE'),('synthetic-landscape','ACTIVE'),('synthetic-pbp','ACTIVE'),
      ('synthetic-stars','ACTIVE'),('synthetic-crosswalk','ACTIVE'),('synthetic-service_area','ACTIVE'),
      ('synthetic-partd','ACTIVE'),('synthetic-unrelated','QUARANTINED');
    INSERT INTO puf_import VALUES ('synthetic-puf',2027);
    INSERT INTO puf_active_catalog VALUES ('synthetic-puf',2027);
    INSERT INTO puf_import_file VALUES ('synthetic-puf','synthetic-file');
    INSERT INTO state_rate_import VALUES ('synthetic-state',2027);
    INSERT INTO state_rate_active VALUES ('synthetic-state',2027);
    INSERT INTO medicare_release VALUES ('synthetic-landscape',2027,'landscape'),
      ('synthetic-pbp',2027,'pbp'),('synthetic-stars',2027,'stars'),
      ('synthetic-crosswalk',2027,'crosswalk'),('synthetic-service_area',2027,'service_area');
    INSERT INTO partd_release VALUES ('synthetic-partd',2027);
  `);
  for (const [domain, releases] of [
    [
      "individual",
      [
        { kind: "puf", snapshot_id: "synthetic-puf", contract_year: 2027 },
        { kind: "state", snapshot_id: "synthetic-state", contract_year: 2027 },
      ],
    ],
    [
      "medicare",
      [
        ...["landscape", "pbp", "stars", "crosswalk", "service_area"].map(
          (family) => ({
            kind: "medicare",
            snapshot_id: `synthetic-${family}`,
            contract_year: 2027,
            ...(family === "landscape" ? {} : { family }),
          }),
        ),
        { kind: "partd", snapshot_id: "synthetic-partd", contract_year: 2027 },
      ],
    ],
  ])
    await db.query("INSERT INTO annual_data_admission VALUES ($1,2027,$2)", [
      domain,
      { schema_version: 1, releases },
    ]);
});
afterAll(() => db.close());

describe("batched annual admission dependencies", () => {
  it("accepts all four receipt kinds and defaults the Medicare catalog family", async () => {
    expect(await annualAdmissions(db)).toHaveLength(2);
  });
  it.each([
    "synthetic-puf",
    "synthetic-file",
    "synthetic-state",
    "synthetic-landscape",
    "synthetic-pbp",
    "synthetic-stars",
    "synthetic-crosswalk",
    "synthetic-service_area",
    "synthetic-partd",
  ])(
    "negative control: rejects quarantined dependency %s",
    async (snapshot) => {
      const marker = new Error("synthetic rollback");
      await expect(
        db.transaction(async (tx) => {
          await tx.query(
            "UPDATE snapshot SET validation_state='QUARANTINED' WHERE snapshot_id=$1",
            [snapshot],
          );
          await expect(annualAdmissions(tx)).rejects.toThrow(
            "annual_admission_dependency_invalid",
          );
          throw marker;
        }),
      ).rejects.toBe(marker);
      expect(await annualAdmissions(db)).toHaveLength(2);
    },
  );
  it.each([
    "UPDATE puf_import SET plan_year=2026",
    "UPDATE puf_active_catalog SET plan_year=2026",
    "DELETE FROM puf_import_file",
    "UPDATE state_rate_import SET plan_year=2026",
    "UPDATE state_rate_active SET plan_year=2026",
    "UPDATE medicare_release SET contract_year=2026 WHERE family='landscape'",
    "UPDATE medicare_release SET family='stars' WHERE family='pbp'",
    "UPDATE partd_release SET contract_year=2026",
    "DELETE FROM snapshot WHERE snapshot_id='synthetic-partd'",
  ])("negative control: rejects altered receipt graph %s", async (mutation) => {
    const marker = new Error("synthetic rollback");
    await expect(
      db.transaction(async (tx) => {
        await tx.exec(mutation);
        await expect(annualAdmissions(tx)).rejects.toThrow(
          "annual_admission_dependency_invalid",
        );
        throw marker;
      }),
    ).rejects.toBe(marker);
    expect(await annualAdmissions(db)).toHaveLength(2);
  });
});
