import { describe, it, expect } from "vitest";
import { ingestGeocode } from "../../../src/ingest/geocode/index.js";
import { parseBatch } from "../../../src/ingest/geocode/parse.js";
import { addressIdentity } from "../../../src/ingest/geocode/address.js";
import { setup, raw } from "./helpers.js";
import { runWorker } from "../../../src/worker/commands.js";
describe("Census batch ingest", () => {
  it("records real matches, tie and unmatched, with honest fallback/no-point and incremental reuse", async () => {
    const h = await setup();
    let calls = 0;
    try {
      const acquire = async () => {
        calls++;
        return { file: await h.file(await raw()), requests: 1 };
      };
      const report = await ingestGeocode(h.db, { acquire });
      expect(report).toMatchObject({
        selected: 6,
        addressesSent: 6,
        exact: 3,
        nonExact: 0,
        tie: 1,
        unmatched: 2,
        centroidFallbacks: 1,
        noPoint: 2,
        issues: 0,
        requests: 1,
      });
      const points = (
        await h.db.query(
          "SELECT source_row,method,match_status,centroid_snapshot_id FROM address_point ORDER BY source_row",
        )
      ).rows;
      expect(points).toHaveLength(4);
      expect(points[3]).toMatchObject({
        source_row: "1000000005:practice:0",
        method: "zcta_centroid",
        match_status: "No_Match",
        centroid_snapshot_id: "centroid",
      });
      expect(
        (
          await h.db.query(
            "SELECT outcome FROM geocode_attempt WHERE source_row='1000000003:practice:0'",
          )
        ).rows,
      ).toEqual([{ outcome: "no_point" }]);
      expect(
        (
          await h.db.query(
            "SELECT outcome FROM geocode_attempt WHERE source_row='1000000004:practice:0'",
          )
        ).rows,
      ).toEqual([{ outcome: "no_point" }]);
      const again = await ingestGeocode(h.db, { acquire });
      expect(again).toMatchObject({ reused: 6, addressesSent: 0, requests: 0 });
      expect(calls).toBe(1);
      await h.db.query("UPDATE npi_address SET snapshot_id='new-input'");
      expect((await ingestGeocode(h.db, { acquire })).reused).toBe(6);
      expect(calls).toBe(1);
      expect(
        (
          await h.db.query(
            "SELECT DISTINCT source_snapshot_id FROM address_point",
          )
        ).rows,
      ).toEqual([{ source_snapshot_id: "new-input" }]);
      const a = h.addresses[0]!;
      expect(addressIdentity(a).hash).toBe(
        addressIdentity({ ...a, line_1: "  901   BAGBY ST  " }).hash,
      );
      expect(addressIdentity(a).hash).not.toBe(
        addressIdentity({ ...a, line_2: "Suite 2" }).hash,
      );
    } finally {
      await h.cleanup();
    }
  });
  it("negative control: malformed lines are issues and valid sibling rows still become points", async () => {
    const h = await setup();
    try {
      const text = (await raw()).replace(/^"2".*$/m, '"2","unterminated');
      const parsed = await parseBatch(text);
      expect(parsed.rows.size).toBe(5);
      expect(parsed.issues).toHaveLength(1);
      const report = await ingestGeocode(h.db, {
        acquire: async () => ({ file: await h.file(text), requests: 1 }),
      });
      expect(report).toMatchObject({
        exact: 2,
        issues: 2,
        noPoint: 3,
        centroidFallbacks: 1,
      });
      expect(
        (await h.db.query("SELECT count(*)::int AS n FROM address_point")).rows,
      ).toEqual([{ n: 3 }]);
      expect(
        (
          await h.db.query(
            "SELECT method FROM address_point WHERE source_row='1000000001:practice:0'",
          )
        ).rows,
      ).toEqual([]);
    } finally {
      await h.cleanup();
    }
  });
  it("negative controls: invalid coordinates and duplicate response IDs cannot be exact points", async () => {
    const text = await raw();
    expect(
      (
        await parseBatch(
          text.replace(
            "-95.369483289562,29.760724420884",
            "29.760724420884,-95.369483289562",
          ),
        )
      ).rows.has("1"),
    ).toBe(false);
    expect(
      (await parseBatch(text + "\n" + text.split("\n")[0])).rows.has("1"),
    ).toBe(false);
  });
  it("filters county/ZIP inputs and records changed source addresses as new work", async () => {
    const h = await setup();
    try {
      await h.db.query(
        `INSERT INTO zcta_county VALUES('77002','48201','Harris County',1,0,1,0,1,0,'relationship',2)`,
      );
      const first = (await raw()).split("\n")[0]! + "\n";
      const acquire = async () => ({ file: await h.file(first), requests: 1 });
      expect(
        await ingestGeocode(h.db, {
          county: "48201",
          zips: ["77002"],
          acquire,
        }),
      ).toMatchObject({ selected: 1, exact: 1 });
      await h.db.query(
        "UPDATE npi_address SET line_2='Synthetic Suite 1',snapshot_id='new-input' WHERE zip5='77002'",
      );
      expect(
        await ingestGeocode(h.db, { county: "48201", acquire }),
      ).toMatchObject({ selected: 1, reused: 0, addressesSent: 1 });
      expect(
        (await h.db.query("SELECT count(*)::int n FROM address_point")).rows,
      ).toEqual([{ n: 2 }]);
      // Historical evidence remains, but the domain query excludes its old input snapshot.
      await expect(
        h.db.query(`UPDATE address_point SET method=NULL`),
      ).rejects.toThrow();
      await expect(
        ingestGeocode(h.db, { batchSize: 10001, acquire }),
      ).rejects.toThrow();
    } finally {
      await h.cleanup();
    }
  });
  it("pages batches with sequential pacing and never retries an unmatched no-point on rerun", async () => {
    const h = await setup(),
      sleeps: number[] = [];
    try {
      const report = await ingestGeocode(h.db, {
        batchSize: 2,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        acquire: async () => ({
          file: await h.file(
            '"1","synthetic unmatched","No_Match"\n"2","synthetic unmatched","No_Match"\n',
          ),
          requests: 1,
        }),
      });
      expect(report).toMatchObject({
        batches: 3,
        addressesSent: 6,
        requests: 3,
        unmatched: 6,
        centroidFallbacks: 3,
        noPoint: 3,
      });
      expect(sleeps).toEqual([1000, 1000]);
    } finally {
      await h.cleanup();
    }
  });
  it("rejects CLI mistakes before connecting and exposes no driver details", async () => {
    const errors: string[] = [];
    const output = { out: () => {}, error: (s: string) => errors.push(s) };
    expect(
      await runWorker(
        ["ingest", "geocode", "--county", "99999"],
        () => {
          throw new Error("secret");
        },
        output,
      ),
    ).toBe(1);
    expect(errors[0]).toContain("Usage: worker ingest geocode");
    errors.length = 0;
    expect(
      await runWorker(
        ["ingest", "geocode", "--county", "48201"],
        () => {
          throw new Error("secret");
        },
        output,
      ),
    ).toBe(1);
    expect(errors.join()).not.toContain("secret");
  });
});
