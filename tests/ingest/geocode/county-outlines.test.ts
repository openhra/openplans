import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  alignLongitude,
  buildCounties,
  checkCountyPoint,
  countyAt,
  countySource,
  countyUrl,
  extentMargin,
  geocodeState,
  geocodeStates,
  geocodeStateCodes,
  readCountyArchive,
} from "../../../src/ingest/geocode/counties.js";
import type { County } from "../../../src/ingest/geocode/counties.js";
import {
  readDbf,
  readPolygons,
} from "../../../src/ingest/geocode/shapefile.js";
import { setup } from "./helpers.js";

// Synthetic shapefile writer for tests only: one polygon record per entry, parts as given.
function shp(records: [number, number][][][]): Buffer {
  const bodies = records.map((parts) => {
    const points = parts.flat(),
      body = Buffer.alloc(44 + parts.length * 4 + points.length * 16);
    body.writeInt32LE(5, 0);
    body.writeInt32LE(parts.length, 36);
    body.writeInt32LE(points.length, 40);
    let index = 0;
    parts.forEach((part, p) => {
      body.writeInt32LE(index, 44 + p * 4);
      index += part.length;
    });
    points.forEach(([x, y], i) => {
      body.writeDoubleLE(x, 44 + parts.length * 4 + i * 16);
      body.writeDoubleLE(y, 52 + parts.length * 4 + i * 16);
    });
    return body;
  });
  const total = 100 + bodies.reduce((n, b) => n + 8 + b.length, 0),
    header = Buffer.alloc(100);
  header.writeInt32BE(9994, 0);
  header.writeInt32BE(total / 2, 24);
  header.writeInt32LE(1000, 28);
  header.writeInt32LE(5, 32);
  return Buffer.concat([
    header,
    ...bodies.flatMap((b, i) => {
      const h = Buffer.alloc(8);
      h.writeInt32BE(i + 1, 0);
      h.writeInt32BE(b.length / 2, 4);
      return [h, b];
    }),
  ]);
}
function dbf(fields: [string, number][], rows: string[][]): Buffer {
  const headerBytes = 32 + fields.length * 32 + 1,
    recordBytes = 1 + fields.reduce((n, [, size]) => n + size, 0),
    out = Buffer.alloc(headerBytes + rows.length * recordBytes + 1, 0x20);
  out.fill(0, 0, headerBytes);
  out[0] = 3;
  out.writeUInt32LE(rows.length, 4);
  out.writeUInt16LE(headerBytes, 8);
  out.writeUInt16LE(recordBytes, 10);
  fields.forEach(([name, size], i) => {
    out.write(name, 32 + i * 32, "latin1");
    out[32 + i * 32 + 11] = "C".charCodeAt(0);
    out[32 + i * 32 + 16] = size;
  });
  out[headerBytes - 1] = 0x0d;
  rows.forEach((row, r) => {
    let at = headerBytes + r * recordBytes + 1;
    row.forEach((value, i) => {
      out.write(value, at, "utf8");
      at += fields[i]![1];
    });
  });
  out[out.length - 1] = 0x1a;
  return out;
}
const square = (x: number, y: number, d = 0.1): [number, number][] => [
  [x - d, y - d],
  [x - d, y + d],
  [x + d, y + d],
  [x + d, y - d],
  [x - d, y - d],
];

describe("shapefile reader", () => {
  it("reads multipart polygons and their attribute rows", () => {
    const polygons = readPolygons(
      shp([[square(-97, 31)], [square(-96, 30), square(-95, 30)]]),
    );
    expect(polygons.map((p) => p.rings.length)).toEqual([1, 2]);
    expect(polygons[1]!.rings[1]![0]).toEqual([-95.1, 29.9]);
    const rows = readDbf(
      dbf(
        [
          ["GEOID", 5],
          ["NAME", 12],
        ],
        [
          ["48001", "Doña Ana"],
          ["48003", "Synthetic"],
        ],
      ),
    );
    expect(rows).toEqual([
      { GEOID: "48001", NAME: "Doña Ana" },
      { GEOID: "48003", NAME: "Synthetic" },
    ]);
  });
  it("rejects a non-polygon file, a length mismatch and an open ring", () => {
    const good = shp([[square(-97, 31)]]);
    const point = Buffer.from(good);
    point.writeInt32LE(1, 32);
    expect(() => readPolygons(point)).toThrow("not a polygon");
    expect(() => readPolygons(good.subarray(0, good.length - 8))).toThrow(
      "length",
    );
    const open = shp([
      [
        square(-97, 31)
          .slice(0, 4)
          .concat([[-90, 31]]),
      ],
    ]);
    expect(() => readPolygons(open)).toThrow("open ring");
  });
});

describe("county outlines for every state", () => {
  it("covers the 50 states and DC with oracle extents", () => {
    expect(geocodeStateCodes).toHaveLength(51);
    expect(new Set(Object.values(geocodeStates).map((s) => s.fips)).size).toBe(
      51,
    );
    expect(geocodeState("AK")).toBe("AK");
    expect(() => geocodeState("PR")).toThrow("50 states and DC");
  });
  it("rejects a county outside its state's oracle extent", () => {
    const ohio = [
      { GEOID: "48201", NAME: "Synthetic", rings: [square(-82.99, 39.96)] },
    ];
    expect(() => buildCounties(ohio, "synthetic", 1, "TX")).toThrow(
      "Invalid TX county extent",
    );
    // Each edge on its own: south, north, west and east of the TX extent.
    for (const [x, y] of [
      [-97, 24.6],
      [-97, 37.8],
      [-108, 31],
      [-92.4, 31],
    ] as const)
      expect(() =>
        buildCounties(
          [{ GEOID: "48001", NAME: "Synthetic", rings: [square(x, y)] }],
          "synthetic",
          1,
          "TX",
        ),
      ).toThrow("Invalid TX county extent");
    expect(
      buildCounties(
        [{ GEOID: "48001", NAME: "Synthetic", rings: [square(-97, 31)] }],
        "synthetic",
        1,
        "TX",
      ),
    ).toHaveLength(1);
  });
  it("keeps an Aleutian outline across the antimeridian as one box", () => {
    // Synthetic: one county with an island on each side of 180°, already shifted as stored.
    const [aleutians] = buildCounties(
      [
        {
          GEOID: "02016",
          NAME: "Synthetic",
          rings: [square(173 - 360, 52.9), square(-176.6, 51.9)],
        },
      ],
      "synthetic",
      1,
      "AK",
    );
    expect(aleutians!.west).toBeLessThan(-180);
    expect(alignLongitude(173, aleutians!)).toBeCloseTo(-187);
    expect(countyAt(52.9, 173, [aleutians!])?.county_fips).toBe("02016");
    expect(countyAt(51.9, -176.6, [aleutians!])?.county_fips).toBe("02016");
    expect(countyAt(52.9, 175, [aleutians!])).toBeUndefined();
    expect(countyAt(0, 0, [aleutians!])).toBeUndefined();
  });
});

describe("county and result extent constraints", () => {
  it("admit every state, reject cross-state points and accept Aleutian longitudes", async () => {
    const h = await setup();
    try {
      const insert = (fips: string, x: number, y: number) =>
        h.db.query(
          "INSERT INTO geocode_tx_county SELECT * FROM json_populate_record(NULL::geocode_tx_county,$1::json)",
          [
            JSON.stringify({
              county_fips: fips,
              name: "Synthetic",
              south: y - 0.1,
              north: y + 0.1,
              west: x - 0.1,
              east: x + 0.1,
              rings: [square(x, y)],
              snapshot_id: "synthetic",
            }),
          ],
        );
      await insert("39049", -82.99, 39.96);
      await insert("02016", 172.9 - 360, 52.9);
      // Ohio geometry labelled as a Texas county.
      await expect(insert("48201", -82.99, 39.96)).rejects.toThrow();
      const result = (hash: string, fips: string, lat: number, lon: number) =>
        h.db.query(
          `INSERT INTO geocode_tx_result(address_hash,normalized_address,match_status,method,latitude,longitude,
          county_fips,county_basis,snapshot_id) VALUES($1,'synthetic','Match','census_geocoder',$2,$3,$4,'point_in_county','synthetic')`,
          [hash, lat, lon, fips],
        );
      await result("a".repeat(64), "02016", 52.9, 172.9);
      await result("b".repeat(64), "39049", 39.96, -82.99);
      await expect(
        result("c".repeat(64), "39049", 52.9, 172.9),
      ).rejects.toThrow();
      await expect(result("d".repeat(64), "39049", 0, 0)).rejects.toThrow();
      await h.db.query(
        "INSERT INTO geocode_tx_run(run_id,source_shards,state) VALUES('ak-run','{}','AK')",
      );
      await expect(
        h.db.query(
          "INSERT INTO geocode_tx_run(run_id,source_shards,state) VALUES('pr-run','{}','PR')",
        ),
      ).rejects.toThrow();
    } finally {
      await h.cleanup();
    }
  }, 120_000);
});

const cacheRoot = process.env.OPENPLANS_DATA_DIR;
const payload = (() => {
  if (!cacheRoot) return undefined;
  const dir = join(cacheRoot, "raw", countySource);
  if (!existsSync(dir)) return undefined;
  const meta = readdirSync(dir)
    .filter((n) => n.endsWith(".meta.json"))
    .map(
      (n) =>
        JSON.parse(readFileSync(join(dir, n), "utf8")) as {
          url: string;
          snapshot_id: string;
          sha256: string;
        },
    )
    .find((m) => m.url === countyUrl);
  return meta && join(dir, meta.snapshot_id, "payload");
})();

// Runs where the national file is cached (operators and maintainers); CI has no download.
describe.skipIf(!payload)("cached Census 2024 county file", () => {
  let all: Map<string, County[]> | undefined;
  const load = async () => {
    if (all) return all;
    const archive = await readCountyArchive(payload!);
    all = new Map(
      geocodeStateCodes.map((code) => {
        const s = geocodeStates[code];
        return [
          code,
          buildCounties(archive.get(s.fips) ?? [], "cb", s.counties, code),
        ];
      }),
    );
    return all;
  };
  it("loads every state inside its oracle extent, 3144 counties in all", async () => {
    const states = await load();
    let total = 0;
    for (const [code, counties] of states) {
      const s = geocodeStates[code as keyof typeof geocodeStates];
      total += counties.length;
      for (const c of counties) {
        expect(c.south).toBeGreaterThanOrEqual(s.south - extentMargin);
        expect(c.north).toBeLessThanOrEqual(s.north + extentMargin);
        expect(c.west).toBeGreaterThanOrEqual(s.west - extentMargin);
        expect(c.east).toBeLessThanOrEqual(s.east + extentMargin);
      }
    }
    expect(total).toBe(3144);
  }, 60_000);
  it("puts known points in the right county and rejects the wrong one", async () => {
    const states = await load(),
      tx = states.get("TX")!,
      ak = states.get("AK")!,
      oh = states.get("OH")!;
    // Houston city hall, Harris County.
    expect(countyAt(29.7604, -95.3698, tx)?.county_fips).toBe("48201");
    expect(() => checkCountyPoint(29.7604, -95.3698, "48339", tx)).toThrow(
      "County bounds check failed",
    );
    expect(countyAt(29.7604, -95.3698, oh)).toBeUndefined();
    // Columbus, Franklin County OH.
    expect(countyAt(39.9612, -82.9988, oh)?.county_fips).toBe("39049");
    for (const counties of states.values())
      expect(countyAt(0, 0, counties)).toBeUndefined();
    // Alaska: Anchorage, Adak (west of 180°) and Attu Island (east of 180°).
    expect(countyAt(61.2181, -149.9003, ak)?.county_fips).toBe("02020");
    expect(countyAt(51.8, -176.6, ak)?.county_fips).toBe("02016");
    expect(countyAt(52.9, 172.9, ak)?.county_fips).toBe("02016");
    expect(countyAt(52.9, 172.9, tx)).toBeUndefined();
  }, 60_000);
});
