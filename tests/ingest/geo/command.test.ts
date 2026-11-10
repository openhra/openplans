import { PGlite } from "@electric-sql/pglite";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { runGeo } from "../../../src/ingest/geo/command.js";
import * as sources from "../../../src/ingest/geo/sources.js";
import type { GeoFiles } from "../../../src/ingest/geo/sources.js";
import { ratingAreaForLocation } from "../../../src/ingest/geo/repository.js";
import { coreMigrations, testDatabase } from "../../pglite.js";

const root = fileURLToPath(
  new URL("../../fixtures/sbe/geography/", import.meta.url),
);
const db = testDatabase(new PGlite());
let migrations: Awaited<ReturnType<typeof coreMigrations>>;
let directory: string;

async function files(state: string): Promise<GeoFiles> {
  const scope = JSON.parse(
    await readFile(join(root, "provenance.json"), "utf8"),
  ).states[state];
  return Object.fromEntries(
    Object.entries(scope).map(([kind, value]) => {
      const cut = value as {
        file: string;
        original: GeoFiles["relationship"]["metadata"];
        sha256: string;
        bytes: number;
      };
      return [
        kind,
        {
          path: join(root, cut.file),
          // Synthetic acquisition metadata wraps unmodified public source rows.
          metadata: { ...cut.original, sha256: cut.sha256, bytes: cut.bytes },
        },
      ];
    }),
  ) as GeoFiles;
}

async function command(state: string) {
  const lines: string[] = [],
    errors: string[] = [];
  const code = await runGeo(
    ["--state", state, "--year", "2026"],
    () => ({ ...db, close: async () => {} }),
    { out: (line) => lines.push(line), error: (line) => errors.push(line) },
    migrations.directory,
  );
  return { code, lines, errors };
}

beforeAll(async () => {
  migrations = await coreMigrations();
  directory = await mkdtemp(join(tmpdir(), "openplans-geo-command-"));
});
afterAll(async () => {
  vi.restoreAllMocks();
  await db.close();
  await migrations.cleanup();
  await rm(directory, { recursive: true, force: true });
});

it.each([
  ["CA", "San Bernadino", "sanbernardino"],
  ["GA", "Heralson", "haralson"],
  ["IL", "Vermillion", "vermilion"],
  ["MA", null, null],
  ["NM", "Dona Ana", "doaana"],
])(
  "worker ingest geo imports cached %s geography through the state adapter",
  async (state, published, censusKey) => {
    vi.spyOn(sources, "acquireGeo").mockResolvedValue(await files(state!));
    const result = await command(state!);
    expect(result.errors).toEqual([]);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.lines[0]!);
    expect(report).toMatchObject({ state, planYear: 2026 });
    expect(report.zctaCountyRows).toBeGreaterThan(0);
    expect(report.zctaCentroidRows).toBeGreaterThan(0);
    if (published)
      expect(report.countyNameCorrections).toContainEqual(
        expect.objectContaining({ published, censusKey }),
      );
    expect(
      (await db.query("SELECT state FROM geo_import WHERE state=$1", [state]))
        .rows,
    ).toEqual([{ state }]);
    if (state === "CA") {
      expect(
        await ratingAreaForLocation(db, "CA", 2026, "06037"),
      ).toMatchObject({ status: "unknown" });
      expect(
        await ratingAreaForLocation(db, "CA", 2026, "06037", "90001"),
      ).toMatchObject({
        status: "available",
        areas: [{ rating_area_id: "Rating Area 16" }],
      });
    }
    if (state === "MA")
      expect(report.constraints).toMatchObject({
        unlisted_rating_area: "unknown",
      });
  },
);

it("rejects a planted unknown CMS county and preserves the active state import", async () => {
  const valid = await files("GA");
  const body = (await readFile(valid.ratingAreas.path, "utf8")).replace(
    "Heralson",
    "Unknown synthetic county",
  );
  expect(body).toContain("Unknown synthetic county");
  const path = join(directory, "synthetic-mutant-ga.html");
  await writeFile(path, body);
  const mutant = {
    ...valid,
    ratingAreas: {
      path,
      metadata: {
        ...valid.ratingAreas.metadata,
        sha256: createHash("sha256").update(body).digest("hex"),
        bytes: Buffer.byteLength(body),
      },
    },
  };
  const before = (await db.query("SELECT * FROM geo_import WHERE state='GA'"))
    .rows;
  vi.spyOn(sources, "acquireGeo").mockResolvedValue(mutant);
  const result = await command("GA");
  expect(result.code).toBe(1);
  expect(result.errors).toEqual([
    "Geography GA PY2026 failed; previous import preserved",
  ]);
  expect(
    (await db.query("SELECT * FROM geo_import WHERE state='GA'")).rows,
  ).toEqual(before);
  expect(await ratingAreaForLocation(db, "GA", 2026, "13143")).toMatchObject({
    status: "available",
  });
});
