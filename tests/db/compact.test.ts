import { PGlite } from "@electric-sql/pglite";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rebaseImports } from "../../scripts/source-mutation.mjs";
import { compactDatabase } from "../../src/db/compact.js";
import { compactImportGuard, COMPACT_LOCK } from "../../src/db/compact-lock.js";
import { stagingTables } from "../../src/db/table-classes.js";
import { createDatabase } from "../../src/db/database.js";
import type { Database } from "../../src/db/database.js";
import { coreMigrations, testDatabase } from "../pglite.js";
import { migrate } from "../../src/db/migrate.js";
import { createApp } from "../../src/api/app.js";
import {
  createRun,
  stagePage,
  publishStatewide,
} from "../../src/ingest/geocode/statewide.js";
import { loadConfig } from "../../src/config/index.js";
import { runWorker } from "../../src/worker/commands.js";

async function fixture(db: Database) {
  const core = await coreMigrations();
  try {
    await migrate(db, core.directory);
  } finally {
    await core.cleanup();
  }
  // Synthetic source, identities, coordinates and geocode observations only.
  await db.exec(`INSERT INTO source(source_id,publisher,source_kind) VALUES('synthetic-compact','Synthetic fixture','test');
    INSERT INTO snapshot(snapshot_id,source_id) VALUES('synthetic-compact','synthetic-compact');
    INSERT INTO npi_provider(npi,in_scope,state_filter,data_date,snapshot_id,entity_type,organization_name)
      VALUES('1000000000',true,'TX','2026-11-19','synthetic-compact','2','Synthetic clinic');
    INSERT INTO npi_address(npi,kind,ordinal,line_1,city,state,zip5,snapshot_id)
      VALUES('1000000000','practice',0,'100 Synthetic St','HOUSTON','TX','77030','synthetic-compact');`);
  await createRun(db, "synthetic-completed");
  while (await stagePage(db, "synthetic-completed", "npi_address")) {
    /* finish staging */
  }
  while (await stagePage(db, "synthetic-completed", "qhp_provider_address")) {
    /* finish staging */
  }
  await db.exec(`INSERT INTO geocode_tx_county(county_fips,name,south,north,west,east,rings,snapshot_id)
    VALUES('48201','Synthetic county',29,31,-96,-94,'[]','synthetic-compact');
    INSERT INTO geocode_tx_result(address_hash,normalized_address,match_status,match_quality,method,
      latitude,longitude,county_basis,county_fips,snapshot_id,geocoded_at)
    SELECT address_hash,'synthetic address','Match','Exact','census_geocoder',29.7,-95.3,'point_in_county','48201','synthetic-compact','2026-11-19'
    FROM geocode_tx_address;
    INSERT INTO geocode_tx_batch(run_id,batch_id,address_hashes,request_csv,completed,completed_at)
    SELECT 'synthetic-completed','synthetic-batch',array_agg(address_hash),(SELECT string_agg(md5(g::text),'') FROM generate_series(1,20000) g),true,now()
    FROM geocode_tx_address;`);
  await publishStatewide(db, "synthetic-completed");
}

async function served(db: Database) {
  const config = loadConfig({ OPENPLANS_API_CACHE: "off" });
  const app = createApp(db, {}, { config });
  const result: string[] = [];
  for (const path of [
    "/v1/providers/1000000000?year=2026",
    "/v1/providers?state=TX&year=2026&name=Synthetic",
  ]) {
    const response = await app.request(path);
    expect(response.status).toBe(200);
    result.push(await response.text());
  }
  expect(result.join("")).toContain("1000000000");
  return result;
}

async function checks(db: Database) {
  await fixture(db);
  await db.exec("CREATE TABLE synthetic_unclassified (id integer)");
  try {
    await expect(compactDatabase(db)).rejects.toThrow(
      "unclassified database table",
    );
  } finally {
    await db.exec("DROP TABLE synthetic_unclassified");
  }
  const commandOutput: string[] = [];
  expect(
    await runWorker(
      ["compact", "--dry-run"],
      () => ({ ...db, close: async () => {} }),
      {
        out: (line) => commandOutput.push(line),
        error: (line) => {
          throw new Error(line);
        },
      },
    ),
  ).toBe(0);
  expect(commandOutput).toHaveLength(1);
  expect(JSON.parse(commandOutput[0]!)).toMatchObject({ dryRun: true });
  const before = await served(db);
  let evidence = await db.query(
    "SELECT * FROM geocode_match_archive ORDER BY address_hash",
  );
  const points = await db.query(
    "SELECT * FROM address_point ORDER BY address_hash",
  );
  const plan = await compactDatabase(db, true);
  expect(plan.dryRun).toBe(true);
  expect(plan.before).toEqual(plan.after);
  expect(plan.truncated.sort()).toEqual([...stagingTables].sort());
  expect(
    (await db.query("SELECT count(*)::int AS n FROM geocode_tx_input")).rows[0]
      ?.n,
  ).toBe(1);

  // Unfinished staging and a pending batch each refuse before changing anything.
  for (const [plant, repair] of [
    [
      "UPDATE geocode_tx_run SET npi_staged=false",
      "UPDATE geocode_tx_run SET npi_staged=true",
    ],
    [
      "UPDATE geocode_tx_batch SET completed=false,completed_at=NULL",
      "UPDATE geocode_tx_batch SET completed=true,completed_at=now()",
    ],
    [
      "UPDATE snapshot SET validation_state='FETCHING'",
      "UPDATE snapshot SET validation_state='DISCOVERED'",
    ],
    [
      "UPDATE geocode_match_archive SET geocoded_at='2020-01-01'",
      "UPDATE geocode_match_archive SET geocoded_at=now()",
    ],
  ] as const) {
    await db.exec(plant);
    await expect(compactDatabase(db)).rejects.toThrow(
      "unfinished import or unpublished geocode run",
    );
    expect(
      (await db.query("SELECT count(*)::int AS n FROM geocode_tx_input"))
        .rows[0]?.n,
    ).toBe(1);
    await db.exec(repair);
  }
  // Restore timestamps to prove the successful compact preserves evidence exactly.
  await db.query("UPDATE geocode_match_archive SET geocoded_at=$1", [
    evidence.rows[0]!.geocoded_at,
  ]);
  evidence = await db.query(
    "SELECT * FROM geocode_match_archive ORDER BY address_hash",
  );
  const generation = await db.query(
    "SELECT * FROM api_data_generation WHERE NOT (table_name=ANY($1::text[])) ORDER BY table_name",
    [stagingTables],
  );
  const report = await compactDatabase(db);
  expect(report.dryRun).toBe(false);
  expect(report.reclaimedRelationBytes).toBeGreaterThan(0);
  expect(await served(db)).toEqual(before);
  expect(
    createHash("sha256")
      .update((await served(db)).join(""))
      .digest("hex"),
  ).toBe(createHash("sha256").update(before.join("")).digest("hex"));
  expect(
    (
      await db.query(
        "SELECT * FROM geocode_match_archive ORDER BY address_hash",
      )
    ).rows,
  ).toEqual(evidence.rows);
  expect(
    (await db.query("SELECT * FROM address_point ORDER BY address_hash")).rows,
  ).toEqual(points.rows);
  expect(
    (
      await db.query(
        "SELECT * FROM api_data_generation WHERE NOT (table_name=ANY($1::text[])) ORDER BY table_name",
        [stagingTables],
      )
    ).rows,
  ).toEqual(generation.rows);
  for (const name of stagingTables)
    expect(
      (await db.query(`SELECT count(*)::int AS n FROM "${name}"`)).rows[0]?.n,
    ).toBe(0);
  expect(
    (await db.query("SELECT count(*)::int AS n FROM geocode_tx_run")).rows[0]
      ?.n,
  ).toBe(1);
  await expect(compactDatabase(db)).resolves.toMatchObject({ dryRun: false });
  // The schema remains usable by the next build, using a fresh run identity.
  await createRun(db, "synthetic-next-build");
  expect(await stagePage(db, "synthetic-next-build", "npi_address")).toBe(1);
}

describe("worker compact", () => {
  it("rejects invalid arguments without opening the database", async () => {
    const errors: string[] = [];
    expect(
      await runWorker(
        ["compact", "--table", "plan"],
        () => {
          throw new Error("must not open");
        },
        { out: () => {}, error: (s) => errors.push(s) },
      ),
    ).toBe(1);
    expect(errors).toEqual(["Usage: worker compact [--dry-run]"]);
  });
  it("reclaims only completed staging and preserves served bytes in the offline fixture", async () => {
    const db = testDatabase(new PGlite());
    try {
      await checks(db);
    } finally {
      await db.close();
    }
  });
});

const serverUrl = process.env.P3I_POSTGIS_URL;
describe.skipIf(!serverUrl)("compact controls on disposable PostGIS", () => {
  let db: Database;
  let other: pg.Client;
  let name: string;
  beforeAll(async () => {
    name = `compact_${randomUUID().replaceAll("-", "")}`;
    const admin = new pg.Client({ connectionString: serverUrl });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${name}`);
    } finally {
      await admin.end();
    }
    const url = new URL(serverUrl!);
    url.pathname = `/${name}`;
    db = createDatabase(url.href);
    other = new pg.Client({ connectionString: url.href });
    await other.connect();
  });
  afterAll(async () => {
    await other?.end();
    await db?.close();
    const admin = new pg.Client({ connectionString: serverUrl });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  });
  it("reclaims staging, retains served tables, and preserves byte-identical HTTP answers", async () => {
    await checks(db);
  });
  it("refuses active import and geocoder sessions, then releases all locks on failure", async () => {
    for (const sql of [
      `pg_advisory_lock_shared(${COMPACT_LOCK})`,
      "pg_advisory_lock(1869636988)",
    ]) {
      await other.query(`SELECT ${sql}`);
      try {
        await expect(compactDatabase(db)).rejects.toThrow("worker is running");
      } finally {
        await other.query("SELECT pg_advisory_unlock_all()");
      }
    }
    await other.query("BEGIN");
    await other.query("LOCK TABLE npi_provider IN ROW EXCLUSIVE MODE");
    try {
      await expect(compactDatabase(db)).rejects.toMatchObject({
        code: "55P03",
      });
    } finally {
      await other.query("ROLLBACK");
    }
    const locks = await other.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database())",
    );
    expect(locks.rows[0]?.n).toBe(0);
  });
  it("an import holds its shared lock until close and refuses compact in the opposite direction", async () => {
    const url = new URL(serverUrl!);
    url.pathname = `/${name}`;
    const guarded = compactImportGuard(createDatabase(url.href));
    try {
      await guarded.query("SELECT 1");
      await expect(compactDatabase(db)).rejects.toThrow("worker is running");
    } finally {
      await guarded.close();
    }
    await other.query(`SELECT pg_advisory_lock(${COMPACT_LOCK})`);
    const refused = compactImportGuard(createDatabase(url.href));
    try {
      await expect(refused.query("SELECT 1")).rejects.toThrow(
        "worker compact is running",
      );
    } finally {
      await refused.close();
      await other.query("SELECT pg_advisory_unlock_all()");
    }
  });
  it("negative control: a mutant adds a served registry table to the truncate list and is refused", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "openplans-compact-mutant-"),
    );
    try {
      const sourceUrl = new URL("../../src/db/compact.ts", import.meta.url);
      let source = await readFile(sourceUrl, "utf8");
      source = source.replace(
        "assertStagingTables(targets);",
        'stagingTables.push("npi_provider");\n        try {\n          targets.push("npi_provider");\n          assertStagingTables(targets);\n        } finally {\n          stagingTables.pop();\n        }',
      );
      source = rebaseImports(source, sourceUrl);
      const mutantPath = join(directory, "compact-mutant.ts");
      await writeFile(mutantPath, source);
      const mutant = (await import(mutantPath)) as {
        compactDatabase: typeof compactDatabase;
      };
      await db.exec(
        "UPDATE geocode_tx_run SET npi_staged=true,issuer_staged=true; DELETE FROM geocode_tx_address WHERE run_id='synthetic-next-build'; DELETE FROM geocode_tx_input WHERE run_id='synthetic-next-build';",
      );
      await expect(mutant.compactDatabase(db)).rejects.toThrow(
        "not a classified staging table",
      );
      expect(
        (await db.query("SELECT count(*)::int AS n FROM npi_provider")).rows[0]
          ?.n,
      ).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("uses FULL for retained relations with dead tuples and keeps their answers", async () => {
    await db.withSession!(async (session) => {
      await session.exec(
        "UPDATE npi_provider SET organization_name=organization_name",
      );
      await session.query("SELECT pg_stat_force_next_flush()");
    });
    const before = await served(db);
    const report = await compactDatabase(db);
    expect(report.vacuum).toContainEqual({ name: "npi_provider", full: true });
    expect(await served(db)).toEqual(before);
  });
  it("serves the same API bytes when staging tables are absent", async () => {
    const before = await served(db);
    await db.exec(
      `DROP TABLE ${stagingTables.map((n) => `public."${n}"`).join(",")} RESTRICT`,
    );
    expect(await served(db)).toEqual(before);
  });
});
