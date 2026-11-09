import { PGlite } from "@electric-sql/pglite";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { coreMigrations, testDatabase } from "../../pglite.js";
import { migrate } from "../../../src/db/migrate.js";
import { ingestGeo } from "../../../src/ingest/geo/index.js";
import { ratingAreaForLocation } from "../../../src/ingest/geo/repository.js";
import { ratingRows } from "../../../src/ingest/geo/parse.js";
import { geoSources } from "../../../src/ingest/geo/sources.js";
import type { GeoFiles, GeoKind } from "../../../src/ingest/geo/sources.js";
import { fixtureFiles } from "./helpers.js";

it("synthetic AK ZIP3 and AL county imports preserve prior state rows and resolve only published divisions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openplans-geo-states-"));
  const db = testDatabase(new PGlite()),
    core = await coreMigrations();
  try {
    await migrate(db, core.directory);
    await ingestGeo(db, { files: await fixtureFiles() });
    const txBefore = (
      await db.query(
        "SELECT count(*)::int AS n FROM zcta_county WHERE county_fips LIKE '48%'",
      )
    ).rows;
    // Labelled synthetic geography, used only to verify storage and routing (not a real Census cut).
    const relationship =
      "GEOID_ZCTA5_20|GEOID_COUNTY_20|NAMELSAD_COUNTY_20|AREALAND_ZCTA5_20|AREAWATER_ZCTA5_20|AREALAND_COUNTY_20|AREAWATER_COUNTY_20|AREALAND_PART|AREAWATER_PART\n99501|02020|Anchorage Municipality|10|0|10|0|10|0\n35004|01001|Autauga County|10|0|10|0|10|0\n";
    const centroids =
      "GEOID\tINTPTLAT\tINTPTLONG\n99501\t61.200000\t-149.900000\n35004\t32.500000\t-86.500000\n";
    async function files(state: string, rating: string): Promise<GeoFiles> {
      const sources = geoSources(state),
        files = {} as GeoFiles;
      for (const [kind, text] of Object.entries({
        relationship,
        centroids,
        ratingAreas: rating,
      }) as [GeoKind, string][]) {
        const hash = createHash("sha256").update(text).digest("hex"),
          path = join(directory, `${state}-${kind}`);
        await writeFile(path, text);
        files[kind] = {
          path,
          metadata: {
            ...(await fixtureFiles())[kind].metadata,
            source: sources[kind].source,
            url: sources[kind].url,
            sha256: hash,
            bytes: Buffer.byteLength(text),
          },
        };
      }
      return files;
    }
    const header =
      "<table><tr><th>Rating Area ID (for federal systems)</th><th>County Name</th><th>3 Digit Zip Code (if applicable)</th></tr>";
    const ak = await files(
      "AK",
      header + "<tr><td>Rating Area 1</td><td></td><td>995</td></tr></table>",
    );
    expect(
      await ingestGeo(db, { state: "AK", planYear: 2027, files: ak }),
    ).toMatchObject({ ratingAreaRows: 1, ratingAreaUnit: "zip3" });
    const al = await files(
      "AL",
      header +
        "<tr><td>Rating Area 2</td><td>Autauga</td><td></td></tr></table>",
    );
    await ingestGeo(db, { state: "AL", files: al });
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM zcta_county WHERE county_fips LIKE '48%'",
        )
      ).rows,
    ).toEqual(txBefore);
    expect(
      (await db.query("SELECT state FROM geo_import ORDER BY state")).rows,
    ).toEqual([{ state: "AK" }, { state: "AL" }, { state: "TX" }]);
    expect(
      await ratingAreaForLocation(db, "AK", 2027, "01001", "99501"),
    ).toMatchObject({ status: "unknown", areas: [] });
    expect(await ratingAreaForLocation(db, "AK", 2027, "02020")).toMatchObject({
      status: "unknown",
      areas: [],
    });
    expect(
      await ratingAreaForLocation(db, "AK", 2027, "02020", "99501"),
    ).toMatchObject({
      status: "available",
      areas: [{ rating_area_id: "Rating Area 1" }],
    });
    expect(await ratingAreaForLocation(db, "AL", 2026, "01001")).toMatchObject({
      status: "available",
      areas: [{ rating_area_id: "Rating Area 2" }],
    });

    // A published CMS typo maps only through the explicit state allowlist; evidence records the correction.
    const inFiles = await files(
      "IN",
      header +
        "<tr><td>Rating Area 3</td><td>Deleware</td><td></td></tr></table>",
    );
    const inRelationship =
      relationship.split("\n")[0] +
      "\n47302|18035|Delaware County|10|0|10|0|10|0\n";
    const inCentroids =
      "GEOID\tINTPTLAT\tINTPTLONG\n47302\t40.100000\t-85.400000\n";
    for (const [kind, body] of [
      ["relationship", inRelationship],
      ["centroids", inCentroids],
    ] as const) {
      await writeFile(inFiles[kind].path, body);
      inFiles[kind].metadata.sha256 = createHash("sha256")
        .update(body)
        .digest("hex");
      inFiles[kind].metadata.bytes = Buffer.byteLength(body);
    }
    expect(await ingestGeo(db, { state: "IN", files: inFiles })).toMatchObject({
      countyNameCorrections: [{ published: "Deleware", censusKey: "delaware" }],
    });
    expect(await ratingAreaForLocation(db, "IN", 2026, "18035")).toMatchObject({
      status: "available",
    });

    // A missing prefix fails closed and preserves the previous year/state pointer.
    const broken = await files(
      "AK",
      header + "<tr><td>Rating Area 1</td><td></td><td>999</td></tr></table>",
    );
    await expect(
      ingestGeo(db, { state: "AK", planYear: 2027, files: broken }),
    ).rejects.toThrow("omits a selected ZCTA prefix");
    expect(
      await ratingAreaForLocation(db, "AK", 2027, "02020", "99501"),
    ).toMatchObject({ status: "available" });
  } finally {
    await db.close();
    await core.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
});

it("selects the first individual-market CMS table and rejects malformed third columns", async () => {
  const header =
    "<table><tr><th>Rating Area ID</th><th>County Name</th><th>3 Digit Zip Code</th></tr>";
  async function* input() {
    yield header +
      "<tr><td>Rating Area 1</td><td>Example</td><td></td></tr></table>" +
      header +
      "<tr><td>Rating Area 9</td><td></td><td>999</td></tr></table>";
  }
  const rows = [];
  for await (const row of ratingRows(input())) rows.push(row);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    countyName: "Example",
    ratingAreaId: "Rating Area 1",
  });
  async function* mutant() {
    yield header +
      "<tr><td>Rating Area 1</td><td></td><td>99</td></tr></table>";
  }
  await expect(
    (async () => {
      for await (const _ of ratingRows(mutant())) {
        /* consume */
      }
    })(),
  ).rejects.toThrow("unrecognized CMS");
});
