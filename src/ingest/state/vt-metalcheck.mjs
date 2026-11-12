#!/usr/bin/env node
// Cache-only evidence and service check in an isolated disposable database.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { ingestStateRates } from "../../../dist/ingest/state/index.js";
import { vtLcspCatalog } from "../../../dist/ingest/state/catalog.js";
import { cachedSbe } from "../../../dist/ingest/sbe/source.js";
import { importSbe } from "../../../dist/ingest/sbe/import.js";
import {
  ichraAffordability,
  vtLcspAvailability,
} from "../../../dist/services/ichra.js";
import { dataAvailability } from "../../../dist/services/availability.js";
import {
  rebaseImports,
  replaceSyntax,
} from "../../../scripts/source-mutation.mjs";

const data = resolve(process.argv[2] ?? process.env.OPENPLANS_DATA_DIR ?? ".");
const root = fileURLToPath(new URL("../../../", import.meta.url));
const reportDir = join(data, "reports/vt-metal-2026");
await mkdir(reportDir, { recursive: true });
const auditPath = join(reportDir, "sources.json");
const auditRun = spawnSync(
  "python3",
  [
    "-B",
    fileURLToPath(new URL("vt-metal.py", import.meta.url)),
    "--data-dir",
    data,
    "--report",
    auditPath,
  ],
  { encoding: "utf8" },
);
assert.equal(auditRun.status, 0, auditRun.stderr);
const audit = JSON.parse(await readFile(auditPath, "utf8"));
const pg = new PGlite();
const wrap = (tx) => ({
  query: (sql, args) => tx.query(sql, args),
  exec: async (sql) => {
    await tx.exec(sql);
  },
});
const db = {
  ...wrap(pg),
  transaction: (run) => pg.transaction((tx) => run(wrap(tx))),
  close: () => pg.close(),
};
const directory = await mkdtemp("/tmp/openplans-vt-metal-");
// SYNTHETIC employee and income. Plan facts and prices are cached public evidence.
const request = {
  planStart: "2026-01-01",
  monthsAvailable: 12,
  dateOfBirth: "1985-10-01",
  eligibleFrom: null,
  residence: { county: "50007" },
  worksite: null,
  hraAnnualCents: 300000,
  income: [{ measure: "household", annualCents: 4118000 }],
  safeHarbors: { location: false, lookBack: false },
  lcspPremiumBasis: "gross",
};
try {
  for (const name of (await readdir(join(root, "migrations"))).sort(
    (a, b) => parseInt(a, 10) - parseInt(b, 10),
  ))
    if (name.endsWith(".sql") && name !== "002_postgis.sql")
      await db.exec(await readFile(join(root, "migrations", name), "utf8"));
  const serviceModule = new URL(
    "../../../dist/services/ichra.js",
    import.meta.url,
  );
  const mutant = join(directory, "before-vt.mjs");
  await writeFile(
    mutant,
    rebaseImports(
      replaceSyntax(
        await readFile(serviceModule, "utf8"),
        'if (state === "NY" || state === "VT")',
        'if (state === "VT") return refuse("requires_state_rules", "state_filed_tier_pending");\n    if (state === "NY")',
      ),
      serviceModule,
    ),
  );
  const old = await import(pathToFileURL(mutant).href);
  const files = await cachedSbe(
    {
      state: "VT",
      year: 2026,
      url: "https://www.cms.gov/files/zip/vermontsbepuf2026.zip",
    },
    data,
  );
  const imported = await importSbe(db, {
    state: "VT",
    year: 2026,
    dataDir: data,
    files,
    acquire: false,
  });
  assert.equal(imported.passed, true);
  const scopes = [];
  for (const [artifact, count] of [
    ["vt-2026.json", 26],
    ["vt-2026-with-reflective.json", 34],
  ]) {
    await ingestStateRates(
      db,
      join(data, "derived/state-rating", artifact),
      "VT",
    );
    const catalog = await vtLcspCatalog(db, 2026);
    assert.equal(catalog.length, count);
    assert.equal(catalog.filter((p) => p.filed_identity).length, 26);
    assert.equal(catalog.filter((p) => p.off_exchange).length, count - 26);
    const before = await old.ichraAffordability(db, request);
    assert.equal(before.status, "requires_state_rules");
    const result = await ichraAffordability(db, request);
    assert.equal(result.status, "calculated", JSON.stringify(result));
    assert.equal(result.lcsp.monthly_cents, audit.gross_lcsp_cents);
    assert.equal(result.lcsp.silver_plan_count, audit.silver.length);
    assert.deepEqual(result.lcsp.plan_ids, [audit.silver[0].plan_key]);
    const ehb = await ichraAffordability(db, {
      ...request,
      lcspPremiumBasis: "ehb_portion",
    });
    assert.equal(ehb.status, "calculated", JSON.stringify(ehb));
    assert.equal(ehb.lcsp.monthly_cents, audit.ehb_lcsp_cents);
    assert.deepEqual(ehb.lcsp.plan_ids, [audit.silver[0].plan_key]);
    assert.equal((await vtLcspAvailability(db, 2026)).status, "available");
    const availability = await dataAvailability(db, {
      state: "VT",
      year: 2026,
    });
    assert.ok(availability.length > 0);
    assert.ok(availability.every((row) => row.ichra_status === "available"));
    const counties = [];
    for (const suffix of [
      "001",
      "003",
      "005",
      "007",
      "009",
      "011",
      "013",
      "015",
      "017",
      "019",
      "021",
      "023",
      "025",
      "027",
    ]) {
      const county = `50${suffix}`;
      const answer = await ichraAffordability(db, {
        ...request,
        residence: { county },
      });
      assert.equal(answer.status, "calculated");
      assert.equal(answer.lcsp.monthly_cents, audit.gross_lcsp_cents);
      counties.push(county);
    }
    scopes.push({
      artifact,
      count,
      counties,
      before: { status: before.status, reason: before.reason },
      gross: result,
      ehb,
    });
  }
  const controls = [];
  for (const [name, sql] of [
    [
      "wrong_metal",
      "UPDATE plan_attribute SET metal='Gold' WHERE state='VT' AND metal='Silver'",
    ],
    [
      "missing_silver",
      "DELETE FROM plan_attribute WHERE state='VT' AND metal='Silver'",
    ],
    [
      "changed_price",
      "UPDATE state_community_rate SET rate=jsonb_set(rate,'{prices,single}',to_jsonb((rate->'prices'->>'single')::int+1)) WHERE plan_key='MVP:MVP VT Silver 3'",
    ],
    [
      "inactive_attributes",
      "UPDATE snapshot SET validation_state='QUARANTINED' WHERE snapshot_id IN (SELECT snapshot_id FROM puf_import_file WHERE kind='plan-attributes')",
    ],
  ]) {
    const marker = new Error("rollback VT mutant");
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.exec(sql);
        const answer = await ichraAffordability(tx, request);
        assert.equal(answer.status, "incomplete_lcsp", JSON.stringify(answer));
        assert.equal(answer.reason, "metal_level_unknown");
        controls.push({ name, status: answer.status, reason: answer.reason });
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
        database: "isolated PGlite; PostGIS migration omitted",
        audit,
        scopes,
        negative_controls: controls,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `PASS: VT 26/26 cited metals; 8 eligible silver; gross LCSP ${audit.gross_lcsp_cents}; second silver ${audit.gross_second_silver_cents}; original and reflective catalogs; all 14 counties; ${controls.length} database mutants rejected`,
  );
} finally {
  await db.close();
  await rm(directory, { recursive: true, force: true });
}
