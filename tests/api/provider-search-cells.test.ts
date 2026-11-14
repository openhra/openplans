import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { cellRanges } from "../../src/api/provider-search-keys.js";
import { importMutant, withMutantFile } from "../mutant-file.js";
import { replaceSyntax } from "../source-mutation.js";

// The cell covering of a radius must hold every point ST_DWithin(..., false) accepts. Points are
// placed on PostGIS's sphere at a chosen great-circle distance and bearing from the origin, the
// way ST_Project does, just inside the radius; their cells use the stored formula.
type Ranges = typeof cellRanges;
const SPHERE_METERS = 6371008.771415059;
const METERS_PER_MILE = 1609.344;
const radians = (degrees: number) => (degrees * Math.PI) / 180;
const degrees = (value: number) => (value * 180) / Math.PI;

function project(lat: number, lon: number, meters: number, bearing: number) {
  const d = meters / SPHERE_METERS,
    phi = radians(lat),
    theta = radians(bearing);
  const phi2 = Math.asin(
    Math.sin(phi) * Math.cos(d) + Math.cos(phi) * Math.sin(d) * Math.cos(theta),
  );
  const lambda2 =
    radians(lon) +
    Math.atan2(
      Math.sin(theta) * Math.sin(d) * Math.cos(phi),
      Math.cos(d) - Math.sin(phi) * Math.sin(phi2),
    );
  let lon2 = degrees(lambda2);
  while (lon2 > 180) lon2 -= 360;
  while (lon2 < -180) lon2 += 360;
  return { latitude: degrees(phi2), longitude: lon2 };
}

/** Same float steps as cellSql in provider-search-keys.ts. */
const cell = (latitude: number, longitude: number) =>
  Math.floor((latitude + 90) * 10) * 3601 + Math.floor((longitude + 180) * 10);

function uncovered(ranges: Ranges, origins: [number, number][]) {
  const misses: string[] = [];
  for (const [lat, lon] of origins)
    for (const miles of [0, 0.5, 5, 25, 100, 500]) {
      const covering = ranges(lat, lon, miles);
      for (let bearing = 0; bearing < 360; bearing += 7.5)
        for (const share of [0, 0.5, 0.999999]) {
          const p = project(lat, lon, miles * METERS_PER_MILE * share, bearing);
          const key = cell(p.latitude, p.longitude);
          if (!covering.some(([first, last]) => key >= first && key <= last))
            misses.push(`${lat},${lon} ${miles}mi ${bearing}deg`);
        }
    }
  return misses;
}

const ORIGINS: [number, number][] = [
  [30.338, -97.5207], // central Texas
  [29.7105, -95.3973],
  [47.6, -122.3],
  [64.84, -147.72], // interior Alaska: wide longitude span
  [51.88, -176.65], // Aleutians: the radius crosses the antimeridian
  [-33.9, 151.2],
  [89.5, 10], // the cap contains the pole
  [0, 179.99],
  [0.05, -0.05],
];

describe("search key cells", () => {
  it("cover every point within the radius on PostGIS's sphere", () => {
    expect(uncovered(cellRanges, ORIGINS)).toEqual([]);
  });

  it("stay compact for a city radius", () => {
    const ranges = cellRanges(30.338, -97.5207, 25);
    // About 0.73 degrees of latitude: eight or nine bands of one range each.
    expect(ranges.length).toBeGreaterThanOrEqual(8);
    expect(ranges.length).toBeLessThanOrEqual(10);
    for (const [first, last] of ranges) expect(last - first).toBeLessThan(12);
  });

  it("fails when the longitude span ignores latitude (planted mutant)", async () => {
    const path = new URL(
      "../../src/api/provider-search-keys.ts",
      import.meta.url,
    );
    const source = replaceSyntax(
      await readFile(path, "utf8"),
      "const ratio = Math.sin(angle) / cosine;",
      "const ratio = Math.sin(angle) / Math.max(cosine, 1);",
    );
    await withMutantFile(path, source, async (file) => {
      const mutant = await importMutant<{ cellRanges: Ranges }>(
        file,
        "cellRanges",
      );
      expect(uncovered(mutant.cellRanges, ORIGINS)).not.toEqual([]);
    });
  });
});
