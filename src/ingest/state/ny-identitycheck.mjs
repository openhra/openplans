#!/usr/bin/env node
// Cache-only NY identity and LCSP check in an isolated, disposable database.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  rebaseImports,
  replaceSyntax,
} from "../../../scripts/source-mutation.mjs";
import { allocatePremium } from "../../../dist/domain/subsidy/dental.js";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../../../dist/db/migrate.js";
import { ingestStateRates } from "../../../dist/ingest/state/index.js";
import {
  nyLcspCatalog,
  nyRatingCounties,
  stateRatingArea,
} from "../../../dist/ingest/state/catalog.js";
import { cachedSbe } from "../../../dist/ingest/sbe/source.js";
import { importSbe } from "../../../dist/ingest/sbe/import.js";
import {
  ichraAffordability,
  nyLcspAvailability,
} from "../../../dist/services/ichra.js";

const data = resolve(
  process.argv[2] ??
    process.env.OPENPLANS_DATA_DIR ??
    join(homedir(), ".local/share/openplans"),
);
const project = fileURLToPath(new URL("../../../", import.meta.url));
const reportDir = join(data, "reports/ny-ehb-2026");
await mkdir(reportDir, { recursive: true });
const raw = spawnSync(
  "python3",
  [
    "-B",
    fileURLToPath(new URL("ny-identity.py", import.meta.url)),
    "--data-dir",
    data,
    "--report",
    join(reportDir, "sources.json"),
  ],
  { encoding: "utf8", maxBuffer: 4 * 1024 ** 2 },
);
assert.equal(raw.status, 0, raw.stderr);
const audit = JSON.parse(
  await readFile(join(reportDir, "sources.json"), "utf8"),
);
const directory = await mkdtemp("/tmp/openplans-ny-identity-");
const pg = new PGlite();
const wrap = (tx) => ({
  query: (sql, parameters) => tx.query(sql, parameters),
  exec: async (sql) => {
    await tx.exec(sql);
  },
});
const db = {
  ...wrap(pg),
  transaction: (run) => pg.transaction((tx) => run(wrap(tx))),
  close: () => pg.close(),
};
try {
  for (const file of await readdir(join(project, "migrations")))
    if (file.endsWith(".sql") && file !== "002_postgis.sql")
      await cp(join(project, "migrations", file), join(directory, file));
  await migrate(db, directory);
  const files = await cachedSbe(
    {
      state: "NY",
      year: 2026,
      url: "https://www.cms.gov/files/zip/newyorksbepuf2026.zip",
    },
    data,
  );
  const imported = await importSbe(db, {
    state: "NY",
    year: 2026,
    dataDir: data,
    files,
    acquire: false,
  });
  assert.equal(imported.passed, true);
  await ingestStateRates(
    db,
    join(data, "derived/state-rating/ny-2026.json"),
    "NY",
  );
  const catalog = await nyLcspCatalog(db, 2026);
  assert.equal(catalog.length, 1245);
  assert.equal(catalog.filter((r) => !r.exchange_evidence).length, 424);
  assert.equal(catalog.filter((r) => r.filed_identity).length, 424);
  assert.equal(
    catalog.filter((r) => r.filed_identity?.off_exchange).length,
    422,
  );
  const catalogModule = new URL(
    "../../../dist/ingest/state/catalog.js",
    import.meta.url,
  );
  const mutantCatalog = join(directory, "old-ehb-catalog.mjs");
  await writeFile(
    mutantCatalog,
    rebaseImports(
      replaceSyntax(
        (await readFile(catalogModule, "utf8")).replaceAll(
          "import.meta.url",
          JSON.stringify(catalogModule.href),
        ),
        "return normalizeEhbColumns(result);",
        'return { ...result, EHBPercentTotalPremium: raw["EHB PERCENT PREMIUM"] ?? raw.EHBPercentTotalPremium };',
      ),
      catalogModule,
    ),
  );
  const serviceModule = new URL(
    "../../../dist/services/ichra.js",
    import.meta.url,
  );
  const mutantService = join(directory, "old-ehb-service.mjs");
  await writeFile(
    mutantService,
    rebaseImports(
      replaceSyntax(
        await readFile(serviceModule, "utf8"),
        '"../ingest/state/catalog.js"',
        JSON.stringify(pathToFileURL(mutantCatalog).href),
      ),
      serviceModule,
    ),
  );
  const oldBehavior = await import(pathToFileURL(mutantService).href);
  const regions = [];
  for (const county of nyRatingCounties(2026)) {
    const region = stateRatingArea("NY", 2026, county).rating_area_id;
    const request = {
      // SYNTHETIC employee and income. All LCSP prices come from cached publications.
      planStart: "2026-01-01",
      monthsAvailable: 12,
      dateOfBirth: "1985-10-01",
      eligibleFrom: null,
      residence: { county },
      worksite: null,
      hraAnnualCents: 300000,
      income: [{ measure: "household", annualCents: 4118000 }],
      safeHarbors: { location: false, lookBack: false },
      lcspPremiumBasis: "gross",
    };
    const result = await ichraAffordability(db, request);
    const expected = audit.regions[region];
    assert.equal(
      result.status,
      "calculated",
      JSON.stringify({ region, result }),
    );
    assert.equal(result.lcsp.monthly_cents, expected.gross_lcsp_cents);
    assert.equal(result.lcsp.silver_plan_count, expected.silver_plan_count);
    assert.deepEqual(result.lcsp.plan_ids, expected.gross_lcsp_ids);
    const ehbRequest = { ...request, lcspPremiumBasis: "ehb_portion" };
    const ehb = await ichraAffordability(db, ehbRequest);
    const checkEhb = (answer) => {
      assert.equal(
        answer.status,
        "calculated",
        JSON.stringify({ region, answer }),
      );
      assert.equal(answer.lcsp.monthly_cents, expected.ehb_lcsp_cents);
      assert.deepEqual(answer.lcsp.plan_ids, expected.ehb_lcsp_ids);
      assert.equal(answer.lcsp.silver_plan_count, expected.silver_plan_count);
    };
    checkEhb(ehb);
    const before = await oldBehavior.ichraAffordability(db, ehbRequest);
    assert.equal(before.status, "incomplete_lcsp");
    assert.equal(before.reason, "ehb_allocation_unknown");
    assert.throws(() => checkEhb(before), assert.AssertionError);
    const silver = catalog.filter(
      ({ row, exchange_evidence, attributes }) =>
        row.region === region &&
        exchange_evidence &&
        attributes.every((a) => a.metal === "Silver"),
    );
    const known = (original) =>
      silver.filter(({ attributes }) =>
        attributes.every(
          (a) =>
            allocatePremium(
              100_000,
              original
                ? a.raw["EHB PERCENT PREMIUM"]
                : a.raw.EHBPercentTotalPremium,
            ) !== null,
        ),
      ).length;
    assert.equal(known(true), expected.ehb_known_before);
    assert.equal(known(false), expected.ehb_known_after);
    regions.push({
      region,
      ...expected,
      status: result.status,
      lcsp: result.lcsp,
      ehb_before_status: before.status,
      ehb_after_status: ehb.status,
      ehb_lcsp: ehb.lcsp,
    });
  }
  assert.equal((await nyLcspAvailability(db, 2026)).status, "available");
  // Disposable database mutants: no alteration of the cached source files.
  const checks = [];
  for (const [name, sql, reason] of [
    [
      "missing_silver",
      "DELETE FROM plan_attribute WHERE metal='Silver'",
      "metal_level_unknown",
    ],
    [
      "changed_filed_price",
      "UPDATE state_community_rate SET rate=jsonb_set(rate,'{prices,single}',to_jsonb((rate->'prices'->>'single')::int+1)) WHERE plan_key='41046NY0020014'",
      "metal_level_unknown",
    ],
  ]) {
    const marker = new Error("rollback NY negative control");
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.exec(sql);
        const { status, reason: actual } = await nyLcspAvailability(tx, 2026);
        assert.equal(status, "incomplete_lcsp");
        assert.equal(actual, reason);
        checks.push({ name, status, reason: actual });
        throw marker;
      }),
      (error) => error === marker,
    );
  }
  await writeFile(
    join(reportDir, "result.json"),
    JSON.stringify(
      {
        status: "PASS",
        database: "disposable PGlite; PostGIS migration omitted",
        imported: imported.import_id,
        regions,
        negative_controls: checks,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `PASS: NY identities 821 -> 1245/1245; 422 off-Exchange + 2 catastrophic; ${regions.length}/8 gross and EHB LCSP regions calculated; old EHB mutant rejected in every region; ${checks.length} negative controls`,
  );
} finally {
  await db.close();
  await rm(directory, { recursive: true, force: true });
}
