import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SqlSession } from "../../../src/db/database.js";
import { createDatabase } from "../../../src/db/database.js";
import {
  searchProviderLocations,
  searchProviders,
} from "../../../src/api/provider-repository.js";
import { mapProviders } from "../../../src/compat/v1/providers.js";
import { setup } from "../../ingest/qhp/provider-helpers.js";
import { saveResult } from "../../../src/ingest/geocode/repository.js";
import { storeOperatorPoints } from "../../../src/ingest/geocode/operator-store.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Synthetic identities, addresses and coordinates. The optional URL must be disposable.
describe("compatibility location paging preserves the complete native mapping", () => {
  let h: Awaited<ReturnType<typeof setup>>;
  const origin = {
    latitude: 29.7105,
    longitude: -95.3973,
    method: "coordinates",
  };
  const q = { page: 1, origin, radius: 5 };
  beforeAll(async () => {
    h = await setup(
      process.env.P6K2_POSTGIS_URL
        ? createDatabase(process.env.P6K2_POSTGIS_URL)
        : undefined,
    );
    for (let i = 0; i < 64; i++) {
      const npi = String(1000040000 + i);
      await h.db.query(
        `INSERT INTO npi_provider(npi,entity_type,first_name,last_name,in_scope,state_filter,data_date,snapshot_id)
        VALUES ($1,'1','Synthetic','LocationPaging',true,'TX','2026-11-08','catalog')`,
        [npi],
      );
      // Multiple primary rows test the native mapper's first-primary rule.
      await h.db.query(
        `INSERT INTO npi_taxonomy VALUES ($1,1,'207Q00000X',true,'TX','catalog'),
        ($1,2,'UNKNOWN000',true,'TX','catalog')`,
        [npi],
      );
      for (let ordinal = 0; ordinal < (i === 0 ? 4 : 1); ordinal++) {
        const line =
          i === 0
            ? [
                "  Synthetic\tstraße  ",
                "SYNTHETIC STRASSE",
                "Synthetic other",
                "Synthetic far",
              ][ordinal]!
            : `Synthetic location ${i}`;
        await h.db.query(
          `INSERT INTO npi_address(npi,kind,ordinal,line_1,line_2,city,state,zip5,snapshot_id)
          VALUES ($1,'practice',$2,$3,NULL,'HOUSTON','TX','77030',$4)`,
          [
            npi,
            ordinal,
            line,
            i === 0 && ordinal === 0 ? "registry" : "catalog",
          ],
        );
        if (i === 63) continue;
        await saveResult(
          h.db,
          {
            npi,
            kind: "practice",
            ordinal,
            line_1: line,
            line_2: null,
            city: "HOUSTON",
            state: "TX",
            zip5: "77030",
            snapshot_id:
              i === 62 || (i === 0 && ordinal === 0) ? "registry" : "catalog",
            source_table: "npi_address",
            source_row: `${npi}:practice:${ordinal}`,
          },
          {
            id: String(i),
            status: "Match",
            quality: "Exact",
            latitude: origin.latitude + (ordinal === 3 ? 0.5 : (i % 3) / 10000),
            longitude: origin.longitude,
          },
          "catalog",
        );
      }
    }
    await h.db.query(
      `UPDATE npi_provider SET snapshot_id='registry' WHERE npi='1000040061'`,
    );
    await h.db.exec(`DELETE FROM npi_taxonomy WHERE npi='1000040063';
      INSERT INTO npi_taxonomy VALUES ('1000040063',1,'UNKNOWN000',NULL,'TX','catalog')`);
    await h.db
      .query(`INSERT INTO provider_taxonomy(code,display_name,classification,version,snapshot_id)
      VALUES ('207Q00000X','Synthetic family medicine','Synthetic','test','catalog')`);
  });
  afterAll(async () => {
    await h?.close();
  });

  it("pages consented operator points with provenance and excludes them when caching is on", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-operator-merge-"));
    const previous = {
      OPENPLANS_DATA_DIR: process.env.OPENPLANS_DATA_DIR,
      OPENPLANS_GEOCODER_STORE: process.env.OPENPLANS_GEOCODER_STORE,
      OPENPLANS_API_CACHE: process.env.OPENPLANS_API_CACHE,
    };
    const rollback = new Error("rollback operator merge control");
    const county = {
      county_fips: "48201",
      name: "Synthetic Harris rectangle",
      south: 29.5,
      north: 30,
      west: -96,
      east: -95,
      rings: [
        [
          [-96, 29.5],
          [-95, 29.5],
          [-95, 30],
          [-96, 30],
          [-96, 29.5],
        ],
      ],
      snapshot_id: "catalog",
    };
    try {
      process.env.OPENPLANS_DATA_DIR = root;
      process.env.OPENPLANS_GEOCODER_STORE = "1";
      process.env.OPENPLANS_API_CACHE = "off";
      await expect(
        h.db.transaction(async (tx) => {
          await tx.query(
            `INSERT INTO geocode_tx_county VALUES ('48201','Synthetic Harris rectangle',29.5,30,-96,-95,$1,'catalog')`,
            [JSON.stringify(county.rings)],
          );
          await saveResult(
            tx,
            {
              npi: "1000040063",
              kind: "practice",
              ordinal: 0,
              line_1: "Synthetic location 63",
              line_2: null,
              city: "HOUSTON",
              state: "TX",
              zip5: "77030",
              snapshot_id: "catalog",
              source_table: "npi_address",
              source_row: "1000040063:practice:0",
            },
            { id: "operator", status: "No_Match", quality: null },
            "catalog",
          );
          const address_hash = (
            await tx.query(
              `SELECT address_hash FROM geocode_attempt WHERE source_row='1000040063:practice:0'`,
            )
          ).rows[0]!.address_hash as string;
          await storeOperatorPoints(
            [
              {
                address_hash,
                latitude: origin.latitude,
                longitude: origin.longitude,
                county_fips: "48201",
                source: "operator_geocoder",
                as_of: "2026-11-08",
                bounds_snapshot_id: "catalog",
              },
            ],
            [county],
            root,
            { OPENPLANS_GEOCODER_STORE: "1" },
          );
          const located = await searchProviderLocations(tx, q, {
            offset: 0,
            size: 100,
          });
          expect(located.total).toBe(64);
          const point = located.providers.find((p) => p.npi === "1000040063")!
            .addresses[0];
          expect(point).toMatchObject({
            method: "operator_geocoder",
            geocode_label: "operator_geocoder",
            precision: "operator_reported",
          });
          expect(point).toHaveProperty("geocode_as_of");
          expect(
            (
              await tx.query(
                `SELECT 1 FROM address_point WHERE source_row='1000040063:practice:0'`,
              )
            ).rows,
          ).toEqual([]);
          process.env.OPENPLANS_API_CACHE = "on";
          expect(
            (await searchProviderLocations(tx, q, { offset: 0, size: 100 }))
              .total,
          ).toBe(63);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("matches all pages, duplicate provenance, tied distances, reverse order and empty pages", async () => {
    const records = [];
    for (let page = 1; ; page++) {
      const result = await searchProviders(h.db, { ...q, page });
      records.push(...result.providers);
      if (!result.next_page) break;
    }
    const mapped = mapProviders(records).sort(
      (a, b) => a.distance_miles! - b.distance_miles!,
    );
    const updated = records.find((p) => p.npi === "1000040061")!;
    expect(updated.snapshot_id).toBe("registry");
    expect(updated.addresses[0]).toMatchObject({ snapshot_id: "catalog" });
    expect(mapped).toHaveLength(63);
    expect(mapped[0]!.provenance).toHaveLength(2);
    for (const reverse of [false, true]) {
      const expected = reverse ? [...mapped].reverse() : mapped;
      const pages = [];
      for (const offset of [0, 17, 34, 51, 68]) {
        const result = await searchProviderLocations(h.db, q, {
          offset,
          size: 17,
          reverse,
        });
        const actual = mapProviders(result.providers).sort(
          (a, b) => a.distance_miles! - b.distance_miles!,
        );
        if (reverse) actual.reverse();
        expect(actual).toEqual(expected.slice(offset, offset + 17));
        expect(result.total).toBe(63);
        expect(result.taxonomy_unknown).toBe(false);
        expect(result.unlocated).toBe(true); // The facade needs the missing-point flag only.
        pages.push(...actual);
      }
      expect(pages).toEqual(expected);
      for (const offset of [0, 1, 61, 62]) {
        const result = await searchProviderLocations(h.db, q, {
          offset,
          size: 1,
          reverse,
        });
        expect(mapProviders(result.providers)).toEqual(
          expected.slice(offset, offset + 1),
        );
      }
    }
  });

  it("keeps results when the new indexes are removed", async () => {
    const expected = await searchProviderLocations(h.db, q, {
      offset: 0,
      size: 100,
    });
    const native = await searchProviders(h.db, q),
      rollback = new Error("rollback location index control");
    await expect(
      h.db.transaction(async (tx) => {
        await tx.exec(`DROP INDEX address_point_npi_source; DROP INDEX npi_provider_in_scope;
        DROP INDEX npi_address_practice_count; DROP INDEX address_point_npi_identity;
        DROP INDEX npi_provider_out_of_scope; DROP INDEX npi_address_practice_location;
        DROP INDEX IF EXISTS address_point_provider_radius`);
        expect(
          await searchProviderLocations(tx, q, { offset: 0, size: 100 }),
        ).toEqual(expected);
        expect(await searchProviders(tx, q)).toEqual(native);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });

  it("disables JIT only inside the search and keeps request text bound", async () => {
    const before = (await h.db.query(`SELECT current_setting('jit') AS jit`))
      .rows[0]!.jit;
    const name = "Synthetic $provider_query$'; SELECT 'literal'";
    const execute = (sql: string) =>
      h.db.query<{ value: { jit: string; name: string } }>(
        `SELECT provider_search_query($1,NULL,NULL,NULL,NULL,$2,NULL,NULL,NULL,NULL) AS value`,
        [sql, name],
      );
    const result = await execute(
      `SELECT current_setting('jit') AS jit,$5::text AS name`,
    );
    expect(result.rows[0]!.value).toEqual({ jit: "off", name });
    expect(
      (
        await searchProviderLocations(
          h.db,
          { ...q, name },
          { offset: 0, size: 10 },
        )
      ).total,
    ).toBe(0);
    await expect(execute("SELECT synthetic_missing_column")).rejects.toThrow();
    expect(
      (await h.db.query(`SELECT current_setting('jit') AS jit`)).rows[0]!.jit,
    ).toBe(before);
  });

  it("retains missing specialty descriptions even on an empty requested page", async () => {
    const rollback = new Error("rollback empty specialty description");
    await expect(
      h.db.transaction(async (tx) => {
        await tx.exec(`UPDATE provider_taxonomy SET display_name=''`);
        const result = await searchProviderLocations(tx, q, {
          offset: 1000,
          size: 10,
        });
        expect(result.total).toBe(63);
        expect(result.providers).toEqual([]);
        expect(result.taxonomy_unknown).toBe(true);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });

  it("negative control: removing the radius changes the complete mapped set", async () => {
    const original = await searchProviderLocations(h.db, q, {
      offset: 0,
      size: 100,
    });
    let mutated = false;
    const mutant: SqlSession = {
      ...h.db,
      query: (sql, args) => {
        if (sql.includes("AS total")) {
          if (sql.includes("ST_DWithin"))
            sql = sql.replace(
              "AND ST_DWithin(p.point,ST_SetSRID(ST_MakePoint($8,$7),4326)::geography,$9*1609.344,false)",
              "AND $9::float8 IS NOT NULL",
            );
          else
            sql = sql.replace(
              "WHERE distance_miles <= $9",
              "WHERE $9::float8 IS NOT NULL",
            );
          mutated = true;
        }
        return h.db.query(sql, args);
      },
    };
    const broken = await searchProviderLocations(mutant, q, {
      offset: 0,
      size: 100,
    });
    expect(mutated).toBe(true);
    expect(broken.total).toBeGreaterThan(original.total);
    expect(() =>
      expect(mapProviders(broken.providers)).toEqual(
        mapProviders(original.providers),
      ),
    ).toThrow();
  });
});
