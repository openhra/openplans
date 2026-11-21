import { PGlite } from "@electric-sql/pglite";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Database, SqlSession } from "../../src/db/database.js";
import { copyMigrations } from "../../src/db/copy-migrations.js";
import { loadMigrations, migrate } from "../../src/db/migrate.js";
import { classifyMigration } from "../../src/db/migrate-safety.js";
import {
  assertNoBuildEvidence,
  excludeBuildEvidence,
} from "../../src/db/build-evidence.js";
import * as archive from "../../src/db/geocode-archive.js";
import { ingestGeocode } from "../../src/ingest/geocode/index.js";
import { setup, raw } from "../ingest/geocode/helpers.js";
import { plantMutantFile } from "../mutant-file.js";
import { testDatabase } from "../pglite.js";
import { rebaseImports } from "../../scripts/source-mutation.mjs";

const migrationName = "20261120123130_geocode_match_archive.sql";
const ATTEMPTS = 40;

// What every serving version reads from these tables: unresolved attempts and points.
const servedReads = async (db: SqlSession) => ({
  unresolved: (
    await db.query(
      "SELECT * FROM geocode_attempt WHERE match_status<>'Match' ORDER BY address_hash,source_table,source_row",
    )
  ).rows,
  overlay: (
    await db.query(
      `SELECT split_part(a.source_row,':',1) AS npi FROM geocode_attempt a
      WHERE a.match_status IN ('Tie','No_Match') AND a.source_table='npi_address' ORDER BY 1`,
    )
  ).rows,
  points: (
    await db.query(
      "SELECT * FROM address_point ORDER BY address_hash,source_table,source_row",
    )
  ).rows,
});

const readerConflicts = async (db: SqlSession) =>
  (
    await db.query<{ relname: string }>(
      `SELECT c.relname FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
      WHERE l.pid=pg_backend_pid() AND l.locktype='relation' AND l.granted
        AND l.mode='AccessExclusiveLock' AND c.relname IN ('geocode_attempt','address_point')`,
    )
  ).rows.map((row) => row.relname);

const revision = async (db: SqlSession) =>
  Number(
    (
      await db.query<{ revision: string }>(
        "SELECT revision::text FROM api_data_generation WHERE table_name='geocode_attempt'",
      )
    ).rows[0]!.revision,
  );

/** A database at v0.4.17's schema with synthetic attempts (most of them matched) and points. */
async function populated() {
  const directory = await mkdtemp(
    join(tmpdir(), "openplans-attempt-migration-"),
  );
  const db = testDatabase(new PGlite());
  await copyMigrations(directory, [
    migrationName,
    ...(process.env.OPENPLANS_TEST_DB === "postgres"
      ? []
      : ["002_postgis.sql"]),
  ]);
  await migrate(db, directory);
  await db.exec(`INSERT INTO source(source_id,publisher,source_kind) VALUES('synthetic-archive','Synthetic fixture','test');
    INSERT INTO snapshot(snapshot_id,source_id) VALUES('synthetic-archive','synthetic-archive');
    INSERT INTO geocode_attempt(address_hash,source_table,source_row,normalized_address,source_snapshot_id,
      snapshot_id,match_status,match_quality,outcome,geocoded_at)
    SELECT lpad(to_hex(i),64,'0'),'npi_address',i::text||':practice:1','Synthetic address','synthetic-archive','synthetic-archive',
      CASE i%10 WHEN 0 THEN 'Tie' WHEN 1 THEN 'No_Match' WHEN 2 THEN 'rejected_out_of_bounds' ELSE 'Match' END,
      CASE WHEN i%10>2 THEN 'Exact' END,CASE WHEN i%10>2 THEN 'point' ELSE 'no_point' END,'2026-11-19'
    FROM generate_series(1,${ATTEMPTS}) i;
    INSERT INTO address_point(address_hash,source_table,source_row,source_snapshot_id,latitude,longitude,
      method,match_status,match_quality,snapshot_id)
    SELECT address_hash,source_table,source_row,'synthetic-archive',29.7,-95.3,'census_geocoder','Match','Exact','synthetic-archive'
    FROM geocode_attempt WHERE match_status='Match';`);
  // Metadata the move must keep byte for byte, not restamp.
  await db.exec(`ALTER TABLE geocode_attempt DISABLE TRIGGER row_provenance;
    ALTER TABLE geocode_attempt DISABLE TRIGGER zz_record_policy;
    UPDATE geocode_attempt SET sourced_by='unknown',sourced_at=NULL,sourced_slug='unknown',record_policy='unknown'
    WHERE match_status='Match';
    ALTER TABLE geocode_attempt ENABLE TRIGGER row_provenance;
    ALTER TABLE geocode_attempt ENABLE TRIGGER zz_record_policy;`);
  const before = (
    await db.query(
      "SELECT * FROM geocode_attempt ORDER BY address_hash,source_table,source_row",
    )
  ).rows as { match_status: string }[];
  const migration = (await loadMigrations()).find(
    (m) => m.name === migrationName,
  )!;
  return {
    db,
    before,
    matched: before.filter((row) => row.match_status === "Match"),
    migration,
    cleanup: async () => {
      await db.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** The migration's own transaction may lock briefly but must not touch a row. */
async function applyCatalogOnly(db: Database, sql: string) {
  const reads = await servedReads(db);
  const attempts = await db.query(
    "SELECT * FROM geocode_attempt ORDER BY 1,2,3",
  );
  await db.transaction((tx) => tx.exec(sql));
  expect(await servedReads(db)).toEqual(reads);
  expect(
    (await db.query("SELECT * FROM geocode_attempt ORDER BY 1,2,3")).rows,
  ).toEqual(attempts.rows);
  expect(
    (await db.query("SELECT count(*)::int n FROM geocode_match_archive"))
      .rows[0],
  ).toEqual({ n: 0 });
  expect(
    (
      await db.query(
        `SELECT conname,convalidated FROM pg_constraint
        WHERE conname IN ('geocode_attempt_unresolved','address_point_source_identity') ORDER BY 1`,
      )
    ).rows,
  ).toEqual([
    { conname: "address_point_source_identity", convalidated: false },
    { conname: "geocode_attempt_unresolved", convalidated: false },
  ]);
}

describe("matched geocode archive", () => {
  it("migrates the catalog only; a single long move transaction is refused", async () => {
    const f = await populated();
    try {
      expect(classifyMigration(f.migration.sql).classification).toBe("risky");
      // Mutant: the bulk move back inside the migration transaction.
      const longTransaction = `${f.migration.sql}
ALTER TABLE geocode_match_archive DISABLE TRIGGER row_provenance;
ALTER TABLE geocode_match_archive DISABLE TRIGGER zz_record_policy;
INSERT INTO geocode_match_archive SELECT * FROM geocode_attempt WHERE match_status='Match';
ALTER TABLE geocode_match_archive ENABLE TRIGGER row_provenance;
ALTER TABLE geocode_match_archive ENABLE TRIGGER zz_record_policy;
DELETE FROM geocode_attempt WHERE match_status='Match';
ALTER TABLE geocode_attempt VALIDATE CONSTRAINT geocode_attempt_unresolved;`;
      await expect(applyCatalogOnly(f.db, longTransaction)).rejects.toThrow();
    } finally {
      await f.cleanup();
    }
    const g = await populated();
    try {
      await applyCatalogOnly(g.db, g.migration.sql);
      expect(await archive.geocodeArchiveReady(g.db)).toBe(false);
      await expect(archive.refuseGeocodeArchivePending(g.db)).rejects.toThrow(
        archive.ARCHIVE_PENDING,
      );
      // New writes are bound at once: no matched attempt, no malformed point.
      await expect(
        g.db.exec(
          "UPDATE geocode_attempt SET match_status='Match' WHERE match_status='Tie'",
        ),
      ).rejects.toThrow();
      await expect(
        g.db.exec("UPDATE address_point SET source_table='invalid'"),
      ).rejects.toThrow();
    } finally {
      await g.cleanup();
    }
  });

  it("backfills in small transactions without reader-blocking locks; old reads hold between steps; a blocking mutant fails", async () => {
    const f = await populated();
    try {
      const reads = await servedReads(f.db);
      await f.db.transaction((tx) => tx.exec(f.migration.sql));
      expect(await servedReads(f.db)).toEqual(reads);
      const startRevision = await revision(f.db);
      const conflicts: string[] = [];
      const midReads: unknown[] = [];
      const result = await archive.backfillGeocodeArchive(f.db, {
        batchRows: 7,
        pauseMs: 0,
        beforeCommit: async (session) => {
          conflicts.push(...(await readerConflicts(session)));
        },
        onBatch: async () => {
          midReads.push(await servedReads(f.db));
        },
      });
      expect(conflicts).toEqual([]);
      expect(result).toMatchObject({
        moved: f.matched.length,
        batches: Math.ceil(f.matched.length / 7),
        validated: [
          "geocode_attempt_unresolved",
          "address_point_source_identity",
        ],
      });
      expect(midReads.length).toBe(result.batches);
      for (const read of midReads) expect(read).toEqual(reads);
      expect(await servedReads(f.db)).toEqual(reads);
      // Row metadata moves byte for byte; one generation bump for the whole move.
      expect(
        (await f.db.query("SELECT * FROM geocode_match_archive ORDER BY 1,2,3"))
          .rows,
      ).toEqual(f.matched);
      expect(await revision(f.db)).toBe(startRevision + 1);
      expect(await archive.geocodeArchiveReady(f.db)).toBe(true);
      await expect(
        f.db.exec("UPDATE geocode_attempt SET match_status='Match'"),
      ).rejects.toThrow();
      await expect(
        f.db.exec("UPDATE geocode_match_archive SET match_status='Tie'"),
      ).rejects.toThrow();
      await expect(
        f.db.exec("UPDATE address_point SET address_hash='invalid'"),
      ).rejects.toThrow();
      await expect(
        f.db.exec("UPDATE address_point SET snapshot_id='missing'"),
      ).rejects.toThrow();
    } finally {
      await f.cleanup();
    }
    // Mutant: a step that holds ACCESS EXCLUSIVE, so the old API's reads would wait on it.
    const url = new URL("../../src/db/geocode-archive.ts", import.meta.url);
    const source = await readFile(url, "utf8");
    const needle =
      "await session.exec(`ALTER TABLE ${table} VALIDATE CONSTRAINT ${name}`);";
    expect(source).toContain(needle);
    const planted = await plantMutantFile(
      url,
      source.replace(
        needle,
        "await session.exec(`ALTER TABLE ${table} VALIDATE CONSTRAINT ${name}; LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);",
      ),
    );
    const g = await populated();
    try {
      const mutant = (await import(planted.path)) as typeof archive;
      await g.db.transaction((tx) => tx.exec(g.migration.sql));
      const conflicts: string[] = [];
      await mutant.backfillGeocodeArchive(g.db, {
        pauseMs: 0,
        beforeCommit: async (session) => {
          conflicts.push(...(await readerConflicts(session)));
        },
      });
      expect(conflicts).not.toEqual([]);
    } finally {
      await g.cleanup();
      await planted.cleanup();
    }
  });

  it("resumes after an interrupted run, keeps archive rows already there, reruns as a no-op; a non-idempotent mutant fails", async () => {
    const f = await populated();
    const url = new URL("../../src/db/geocode-archive.ts", import.meta.url);
    const source = await readFile(url, "utf8");
    const needle =
      "INSERT INTO geocode_match_archive SELECT * FROM moved ON CONFLICT DO NOTHING RETURNING 1";
    expect(source).toContain(needle);
    const planted = await plantMutantFile(
      url,
      source.replace(
        needle,
        "INSERT INTO geocode_match_archive SELECT * FROM moved RETURNING 1",
      ),
    );
    try {
      await f.db.transaction((tx) => tx.exec(f.migration.sql));
      // A refresh on the new image archived one matched address before the backfill.
      const first = f.matched[0] as unknown as { address_hash: string };
      await f.db
        .exec(`INSERT INTO geocode_match_archive SELECT * FROM geocode_attempt
        WHERE address_hash='${first.address_hash}'`);
      const kept = (await f.db.query(`SELECT * FROM geocode_match_archive`))
        .rows[0];
      const mutant = (await import(planted.path)) as typeof archive;
      await expect(
        mutant.backfillGeocodeArchive(f.db, { batchRows: 5, pauseMs: 0 }),
      ).rejects.toThrow();
      // Interrupted after two committed batches.
      let calls = 0;
      await expect(
        archive.backfillGeocodeArchive(f.db, {
          batchRows: 5,
          pauseMs: 0,
          onBatch: () => {
            if (++calls === 2) throw new Error("interrupted");
          },
        }),
      ).rejects.toThrow("interrupted");
      expect(
        (
          await f.db.query(
            "SELECT count(*)::int n FROM geocode_attempt WHERE match_status='Match'",
          )
        ).rows[0],
      ).toEqual({ n: f.matched.length - 10 });
      expect(await archive.geocodeArchiveReady(f.db)).toBe(false);
      const resumed = await archive.backfillGeocodeArchive(f.db, {
        batchRows: 5,
        pauseMs: 0,
      });
      expect(resumed.moved).toBe(f.matched.length - 10);
      const archived = (
        await f.db.query("SELECT * FROM geocode_match_archive ORDER BY 1,2,3")
      ).rows;
      expect(archived).toHaveLength(f.matched.length);
      expect(archived).toContainEqual(kept);
      expect(
        (
          await f.db.query(
            "SELECT count(*)::int n FROM geocode_attempt WHERE match_status='Match'",
          )
        ).rows[0],
      ).toEqual({ n: 0 });
      const settled = await revision(f.db);
      expect(
        await archive.backfillGeocodeArchive(f.db, { pauseMs: 0 }),
      ).toMatchObject({ moved: 0, batches: 0, validated: [] });
      expect(await revision(f.db)).toBe(settled);
    } finally {
      await f.cleanup();
      await planted.cleanup();
    }
  });

  it("validates at migration time on an empty install and excludes the archive from artifacts", async () => {
    const db = testDatabase(new PGlite());
    const directory = await mkdtemp(join(tmpdir(), "openplans-attempt-empty-"));
    try {
      await copyMigrations(
        directory,
        process.env.OPENPLANS_TEST_DB === "postgres" ? [] : ["002_postgis.sql"],
      );
      await migrate(db, directory);
      expect(await archive.geocodeArchiveReady(db)).toBe(true);
      const start = await revision(db);
      expect(
        await archive.backfillGeocodeArchive(db, { pauseMs: 0 }),
      ).toMatchObject({
        moved: 0,
        validated: [],
      });
      expect(await revision(db)).toBe(start);
      await expect(assertNoBuildEvidence(db)).rejects.toThrow(
        "build-only table remains",
      );
      expect(await excludeBuildEvidence(db)).toEqual(["geocode_match_archive"]);
      await assertNoBuildEvidence(db);
      expect(
        (
          await db.query(
            "SELECT 1 FROM row_provenance_rule WHERE table_name='geocode_match_archive'",
          )
        ).rows,
      ).toEqual([]);
      // Validation survives the exclusion, and the next build recreates the archive.
      expect(await archive.geocodeArchiveReady(db)).toBe(true);
      await db.query("SELECT prepare_geocode_match_archive()");
      await expect(assertNoBuildEvidence(db)).rejects.toThrow(
        "build-only table remains",
      );
    } finally {
      await db.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refreshes without requests through the archive and after artifact exclusion; kills a refresh that re-geocodes known addresses", async () => {
    const h = await setup();
    const directory = await mkdtemp(
      join(tmpdir(), "openplans-attempt-refresh-"),
    );
    try {
      await ingestGeocode(h.db, {
        acquire: async () => ({ file: await h.file(await raw()), requests: 1 }),
      });
      expect(
        (await h.db.query("SELECT count(*)::int n FROM geocode_match_archive"))
          .rows[0]!.n,
      ).toBe(3);
      expect(
        (await h.db.query("SELECT count(*)::int n FROM geocode_attempt"))
          .rows[0]!.n,
      ).toBe(3);
      const refresh = async (run: typeof ingestGeocode) => {
        const result = await run(h.db, {
          acquire: async () => {
            throw new Error("known address re-geocoded");
          },
        });
        expect(result).toMatchObject({
          reused: 6,
          addressesSent: 0,
          requests: 0,
        });
      };
      await h.db.exec("UPDATE npi_address SET snapshot_id='new-input'");
      await refresh(ingestGeocode);
      await excludeBuildEvidence(h.db);
      await refresh(ingestGeocode);
      const url = new URL("../../src/ingest/geocode/index.ts", import.meta.url);
      const source = await readFile(url, "utf8");
      const needle = "if (await reused(db, address))";
      expect(source).toContain(needle);
      const mutant = rebaseImports(source.replace(needle, "if (false)"), url);
      const path = join(directory, "refresh-mutant.ts");
      await writeFile(path, mutant);
      const module = (await import(path)) as {
        ingestGeocode: typeof ingestGeocode;
      };
      await expect(refresh(module.ingestGeocode)).rejects.toThrow(
        "known address re-geocoded",
      );
    } finally {
      await h.cleanup();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
