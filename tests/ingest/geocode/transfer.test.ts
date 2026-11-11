import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup } from "./helpers.js";
import { stageStatewide } from "../../../src/ingest/geocode/statewide.js";
import {
  exportGeocodes,
  importGeocodes,
  inspectGeocodes,
  verifyTransferSnapshot,
} from "../../../src/ingest/geocode/transfer.js";

const skipRaw = async () => {};
async function harness() {
  const source = await setup(),
    target = await setup();
  const temp = await mkdtemp(join(tmpdir(), "openplans-transfer-"));
  // Synthetic county rectangles and observations only. No network calls or real NPIs.
  await source.db.query(`INSERT INTO snapshot(snapshot_id,source_id)
    VALUES('observation','synthetic-test'),('outlines','synthetic-test')`);
  await source.db
    .query(`INSERT INTO geocode_tx_county(county_fips,name,south,north,west,east,rings,snapshot_id)
    SELECT '48'||lpad(i::text,3,'0'),'Synthetic rectangle',25.5,36.5,-106.5,-93.5,'[]','outlines' FROM generate_series(1,254) i`);
  await stageStatewide(source.db, { runId: "source", state: "TX" });
  await source.db
    .query(`INSERT INTO geocode_tx_result(address_hash,normalized_address,match_status,match_quality,method,
    latitude,longitude,county_fips,county_basis,snapshot_id,centroid_snapshot_id,bounds_snapshot_id)
    SELECT a.address_hash,i.normalized_address,'Match','Exact','census_geocoder',30,-100,'48001','point_in_county','observation',NULL,'outlines'
    FROM geocode_tx_address a JOIN geocode_tx_input i USING(run_id,address_hash) WHERE a.run_id='source'`);
  const path = join(temp, "tx.jsonl");
  await exportGeocodes(source.db, "source", path);
  return {
    source,
    target,
    temp,
    path,
    cleanup: async () => {
      await source.cleanup();
      await target.cleanup();
      await rm(temp, { recursive: true, force: true });
    },
  };
}
async function rewrite(
  path: string,
  mutate: (rows: Record<string, unknown>[]) => void,
) {
  const rows = (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  rows.pop();
  mutate(rows);
  const body = rows.map((row) => JSON.stringify(row) + "\n").join("");
  await writeFile(
    path,
    body +
      JSON.stringify({
        end: true,
        count: rows.length - 1,
        sha256: createHash("sha256").update(body).digest("hex"),
      }) +
      "\n",
  );
}
describe("offline geocode transfer", () => {
  it("verifies cached bytes and refuses a corrupted or quarantined raw reply", async () => {
    const temp = await mkdtemp(join(tmpdir(), "openplans-transfer-raw-"));
    try {
      const body = "synthetic reply\n",
        sha256 = createHash("sha256").update(body).digest("hex");
      const source = "census-geocoder-batch",
        dir = join(temp, "raw", source);
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(dir, sha256), { recursive: true });
      const metadata = {
        source,
        snapshot_id: sha256,
        sha256,
        bytes: Buffer.byteLength(body),
        url: "https://geocoding.geo.census.gov/geocoder/locations/addressbatch",
      };
      await writeFile(
        join(dir, sha256 + ".meta.json"),
        JSON.stringify(metadata),
      );
      const path = join(dir, sha256, "payload");
      await writeFile(path, body);
      const snapshot = {
        validation_state: "ACTIVE",
        authorization_class: "public",
        source_id: source,
        sha256,
        requested_url: metadata.url,
        compressed_bytes: metadata.bytes,
      };
      await verifyTransferSnapshot(snapshot, temp);
      await writeFile(path, body + "corrupt");
      await expect(verifyTransferSnapshot(snapshot, temp)).rejects.toThrow(
        "hash mismatch",
      );
      await writeFile(path, body);
      await writeFile(
        join(dir, "QUARANTINE.json"),
        JSON.stringify({ snapshots: [sha256], reason: "synthetic quarantine" }),
      );
      await expect(verifyTransferSnapshot(snapshot, temp)).rejects.toThrow();
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
  it("publishes against current target snapshots, preserves evidence and is repeatable", async () => {
    const h = await harness();
    try {
      await h.target.db.exec("UPDATE npi_address SET snapshot_id='new-input'");
      const result = await importGeocodes(
        h.target.db,
        h.path,
        "target",
        h.temp,
        skipRaw,
      );
      expect(result.pending).toBe(0);
      expect(result.imported).toBeGreaterThan(0);
      const points = (await h.target.db.query("SELECT * FROM address_point"))
        .rows;
      expect(
        (
          await h.target.db.query(
            "SELECT raw_path FROM snapshot WHERE snapshot_id='observation'",
          )
        ).rows[0]?.raw_path,
      ).toBe(join(h.temp, "raw", "synthetic-test", "null", "payload"));
      expect(points).toHaveLength(result.addresses as number);
      expect(
        points.every(
          (r) =>
            r.source_snapshot_id === "new-input" &&
            r.snapshot_id === "observation" &&
            r.match_quality === "Exact",
        ),
      ).toBe(true);
      const times = points.map((r) => String(r.geocoded_at));
      await importGeocodes(h.target.db, h.path, "target", h.temp, skipRaw);
      expect(
        (await h.target.db.query("SELECT * FROM address_point")).rows.map((r) =>
          String(r.geocoded_at),
        ),
      ).toEqual(times);
      expect(
        (
          await h.target.db.query(
            "SELECT count(*)::int n FROM provider_active_set",
          )
        ).rows[0]?.n,
      ).toBe(0);
      await h.target.db.exec("UPDATE geocode_tx_result SET latitude=31");
      await expect(
        importGeocodes(h.target.db, h.path, "target", h.temp, skipRaw),
      ).rejects.toThrow("conflicting target observation");
      await h.target.db.exec(
        "UPDATE snapshot SET validation_state='QUARANTINED' WHERE snapshot_id='observation'",
      );
      await expect(
        importGeocodes(h.target.db, h.path, "target", h.temp, skipRaw),
      ).rejects.toThrow("conflicting target evidence");
    } finally {
      await h.cleanup();
    }
  });
  it("keeps labelled centroids and terminal no-point observations", async () => {
    const h = await harness();
    try {
      await rewrite(h.path, (rows) => {
        rows[1]!.method = "zcta_centroid";
        rows[1]!.match_status = "No_Match";
        rows[1]!.match_quality = null;
        rows[1]!.centroid_snapshot_id = "centroid";
        (rows[0]!.snapshots as Record<string, unknown>[]).push({
          ...(rows[0]!.snapshots as Record<string, unknown>[])[0],
          snapshot_id: "centroid",
        });
        rows[2]!.method = null;
        rows[2]!.latitude = null;
        rows[2]!.longitude = null;
        rows[2]!.county_fips = null;
        rows[2]!.match_status = "No_Match";
        rows[2]!.match_quality = null;
      });
      await importGeocodes(h.target.db, h.path, "target", h.temp, skipRaw);
      const centroid = (
        await h.target.db.query(
          "SELECT * FROM address_point WHERE method='zcta_centroid'",
        )
      ).rows[0];
      expect(centroid).toMatchObject({
        centroid_snapshot_id: "centroid",
        match_quality: null,
      });
      expect(
        (
          await h.target.db.query(
            "SELECT count(*)::int n FROM geocode_attempt WHERE outcome='no_point'",
          )
        ).rows[0]?.n,
      ).toBe(1);
    } finally {
      await h.cleanup();
    }
  });
  it("rejects truncation, changed bytes, wrong state, false centroid labels and missing evidence before writes", async () => {
    const h = await harness();
    try {
      const original = await readFile(h.path, "utf8");
      for (const mutate of [
        () =>
          writeFile(h.path, original.slice(0, original.lastIndexOf('{"end"'))),
        () => writeFile(h.path, original.replace("Exact", "Non_Exact")),
        () =>
          rewrite(h.path, (rows) => {
            rows[1]!.address_hash = "a".repeat(64);
          }),
        () =>
          rewrite(h.path, (rows) => {
            rows[0]!.state = "CA";
          }),
        () =>
          rewrite(h.path, (rows) => {
            rows[1]!.method = "zcta_centroid";
          }),
        () =>
          rewrite(h.path, (rows) => {
            rows[0]!.snapshots = [];
          }),
      ]) {
        await writeFile(h.path, original);
        await mutate();
        await expect(
          importGeocodes(h.target.db, h.path, "target", h.temp, skipRaw),
        ).rejects.toThrow();
        expect(
          (
            await h.target.db.query(
              "SELECT count(*)::int n FROM geocode_tx_run",
            )
          ).rows[0]?.n,
        ).toBe(0);
      }
      await expect(
        verifyTransferSnapshot({ validation_state: "QUARANTINED" }, h.temp),
      ).rejects.toThrow("inactive");
    } finally {
      await h.cleanup();
    }
  });
  it("rejects incomplete source queues and refuses to invent missing target results", async () => {
    const h = await harness();
    try {
      await h.source.db.exec(
        "DELETE FROM geocode_tx_result WHERE address_hash=(SELECT min(address_hash) FROM geocode_tx_result)",
      );
      await expect(
        exportGeocodes(h.source.db, "source", join(h.temp, "incomplete")),
      ).rejects.toThrow("incomplete");
      await h.target.db.exec(
        "UPDATE npi_address SET line_1='Synthetic changed address' WHERE npi=(SELECT min(npi) FROM npi_provider)",
      );
      await expect(
        importGeocodes(h.target.db, h.path, "target", h.temp, skipRaw),
      ).rejects.toThrow("absent from transfer");
      expect((await inspectGeocodes(h.path, skipRaw)).count).toBeGreaterThan(0);
    } finally {
      await h.cleanup();
    }
  });
});
