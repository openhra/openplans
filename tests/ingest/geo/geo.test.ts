import { PGlite } from "@electric-sql/pglite";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ingestGeo,
  createGeoRepository,
  GeoError,
} from "../../../src/ingest/geo/index.js";
import { relationships, ratingRows } from "../../../src/ingest/geo/parse.js";
import { migrate } from "../../../src/db/migrate.js";
import { coreMigrations, testDatabase } from "../../pglite.js";
import { fixtureDirectory, fixtureFiles } from "./helpers.js";
import type { SqlSession } from "../../../src/db/database.js";
import { lookupZip } from "../../../src/services/catalog.js";
import {
  servingGeneration,
  withDataPolicy,
} from "../../../src/services/data-window.js";
import { plantMutant } from "../../../src/plugins/testing/index.js";
import * as repository from "../../../src/ingest/geo/repository.js";
import {
  runWithScope,
  setScopeResponseGeneration,
} from "../../../src/plugins/request-scope.js";

const pg = new PGlite(),
  db = testDatabase(pg);
let core: Awaited<ReturnType<typeof coreMigrations>>, temporary: string;
beforeAll(async () => {
  core = await coreMigrations();
  temporary = await mkdtemp(join(tmpdir(), "openplans-geo-"));
  await migrate(db, core.directory);
  await ingestGeo(db, { files: await fixtureFiles() });
}, 30_000);
afterAll(async () => {
  await db.close();
  await core.cleanup();
  await rm(temporary, { recursive: true, force: true });
});

describe("real Census/CMS source cuts imported into PGlite", () => {
  it("shares a pending ZCTA query while every request still checks generation", async () => {
    let release!: () => void;
    const wait = new Promise<void>((done) => {
      release = done;
    });
    let armed!: () => void;
    const started = new Promise<void>((done) => {
      armed = done;
    });
    let requests = 0,
      generations = 0,
      reads = 0;
    const reader: SqlSession = {
      query: async (sql, values) => {
        if (sql.includes("api_data_generation")) generations++;
        if (sql.includes("SELECT DISTINCT z.county_fips")) {
          reads++;
          await wait;
        }
        return db.query(sql, values);
      },
      exec: db.exec,
    };
    const runs = Array.from({ length: 4 }, () =>
      withDataPolicy({ historyYears: 3 }, () =>
        runWithScope(async () => {
          setScopeResponseGeneration(await servingGeneration(reader));
          const result = lookupZip(reader, "75034");
          if (++requests === 4) armed();
          return result;
        }),
      ),
    );
    try {
      await started;
      expect(generations).toBe(4);
      expect(reads).toBe(1);
    } finally {
      release();
    }
    const results = await Promise.all(runs);
    expect(results[0]!.counties.map((row) => row.county_fips)).toEqual([
      "48085",
      "48121",
    ]);
    results[0]!.counties[0]!.county_name = "synthetic mutation";
    expect(results[1]!.counties[0]!.county_name).not.toBe("synthetic mutation");
    await withDataPolicy({ historyYears: 3 }, () =>
      runWithScope(async () => {
        setScopeResponseGeneration(await servingGeneration(reader));
        await lookupZip(reader, "75034");
      }),
    );
    expect(reads, "completed reads must not stay cached").toBe(2);
  });
  it("does not retain a failed shared query or merge fallback work", async () => {
    let fail = true,
      reads = 0,
      fallbacks = 0;
    const reader: SqlSession = {
      query: async (sql, values) => {
        if (sql.includes("SELECT DISTINCT z.county_fips")) {
          reads++;
          if (fail) throw new Error("synthetic query failure");
        }
        if (sql.includes("FROM zip_county_fallback")) fallbacks++;
        return db.query(sql, values);
      },
      exec: db.exec,
    };
    const geo = repository.createGeoRepository(reader, {
      generation: "synthetic-generation",
      allowCmsLive: false,
    });
    const outcomes = await Promise.allSettled(
      Array.from({ length: 4 }, () => geo.zipToCounties("75034")),
    );
    expect(outcomes.every((row) => row.status === "rejected")).toBe(true);
    expect(reads).toBe(1);
    fail = false;
    expect((await geo.zipToCounties("75034")).status).toBe("available");
    expect(reads).toBe(2);
    const missing = await Promise.all(
      Array.from({ length: 4 }, () => geo.zipToCounties("00000")),
    );
    expect(missing.every((row) => row.status === "unknown")).toBe(true);
    expect(reads).toBe(3);
    expect(
      fallbacks,
      "fallback admission and budgets belong to each request",
    ).toBe(4);
  });
  it("negative control: separate generations cannot join the same pending read", async () => {
    async function contract(
      module: Pick<typeof repository, "createGeoRepository">,
    ) {
      let release!: () => void;
      const wait = new Promise<void>((done) => {
        release = done;
      });
      let reads = 0;
      const reader: SqlSession = {
        query: async (sql, values) => {
          if (sql.includes("SELECT DISTINCT z.county_fips")) {
            reads++;
            await wait;
          }
          return db.query(sql, values);
        },
        exec: db.exec,
      };
      const runs = ["synthetic-before", "synthetic-after"].map((generation) =>
        module
          .createGeoRepository(reader, { generation })
          .zipToCounties("75034"),
      );
      try {
        expect(reads, "different generations must use separate reads").toBe(2);
      } finally {
        release();
        await Promise.allSettled(runs);
      }
    }
    await contract(repository);
    const mutant = await plantMutant(
      new URL("../../../src/ingest/geo/repository.ts", import.meta.url),
      "JSON.stringify([generation, zip])",
      "JSON.stringify([zip])",
    );
    try {
      const module = (await import(mutant.path)) as typeof repository;
      await expect(contract(module)).rejects.toThrow(
        "different generations must use separate reads",
      );
    } finally {
      await mutant.cleanup();
    }
  });
  it("retains every county for multi-county 75034, raw land measurements and exact shares", async () => {
    const result = await createGeoRepository(db).zipToCounties("75034");
    expect(result.status).toBe("available");
    expect(result.counties.map((c) => c.county_fips)).toEqual([
      "48085",
      "48121",
    ]);
    expect(result.counties.map((c) => c.arealand_part)).toEqual([
      "23312510",
      "17981890",
    ]);
    expect(result.counties.map((c) => c.arealand_zcta)).toEqual([
      "41294400",
      "41294400",
    ]);
    expect(
      result.counties.reduce((sum, c) => sum + Number(c.zcta_land_share), 0),
    ).toBeCloseTo(1, 12);
    expect(
      result.counties.every(
        (c) =>
          c.source_row > 1 &&
          c.snapshot_id.startsWith("census-zcta-county-2020:"),
      ),
    ).toBe(true);
  });
  it("preserves county 48001 and rejects mutant four-digit 8001 at its source row", async () => {
    expect(
      (
        await db.query(
          "SELECT DISTINCT county_fips FROM zcta_county WHERE county_fips = '48001'",
        )
      ).rows,
    ).toEqual([{ county_fips: "48001" }]);
    const text = await readFile(
      join(fixtureDirectory, "zcta-county-tx.psv"),
      "utf8",
    );
    const mutant = text.replace("|48001|", "|8001|");
    const rowNumber = mutant
      .slice(0, mutant.indexOf("|8001|"))
      .split("\n").length;
    const path = join(temporary, "mutant-fips.psv");
    await writeFile(path, mutant);
    await expect(
      ingestGeo(db, { files: await fixtureFiles({ relationship: path }) }),
    ).rejects.toMatchObject({ code: "invalid_fips", rowNumber });
    await expect(
      db.query(
        `UPDATE zcta_county SET county_fips = '8001' WHERE county_fips = '48001'`,
      ),
    ).rejects.toThrow(/check constraint/i);
  });
  it("unknown ZIP returns unknown and no guessed counties; leading zero ZIPs remain strings", async () => {
    expect(await createGeoRepository(db).zipToCounties("00000")).toEqual({
      zip: "00000",
      status: "unknown",
      geography: "2020_zcta",
      source: null,
      counties: [],
    });
    expect(await createGeoRepository(db).zipToCounties("00601")).toMatchObject({
      zip: "00601",
      status: "unknown",
      counties: [],
    });
    await expect(createGeoRepository(db).zipToCounties("8001")).rejects.toThrow(
      "five-digit",
    );
  });
  it("joins Harris County to CMS Rating Area 10 with snapshot/row provenance, idempotently", async () => {
    const first = await ingestGeo(db, { files: await fixtureFiles() });
    const second = await ingestGeo(db, { files: await fixtureFiles() });
    expect(second).toEqual(first);
    expect(second.ratingAreaRows).toBe(254);
    expect(second.zctaCountyRows).toBeGreaterThan(254);
    const rows = (
      await db.query(
        "SELECT county_fips, rating_area_id, plan_year, snapshot_id, source_row FROM rating_area WHERE county_fips = '48201'",
      )
    ).rows;
    expect(rows).toEqual([
      expect.objectContaining({
        county_fips: "48201",
        rating_area_id: "Rating Area 10",
        plan_year: 2026,
        source_row: expect.any(Number) as number,
      }),
    ]);
    expect(
      (await db.query("SELECT COUNT(*)::int AS count FROM snapshot")).rows,
    ).toEqual([{ count: 3 }]);
    expect(
      (
        await db.query(
          "SELECT COUNT(*)::int AS count FROM snapshot WHERE validation_state = 'ACTIVE' AND sha256 IS NOT NULL AND activated_at IS NOT NULL",
        )
      ).rows,
    ).toEqual([{ count: 3 }]);
  });
  it("uses the latest geography import without duplicating counties from older plan years", async () => {
    const rollback = new Error("synthetic transaction rollback");
    await expect(
      db.transaction(async (tx) => {
        const { rows } = await tx.query<{
          relationship_snapshot_id: string;
          centroid_snapshot_id: string;
          rating_snapshot_id: string;
        }>("SELECT * FROM geo_import");
        const current = rows[0]!;
        await tx.query(`INSERT INTO snapshot (snapshot_id, source_id, parser_version)
        VALUES ('synthetic-older', 'census-zcta-county-2020', 'synthetic')`);
        await tx.query(`INSERT INTO zcta_county SELECT zcta,county_fips,county_name,arealand_zcta,areawater_zcta,
        arealand_county,areawater_county,arealand_part,areawater_part,'synthetic-older',source_row
        FROM zcta_county WHERE zcta='75034'`);
        await tx.query(
          `INSERT INTO geo_import VALUES ('TX',2025,'synthetic-older',$1,$2,'2000-01-01')`,
          [current.centroid_snapshot_id, current.rating_snapshot_id],
        );
        const result = await createGeoRepository(tx).zipToCounties("75034");
        expect(result.counties).toHaveLength(2);
        expect(
          result.counties.every(
            (row) => row.snapshot_id === current.relationship_snapshot_id,
          ),
        ).toBe(true);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });
  it("negative control: an omitted CMS county fails and atomically preserves the prior import", async () => {
    const before = (await db.query("SELECT * FROM geo_import")).rows;
    const html = await readFile(
      join(fixtureDirectory, "tx-rating-areas.html"),
      "utf8",
    );
    const path = join(temporary, "mutant-cms.html");
    await writeFile(path, html.replace(/<tr>\s*<td[^>]*>[\s\S]*?<\/tr>/, ""));
    await expect(
      ingestGeo(db, { files: await fixtureFiles({ ratingAreas: path }) }),
    ).rejects.toMatchObject({ code: "incomplete" });
    expect((await db.query("SELECT * FROM geo_import")).rows).toEqual(before);
    expect(
      (await db.query("SELECT COUNT(*)::int AS count FROM rating_area")).rows,
    ).toEqual([{ count: 254 }]);
    expect(
      (await db.query("SELECT COUNT(*)::int AS count FROM snapshot")).rows,
    ).toEqual([{ count: 3 }]);
    expect(
      (await createGeoRepository(db).zipToCounties("75034")).counties,
    ).toHaveLength(2);
  });
  it("negative controls: missing published columns, broken CMS table and modified snapshot fail", async () => {
    async function* badHeader() {
      yield "GEOID_ZCTA5_20|GEOID_COUNTY_20\n75034|48085";
    }
    await expect(
      (async () => {
        for await (const discarded of relationships(badHeader())) {
          void discarded;
        }
      })(),
    ).rejects.toBeInstanceOf(GeoError);
    async function* brokenHtml() {
      yield "<table><tr><th>Rating Area ID</th><th>County Name</th></tr><tr><td>Rating Area 10";
    }
    await expect(
      (async () => {
        for await (const discarded of ratingRows(brokenHtml())) {
          void discarded;
        }
      })(),
    ).rejects.toMatchObject({ code: "incomplete" });
    const completeHtml = await readFile(
      join(fixtureDirectory, "tx-rating-areas.html"),
      "utf8",
    );
    async function* noTableEnd() {
      yield completeHtml.replace("</table>", "");
    }
    await expect(
      (async () => {
        for await (const discarded of ratingRows(noTableEnd())) {
          void discarded;
        }
      })(),
    ).rejects.toMatchObject({ code: "incomplete" });
    const files = await fixtureFiles();
    files.centroids.metadata.sha256 = "a".repeat(64);
    await expect(ingestGeo(db, { files })).rejects.toThrow("snapshot metadata");
  });
  it("fixture row numbers refer to exact physical source-cut lines", async () => {
    const lines = (
      await readFile(join(fixtureDirectory, "zcta-county-tx.psv"), "utf8")
    ).split("\n");
    for await (const row of relationships(
      createReadStream(join(fixtureDirectory, "zcta-county-tx.psv")),
    )) {
      expect(lines[row.rowNumber - 1]!.split("|")[9]).toBe(row.countyFips);
    }
  });
});
