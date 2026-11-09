#!/usr/bin/env node
import { homedir } from "node:os";
// Real Postgres + TCP HTTP check. Requires a lane-owned, empty migrated database.
// Never points this at the shared production catalog. Raw files stay in the data cache.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { serve } from "@hono/node-server";
import { createApp } from "../../../dist/api/app.js";
import { createDatabase } from "../../../dist/db/database.js";
import { migrate } from "../../../dist/db/migrate.js";
import { ingestStateRates } from "../../../dist/ingest/state/index.js";
import {
  stateCatalog,
  stateSourceCell,
} from "../../../dist/ingest/state/catalog.js";
import { relationships } from "../../../dist/ingest/geo/parse.js";
import {
  countyPlans,
  findPlan,
  resolveLocation,
} from "../../../dist/api/repository.js";
import { estimatePremium } from "../../../dist/api/premiums.js";
import { premiumRequest } from "../../../dist/api/validation.js";
import { Readable } from "node:stream";

const data = resolve(
  process.env.OPENPLANS_DATA_DIR ??
    join(homedir(), ".local", "share", "openplans"),
);
const db = createDatabase();
const token = randomUUID(); // ephemeral, never written or logged
const report = {
  database: "Postgres 16 + PostGIS, lane-owned Docker container",
  imports: [],
  http: [],
  catalog: [],
  library_vt: [],
  issues: [],
};
let server;
try {
  await migrate(db);
  assert.equal(
    (await db.query("SELECT count(*)::int AS n FROM puf_active_catalog"))
      .rows[0].n,
    0,
    "use an isolated lane DB",
  );
  for (const state of ["NY", "VT"]) {
    const staged = await ingestStateRates(
      db,
      join(data, "derived/state-rating", `${state.toLowerCase()}-2026.json`),
      state,
    );
    report.imports.push({ ...staged, original_hashes_verified: true });
  }
  // Load unchanged Census rows for the three exercised ZIPs, preserving source row numbers.
  const digest =
    "3ed41278d637dc249e0323306f68be8a6c234e3090f4de88ef328dee71aeaaaf";
  const path = join(data, "raw/census-zcta-county-2020", digest, "payload");
  const bytes = await readFile(path);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), digest);
  const meta = JSON.parse(
    await readFile(
      join(data, "raw/census-zcta-county-2020", `${digest}.meta.json`),
      "utf8",
    ),
  );
  const snapshot = `p8c-census:${digest}`;
  await db.query(
    `INSERT INTO source(source_id,publisher,source_kind,registry_evidence)
    VALUES('p8c-census','US Census Bureau','geography',$1) ON CONFLICT DO NOTHING`,
    [JSON.stringify([meta.url])],
  );
  await db.query(
    `INSERT INTO snapshot(snapshot_id,source_id,retrieved_at,http_status,content_type,compressed_bytes,sha256,raw_path,
    expected_children,fetched_children,validation_state,activated_at)
    VALUES($1,'p8c-census',$2,200,'text/plain',$3,$4,$5,0,0,'ACTIVE',now()) ON CONFLICT DO NOTHING`,
    [snapshot, meta.fetched_at, bytes.length, digest, path],
  );
  for await (const row of relationships(Readable.from([bytes]))) {
    if (!["10001", "05401", "05602"].includes(row.zcta)) continue;
    await db.query(
      `INSERT INTO zcta_county VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
      [
        row.zcta,
        row.countyFips,
        row.countyName,
        ...row.areas,
        snapshot,
        row.rowNumber,
      ],
    );
  }
  for (const state of ["NY", "VT"])
    await db.query(
      `INSERT INTO geo_import(state,plan_year,relationship_snapshot_id,centroid_snapshot_id,rating_snapshot_id)
    VALUES($1,2026,$2,$2,$2) ON CONFLICT DO NOTHING`,
      [state, snapshot],
    );
  const app = createApp(db, { premiumToken: token });
  server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  if (!server.listening) await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const subscriber = { age: 40, tobacco: false, relationship: "subscriber" };
  const spouse = { age: 45, tobacco: false, relationship: "spouse" };
  const children = [
    { age: 10, tobacco: false, relationship: "child" },
    { age: 17, tobacco: false, relationship: "child" },
  ];
  const households = [
    [subscriber],
    [subscriber, spouse],
    [subscriber, ...children],
    [subscriber, spouse, ...children],
  ];
  for (const [state, zip, planKey, region, expected] of [
    [
      "NY",
      "10001",
      "11177NY0220001",
      "Rating Area 4",
      [127098, 254196, 216067, 362229],
    ],
    [
      "VT",
      "05401",
      "BCBSVT:Gold Plan",
      "Vermont",
      [134545, 269090, 259672, 378071],
    ],
  ]) {
    const rows = await stateCatalog(db, 2026, state, planKey, region);
    assert.equal(rows.length, 1);
    const row = rows[0];
    for (const [i, tier] of [
      "single",
      "couple",
      "adult_children",
      "family",
    ].entries()) {
      const input = {
        zip,
        ...(state === "VT"
          ? { plan_keys: [planKey] }
          : { plan_ids: [planKey] }),
        coverage_start: "2026-01-01",
        members: households[i],
        household_income_annual: 50000,
        household_size: households[i].length,
        tax_filing: i === 1 || i === 3 ? "married_filing_jointly" : "single",
      };
      const response = await fetch(`${origin}/v1/premium-quotes`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(input),
      });
      const payload = await response.json(),
        quote = payload.quotes?.[0];
      const matches =
        response.status === 200 &&
        quote?.total_cents === expected[i] &&
        quote?.quote_method === "state_filed_tier" &&
        quote?.bindable_quote === false &&
        quote?.subsidy_status === "requires_state_rules" &&
        quote?.estimated_monthly_tax_credit_cents === null;
      report.http.push({
        state,
        zip,
        plan_key: planKey,
        tier,
        expected_cents: expected[i],
        http_status: response.status,
        matches,
        quote: quote ?? payload,
        source_cell: stateSourceCell(row, tier),
      });
      if (!matches)
        report.issues.push(
          `${state} ${zip} ${tier}: native HTTP quote incomplete (${response.status})`,
        );
      if (state === "VT") {
        // Explicitly a library check, never represented as a native HTTP success.
        const request = premiumRequest({
          ...input,
          plan_keys: undefined,
          plan_ids: ["11177NY0220001"],
        });
        const plan = await findPlan(db, planKey, 2026),
          location = await resolveLocation(db, { zip });
        const result = await estimatePremium(
          db,
          plan,
          planKey,
          request,
          location,
        );
        assert.equal(result.total_cents, expected[i]);
        report.library_vt.push({ tier, quote: result });
      }
    }
    const listed = await fetch(`${origin}/v1/plans?zip=${zip}&year=2026`);
    const catalog = await listed.json();
    const available = await (
      await fetch(`${origin}/v1/data-availability?state=${state}&year=2026`)
    ).json();
    report.catalog.push({
      state,
      zip,
      http_status: listed.status,
      top_level_status: catalog.status,
      total: catalog.total,
      sample: catalog.plans?.find((p) => p.plan_key === planKey),
      data_availability: available,
    });
    if (catalog.status !== "available")
      report.issues.push(
        `${state}: plan-list route checks only puf_active_catalog (top-level ${catalog.status})`,
      );
  }
  const montpelier = await countyPlans(db, "50023", 2026, "05602");
  assert.equal(montpelier.length, 26);
  const size = await db.query(
    `SELECT pg_database_size(current_database())::text AS bytes,version() AS version`,
  );
  report.database_evidence = size.rows[0];
  report.status = report.issues.length ? "PARTIAL" : "PASS";
  const directory = join(data, "reports");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(
      directory,
      process.argv.includes("--candidate")
        ? "p8c-candidate-native-http.json"
        : "p8c-native-http.json",
    ),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      status: report.status,
      http_matched: report.http.filter((r) => r.matches).length,
      http_total: report.http.length,
      postgres_database_bytes: size.rows[0].bytes,
      issues: report.issues,
    }),
  );
  if (report.issues.length) process.exitCode = 1;
} finally {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await db.close();
}
