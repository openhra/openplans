import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { coreMigrations, testDatabase } from "../../pglite.js";
import { migrate } from "../../../src/db/migrate.js";
import { createApp } from "../../../src/api/app.js";
import { countyPlans } from "../../../src/api/repository.js";
import { importPufs } from "../../../src/ingest/puf/import.js";
import type { ImportFile } from "../../../src/ingest/puf/import.js";
import { ingestGeo } from "../../../src/ingest/geo/index.js";
import { readCsv } from "../../../src/ingest/csv/index.js";
import {
  marketCatalogCensus,
  SHOP_MARKET,
} from "../../../src/ingest/puf/import-repository.js";
import { fixtureFiles } from "../../api/helpers.js";
import { fixtureFiles as geoFiles } from "../geo/helpers.js";

/** Each case runs full catalog imports, which take far longer on a loaded machine. */
const IMPORT_TEST_TIMEOUT_MS = 120_000;
const SOURCE_PLAN = "11718TX0140016";
/** Labelled synthetic: a SHOP copy of a real TX plan under an unused plan ID. */
const SYNTHETIC_SHOP_PLAN = "11718TX0140099";

async function rewrite(
  file: ImportFile,
  directory: string,
  change: (rows: Record<string, string>[]) => Record<string, string>[],
): Promise<ImportFile> {
  const rows: Record<string, string>[] = [];
  for await (const row of readCsv(Readable.from([await readFile(file.path)])))
    rows.push(row.values);
  const changed = change(rows);
  const keys = Object.keys(changed[0]!);
  const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const data = Buffer.from(
    [
      keys.map(quote).join(","),
      ...changed.map((row) => keys.map((key) => quote(row[key]!)).join(",")),
    ].join("\n") + "\n",
  );
  const path = join(directory, `synthetic-shop-${file.kind}.csv`);
  await writeFile(path, data);
  return {
    ...file,
    path,
    bytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
}

/** Appends a copy of every row of SOURCE_PLAN (and its issuer's area/network) in `market`. */
async function withCopiedPlan(
  files: ImportFile[],
  directory: string,
  market: string,
): Promise<ImportFile[]> {
  const issuer = SOURCE_PLAN.slice(0, 5);
  return Promise.all(
    files.map((file) =>
      rewrite(file, directory, (rows) => {
        const copies = rows
          .filter((row) =>
            ["service-area", "network"].includes(file.kind)
              ? row.IssuerId === issuer && row.MarketCoverage === "Individual"
              : (row.StandardComponentId ?? row.PlanId ?? "").startsWith(
                  SOURCE_PLAN,
                ),
          )
          .map((row) => {
            const copy = { ...row };
            for (const key of ["StandardComponentId", "PlanId"])
              if (copy[key])
                copy[key] = copy[key]!.replace(
                  SOURCE_PLAN,
                  SYNTHETIC_SHOP_PLAN,
                );
            if ("MarketCoverage" in copy) copy.MarketCoverage = market;
            return copy;
          });
        return [...rows, ...copies];
      }),
    ),
  );
}

interface IndividualView {
  medical: string[];
  dental: string[];
  native_total: number;
}
async function individualView(db: ReturnType<typeof testDatabase>) {
  const medical = await countyPlans(db, "48201", 2026, "77002");
  const dental = await countyPlans(db, "48201", 2026, "77002", "dental");
  const native = (await (
    await createApp(db).request("/v1/plans?zip=77002&county=48201&year=2026")
  ).json()) as { total: number };
  return {
    medical: medical.map((p) => p.base_plan_id).sort(),
    dental: dental.map((p) => p.base_plan_id).sort(),
    native_total: native.total,
  } satisfies IndividualView;
}

describe("SHOP rows stay stored behind market; individual routes unchanged", () => {
  const databases: ReturnType<typeof testDatabase>[] = [];
  let directory: string, core: Awaited<ReturnType<typeof coreMigrations>>;
  async function catalog(
    change?: (files: ImportFile[]) => Promise<ImportFile[]>,
  ) {
    const db = testDatabase(new PGlite());
    databases.push(db);
    await migrate(db, core.directory);
    await ingestGeo(db, { files: await geoFiles() });
    const base = await fixtureFiles(await mkdtemp(join(directory, "base-")));
    const files = change ? await change(base) : base;
    const report = await importPufs(db, {
      year: 2026,
      state: "TX",
      files,
      dataDir: directory,
    });
    expect(report.status).toBe("ACTIVE");
    return db;
  }
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "openplans-shop-rows-"));
    core = await coreMigrations();
  });
  afterAll(async () => {
    for (const db of databases) await db.close();
    await core.cleanup();
    await rm(directory, { recursive: true, force: true });
  });

  it(
    "keeps a SHOP plan in the census and leaves individual answers identical",
    async () => {
      const baseline = await catalog();
      const withShop = await catalog((files) =>
        withCopiedPlan(files, directory, SHOP_MARKET),
      );
      const before = await individualView(baseline);
      expect(before.medical).toContain(SOURCE_PLAN);
      expect(before.native_total).toBe(before.medical.length);
      expect(await individualView(withShop)).toEqual(before);
      const census = await marketCatalogCensus(withShop, 2026);
      expect(
        census.map(({ market, base_plans }) => ({ market, base_plans })),
      ).toEqual([
        {
          market: "Individual",
          base_plans: (await marketCatalogCensus(baseline, 2026))[0]!
            .base_plans,
        },
        { market: SHOP_MARKET, base_plans: 1 },
      ]);
      const { rows } = await withShop.query<{ market: string }>(
        "SELECT market FROM plan WHERE base_plan_id=$1",
        [SYNTHETIC_SHOP_PLAN],
      );
      expect(rows).toEqual([{ market: SHOP_MARKET }]);
    },
    IMPORT_TEST_TIMEOUT_MS,
  );

  it(
    "negative control: the same copy filed as Individual changes the individual answer",
    async () => {
      const baseline = await individualView(databases[0]!);
      const leaked = await catalog((files) =>
        withCopiedPlan(files, directory, "Individual"),
      );
      const after = await individualView(leaked);
      expect(after.medical).toContain(SYNTHETIC_SHOP_PLAN);
      expect(after).not.toEqual(baseline);
    },
    IMPORT_TEST_TIMEOUT_MS,
  );

  it(
    "a SHOP-only catalog serves its SHOP market without replacing the individual pointer",
    async () => {
      const db = databases[0]!;
      const { rows: before } = await db.query<{ import_id: string }>(
        "SELECT import_id FROM puf_active_catalog WHERE state='TX' AND plan_year=2026",
      );
      const shopOnly = await Promise.all(
        (await fixtureFiles(await mkdtemp(join(directory, "shop-only-")))).map(
          (file) =>
            rewrite(file, directory, (rows) =>
              rows
                .filter((row) => row.StateCode === "TX")
                .map((row) =>
                  "MarketCoverage" in row
                    ? { ...row, MarketCoverage: SHOP_MARKET }
                    : row,
                ),
            ),
        ),
      );
      const report = await importPufs(db, {
        year: 2026,
        state: "TX",
        files: shopOnly,
        dataDir: directory,
        publish: false,
        marketsWithoutPublish: [SHOP_MARKET],
      });
      expect(report.status).toBe("ACTIVE");
      const { rows: after } = await db.query<{ import_id: string }>(
        "SELECT import_id FROM puf_active_catalog WHERE state='TX' AND plan_year=2026",
      );
      expect(after).toEqual(before);
      const markets = await db.query<{ market: string; import_id: string }>(
        "SELECT market,import_id FROM puf_market_catalog WHERE state='TX' AND plan_year=2026 ORDER BY market",
      );
      expect(markets.rows).toEqual([
        { market: "Individual", import_id: before[0]!.import_id },
        { market: SHOP_MARKET, import_id: report.import_id },
      ]);
    },
    IMPORT_TEST_TIMEOUT_MS,
  );
});
