#!/usr/bin/env node
// Cache-only real-corpus validation in an isolated database and loopback HTTP.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { homedir } from "node:os";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { serve } from "@hono/node-server";
import { createApp } from "../../../dist/api/app.js";
import { stateCatalog } from "../../../dist/ingest/state/catalog.js";
import { ingestStateRates } from "../../../dist/ingest/state/index.js";
import { importSbe } from "../../../dist/ingest/sbe/import.js";
import { cachedSbe, sbePublications } from "../../../dist/ingest/sbe/source.js";

const data = resolve(
  process.argv[2] ??
    process.env.OPENPLANS_DATA_DIR ??
    join(homedir(), ".local", "share", "openplans"),
);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const pg = new PGlite(),
  wrap = (tx) => ({
    query: (sql, args) => tx.query(sql, args),
    exec: (sql) => tx.exec(sql),
  });
const db = {
  ...wrap(pg),
  transaction: (run) => pg.transaction((tx) => run(wrap(tx))),
  close: () => pg.close(),
};
const previous = process.env.OPENPLANS_COMPAT_API_KEY,
  token = randomUUID();
process.env.OPENPLANS_COMPAT_API_KEY = token;
let server;
try {
  for (const name of (await readdir(join(root, "migrations")))
    .filter((n) => n.endsWith(".sql") && n !== "002_postgis.sql")
    .sort()) {
    await db.exec(await readFile(join(root, "migrations", name), "utf8"));
  }
  const path = join(data, "derived/state-rating/vt-2026.json"),
    artifact = JSON.parse(await readFile(path, "utf8"));
  await ingestStateRates(db, path, "VT"); // verifies original public PDF bytes
  const stored = async () =>
    JSON.stringify(
      (
        await db.query(
          "SELECT * FROM state_community_rate ORDER BY source_index,record_index",
        )
      ).rows,
    );
  const before = await stored();
  const publication = (await sbePublications(data, false)).find(
    (l) => l.state === "VT" && l.year === 2026,
  );
  assert.ok(publication);
  const imported = await importSbe(db, {
    ...publication,
    dataDir: data,
    files: await cachedSbe(publication, data),
    acquire: false,
  });
  assert.equal(imported.status, "ACTIVE");
  assert.equal(imported.serving, false);
  const catalog = await stateCatalog(db, 2026, "VT");
  assert.equal(catalog.length, 26);
  server = serve({
    fetch: createApp(db, { premiumToken: token }).fetch,
    hostname: "127.0.0.1",
    port: 0,
  });
  if (!server.listening) await once(server, "listening");
  const request = async (path, body, compatibility = false) => {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}${path}`,
      {
        method: body ? "POST" : "GET",
        headers: {
          "content-type": "application/json",
          ...(compatibility
            ? { "X-Api-Key": token }
            : { authorization: `Bearer ${token}` }),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
    assert.equal(response.status, 200);
    return response.json();
  };
  const list = await request("/v1/plans?county=50007&year=2026");
  assert.equal(list.total, 26);
  for (const plan of list.plans) {
    assert.equal(plan.on_exchange, true);
    assert.equal(plan.off_exchange, true);
    assert.ok(plan.provenance.exchange.source_rows.length);
    assert.ok(plan.hios_id);
  }
  const subscriber = { age: 40, tobacco: false, relationship: "subscriber" };
  const spouse = { age: 45, tobacco: false, relationship: "spouse" };
  const child = { age: 10, tobacco: false, relationship: "child" };
  const households = [
    [subscriber],
    [subscriber, spouse],
    [subscriber, child],
    [subscriber, spouse, child],
  ];
  const tiers = ["single", "couple", "adult_children", "family"];
  let comparisons = 0;
  for (const row of catalog) {
    const record = artifact.sources
      .flatMap((s) => s.records)
      .find((r) => `${r.issuer}:${r.plan_name}` === row.plan_key);
    assert.ok(record);
    for (const [index, members] of households.entries()) {
      const quote = (
        await request("/v1/premium-quotes", {
          plan_ids: [row.hios_id],
          county: "50007",
          coverage_start: "2026-01-01",
          members,
        })
      ).quotes[0];
      assert.equal(quote.status, "rated");
      assert.equal(
        quote.total_cents,
        Math.round(Number(record.prices[tiers[index]]) * 100),
      );
      comparisons++;
    }
    const facade = (
      await request(
        "/compat/v1/plans/medical/search",
        {
          ids: [row.plan_key],
          fips_code: "50007",
          applicants: [{ age: 40 }],
          enrollment_date: "2026-01-01",
        },
        true,
      )
    ).plans;
    assert.equal(facade.length, 1);
    assert.equal(facade[0].on_market, true);
    assert.equal(facade[0].off_market, true);
    assert.equal(facade[0].plan_market, "both");
    assert.equal(facade[0].hios_id, row.hios_id);
  }
  assert.equal(await stored(), before);
  await mkdir(join(data, "reports"), { recursive: true });
  await writeFile(
    join(data, "reports/p8g-vt-http.json"),
    JSON.stringify(
      {
        status: "PASS",
        scope:
          "26 existing filed plans; no additional off-exchange-only IDs in source",
        database: "isolated ephemeral PGlite; PostGIS migration omitted",
        transport: "TCP HTTP on 127.0.0.1",
        native_plans: 26,
        compatibility_plans: 26,
        filed_tier_comparisons: comparisons,
        rate_rows_byte_identical: true,
        public_source_hashes_verified: true,
        new_off_exchange_only_plans: 0,
        eight_missing_silver_plans: "source_data_gap",
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `PASS: 26 native + 26 compatibility Both-market plans; ${comparisons} filed premiums unchanged; missing eight IDs remain a source gap`,
  );
} finally {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (previous === undefined) delete process.env.OPENPLANS_COMPAT_API_KEY;
  else process.env.OPENPLANS_COMPAT_API_KEY = previous;
  await db.close();
}
