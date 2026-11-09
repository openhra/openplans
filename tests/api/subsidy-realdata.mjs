#!/usr/bin/env node
/** Opt-in real HTTP check; prepared private PGlite copy in the external data cache, no downloads. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { serve } from "@hono/node-server";
import { createApp } from "../../dist/api/app.js";

const path = process.env.OPENPLANS_PGLITE_DIR;
assert.ok(
  path && isAbsolute(path),
  "Set OPENPLANS_PGLITE_DIR to a private prepared real-data database copy",
);
const pg = new PGlite(path);
const db = {
  query: (sql, args) => pg.query(sql, args),
  exec: async (sql) => {
    await pg.exec(sql);
  },
};
const token = randomBytes(32).toString("hex"); // Only in memory; never printed or persisted.
let server;
try {
  const app = createApp(db, { premiumToken: token });
  await new Promise((resolve, reject) => {
    server = serve(
      { fetch: app.fetch, hostname: "127.0.0.1", port: 0 },
      resolve,
    );
    server.once("error", reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const benchmarkPath = "/v1/benchmark?zip=77002&year=2026&ages=40";
  const benchmarkResponse = await fetch(base + benchmarkPath, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(benchmarkResponse.status, 200);
  const benchmark = await benchmarkResponse.json();
  assert.equal(benchmark.status, "calculated", JSON.stringify(benchmark));
  assert.equal(benchmark.lowest_silver_plans.length, 2);
  assert.equal(
    benchmark.slcsp_monthly_cents,
    benchmark.lowest_silver_plans[1].benchmark_monthly_cents,
  );
  assert.equal(benchmark.slcsp_monthly_cents, 59176);
  const ids = ["11718TX0140016", "20069TX0100006", "87226TX0100013"];
  // SYNTHETIC household; all plan premiums and benchmark evidence come from real imported PUFs.
  const premiumResponse = await fetch(`${base}/v1/premium-estimates`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      plan_ids: ids,
      zip: "77002",
      coverage_start: "2026-01-01",
      members: [{ age: 40, tobacco: false, relationship: "subscriber" }],
      household_income_annual: 31_300,
      household_size: 1,
      tax_filing: "single",
    }),
  });
  assert.equal(premiumResponse.status, 200);
  const premiums = await premiumResponse.json();
  assert.equal(premiums.estimates.length, 3);
  assert.ok(
    premiums.estimates.every(
      (e) => e.status === "rated" && e.subsidy_status === "estimated",
    ),
  );
  for (const e of premiums.estimates) {
    assert.equal(e.slcsp_monthly_cents, benchmark.slcsp_monthly_cents);
    assert.equal(e.subsidy.fpl_percent, 200);
    assert.equal(e.subsidy.applicable_percentage, 0.066);
    assert.equal(e.subsidy.expected_contribution_annual_cents, 206600);
    assert.equal(e.subsidy.expected_contribution_monthly_cents, 17200);
    assert.equal(e.subsidy.estimated_monthly_tax_credit_cents, 41976);
    assert.equal(
      e.estimated_monthly_tax_credit_cents,
      Math.min(
        e.subsidy.enrollment_ehb_monthly_cents,
        Math.max(0, benchmark.slcsp_monthly_cents - 17_200),
      ),
    );
    assert.equal(
      e.estimated_net_monthly_cents,
      e.total_cents - e.estimated_monthly_tax_credit_cents,
    );
    assert.equal(e.quote_method, "puf_calculation");
    assert.equal(e.bindable_quote, false);
  }
  const familyBenchmarkPath = "/v1/benchmark?zip=77002&year=2026&ages=40,40,10";
  const familyBenchmarkResponse = await fetch(base + familyBenchmarkPath, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(familyBenchmarkResponse.status, 200);
  const familyBenchmark = await familyBenchmarkResponse.json();
  const familyResponse = await fetch(`${base}/v1/premium-estimates`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      plan_ids: ids,
      zip: "77002",
      coverage_start: "2026-01-01",
      members: [
        { age: 40, tobacco: false, relationship: "subscriber" },
        { age: 40, tobacco: false, relationship: "spouse" },
        { age: 10, tobacco: false, relationship: "child" },
      ],
      household_income_annual: 53300,
      household_size: 3,
      tax_filing: "married_filing_jointly",
    }),
  });
  assert.equal(familyResponse.status, 200);
  const family = await familyResponse.json();
  assert.equal(family.estimates.length, 3);
  // This prepared complete TX catalog has the cited public dental evidence; do not accept a regression to unknown.
  assert.equal(
    familyBenchmark.status,
    "calculated",
    JSON.stringify(familyBenchmark),
  );
  assert.equal(familyBenchmark.slcsp_monthly_cents, 155055);
  assert.equal(familyBenchmark.pediatric_dental.monthlyCents, 1282);
  assert.deepEqual(familyBenchmark.pediatric_dental.planIds, [
    "23891TX0010006",
  ]);
  for (const e of family.estimates) {
    assert.equal(e.status, "rated");
    assert.equal(e.subsidy_status, "estimated");
    assert.equal(e.slcsp_monthly_cents, familyBenchmark.slcsp_monthly_cents);
    assert.equal(e.subsidy.fpl_percent, 200);
    assert.equal(e.subsidy.expected_contribution_annual_cents, 351800);
    assert.equal(e.subsidy.expected_contribution_monthly_cents, 29300);
    assert.equal(
      e.estimated_monthly_tax_credit_cents,
      Math.min(
        e.subsidy.enrollment_ehb_monthly_cents,
        Math.max(0, familyBenchmark.slcsp_monthly_cents - 29300),
      ),
    );
    assert.equal(
      e.estimated_net_monthly_cents,
      e.total_cents - e.estimated_monthly_tax_credit_cents,
    );
  }
  const trimmed = (e) => ({
    plan_id: e.plan_id,
    gross_cents: e.total_cents,
    ehb_enrollment_cents: e.subsidy.enrollment_ehb_monthly_cents,
    slcsp_cents: e.slcsp_monthly_cents,
    credit_cents: e.estimated_monthly_tax_credit_cents,
    net_cents: e.estimated_net_monthly_cents,
    status: e.subsidy_status,
  });
  const report = {
    database: path,
    transport: "HTTP on 127.0.0.1, ephemeral port",
    synthetic_household: true,
    benchmark: {
      request: benchmarkPath,
      status: benchmark.status,
      slcsp_monthly_cents: benchmark.slcsp_monthly_cents,
      silver_plan_count: benchmark.silver_plan_count,
      lowest_silver_plans: benchmark.lowest_silver_plans.map((p) => ({
        plan_id: p.plan_id,
        gross_monthly_cents: p.gross_monthly_cents,
        ehb_monthly_cents: p.ehb_monthly_cents,
        ehb_fraction: p.ehb_fraction,
      })),
    },
    contribution: {
      rounding_policy: premiums.estimates[0].subsidy.rounding_policy,
      annual_cents: 206600,
      monthly_cents: 17200,
      household_credit_cents: 41976,
    },
    family: {
      ages: [40, 40, 10],
      income: 53300,
      benchmark_status: familyBenchmark.status,
      slcsp_cents: familyBenchmark.slcsp_monthly_cents,
      issues: familyBenchmark.issues,
      dental: familyBenchmark.pediatric_dental && {
        monthly_cents: familyBenchmark.pediatric_dental.monthlyCents,
        plan_ids: familyBenchmark.pediatric_dental.planIds,
        offers: familyBenchmark.pediatric_dental.offers,
      },
      lowest_silver_plans: familyBenchmark.lowest_silver_plans,
      estimates: family.estimates.map(trimmed),
    },
    premium_estimates: premiums.estimates.map((e) => ({
      plan_id: e.plan_id,
      status: e.status,
      total_cents: e.total_cents,
      slcsp_monthly_cents: e.slcsp_monthly_cents,
      estimated_monthly_tax_credit_cents: e.estimated_monthly_tax_credit_cents,
      estimated_net_monthly_cents: e.estimated_net_monthly_cents,
      subsidy_status: e.subsidy_status,
      quote_method: e.quote_method,
      bindable_quote: e.bindable_quote,
    })),
    passed: true,
  };
  const dataDir = process.env.OPENPLANS_DATA_DIR ?? dirname(path);
  await mkdir(join(dataDir, "reports"), { recursive: true });
  const reportPath = join(dataDir, "reports", "p5c-subsidy-http.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ report: reportPath, ...report }, null, 2));
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  await pg.close();
}
