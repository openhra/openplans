import { PGlite } from "@electric-sql/pglite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrate } from "../../../src/db/migrate.js";
import type { Database } from "../../../src/db/database.js";
import { acquireArchive } from "../../../src/ingest/medicare/acquire.js";
import { importMedicare } from "../../../src/ingest/medicare/command.js";
import { parseArchiveUrl } from "../../../src/ingest/medicare/sources.js";
import { coreMigrations, testDatabase } from "../../pglite.js";
import { fixtureArchives, fixtureTransport, lookup } from "./helpers.js";
import type { Mutate } from "./helpers.js";

// CMS publishes contract service-area files monthly. These tests cache the real October 2026
// fixture rows under other months' URLs and member names to model which releases exist for a
// contract year.
const cms = "https://www.cms.gov/files/zip/";
const serviceArea = (kind: "pdp" | "ma", month: string) =>
  `${cms}${kind}-contract-service-area-state-county-${month}.zip`;
const landscape2026 = `${cms}cy2026-landscape-202609.zip`;
const landscape2027 = `${cms}cy2027-landscape-202611.zip`;

const monthNumbers: Record<string, string> = {
  january: "01",
  october: "10",
  december: "12",
};
/** Service-area members renamed to another month, so each month's archive has its own bytes. */
const asMonth =
  (month: string): Mutate =>
  (family, files) => {
    if (family !== "pdp" && family !== "ma") return;
    const [name, year] = month.split("-") as [string, string];
    for (const key of Object.keys(files)) {
      const renamed = key.replace(
        /_Cnty_SA_\d{4}_\d{2}\.csv$/,
        `_Cnty_SA_${year}_${monthNumbers[name]}.csv`,
      );
      if (renamed === key) continue;
      files[renamed] = files[key]!;
      delete files[key];
    }
  };

/** The CY2026 Landscape cut relabelled as CY2027 (contract year cells and member name). */
const asContractYear2027: Mutate = (family, files) => {
  if (family !== "landscape") return;
  const [name] = Object.keys(files);
  const text = files[name!]!.toString("latin1");
  delete files[name!];
  files[name!.replace("CY2026_Landscape_202609", "CY2027_Landscape_202611")] =
    Buffer.from(text.replace(/^2026,/gm, "2027,"), "latin1");
};

interface Setup {
  db: Database;
  dataDir: string;
}
const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

/** A fresh database and a cache holding only the named service-area months and Landscape cuts. */
async function setup(
  months: string[],
  landscapes: ("2026" | "2027")[] = [],
): Promise<Setup> {
  const migrations = await coreMigrations();
  const dataDir = await mkdtemp(join(tmpdir(), "medicare-sa-year-"));
  const db = testDatabase(new PGlite());
  open.push(async () => {
    await db.close();
    await migrations.cleanup();
    await rm(dataDir, { recursive: true, force: true });
  });
  await migrate(db, migrations.directory);
  const base = await fixtureArchives();
  const relabelled = await fixtureArchives(asContractYear2027);
  const archives = new Map<string, Buffer>();
  for (const month of months) {
    const renamed = await fixtureArchives(asMonth(month));
    for (const kind of ["pdp", "ma"] as const)
      archives.set(
        serviceArea(kind, month),
        renamed.get(serviceArea(kind, "october-2026"))!,
      );
  }
  if (landscapes.includes("2026"))
    archives.set(landscape2026, base.get(landscape2026)!);
  if (landscapes.includes("2027"))
    archives.set(landscape2027, relabelled.get(landscape2026)!);
  for (const url of archives.keys())
    await acquireArchive(parseArchiveUrl(url)!, {
      dataDir,
      dependencies: { lookup, transport: fixtureTransport(archives) },
    });
  return { db, dataDir };
}

const releases = async (db: Database) =>
  (
    await db.query<{
      family: string;
      as_of_label: string;
      contract_year: number;
    }>(
      "SELECT family,as_of_label,contract_year FROM medicare_release ORDER BY family,as_of_label",
    )
  ).rows;

describe("service-area release chosen for a contract year", () => {
  it("prefers the contract year's own release over an earlier one", async () => {
    const { db, dataDir } = await setup(["december-2025", "october-2026"]);
    const reports = await importMedicare(
      db,
      { year: 2026, family: "service_area" },
      dataDir,
    );
    expect(
      reports.map((r) => [
        r.as_of_label,
        r.contract_year,
        r.serves_contract_year,
      ]),
    ).toEqual([
      ["pdp-2026-10", 2026, 2026],
      ["ma-2026-10", 2026, 2026],
    ]);
  }, 60_000);

  it("falls back to the newest earlier release and records it", async () => {
    const { db, dataDir } = await setup(
      ["december-2025", "october-2026"],
      ["2027"],
    );
    const reports = await importMedicare(
      db,
      { year: 2027, family: "service_area" },
      dataDir,
    );
    // The release keeps its own year; the report names the contract year it serves.
    expect(
      reports.map((r) => [
        r.as_of_label,
        r.contract_year,
        r.serves_contract_year,
      ]),
    ).toEqual([
      ["pdp-2026-10", 2026, 2027],
      ["ma-2026-10", 2026, 2027],
    ]);
    await importMedicare(db, { year: 2027, family: "landscape" }, dataDir);
    const counts = (
      await db.query<{ counts: Record<string, number> }>(
        "SELECT counts FROM medicare_release WHERE family='landscape' AND contract_year=2027",
      )
    ).rows[0]!.counts;
    // The CY2027 Landscape release names the October 2026 files that built its county map.
    expect(counts).toMatchObject({
      county_map_pdp_release: 202610,
      county_map_ma_release: 202610,
      county_fips_unresolved: 0,
    });
  }, 60_000);

  it("never uses a release dated after the contract year", async () => {
    const { db, dataDir } = await setup(["october-2026", "january-2027"]);
    const reports = await importMedicare(
      db,
      { year: 2026, family: "service_area" },
      dataDir,
    );
    expect(reports.map((r) => r.as_of_label)).toEqual([
      "pdp-2026-10",
      "ma-2026-10",
    ]);
    expect(
      (await releases(db)).some((row) => row.as_of_label.endsWith("2027-01")),
    ).toBe(false);
  }, 60_000);

  it("refuses when only a later release is cached", async () => {
    const { db, dataDir } = await setup(["january-2027"], ["2026"]);
    await expect(importMedicare(db, { year: 2026 }, dataDir)).rejects.toThrow(
      "Import the CMS contract service-area files first",
    );
    expect(
      (await releases(db)).filter((row) => row.family === "service_area"),
    ).toEqual([]);
  }, 60_000);

  it("refuses with the existing message when no service-area file is cached", async () => {
    const { db, dataDir } = await setup([], ["2026"]);
    await expect(importMedicare(db, { year: 2026 }, dataDir)).rejects.toThrow(
      "Import the CMS contract service-area files first",
    );
  }, 60_000);

  it("leaves a county map of the contract year itself unchanged by later files", async () => {
    // A CY2026 Landscape import ignores a CY2027 service-area release already in the database.
    const { db, dataDir } = await setup(["january-2027"], ["2026"]);
    await importMedicare(db, { year: 2027, family: "service_area" }, dataDir);
    await expect(
      importMedicare(db, { year: 2026, family: "landscape" }, dataDir),
    ).rejects.toThrow("Import the CMS contract service-area files first");
  }, 60_000);
});
