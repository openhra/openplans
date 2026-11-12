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
  const artifactPath = join(data, "derived/state-rating/ny-2026.json");
  const artifact = JSON.parse(await readFile(artifactPath, "utf8"));
  const staged = await ingestStateRates(db, artifactPath, "NY");
  // Expectations follow the artifact: a refused template's rows are absent and its
  // refusal is recorded; every region it lists a possible silver plan in is unknown.
  const refusals = artifact.template_checks.filter(
    (c) => c.decision === "refused",
  );
  const refusedIssuers = new Set(refusals.flatMap((c) => c.issuer_ids));
  const records = artifact.sources.reduce((n, s) => n + s.records.length, 0);
  assert.equal(staged.records, records);
  assert.deepEqual(
    staged.unknown_issuers,
    refusals.flatMap((c) =>
      c.issuer_ids.map((issuer) => ({ issuer, reason: c.reason })),
    ),
  );
  const catalog = await nyLcspCatalog(db, 2026);
  assert.equal(catalog.length, records);
  assert.equal(
    catalog.filter((r) => refusedIssuers.has(r.row.plan_key.slice(0, 5)))
      .length,
    0,
  );
  const recorded = (
    await db.query(
      `SELECT q.source_record,q.issue_code,q.explanation,s.validation_state FROM quality_issue q
      JOIN snapshot s ON s.snapshot_id=q.snapshot_id
      WHERE starts_with(q.snapshot_id,$1) ORDER BY q.source_record`,
      [`${staged.import_id}:refused:`],
    )
  ).rows;
  assert.deepEqual(
    recorded.map((r) => [r.source_record, r.issue_code, r.validation_state]),
    refusals.flatMap((c) =>
      c.issuer_ids.map((issuer) => [issuer, c.reason, "QUARANTINED"]),
    ),
  );
  for (const row of recorded)
    assert.deepEqual(
      JSON.parse(row.explanation).listed_plans,
      refusals
        .find((c) => c.issuer_ids.includes(row.source_record))
        .listed_plans.filter((p) => p.plan_id.startsWith(row.source_record)),
    );
  const mapped = Object.values(audit.regions).reduce(
    (n, r) => n + (r.off_exchange ?? 0) + (r.catastrophic ?? 0),
    0,
  );
  const offExchange = Object.values(audit.regions).reduce(
    (n, r) => n + (r.off_exchange ?? 0),
    0,
  );
  assert.equal(catalog.filter((r) => !r.exchange_evidence).length, mapped);
  assert.equal(catalog.filter((r) => r.filed_identity).length, mapped);
  assert.equal(
    catalog.filter((r) => r.filed_identity?.off_exchange).length,
    offExchange,
  );
  // CMS metal cells for each refused plan: only one non-silver metal rules it out.
  const cmsMetals = new Map();
  for (const { base_plan_id, metal } of (
    await db.query(
      `SELECT base_plan_id,metal FROM plan_attribute WHERE state='NY' AND plan_year=2026
      AND market='Individual' AND NOT dental_only AND base_plan_id=ANY($1::text[])`,
      [refusals.flatMap((c) => c.listed_plans.map((p) => p.plan_id))],
    )
  ).rows)
    cmsMetals.set(base_plan_id, [
      ...new Set([...(cmsMetals.get(base_plan_id) ?? []), metal.toLowerCase()]),
    ]);
  const couldRank = (planId) => {
    const metals = cmsMetals.get(planId) ?? [];
    return !(
      metals.length === 1 &&
      [
        "bronze",
        "expanded bronze",
        "gold",
        "platinum",
        "catastrophic",
      ].includes(metals[0])
    );
  };
  const refusedIn = (region) =>
    refusals.flatMap((c) =>
      c.listed_plans
        .filter((p) => p.region === region && couldRank(p.plan_id))
        .map((p) => ({ ...p, reason: c.reason })),
    );
  const ignoreRefusal = join(directory, "refusal-ignored-service.mjs");
  await writeFile(
    ignoreRefusal,
    rebaseImports(
      replaceSyntax(
        await readFile(
          new URL("../../../dist/services/ichra.js", import.meta.url),
          "utf8",
        ),
        ".filter(couldRankSilver)",
        ".filter(() => false)",
      ),
      new URL("../../../dist/services/ichra.js", import.meta.url),
    ),
  );
  const withoutRefused = await import(pathToFileURL(ignoreRefusal).href);
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
    const refused = refusedIn(region);
    if (refused.length) {
      const checkUnknown = (answer) => {
        assert.equal(answer.status, "unknown", JSON.stringify({ region }));
        assert.equal(answer.reason, refused[0].reason);
        assert.equal(answer.lcsp.monthly_cents, null);
        assert.deepEqual(answer.verdicts, []);
        assert.deepEqual(
          answer.lcsp.provenance.refused_templates.map((p) => p.plan_id),
          refused.map((p) => p.plan_id).sort(),
        );
      };
      checkUnknown(result);
      const ehb = await ichraAffordability(db, {
        ...request,
        lcspPremiumBasis: "ehb_portion",
      });
      checkUnknown(ehb);
      // Planted mutant: the same request computed without the refused issuer is rejected.
      const bad = await withoutRefused.ichraAffordability(db, request);
      assert.equal(bad.status, "calculated");
      assert.equal(bad.lcsp.monthly_cents, expected.gross_lcsp_cents);
      assert.throws(() => checkUnknown(bad), assert.AssertionError);
      regions.push({
        region,
        status: result.status,
        reason: result.reason,
        refused_plans: refused.map((p) => p.plan_id),
        lcsp: result.lcsp,
        ehb_status: ehb.status,
        without_refused_issuer_rejected: {
          status: bad.status,
          gross_lcsp_cents: bad.lcsp.monthly_cents,
        },
      });
      continue;
    }
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
  const unknownRegions = regions.filter((r) => r.status === "unknown");
  assert.deepEqual(
    await nyLcspAvailability(db, 2026),
    unknownRegions.length
      ? { status: "unknown", reason: unknownRegions[0].reason }
      : { status: "available", reason: null },
  );
  // Disposable database mutants: no alteration of the cached source files. These
  // controls exercise the other candidate guards, so they set the refusal aside first.
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
        await tx.exec(
          `DELETE FROM quality_issue WHERE starts_with(snapshot_id,'${staged.import_id}:refused:')`,
        );
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
        state_import: staged.import_id,
        records,
        refusals: refusals.map((c) => ({
          url: c.url,
          filing: c.filing,
          issuer_ids: c.issuer_ids,
          reason: c.reason,
          listed_plans: c.listed_plans.length,
        })),
        regions,
        negative_controls: checks,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `PASS: NY ${catalog.length}/${records} filed rows; refused issuers ${[...refusedIssuers].join(",") || "none"} absent and recorded; ${offExchange} off-Exchange + ${mapped - offExchange} catastrophic; ${regions.length - unknownRegions.length}/${regions.length} regions calculated (old EHB mutant rejected), ${unknownRegions.length} unknown for a refused issuer (computing without it rejected); ${checks.length} negative controls`,
  );
} finally {
  await db.close();
  await rm(directory, { recursive: true, force: true });
}
