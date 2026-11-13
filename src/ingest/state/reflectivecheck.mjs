#!/usr/bin/env node
// Cache-only validation: original source hashes, isolated PGlite, loopback TCP.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { serve } from "@hono/node-server";
import { createApp } from "../../../dist/api/app.js";
import { ingestStateRates } from "../../../dist/ingest/state/index.js";
import { importSbe } from "../../../dist/ingest/sbe/import.js";
import { cachedSbe, sbePublications } from "../../../dist/ingest/sbe/source.js";
import { dataDirectory } from "../../../dist/config/access.js";

const data = resolve(process.argv[2] ?? dataDirectory());
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
// Ephemeral credential for both protocols, passed as options and never logged.
const token = randomUUID();
let server;
try {
  for (const name of (await readdir(join(root, "migrations")))
    .filter((n) => n.endsWith(".sql") && n !== "002_postgis.sql")
    .sort()) {
    await db.exec(await readFile(join(root, "migrations", name), "utf8"));
  }
  const originalPath = join(data, "derived/state-rating/vt-2026.json");
  const original = JSON.parse(await readFile(originalPath, "utf8"));
  const originalImport = await ingestStateRates(db, originalPath, "VT");
  const originalRows = async () =>
    JSON.stringify(
      (
        await db.query(
          `SELECT rate,raw_record,publication_snapshot_id
    FROM state_community_rate WHERE import_id=$1 ORDER BY source_index,record_index`,
          [originalImport.import_id],
        )
      ).rows,
    );
  const before = await originalRows();
  const path = join(data, "derived/state-rating/vt-2026-with-reflective.json");
  const artifact = JSON.parse(await readFile(path, "utf8"));
  const combined = await ingestStateRates(db, path, "VT"); // verifies all three original PDFs
  assert.equal(combined.records, 34);
  assert.equal(await originalRows(), before);
  const copiedOriginal = JSON.stringify(
    (
      await db.query(
        `SELECT rate,raw_record,publication_snapshot_id
    FROM state_community_rate WHERE import_id=$1 AND source_index=0 ORDER BY record_index`,
        [combined.import_id],
      )
    ).rows,
  );
  assert.equal(copiedOriginal, before);
  const publication = (await sbePublications(data, false)).find(
    (p) => p.state === "VT" && p.year === 2026,
  );
  assert.ok(publication);
  const sbe = await importSbe(db, {
    ...publication,
    dataDir: data,
    files: await cachedSbe(publication, data),
    acquire: false,
  });
  assert.equal(sbe.status, "ACTIVE");
  server = serve({
    fetch: createApp(db, { premiumToken: token, compatKey: token }).fetch,
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
  assert.equal(list.total, 34);
  const subscriber = { age: 40, tobacco: false, relationship: "subscriber" };
  const spouse = { age: 45, tobacco: false, relationship: "spouse" };
  const child = { age: 24, tobacco: false, relationship: "child" };
  const households = [
    [subscriber],
    [subscriber, spouse],
    [subscriber, child],
    [subscriber, spouse, child],
  ];
  const tiers = ["single", "couple", "adult_children", "family"];
  let existingComparisons = 0,
    reflectiveComparisons = 0,
    compatibilityComparisons = 0;
  for (const source of artifact.sources)
    for (const record of source.records) {
      const key = `${record.issuer}:${record.plan_name}`,
        isReflective = record.exchange === "Off";
      const plan = list.plans.find((p) => p.plan_key === key);
      assert.ok(plan);
      assert.equal(plan.off_exchange, true);
      assert.equal(plan.on_exchange, !isReflective);
      if (isReflective) {
        assert.equal(plan.hios_id, null);
        assert.equal(plan.metal, "Silver");
        assert.equal(plan.provenance.exchange.source_sha256, source.sha256);
        assert.equal(
          plan.provenance.exchange.source_record,
          record.source_record,
        );
      } else assert.ok(plan.hios_id);
      for (const [index, members] of households.entries()) {
        const quote = (
          await request("/v1/premium-quotes", {
            plan_keys: [key],
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
        if (isReflective) reflectiveComparisons++;
        else existingComparisons++;
      }
      const facade = (
        await request(
          "/compat/v1/plans/medical/search",
          {
            ids: [key],
            fips_code: "50007",
            applicants: [{ age: 40 }],
            enrollment_date: "2026-01-01",
          },
          true,
        )
      ).plans;
      assert.equal(facade.length, 1);
      assert.equal(facade[0].on_market, !isReflective);
      assert.equal(facade[0].off_market, true);
      assert.equal(facade[0].premium, Number(record.prices.single));
      assert.equal(facade[0].hios_id, plan.hios_id);
      compatibilityComparisons++;
    }
  assert.equal(existingComparisons, 104);
  assert.equal(reflectiveComparisons, 32);
  assert.deepEqual(artifact.sources[0], original.sources[0]);
  const report = {
    status: "PASS",
    database: "isolated ephemeral PGlite; PostGIS migration omitted",
    transport: "TCP HTTP on 127.0.0.1",
    original_source_hashes_verified: true,
    catalog_plans: 34,
    original_plans: 26,
    reflective_plans: 8,
    original_tier_comparisons: existingComparisons,
    reflective_tier_comparisons: reflectiveComparisons,
    compatibility_plans: compatibilityComparisons,
    original_rates_byte_identical: true,
    reflective_hios_ids: "unknown; no inferred or cross-year identifiers",
    publications: artifact.sources.map((s) => ({
      url: s.url,
      sha256: s.sha256,
    })),
  };
  await mkdir(join(data, "reports"), { recursive: true });
  await writeFile(
    join(data, "reports/p8h-vt-http.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    "PASS: 34 native + 34 compatibility plans; 104 unchanged original + 32 reflective tier prices; all source hashes verified",
  );
} finally {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await db.close();
}
