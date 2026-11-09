#!/usr/bin/env node
/** Opt-in HTTP smoke check of an already prepared real-data PGlite copy. No downloads. */
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
  "Set OPENPLANS_PGLITE_DIR to a private, prepared real-data database copy",
);
const pg = new PGlite(path);
const db = {
  query: (sql, args) => pg.query(sql, args),
  exec: async (sql) => {
    await pg.exec(sql);
  },
};
// Ephemeral credential is kept only in memory and never appears in the report.
const token = randomBytes(32).toString("hex");
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
  const plansResponse = await fetch(`${base}/v1/plans?zip=77002&year=2026`);
  assert.equal(plansResponse.status, 200);
  const plans = await plansResponse.json();
  assert.equal(plans.status, "available");
  assert.ok(plans.total > 3);
  const ids = ["11718TX0140016", "20069TX0100006", "87226TX0100013"];
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
      members: [{ age: 35, tobacco: false, relationship: "subscriber" }],
    }),
  });
  assert.equal(premiumResponse.status, 200);
  const premiums = await premiumResponse.json();
  assert.equal(premiums.estimates.length, 3);
  assert.ok(
    premiums.estimates.every((estimate) => estimate.status === "rated"),
  );
  assert.equal(
    premiums.estimates.find((estimate) => estimate.plan_id === "87226TX0100013")
      .total_cents,
    52928,
  );
  const unknown = await (
    await fetch(`${base}/v1/zip-counties?zip=77001`)
  ).json();
  assert.equal(unknown.status, "unknown");
  assert.deepEqual(unknown.counties, []);
  const availability = await (
    await fetch(`${base}/v1/data-availability?state=TX&year=2026`)
  ).json();
  const report = {
    database: path,
    transport: "HTTP on 127.0.0.1, ephemeral port",
    plans: {
      request: "/v1/plans?zip=77002&year=2026",
      status: plans.status,
      total: plans.total,
      returned: plans.plans.length,
      next_page: plans.next_page,
      sample: plans.plans.slice(0, 3).map((plan) => ({
        base_plan_id: plan.base_plan_id,
        variant_ids: plan.variant_ids,
        metal: plan.metal,
        issuer_id: plan.issuer.issuer_id,
        network_id: plan.network.network_id,
        on_exchange: plan.on_exchange,
        off_exchange: plan.off_exchange,
      })),
    },
    premium_estimates: premiums.estimates.map((estimate) => ({
      plan_id: estimate.plan_id,
      status: estimate.status,
      total_cents: estimate.total_cents,
      rating_area_id: estimate.rating_area_id,
      rate_rows_used: estimate.rate_rows_used,
      rating_rule: estimate.provenance.rating_rule,
    })),
    po_box_zip: unknown,
    availability_entries: availability.length,
    passed: true,
  };
  const dataDir = process.env.OPENPLANS_DATA_DIR ?? dirname(path);
  await mkdir(join(dataDir, "reports"), { recursive: true });
  const reportPath = join(dataDir, "reports", "p1e-api-realdata.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ report: reportPath, ...report }, null, 2));
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  await pg.close();
}
