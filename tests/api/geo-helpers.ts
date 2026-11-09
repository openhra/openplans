import { PGlite } from "@electric-sql/pglite";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../../src/db/migrate.js";
import { saveSnapshot, snapshotId } from "../../src/ingest/geo/repository.js";
import type { GeoFile } from "../../src/ingest/geo/sources.js";
import { coreMigrations, testDatabase } from "../pglite.js";

// Synthetic import pointers model a state-scoped SQL seed beside an unmodified real Census cut.
export async function geoSetup() {
  const db = testDatabase(new PGlite()),
    core = await coreMigrations();
  const directory = await mkdtemp(join(tmpdir(), "openplans-geo-rejection-"));
  const bytes = await readFile(
    new URL("./geo-relationships.psv", import.meta.url),
  );
  const provenance = JSON.parse(
    await readFile(new URL("./geo-provenance.json", import.meta.url), "utf8"),
  );
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== provenance.cut_sha256)
    throw new Error("Census cut hash mismatch");
  const path = join(directory, "relationship.psv");
  await writeFile(path, bytes);
  const file: GeoFile = {
    path,
    metadata: {
      snapshot_id: sha256,
      source: provenance.source,
      url: provenance.url,
      final_url: provenance.url,
      redirect_chain: [],
      status: 200,
      content_type: "text/plain",
      etag: null,
      last_modified: null,
      sha256,
      bytes: bytes.length,
      fetched_at: "2026-11-07T07:32:05.594Z",
    },
  };
  await migrate(db, core.directory);
  await saveSnapshot(db, "relationship", file);
  const snapshot = snapshotId(file);
  await db.query(
    "UPDATE snapshot SET validation_state='ACTIVE',activated_at=now() WHERE snapshot_id=$1",
    [snapshot],
  );
  await db.query(
    `INSERT INTO geo_import(state,plan_year,relationship_snapshot_id,centroid_snapshot_id,rating_snapshot_id)
    VALUES('TX',2026,$1,$1,$1)`,
    [snapshot],
  );
  // Model the partial postal locality list that omitted Lake County in the original request seed.
  await db.query(
    "INSERT INTO geonames_import(singleton,snapshot_id) VALUES(true,$1)",
    [snapshot],
  );
  await db.query(
    `INSERT INTO zip_county_fallback(source,zip,county_fips,county_name,state,snapshot_id,source_row)
    VALUES('geonames','34787','12095','Orange','FL',$1,1)`,
    [snapshot],
  );
  return {
    db,
    path,
    bytes,
    snapshot,
    close: async () => {
      await db.close();
      await core.cleanup();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
