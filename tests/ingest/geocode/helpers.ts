import { PGlite } from "@electric-sql/pglite";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { coreMigrations, testDatabase } from "../../pglite.js";
import type { Database } from "../../../src/db/database.js";
import { migrate, migrationsDirectory } from "../../../src/db/migrate.js";
import type { Address } from "../../../src/ingest/geocode/address.js";
import type { BatchFile } from "../../../src/ingest/geocode/census.js";
export const raw = () =>
  readFile(
    new URL("../../fixtures/geocode/census.csv", import.meta.url),
    "utf8",
  );
export async function setup(database?: Database) {
  const db = database ?? testDatabase(new PGlite()),
    core = database
      ? { directory: migrationsDirectory, cleanup: async () => {} }
      : await coreMigrations();
  await migrate(db, core.directory);
  await db.query(
    `INSERT INTO source(source_id,publisher,source_kind) VALUES('synthetic-test','Synthetic fixture harness','test')`,
  );
  for (const id of ["input", "centroid", "relationship", "rating", "new-input"])
    await db.query(
      `INSERT INTO snapshot(snapshot_id,source_id) VALUES($1,'synthetic-test')`,
      [id],
    );
  await db.query(`INSERT INTO geo_import(state,plan_year,relationship_snapshot_id,centroid_snapshot_id,rating_snapshot_id)
    VALUES('TX',2026,'relationship','centroid','rating')`);
  // Published Gazetteer rows, cut and hash-attributed by the network-only regenerator.
  const { points } = JSON.parse(
    await readFile(
      new URL("../../fixtures/geocode/centroids.json", import.meta.url),
      "utf8",
    ),
  );
  for (const p of points)
    await db.query(`INSERT INTO zcta_centroid VALUES($1,$2,$3,'centroid',$4)`, [
      p.zcta,
      p.latitude,
      p.longitude,
      p.rowNumber,
    ]);
  const inputs = JSON.parse(
    await readFile(
      new URL("../../fixtures/geocode/inputs.json", import.meta.url),
      "utf8",
    ),
  ) as Address[];
  // Synthetic identifiers only; source address strings and Census replies above are recorded.
  const addresses = inputs.map((a, i) => ({
    ...a,
    npi: `100000000${i}`,
    ordinal: 0,
    snapshot_id: "input",
  }));
  for (const a of addresses) {
    await db.query(
      `INSERT INTO npi_provider(npi,in_scope,state_filter,data_date,snapshot_id) VALUES($1,true,'TX','2026-11-07','input')`,
      [a.npi],
    );
    await db.query(
      `INSERT INTO npi_address(npi,kind,ordinal,line_1,line_2,city,state,zip5,snapshot_id) VALUES($1,'practice',0,$2,$3,$4,$5,$6,'input')`,
      [a.npi, a.line_1, a.line_2, a.city, a.state, a.zip5],
    );
  }
  const temp = await mkdtemp(join(tmpdir(), "openplans-geocode-test-"));
  async function file(text: string): Promise<BatchFile> {
    const path = join(temp, createHash("sha256").update(text).digest("hex"));
    await writeFile(path, text);
    return {
      outcome: "downloaded",
      snapshotId: "recording",
      path,
      metadataPath: path + ".json",
      metadata: {
        snapshot_id: "recording",
        source: "census-geocoder-batch",
        url: "https://geocoding.geo.census.gov/geocoder/locations/addressbatch",
        final_url:
          "https://geocoding.geo.census.gov/geocoder/locations/addressbatch",
        redirect_chain: [],
        status: 200,
        content_type: "text/csv",
        etag: null,
        last_modified: null,
        sha256: createHash("sha256").update(text).digest("hex"),
        bytes: Buffer.byteLength(text),
        fetched_at: "2026-11-07T00:00:00Z",
      },
    };
  }
  return {
    db,
    addresses,
    file,
    cleanup: async () => {
      await db.close();
      await core.cleanup();
      await rm(temp, { recursive: true, force: true });
    },
  };
}
