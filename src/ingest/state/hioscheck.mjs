#!/usr/bin/env node
// Offline full-corpus check. Requires cached original publications and a build.
// Uses a fresh, isolated PGlite database; never opens a shared serving database.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { serve } from "@hono/node-server";
import { createApp } from "../../../dist/api/app.js";
import { stateCatalog } from "../../../dist/ingest/state/catalog.js";
import { ingestStateRates } from "../../../dist/ingest/state/index.js";
import { importSbe } from "../../../dist/ingest/sbe/import.js";
import { cachedSbe, sbePublications } from "../../../dist/ingest/sbe/source.js";
import { dataDirectory } from "../../../dist/config/access.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const data = resolve(process.argv[2] ?? dataDirectory());
const work = join(data, "work/p8d"),
  reports = join(data, "reports");
await mkdir(work, { recursive: true });
await mkdir(reports, { recursive: true });
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
const token = randomUUID(); // ephemeral test credential, never persisted or logged
const previousCompatToken = process.env.OPENPLANS_COMPAT_API_KEY;
process.env.OPENPLANS_COMPAT_API_KEY = token;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const prepared = join(data, "derived/state-rating/vt-2026.json");
const report = {
  status: "PASS",
  database: "isolated ephemeral PGlite; PostGIS migration omitted",
  transport: "native and compatibility TCP HTTP on 127.0.0.1, ephemeral port",
  rule_version: "vt-hios-exact-v1",
  imports: [],
  plans: [],
  negative_controls: [],
};
let server;
try {
  for (const name of (await readdir(join(root, "migrations")))
    .filter((n) => n.endsWith(".sql") && n !== "002_postgis.sql")
    .sort()) {
    await db.exec(await readFile(join(root, "migrations", name), "utf8"));
  }
  const artifactBytes = await readFile(prepared),
    artifact = JSON.parse(artifactBytes);
  report.imports.push(await ingestStateRates(db, prepared, "VT")); // original PDF bytes verified
  const keys = (await stateCatalog(db, 2026, "VT")).map((r) => r.plan_key);
  assert.equal(keys.length, 26);
  assert.equal(new Set(keys).size, 26);
  const stateBytes = async () =>
    JSON.stringify(
      (
        await db.query(
          "SELECT * FROM state_community_rate ORDER BY import_id,source_index,record_index",
        )
      ).rows,
    );
  const pointerBytes = async () =>
    JSON.stringify(
      (
        await db.query(
          "SELECT * FROM state_rate_active ORDER BY state,plan_year",
        )
      ).rows,
    );
  const storedBefore = await stateBytes(),
    pointerBefore = await pointerBytes();
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
  server = serve({
    fetch: createApp(db, { premiumToken: token }).fetch,
    hostname: "127.0.0.1",
    port: 0,
  });
  if (!server.listening) await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, body, compatibility = false) => {
    const response = await fetch(origin + path, {
      method: body ? "POST" : "GET",
      headers: {
        "content-type": "application/json",
        ...(compatibility
          ? { "X-Api-Key": token }
          : { authorization: `Bearer ${token}` }),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const payload = await response.json();
    assert.equal(response.status, 200, `${path}: ${JSON.stringify(payload)}`);
    return payload;
  };
  const quote = async (lookup, members) =>
    (
      await request("/v1/premium-quotes", {
        ...lookup,
        county: "50007",
        coverage_start: "2026-01-01",
        members,
      })
    ).quotes[0];
  const compat = async (key) =>
    (
      await request(
        "/compat/v1/plans/medical/search",
        {
          ids: [key],
          fips_code: "50007",
          enrollment_date: "2026-01-01",
          applicants: [{ age: 40 }],
        },
        true,
      )
    ).plans[0];
  // Remove only identity evidence. Everything describing prices, source cells,
  // rules, status, household, subsidy and premium basis must remain byte-identical.
  const premiumBytes = (q, key) =>
    JSON.stringify(
      Object.fromEntries(
        Object.entries({ ...q, plan_id: key }).filter(
          ([name]) =>
            ![
              "base_plan_id",
              "hios_id",
              "hios_match",
              "hios_match_reason",
              "hios_candidates",
              "hios_match_rule",
              "hios_match_provenance",
            ].includes(name),
        ),
      ),
    );
  const before = [],
    beforeCompat = [];
  for (const key of keys) {
    const quotes = [];
    for (const members of households) {
      const q = await quote({ plan_keys: [key] }, members);
      assert.equal(q.status, "rated");
      assert.equal(q.hios_id, null);
      quotes.push(premiumBytes(q, key));
    }
    before.push(quotes);
    beforeCompat.push((await compat(key)).premium);
  }
  const link = (await sbePublications(data, false)).find(
    (l) => l.state === "VT" && l.year === 2026,
  );
  assert.ok(link, "cached VT SBE publication required");
  const files = await cachedSbe(link, data); // verifies original archive digest
  const imported = await importSbe(db, {
    ...link,
    dataDir: data,
    files,
    acquire: false,
  });
  assert.equal(imported.status, "ACTIVE");
  assert.equal(imported.serving, false);
  report.imports.push(imported);
  const independent = spawnSync(
    "python3",
    [
      fileURLToPath(new URL("./hios-oracle.py", import.meta.url)),
      prepared,
      files[0].path,
      files[0].sha256,
    ],
    { encoding: "utf8" },
  );
  assert.equal(independent.status, 0, independent.stderr);
  const oracle = JSON.parse(independent.stdout);
  const joined = await stateCatalog(db, 2026, "VT");
  const after = [];
  for (const [index, row] of joined.entries()) {
    const expected = oracle.find((r) => r.plan_key === row.plan_key);
    assert.ok(expected);
    assert.equal(row.hios_match, expected.hios_match);
    assert.equal(row.hios_id, expected.hios_id);
    assert.deepEqual(
      row.hios_candidates.map((c) => c.hios_id),
      expected.candidates,
    );
    const quotes = [],
      premiums = {};
    for (const [i, members] of households.entries()) {
      const q = await quote({ plan_keys: [row.plan_key] }, members);
      assert.equal(q.status, "rated");
      assert.equal(q.hios_id, row.hios_id);
      const bytes = premiumBytes(q, row.plan_key);
      assert.equal(
        bytes,
        before[index][i],
        "filed premium response bytes changed",
      );
      const filed = artifact.sources
        .flatMap((s) => s.records)
        .find((r) => `${r.issuer}:${r.plan_name}` === row.plan_key);
      const [whole, fraction] = filed.prices[tiers[i]].split(".");
      assert.equal(
        q.total_cents,
        Number(whole) * 100 + Number(fraction.padEnd(2, "0")),
      );
      if (row.hios_match === "matched") {
        const byHios = await quote({ plan_ids: [row.hios_id] }, members);
        assert.equal(byHios.hios_id, row.hios_id);
        assert.equal(
          premiumBytes(byHios, row.plan_key),
          bytes,
          "HIOS alias changed premium evidence",
        );
      }
      premiums[tiers[i]] = q.total_cents;
      quotes.push(bytes);
    }
    after.push(quotes);
    const facade = await compat(row.plan_key);
    assert.equal(facade.premium, beforeCompat[index]);
    assert.deepEqual(
      facade.identifiers,
      row.hios_id ? [{ type: "hios_id", value: row.hios_id }] : [],
    );
    assert.equal(facade.hios_id, row.hios_id);
    if (row.hios_id) {
      assert.equal(facade.hios_issuer_id, row.hios_id.slice(0, 5));
      assert.equal(
        (await request(`/v1/plans/${row.hios_id}?year=2026`)).plan_key,
        row.plan_key,
      );
      assert.equal(
        (
          await request(
            `/compat/v1/plans/medical/${row.hios_id}?year=2026`,
            undefined,
            true,
          )
        ).plan.plan_key,
        row.plan_key,
      );
    }
    report.plans.push({
      plan_key: row.plan_key,
      hios_match: row.hios_match,
      hios_id: row.hios_id,
      reason: row.hios_match_reason,
      tuple: expected.tuple,
      candidates: row.hios_candidates,
      provenance: row.hios_match_provenance,
      premiums,
      premium_bytes_identical: true,
    });
  }
  const listed = await request("/v1/plans?county=50007&year=2026");
  assert.equal(listed.total, 26);
  for (const row of listed.plans)
    assert.equal(
      row.hios_id,
      report.plans.find((p) => p.plan_key === row.plan_key).hios_id,
    );
  assert.equal(await stateBytes(), storedBefore);
  assert.equal(await pointerBytes(), pointerBefore);
  assert.equal(digest(await readFile(prepared)), digest(artifactBytes));
  for (const source of artifact.sources)
    assert.equal(digest(await readFile(source.raw_path)), source.sha256);
  assert.equal(digest(await readFile(files[0].path)), files[0].sha256);
  report.premium_evidence = {
    comparisons: 104,
    hios_alias_comparisons: report.plans.filter((r) => r.hios_id).length * 4,
    compatibility_single_prices: 26,
    stored_rate_rows_sha256: digest(storedBefore),
    premium_bytes_before_sha256: digest(JSON.stringify(before)),
    premium_bytes_after_sha256: digest(JSON.stringify(after)),
    stored_rate_rows_byte_identical: true,
    state_pointer_byte_identical: true,
    original_files_unchanged: true,
  };
  assert.equal(
    report.premium_evidence.premium_bytes_before_sha256,
    report.premium_evidence.premium_bytes_after_sha256,
  );
  await writeFile(join(work, "premium-before.json"), JSON.stringify(before));
  await writeFile(join(work, "premium-after.json"), JSON.stringify(after));

  for (const mode of ["renamed", "duplicate"]) {
    const mutant = structuredClone(artifact),
      record = mutant.sources[0].records.find(
        (r) => r.issuer === "BCBSVT" && r.plan_name === "Gold Plan",
      );
    if (mode === "renamed") record.plan_name += " renamed";
    else {
      const extra = structuredClone(record);
      extra.plan_name = "gold plan";
      extra.source_record += ";synthetic-duplicate";
      mutant.sources[0].records.push(extra);
    }
    const path = join(work, `synthetic-${mode}-vt.json`);
    await writeFile(path, JSON.stringify(mutant));
    const marker = new Error("synthetic rollback");
    await assert.rejects(
      db.transaction(async (tx) => {
        await ingestStateRates(
          { ...db, ...tx, transaction: (run) => run(tx) },
          path,
          "VT",
          { verifyRaw: false },
        );
        const key = `BCBSVT:${record.plan_name}`;
        const row = (await stateCatalog(tx, 2026, "VT", key))[0];
        assert.equal(row.hios_id, null);
        assert.equal(row.hios_match, mode === "renamed" ? "none" : "ambiguous");
        assert.throws(
          () => assert.equal(row.hios_id, "13627VT0340003"),
          "positive identity assertion must fail",
        );
        report.negative_controls.push({
          mode,
          status: row.hios_match,
          hios_id: row.hios_id,
          reason: row.hios_match_reason,
          candidates: row.hios_candidates.map((c) => c.hios_id),
          positive_assertion_failed: true,
        });
        throw marker;
      }),
      (error) => error === marker,
    );
  }
  assert.equal(await stateBytes(), storedBefore);
  assert.equal(await pointerBytes(), pointerBefore);
  report.counts = Object.fromEntries(
    ["matched", "ambiguous", "none"].map((status) => [
      status,
      report.plans.filter((r) => r.hios_match === status).length,
    ]),
  );
  const markdown =
    `# P8d — Vermont HIOS join\n\nStatus: PASS. Rule: vt-hios-exact-v1. ${report.database}. ${report.transport}.\n\n` +
    `All 26 filed designs: ${report.counts.matched} matched, ${report.counts.ambiguous} ambiguous, ${report.counts.none} none. Independent Python csv/zipfile identity oracle: 0 disagreements. Original PDF and CMS archive hashes verified; no downloads or shared-database writes.\n\n` +
    `| Filed plan key | Match | HIOS ID | Reason |\n| --- | --- | --- | --- |\n` +
    report.plans
      .map(
        (r) =>
          `| ${r.plan_key} | ${r.hios_match} | ${r.hios_id ?? "null"} | ${r.reason} |`,
      )
      .join("\n") +
    `\n\nPremiums: 104/104 native plan-key comparisons and ${report.premium_evidence.hios_alias_comparisons}/104 HIOS alias comparisons retain identical price/source/rule response bytes after removing only identity evidence fields. All 26 compatibility single premiums are unchanged. Before/after premium evidence SHA-256: \`${report.premium_evidence.premium_bytes_before_sha256}\`. Stored rate rows SHA-256: \`${report.premium_evidence.stored_rate_rows_sha256}\`; rate rows and active state pointer are byte-identical. All four original tier cents were independently compared to the prepared publication cells.\n\n` +
    `Native plan list/detail and premium plan_ids / plan_keys work. Compatibility key searches and key/HIOS details publish the joined HIOS identifier. Compatibility search ids filtering by HIOS remains outside this lease (router compares the internal pricing key); it is not claimed here.\n\n` +
    `Negative controls (synthetic prepared copies only; rolled back):\n\n` +
    report.negative_controls
      .map(
        (r) =>
          `- ${r.mode}: ${r.status}, hios_id null, reason ${r.reason}, candidates ${JSON.stringify(r.candidates)}; the positive identity assertion fails.`,
      )
      .join("\n") +
    `\n\nAssumptions: issuer aliases BCBSVT → 13627 and MVP → 77566 are scoped to VT and the evidenced issuer/product prefixes; metal uses the one literal metal token in the published name because the filed extraction has no separate metal cell. Expanded Bronze and Bronze share only the identity metal family. Optional BCBSVT prefix and exact bracketed MVP VT/Plus/HDHP formatting are normalized; other qualifiers, Plan, CDHP, numbers and wording remain significant. Repeated CSR rows are one base-ID candidate; duplicate base IDs or filed designs are ambiguous. The newest fully ACTIVE VT SBE set is supplemental identity evidence only.\n\n` +
    `Reproduce: npm run build; node src/ingest/state/hioscheck.mjs /absolute/data/cache. Full evidence: reports/p8d-vt-hios.json; work/p8d/premium-before.json and premium-after.json. This is a PGlite + real TCP HTTP check, not a production Postgres/PostGIS or performance claim. Offline/full gate closeout is appended by the lane after running it.\n`;
  await writeFile(
    join(reports, "p8d-vt-hios.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  await writeFile(join(reports, "p8d-vt-hios.md"), markdown);
  console.log(
    `PASS: VT HIOS: ${keys.length} designs; ${report.counts.matched} matched / ${report.counts.ambiguous} ambiguous / ${report.counts.none} none; 104 premiums byte-identical; 2 negative controls`,
  );
} finally {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (previousCompatToken === undefined)
    delete process.env.OPENPLANS_COMPAT_API_KEY;
  else process.env.OPENPLANS_COMPAT_API_KEY = previousCompatToken;
  await db.close();
}
