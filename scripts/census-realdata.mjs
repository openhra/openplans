#!/usr/bin/env node
import { copyMigrations } from "../dist/db/copy-migrations.js";
// Cached public evidence only. Persons and operator inputs are synthetic and never stored.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  cp,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { arch, cpus, loadavg, platform, totalmem } from "node:os";
import { PGlite } from "@electric-sql/pglite";
import { createDatabase } from "../dist/db/database.js";
import { migrate } from "../dist/db/migrate.js";
import { createApp } from "../dist/api/app.js";
import { ingestStateRates } from "../dist/ingest/state/index.js";
import { ichraAffordability } from "../dist/services/ichra.js";
import { ingestRatingRules } from "../dist/ingest/rating-rules/index.js";
import { ichraRequest } from "../dist/api/validation.js";
import { dataDirectory } from "../dist/config/access.js";
import { dataGeneration } from "../dist/api/cache/generation.js";
import { createRecorder, useRecorder } from "../dist/telemetry/observer.js";
import { quotePlans } from "../dist/services/quotes.js";
import { createCalculationHost } from "../dist/plugins/calculation-host.js";
import {
  censusRows,
  ichraAffordabilityBatch,
} from "../dist/services/ichra-batch.js";
import { employerCosts } from "../plugins/compare/dist/employer.js";
import { employerInput } from "../plugins/compare/dist/employer-input.js";

const data = resolve(dataDirectory());
const connection = process.env.DATABASE_URL;
assert(connection, "DATABASE_URL is required");
const url = new URL(connection);
assert(
  /^\/openplans_tpa1_[a-z0-9_]+$/.test(url.pathname),
  "Disposable database name must start with openplans_tpa1_",
);
assert(
  ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
  "Use a disposable loopback Postgres database",
);
const timing = process.argv.includes("--timing");
async function guardTiming() {
  assert(loadavg()[0] <= 30, "Host load exceeds 30");
  const work = join(data, "work");
  for (const name of await readdir(work)) {
    if (!/^rel0.*go$/.test(name)) continue;
    try {
      await readFile(join(work, name, "request-loop.pid"));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    throw new Error("Live release sentinel exists; timing refused");
  }
}
if (timing) await guardTiming();
const database = createDatabase(connection);
// Preparation can scan full public tables. API withRequest scopes keep their normal timeouts.
const db = {
  ...database,
  query: (sql, args, options) =>
    database.query(sql, args, { timeoutMs: 120000, ...options }),
  exec: async (sql) => {
    await database.query(sql, undefined, { timeoutMs: 120000 });
  },
};
const scratch = await mkdtemp(join(data, "work/tpa1-cached-"));
const report = {
  synthetic_employees: true,
  node_version: process.version,
  hardware: {
    platform: platform(),
    arch: arch(),
    cpu: cpus()[0]?.model,
    memory_bytes: totalmem(),
    load: loadavg(),
  },
  sources: [],
  equality: {
    checked: 0,
    calculated: 0,
    unresolved: 0,
    mismatches: 0,
    reasons: {},
  },
  compare_plugin_equality: {
    synthetic_census: true,
    rows: 0,
    states: [],
    mismatches: 0,
    passed: false,
  },
  coverage: {},
  privacy: {},
  timing: null,
  passed: false,
};
const tables = [
  "source",
  "snapshot",
  "puf_import",
  "puf_import_file",
  "puf_active_catalog",
  "puf_market_catalog",
  "issuer",
  "network",
  "plan",
  "plan_attribute",
  "plan_variant",
  "service_area",
  "service_area_county",
  "business_rule",
  "rate",
  "rate_plan_count",
  "state_rating_rule",
  "rating_rule_document",
  "rating_rule_set",
  "zcta_county",
  "zcta_centroid",
  "rating_area",
  "rating_area_zip",
  "geo_import",
  "sbe_catalog",
  "sbe_issuer_status",
  "state_rate_import",
  "state_community_rate",
  "state_rate_active",
  "state_vt_hios_match",
  "quality_issue",
];
const hasTies = (answer) =>
  [answer.lcsp, answer.employer_lcsp].some(
    (evidence) =>
      evidence &&
      [evidence, ...Object.values(evidence.by_basis)].some(
        (pick) => (pick?.plan_ids.length ?? 0) > 1,
      ),
  );

const quote = (name) => `"${name.replaceAll('"', '""')}"`;
async function copyPublicDatabase(source) {
  const path = join(scratch, source);
  await cp(join(data, source), path, {
    recursive: true,
    mode: constants.COPYFILE_FICLONE,
  });
  const pg = new PGlite(path);
  const wrap = (tx) => ({
    query: (sql, args) => tx.query(sql, args),
    exec: async (sql) => {
      await tx.exec(sql);
    },
  });
  const portable = {
    ...wrap(pg),
    transaction: (run) => pg.transaction((tx) => run(wrap(tx))),
  };
  const directory = join(scratch, "migrations");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(directory, { recursive: true });
  await copyMigrations(directory, ["002_postgis.sql"]);
  try {
    await migrate(portable, directory);
    const sourceReport = {
      database: source,
      tables: {},
      snapshots: (
        await pg.query(
          "SELECT snapshot_id,sha256 FROM snapshot WHERE validation_state='ACTIVE' ORDER BY snapshot_id",
        )
      ).rows,
    };
    // Disable derived-data triggers only while copying unmodified public rows into this disposable DB.
    await db.withSession(async (session) => {
      await session.exec("SET session_replication_role = replica");
      try {
        for (const table of tables) {
          const exists = await pg.query(
            "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1",
            [table],
          );
          if (!exists.rows.length) continue;
          const columns = (
            await db.query(
              "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND is_generated='NEVER' AND is_identity='NO' ORDER BY ordinal_position",
              [table],
            )
          ).rows.map((row) => row.column_name);
          if (!columns.length) continue;
          const list = columns.map(quote).join(",");
          const keys = (
            await pg.query(
              `SELECT k.column_name FROM information_schema.table_constraints c
            JOIN information_schema.key_column_usage k ON c.constraint_name=k.constraint_name
              AND c.table_schema=k.table_schema AND c.table_name=k.table_name
            WHERE c.table_schema='public' AND c.table_name=$1 AND c.constraint_type='PRIMARY KEY'
            ORDER BY k.ordinal_position`,
              [table],
            )
          ).rows.map((row) => row.column_name);
          assert(keys.length, "Public copy requires a primary key");
          let last;
          let copied = 0;
          while (true) {
            const where = last
              ? `WHERE (${keys.map(quote).join(",")}) > (${keys.map((_, i) => `$${i + 1}`).join(",")})`
              : "";
            const rows = (
              await pg.query(
                `SELECT * FROM ${quote(table)} ${where}
              ORDER BY ${keys.map(quote).join(",")} LIMIT 2000`,
                last,
              )
            ).rows;
            if (!rows.length) break;
            await session.query(
              `INSERT INTO ${quote(table)} (${list}) SELECT ${list} FROM json_populate_recordset(NULL::${quote(table)},$1::json) ON CONFLICT DO NOTHING`,
              [JSON.stringify(rows)],
            );
            copied += rows.length;
            last = keys.map((key) => rows.at(-1)[key]);
          }
          sourceReport.tables[table] = copied;
        }
      } finally {
        await session.exec("SET session_replication_role = origin");
      }
    });
    report.sources.push(sourceReport);
    console.log(
      JSON.stringify({
        source,
        public_rows_copied: Object.values(sourceReport.tables).reduce(
          (a, b) => a + b,
          0,
        ),
      }),
    );
  } finally {
    await pg.close();
    await rm(path, { recursive: true, force: true });
  }
}
const token = "synthetic-census-offline-token";
let clock = Date.now();
const options = {
  premiumToken: token,
  tpa: { enabled: true, privateIngress: true },
  now: () => {
    clock += 60001;
    return clock;
  },
};
const send = (app, route, body) =>
  app.request(route, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
const batchPath = "/v1/ichra/affordability/batch";
const envelope = (inputs) => ({
  rows: inputs.map((input, i) => ({ row: i + 1, input })),
});
const sentinels = [
  "1987-06-23",
  "1234567891",
  "987654321",
  "synthetic-census-identity-sentinel",
];
function noSentinels(text) {
  for (const sentinel of sentinels)
    assert(!text.includes(sentinel), "Census sentinel escaped request memory");
}
async function databaseDigest() {
  const result = [];
  for (const { tablename } of (
    await db.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    )
  ).rows) {
    const { rows } = await db.query(
      `SELECT count(*)::text AS n,md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' ORDER BY md5(to_jsonb(t)::text)),'')) AS digest FROM ${quote(tablename)} t`,
      undefined,
      { timeoutMs: 120000 },
    );
    result.push({ table: tablename, ...rows[0] });
    // Only sentinel booleans leave the DB, never rows or census output.
    for (const sentinel of sentinels)
      assert(
        !(
          await db.query(
            `SELECT 1 FROM ${quote(tablename)} t WHERE to_jsonb(t)::text ~ $1 LIMIT 1`,
            [
              /^\d+$/.test(sentinel)
                ? `(^|[^0-9])${sentinel}([^0-9]|$)`
                : sentinel,
            ],
            { timeoutMs: 120000 },
          )
        ).rows.length,
        "Persisted census sentinel",
      );
  }
  return result;
}
try {
  await migrate(db);
  assert.equal(
    (await db.query("SELECT count(*)::int AS n FROM puf_active_catalog"))
      .rows[0].n,
    0,
    "Database must be empty before preparation",
  );
  for (const source of [
    "puf-pglite-p6d-2026-TX",
    "puf-pglite-p6d-2026-FL",
    "sbe-pglite-2026-NY",
    "sbe-pglite-2026-GA",
    "sbe-pglite-2026-VT",
  ])
    await copyPublicDatabase(source);
  await ingestRatingRules(
    db,
    resolve(import.meta.dirname, "../data/rating-rules/2026.json"),
  );
  report.rating_rule_snapshots = (
    await db.query(
      "SELECT s.snapshot_id,s.sha256 FROM rating_rule_set r JOIN snapshot s ON s.snapshot_id=r.snapshot_id ORDER BY r.plan_year",
    )
  ).rows;
  await ingestStateRates(
    db,
    join(data, "derived/state-rating/vt-2026.json"),
    "VT",
  );
  // The disposable source caches predate aggregate manifest replay. Rebuild each top-level
  // catalog digest from its imported, hash-verified members so receipts can verify member files.
  const aggregateRows = (
    await db.query(
      `SELECT i.import_id FROM puf_import i JOIN snapshot s ON s.snapshot_id=i.import_id WHERE s.validation_state='ACTIVE' ORDER BY i.import_id`,
    )
  ).rows;
  report.receipt_manifest_normalizations = 0;
  for (const { import_id } of aggregateRows) {
    const children = (
      await db.query(
        `SELECT f.kind,s.sha256 FROM puf_import_file f JOIN snapshot s ON s.snapshot_id=f.snapshot_id WHERE f.import_id=$1`,
        [import_id],
      )
    ).rows;
    const ordered = [
      "plan-attributes",
      "service-area",
      "network",
      "business-rules",
      "rate",
      "benefits-and-cost-sharing",
    ].flatMap((kind) =>
      children
        .filter((child) => child.kind === kind)
        .map((child) => [child.kind, child.sha256]),
    );
    assert.equal(
      ordered.length,
      children.length,
      "Imported files must have known manifest order",
    );
    const manifestHash = createHash("sha256")
      .update(JSON.stringify(ordered))
      .digest("hex");
    await db.query("UPDATE snapshot SET sha256=$2 WHERE snapshot_id=$1", [
      import_id,
      manifestHash,
    ]);
    report.receipt_manifest_normalizations++;
  }
  const staleRuleSnapshots = await db.query(
    `UPDATE snapshot s SET validation_state='QUARANTINED' WHERE s.source_id='openplans-rating-rules-2026' AND s.validation_state='ACTIVE' AND NOT EXISTS (SELECT 1 FROM rating_rule_set r WHERE r.snapshot_id=s.snapshot_id)`,
  );
  report.superseded_unreferenced_rule_snapshots =
    staleRuleSnapshots.rowCount ?? 0;
  await db.exec(
    "SELECT refresh_vt_hios_matches(); UPDATE api_data_generation SET revision=revision+1; ANALYZE",
  );
  report.postgres = (
    await db.query("SELECT version() AS version")
  ).rows[0].version;
  report.generation = await dataGeneration(db);
  const compareCensus = Array.from({ length: 10 }, (_, index) => {
    const age = 31 + index;
    const county = index % 2 === 0 ? "48201" : "12086";
    return {
      employee: {
        row: index + 1,
        tier: "employee_only",
        input: { county, year: 2026, age, metal: "silver" },
      },
      affordability: {
        plan_start: "2026-01-01",
        employee: { date_of_birth: `${2026 - age}-01-01` },
        residence: { county },
        hra: { self_only_annual_cents: 0 },
        income: [{ measure: "household", annual_cents: 5_000_000 }],
        safe_harbors: { look_back: false },
        lcsp_premium_basis: "gross",
      },
    };
  });
  const censusResults = await ichraAffordabilityBatch(
    db,
    censusRows({
      rows: compareCensus.map((row, index) => ({
        row: index + 1,
        input: row.affordability,
      })),
    }),
    AbortSignal.timeout(120_000),
  );
  assert.equal(censusResults.rows.length, compareCensus.length);
  const calculationHost = createCalculationHost({ public: { quoting: true } });
  const comparison = await employerCosts(
    calculationHost,
    employerInput.parse({
      year: 2026,
      employees: compareCensus.map((row) => row.employee),
      group_quote: {
        basis: "composite_tier",
        source: {
          version: "synthetic-census-equality-v1",
          document_sha256: "a".repeat(64),
          issued_at: "2025-10-01",
          effective_at: "2026-01-01",
          expires_at: "2026-12-31",
          row_refs: compareCensus.map(
            (row) => `synthetic-row-${row.employee.row}`,
          ),
        },
        monthly_cents: {
          employee_only: 50_000,
          employee_spouse: 90_000,
          employee_children: 85_000,
          family: 120_000,
        },
      },
      contribution: { basis: "percentage", basis_points: 7500 },
      fees: [],
    }),
    { db, signal: AbortSignal.timeout(120_000) },
  );
  for (let index = 0; index < compareCensus.length; index++) {
    const item = compareCensus[index];
    const batchRow = censusResults.rows[index];
    const comparedRow = comparison.individual[index];
    assert.equal(batchRow?.status, "calculated", `census row ${index + 1}`);
    assert.equal(comparedRow?.row, index + 1);
    const censusPremium = batchRow.result.lcsp?.by_basis.gross?.monthly_cents;
    const comparedPremium = comparedRow.comparison.statistics.lowest_cents;
    assert.notEqual(censusPremium, null, `census premium row ${index + 1}`);
    assert.equal(
      comparedPremium,
      censusPremium,
      `plugin equality row ${index + 1}`,
    );
    const quotes = [];
    let page = 1;
    while (page !== null) {
      const quotePage = await quotePlans(db, {
        year: 2026,
        county: item.employee.input.county,
        metal: "silver",
        members: [{ age: item.employee.input.age }],
        page,
      });
      quotes.push(...quotePage.quotes);
      page = quotePage.next_page;
    }
    const ratedQuotes = quotes.filter((quote) => quote.status === "rated");
    assert(ratedQuotes.length, `rated quotes row ${index + 1}`);
    const quotePremium = Math.min(
      ...ratedQuotes.map((quote) => quote.total_cents),
    );
    assert.equal(
      comparedPremium,
      quotePremium,
      `quote engine row ${index + 1}`,
    );
  }
  report.compare_plugin_equality = {
    synthetic_census: true,
    rows: comparison.individual.length,
    states: ["TX", "FL"],
    mismatches: 0,
    passed: true,
  };
  const multi = (
    await db.query(
      "SELECT zcta FROM zcta_county WHERE county_fips LIKE '48%' GROUP BY zcta HAVING count(DISTINCT county_fips)>1 ORDER BY zcta LIMIT 1",
    )
  ).rows[0]?.zcta;
  assert(multi, "Cached multi-county ZIP required");
  const limited = (
    await db.query(
      "SELECT county_fips FROM service_area_county WHERE county_fips IS NOT NULL AND NOT dental_only AND market='Individual' AND partial_county AND zip_codes<>'' ORDER BY county_fips LIMIT 1",
    )
  ).rows[0]?.county_fips;
  const scopes = (
    await db.query(
      "SELECT DISTINCT county_fips FROM service_area_county WHERE state IN ('TX','FL') AND county_fips IS NOT NULL AND NOT dental_only AND market='Individual' ORDER BY county_fips",
    )
  ).rows.map((r) => r.county_fips);
  const scenario = (i) => {
    let plan_start = "2026-01-01";
    if (i % 17 === 0) plan_start = "2027-01-01";
    else if (i % 11 === 0) plan_start = "2026-07-01";
    let residence = { county: scopes[i % scopes.length] };
    if (i % 13 === 0) residence = { zip: multi };
    else if (i % 7 === 0) residence = { county: "50007" };
    let income = [{ measure: "household", annual_cents: 1234567891 }];
    if (i % 3 === 0)
      income = [
        {
          measure: "w2",
          annual_cents: 1234567891,
          w2_months_offered: 6,
          w2_months_employed: 10,
        },
      ];
    else if (i % 3 === 1)
      income = [
        {
          measure: "rate_of_pay_salary",
          monthly_cents: 400000,
          salary_reduced: true,
        },
      ];
    return {
      plan_start,
      employee: {
        date_of_birth: sentinels[0],
        ...(i % 11 === 0 ? { eligible_from: "2026-10-01" } : {}),
      },
      residence,
      hra: { self_only_annual_cents: 987654321 },
      income,
      ...(i % 3 === 0 ? { months_available: 6 } : {}),
      safe_harbors: { look_back: i % 5 === 0 },
      lcsp_premium_basis: i % 2 ? "gross" : "ehb_portion",
    };
  };
  const inputs = Array.from({ length: 100 }, (_, i) => scenario(i));
  inputs[1] = {
    ...scenario(1),
    residence: { county: "48201" },
    income: [{ measure: "household", annual_cents: 1234567891 }],
  };
  inputs[2] = { ...scenario(2), residence: { county: "12086" } };
  inputs[3] = {
    ...scenario(3),
    residence: { county: "50007" },
    lcsp_premium_basis: "gross",
  };
  inputs[4] = { ...scenario(4), residence: { county: "99001" } };
  inputs[8] = { ...scenario(8), residence: { county: "36061" } };
  inputs[9] = { ...scenario(9), residence: { county: "13121" } };
  inputs[10] = { ...scenario(10), residence: { county: "50007" } };
  if (limited) inputs[6] = { ...scenario(6), residence: { county: limited } };
  // Select a real tied premium basis from the same deterministic sample, without changing rates.
  for (let index = 0; index < inputs.length && !report.tie_evidence; index++) {
    const answer = await ichraAffordability(db, ichraRequest(inputs[index]), {
      allowCmsLive: false,
    });
    for (const [purpose, evidence] of [
      ["residence", answer.lcsp],
      ["employer", answer.employer_lcsp],
    ]) {
      if (!evidence) continue;
      for (const [basis, pick] of Object.entries(evidence.by_basis)) {
        if ((pick?.plan_ids.length ?? 0) < 2) continue;
        inputs[index] = { ...inputs[index], lcsp_premium_basis: basis };
        report.tie_evidence = {
          synthetic_scenario: index + 1,
          purpose,
          basis,
          public_plan_ids: pick.plan_ids,
          county: evidence.location.county_fips,
          identified_at_age: evidence.identified_at_age,
          priced_at_age: evidence.priced_at_age,
        };
        break;
      }
      if (report.tie_evidence) break;
    }
  }
  assert(
    report.tie_evidence,
    "Sample requires a real tied public premium basis",
  );
  console.log("PASS real public tie selected");
  report.generation = await dataGeneration(db);
  const before = await databaseDigest();
  const logs = [];
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  const cache = [];
  const recorder = createRecorder();
  useRecorder(recorder);
  const app = createApp(db, options, {
    store: {
      get: async (key) => {
        cache.push(key);
        return null;
      },
      set: async (...args) => {
        cache.push(args);
      },
      bytes: () => 0,
    },
  });
  const examples = [];
  try {
    for (const method of Object.keys(original))
      console[method] = (...args) => logs.push(args);
    for (let offset = 0; offset < inputs.length; offset += 25) {
      clock += 60001;
      const response = await send(
        app,
        batchPath,
        envelope(inputs.slice(offset, offset + 25)),
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const batch = await response.json();
      assert.equal(batch.rows.length, 25);
      for (let row = 0; row < 25; row++) {
        const single = await send(
          app,
          "/v1/ichra/affordability",
          inputs[offset + row],
        );
        assert.equal(single.status, 200);
        const answer = await single.json();
        assert.equal(
          JSON.stringify(batch.rows[row].result),
          JSON.stringify(answer),
          "employee equality test",
        );
        report.equality.checked++;
        const reason = answer.reason ?? answer.status;
        report.equality.reasons[reason] =
          (report.equality.reasons[reason] ?? 0) + 1;
        report.equality[
          answer.status === "calculated" ? "calculated" : "unresolved"
        ]++;
        if (hasTies(answer)) report.coverage.ties = true;
        if (
          answer.quote_method === "state_filed_tier" &&
          answer.status === "calculated"
        )
          report.coverage.filed_tier = true;
        examples.push(answer);
      }
    }
    clock += 60001;
    const bad = await send(
      app,
      batchPath,
      envelope([{ ...inputs[1], name: sentinels[3] }]),
    );
    const badBody = await bad.text();
    assert.equal(bad.status, 200);
    noSentinels(badBody);
    const denied = await app.request(batchPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope([inputs[1]])),
    });
    assert.equal(denied.status, 401);
    noSentinels(await denied.text());
  } finally {
    Object.assign(console, original);
    useRecorder(undefined);
  }
  noSentinels(JSON.stringify([logs, cache, recorder.aggregate.snapshot()]));
  assert.equal(cache.length, 0, "Census cache bypass test");
  assert.deepEqual(
    await databaseDigest(),
    before,
    "Census database write test",
  );
  report.privacy = {
    logs_scanned: true,
    cache_reads_and_writes: cache.length,
    metrics_scanned: true,
    all_database_tables_unchanged: true,
    database_sentinels_absent: true,
  };
  report.coverage.multi_county_zip = examples.some(
    (r) => r.reason === "location_ambiguous",
  );
  report.coverage.missing_lookback = examples.some(
    (r) => r.reason === "lookback_catalog_not_loaded",
  );
  report.coverage.unloaded_year = examples.some(
    (r) => r.reason === "catalog_not_loaded",
  );
  report.coverage.mixed_states = [
    ...new Set(
      ["TX", "FL", "NY", "GA", "VT", report.tie_evidence?.state].filter(
        Boolean,
      ),
    ),
  ];
  report.coverage.zip_limited_county = limited ?? "not_loaded";
  for (const key of [
    "multi_county_zip",
    "missing_lookback",
    "unloaded_year",
    "filed_tier",
    "ties",
  ])
    assert(report.coverage[key], `Required sample missing ${key}`);
  // Disposable answer mutations prove the exact-byte and no-log-value checks reject defects.
  assert.throws(() =>
    assert.equal(
      JSON.stringify({ ...examples[1], monthly_hra_cents: 1 }),
      JSON.stringify(examples[1]),
      "employee equality test",
    ),
  );
  assert.throws(() => noSentinels(`income=${sentinels[1]}`));
  // A real concurrent publication changes rates after the repeatable-read snapshot is pinned.
  const chosen = examples[1].lcsp?.plan_ids[0];
  assert(
    chosen,
    "Concurrent publication control requires a calculated TX answer",
  );
  let published = false;
  const publishing = {
    ...db,
    withRequest: (signal, run, options) =>
      db.withRequest(
        signal,
        (session) =>
          run({
            ...session,
            query: async (sql, args, queryOptions) => {
              const answer = await session.query(sql, args, queryOptions);
              if (sql.includes("api_data_generation") && !published) {
                await db.query(
                  "UPDATE rate SET individual_rate_cents=individual_rate_cents+1 WHERE base_plan_id=$1 AND individual_rate_cents IS NOT NULL",
                  [chosen],
                );
                published = true;
              }
              return answer;
            },
          }),
        options,
      ),
  };
  try {
    clock += 60001;
    const response = await send(
      createApp(publishing, options),
      batchPath,
      envelope(Array.from({ length: 25 }, () => inputs[1])),
    );
    assert.equal(response.status, 200);
    const pinned = await response.json();
    assert(published);
    for (const row of pinned.rows)
      assert.equal(
        JSON.stringify(row.result),
        JSON.stringify(examples[1]),
        "Snapshot publication test",
      );
    assert.notEqual(pinned.provenance.generation, await dataGeneration(db));
    const changed = await (
      await send(app, "/v1/ichra/affordability", inputs[1])
    ).json();
    assert.notEqual(
      JSON.stringify(changed),
      JSON.stringify(examples[1]),
      "Publication mutant must change a fresh answer",
    );
    report.coverage.concurrent_publication_pinned = true;
  } finally {
    if (published)
      await db.query(
        "UPDATE rate SET individual_rate_cents=individual_rate_cents-1 WHERE base_plan_id=$1 AND individual_rate_cents IS NOT NULL",
        [chosen],
      );
  }
  console.log(
    "PASS 100 employee answers, privacy scans and pinned publication",
  );
  if (timing) {
    await guardTiming();
    console.log("Measuring 100 warm 25-row batches with two clients");
    const percentiles = (values) => {
      const sorted = [...values].sort((a, b) => a - b);
      return {
        p50_ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
        p95_ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
        runs: sorted.length,
      };
    };
    const benchmarkApp = createApp(db, options);
    const clients = [benchmarkApp, benchmarkApp];
    const payload = envelope(
      Array.from({ length: 25 }, (_, i) => ({
        ...inputs[1],
        hra: { self_only_annual_cents: 987654321 + i },
        employee: { date_of_birth: `${1960 + i}-10-17` },
      })),
    );
    const elapsed = async (client, route, body) => {
      const start = performance.now();
      const response = await send(client, route, body);
      assert.equal(response.status, 200);
      await response.text();
      return performance.now() - start;
    };
    const cold = await elapsed(clients[0], batchPath, payload);
    const baselineClient = createApp(db, {
      ...options,
      tpa: { enabled: false, privateIngress: false },
    });
    const beforeSingle = [];
    for (let i = 0; i < 100; i++)
      beforeSingle.push(
        await elapsed(baselineClient, "/v1/ichra/affordability", inputs[1]),
      );
    const batches = [];
    for (let i = 0; i < 50; i++) {
      await guardTiming();
      batches.push(
        ...(await Promise.all(
          clients.map((client) => elapsed(client, batchPath, payload)),
        )),
      );
    }
    const afterSingle = [];
    for (let i = 0; i < 100; i++)
      afterSingle.push(
        await elapsed(clients[0], "/v1/ichra/affordability", inputs[1]),
      );
    report.timing = {
      transport:
        "in-process HTTP handler on native Postgres, full JSON consumption",
      concurrency: 2,
      admission_clock:
        "synthetic minute advance per admission to measure computation without exceeding work budget",
      first_uniform_batch_after_validation_ms: cold,
      baseline:
        "single-employee route with census disabled, same pinned public data",
      batch: percentiles(batches),
      single_before: percentiles(beforeSingle),
      single_after: percentiles(afterSingle),
      load: loadavg(),
    };
    report.timing.batch_target_met = report.timing.batch.p95_ms <= 3000;
    report.timing.single_regression_within_ten_percent =
      report.timing.single_after.p95_ms <=
      report.timing.single_before.p95_ms * 1.1;
  }
  report.passed = true;
  const outputReport = timing
    ? join(data, "work/tpa1/realdata.json")
    : join(data, "work/tpa2pg/batch-privacy.json");
  await writeFile(outputReport, JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify(
      {
        ...report,
        sources: report.sources.map((r) => ({
          database: r.database,
          tables: r.tables,
          snapshots: r.snapshots.length,
        })),
      },
      null,
      2,
    ),
  );
} finally {
  useRecorder(undefined);
  await db.close();
  await rm(scratch, { recursive: true, force: true });
}
