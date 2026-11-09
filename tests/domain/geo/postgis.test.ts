import { it, expect } from "vitest";
import { createDatabase } from "../../../src/db/database.js";
import { pointsWithinRadius } from "../../../src/domain/geo/index.js";
import { ingestGeocode } from "../../../src/ingest/geocode/index.js";
import { parseBatch } from "../../../src/ingest/geocode/parse.js";
import { setup, raw } from "../../ingest/geocode/helpers.js";
// Explicitly opt in against an empty, disposable PostGIS database. Offline CI uses PGlite.
it.skipIf(!process.env.GEOCODE_POSTGIS_URL)(
  "PostGIS ST_DWithin and PGlite haversine return the same fixture results",
  async () => {
    const pg = await setup(createDatabase(process.env.GEOCODE_POSTGIS_URL)),
      lite = await setup();
    try {
      for (const h of [pg, lite])
        await ingestGeocode(h.db, {
          acquire: async () => ({
            file: await h.file(await raw()),
            requests: 1,
          }),
        });
      expect(
        (
          await pg.db.query(
            "SELECT 1 FROM information_schema.columns WHERE table_name='address_point' AND column_name='point'",
          )
        ).rows,
      ).toHaveLength(1);
      const origin = (await parseBatch(await raw())).rows.get("1")!;
      for (const radius of [0, 1, 3.9, 4.1, 20, 1000]) {
        const args = [origin.latitude!, origin.longitude!, radius] as const;
        const a = await pointsWithinRadius(pg.db, ...args),
          b = await pointsWithinRadius(lite.db, ...args);
        expect(a.map((p) => [p.source_row, p.method])).toEqual(
          b.map((p) => [p.source_row, p.method]),
        );
        a.forEach((p, i) =>
          expect(p.distance_miles).toBeCloseTo(b[i]!.distance_miles, 7),
        );
      }
      // Negative control: corrupt the fallback distance and prove the comparison notices it.
      const a = await pointsWithinRadius(
        pg.db,
        origin.latitude!,
        origin.longitude!,
        4.1,
      );
      const mutant = (
        await pointsWithinRadius(
          lite.db,
          origin.latitude!,
          origin.longitude!,
          4.1,
        )
      ).map((p) => ({ ...p, distance_miles: p.distance_miles + 1 }));
      expect(
        a.some(
          (p, i) =>
            Math.abs(p.distance_miles - mutant[i]!.distance_miles) > 0.1,
        ),
      ).toBe(true);
    } finally {
      await pg.cleanup();
      await lite.cleanup();
    }
  },
  30_000,
);
