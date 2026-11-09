import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture, scope, setup } from "../qhp/provider-helpers.js";
import { importProviders } from "../../../src/ingest/qhp/provider.js";
import { pointsWithinRadius } from "../../../src/domain/geo/index.js";
import { ingestGeocode } from "../../../src/ingest/geocode/index.js";
import type { BatchFile } from "../../../src/ingest/geocode/census.js";

describe("issuer locations share normalized geocodes with NPPES", () => {
  it("reuses across publishers and snapshots, deduplicates a batch, and excludes historical changed-address points", async () => {
    const h = await setup();
    let calls = 0;
    try {
      const provider = structuredClone((await fixture("records"))[0]);
      provider.npi = "1000000000"; // Synthetic identity and duplicate locations; Census reply is a recorded public-address cut.
      provider.addresses = [
        { address: "901 BAGBY ST", city: "HOUSTON", state: "TX", zip: "77002" },
        {
          address: "  901   bagby st  ",
          city: "Houston",
          state: "TX",
          zip: "77002",
        },
      ];
      await h.replace([provider]);
      const first = await importProviders(h.db, scope);
      await h.db
        .query(`INSERT INTO npi_provider(npi,in_scope,state_filter,data_date,snapshot_id)
        VALUES ('1000000000',true,'TX','2026-11-07','catalog')`);
      await h.db
        .exec(`INSERT INTO npi_address(npi,kind,ordinal,line_1,city,state,zip5,snapshot_id)
        VALUES ('1000000000','practice',0,'901 BAGBY ST','HOUSTON','TX','77002','catalog')`);
      const text =
        (
          await readFile(
            new URL("../../fixtures/geocode/census.csv", import.meta.url),
            "utf8",
          )
        ).split("\n")[0]! + "\n";
      const path = join(h.directory, "census.csv");
      await writeFile(path, text);
      const sha = createHash("sha256").update(text).digest("hex");
      const file: BatchFile = {
        outcome: "downloaded",
        snapshotId: sha,
        path,
        metadataPath: path + ".json",
        metadata: {
          source: "census-geocoder-batch",
          snapshot_id: sha,
          url: "https://geocoding.geo.census.gov/geocoder/locations/addressbatch",
          final_url:
            "https://geocoding.geo.census.gov/geocoder/locations/addressbatch",
          redirect_chain: [],
          status: 200,
          content_type: "text/csv",
          etag: null,
          last_modified: null,
          sha256: sha,
          bytes: Buffer.byteLength(text),
          fetched_at: "2026-11-07T00:00:00Z",
        },
      };
      const acquire = async () => {
        calls++;
        return { file, requests: 1 };
      };
      // Issuer first: duplicate source addresses are one Census request row.
      expect(
        await ingestGeocode(h.db, { source: "qhp_provider_address", acquire }),
      ).toMatchObject({ selected: 2, addressesSent: 1, reused: 1 });
      // NPPES second: identical address uses the issuer's point, preserving both source keys.
      expect(
        await ingestGeocode(h.db, { source: "npi_address", acquire }),
      ).toMatchObject({ selected: 1, addressesSent: 0, reused: 1 });
      expect(calls).toBe(1);
      // Identical bytes can be advertised in two active shards. Both source snapshots must stay located.
      await h.child([provider]);
      await importProviders(h.db, scope);
      expect(
        await ingestGeocode(h.db, { source: "qhp_provider_address", acquire }),
      ).toMatchObject({ selected: 4, addressesSent: 0, reused: 4 });
      const currentPoints = await pointsWithinRadius(
        h.db,
        29.760724420884,
        -95.369483289562,
        0.1,
        "qhp_provider_address",
      );
      expect(currentPoints).toHaveLength(4);
      expect(new Set(currentPoints.map((p) => p.source_row)).size).toBe(4);
      expect(
        (
          await h.db.query(
            "SELECT DISTINCT source_table FROM address_point ORDER BY source_table",
          )
        ).rows,
      ).toEqual([
        { source_table: "npi_address" },
        { source_table: "qhp_provider_address" },
      ]);
      await h.replace([provider]);
      const refresh = await importProviders(h.db, scope);
      expect(refresh.snapshot_id).not.toBe(first.snapshot_id);
      expect(
        await ingestGeocode(h.db, { source: "qhp_provider_address", acquire }),
      ).toMatchObject({ selected: 2, addressesSent: 0, reused: 2 });
      expect(
        (
          await h.db.query(
            `SELECT count(*)::int n FROM address_point p JOIN qhp_provider_address a
        ON p.source_row=a.snapshot_id||':'||a.record_id||':'||a.address_index::text AND p.source_snapshot_id=a.snapshot_id
        JOIN provider_shard s ON s.snapshot_id=a.snapshot_id WHERE s.source_set_id=$1`,
            [refresh.snapshot_id],
          )
        ).rows[0]!.n,
      ).toBe(2);
      // A new issuer address must not reuse evidence for the old normalized address.
      provider.addresses[0].address = "Synthetic changed location";
      await h.replace([provider]);
      await importProviders(h.db, scope);
      expect(
        await ingestGeocode(h.db, { source: "qhp_provider_address", acquire }),
      ).toMatchObject({ selected: 2, addressesSent: 1, reused: 1 });
      expect(calls).toBe(2);
      expect(
        await ingestGeocode(h.db, { source: "qhp_provider_address", acquire }),
      ).toMatchObject({ reused: 2, addressesSent: 0 });
      provider.addresses = [
        {
          address: "Synthetic invalid ZIP",
          city: "HOUSTON",
          state: "TX",
          zip: "invalid",
        },
      ];
      await h.replace([provider]);
      await importProviders(h.db, scope);
      const unmatched = '"1","Synthetic invalid ZIP","No_Match"\n',
        unmatchedPath = join(h.directory, "unmatched.csv");
      await writeFile(unmatchedPath, unmatched);
      const unmatchedFile: BatchFile = {
        ...file,
        path: unmatchedPath,
        metadata: {
          ...file.metadata,
          bytes: Buffer.byteLength(unmatched),
          sha256: createHash("sha256").update(unmatched).digest("hex"),
        },
      };
      expect(
        await ingestGeocode(h.db, {
          source: "qhp_provider_address",
          acquire: async () => ({ file: unmatchedFile, requests: 1 }),
        }),
      ).toMatchObject({
        selected: 1,
        addressesSent: 1,
        noPoint: 1,
        centroidFallbacks: 0,
      });
    } finally {
      await h.close();
    }
  });
});
