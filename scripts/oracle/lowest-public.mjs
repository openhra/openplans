#!/usr/bin/env node
// Offline public-catalog audit. Only an explicitly disposable loopback database is accepted.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { cpus, totalmem, loadavg } from "node:os";
import { importDataDirectory } from "../../dist/ingest/puf/import-source.js";
import { createDatabase } from "../../dist/db/database.js";
import { migrate } from "../../dist/db/migrate.js";
import { lowestInput } from "../../dist/api/handy.js";
import {
  lowestPremiums,
  getMarketSummary,
  householdHandy,
} from "../../dist/services/handy.js";
import { buildLowestPremiums } from "../../dist/worker/handy-build.js";
import {
  callLowestTool,
  callMarketSummaryTool,
  callBenchmarkTool,
} from "../../dist/mcp/handy.js";
import { benchmarkSilver } from "../../dist/services/catalog.js";
import { createApp } from "../../dist/api/app.js";
import {
  createResponseCache,
  responseCacheFor,
} from "../../dist/api/cache/index.js";
import { MemoryCache } from "../../dist/api/cache/store.js";
import { loadConfig } from "../../dist/config/index.js";
import { MAX_OUTPUT_BYTES } from "../../dist/mcp/tools.js";
import { checkHouseholdEnumeration } from "./handy-household.mjs";

const args = process.argv.slice(2);
const argument = (name, fallback) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const url = new URL(
  process.env.DATABASE_URL ?? "postgresql://localhost/invalid",
);
assert(
  args.includes("--disposable"),
  "Pass --disposable only for a disposable clone",
);
assert(
  ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
  "Loopback only",
);
assert(
  url.pathname.endsWith("_lowest_public"),
  "Database name must end in _lowest_public",
);
const publicOnly = args.includes("--public-scope");
const destination = argument("--report", "/tmp/lowest-public.json");
await mkdir(dirname(destination), { recursive: true });
const samples = Number(argument("--samples", "200"));
assert(Number.isInteger(samples) && samples >= 200);
async function admission() {
  assert(loadavg()[0] <= 30, "Host load exceeds lane timing limit");
  const work = join(importDataDirectory(), "work");
  let names;
  try {
    names = await readdir(work);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const name of names.filter((n) => /^rel0.*go$/.test(n))) {
    let pid;
    try {
      pid = Number(
        (await readFile(`${work}/${name}/request-loop.pid`, "utf8")).trim(),
      );
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") continue;
      throw error;
    }
    throw new Error(
      "Active public release: wait before running the catalog audit",
    );
  }
}
await admission();
const db = createDatabase(url.href);
const report = {
  passed: false,
  exposure_scope: publicOnly ? "single_age_silver" : "full",
  hardware: {
    cpu: cpus()[0]?.model,
    memory_bytes: totalmem(),
    node: process.version,
  },
  samples_per_path: samples,
  concurrency: 4,
  scopes: [],
  correctness: [],
  latency: [],
  failures: [],
};
const members = [
  { age: 40, relationship: "subscriber", tobacco: false },
  { age: 40, relationship: "spouse", tobacco: false },
  { age: 10, relationship: "child", tobacco: false },
  { age: 8, relationship: "child", tobacco: false },
];
let queries = 0,
  rows = 0;
const instrument = (session) => ({
  ...session,
  query: async (...args) => {
    queries++;
    const result = await session.query(...args);
    rows += result.rows.length;
    return result;
  },
  withRequest: session.withRequest
    ? (signal, run, options) =>
        session.withRequest(signal, (tx) => run(instrument(tx)), options)
    : undefined,
});
const measured = instrument(db);
const p = (values, q) =>
  values.slice().sort((a, b) => a - b)[
    Math.min(values.length - 1, Math.ceil(values.length * q) - 1)
  ];
const timing = async (name, run, target) => {
  await admission();
  const initial = [],
    warm = [],
    failures = [];
  for (let i = 0; i < 4; i++) {
    const start = performance.now();
    await run(i);
    initial.push(performance.now() - start);
  }
  queries = 0;
  rows = 0;
  let next = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (next < samples) {
        const i = next++;
        const start = performance.now();
        try {
          await run(i);
        } catch (e) {
          failures.push(e.message);
        }
        warm.push(performance.now() - start);
      }
    }),
  );
  const result = {
    name,
    requests: samples,
    first_request_ms: initial,
    p50_ms: p(warm, 0.5),
    p95_ms: p(warm, 0.95),
    target_ms: target,
    meets_target: p(warm, 0.95) <= target && !failures.length,
    queries,
    returned_rows: rows,
    timeouts: failures.filter((s) => /timeout|deadline/i.test(s)).length,
    failures,
  };
  report.latency.push(result);
  console.log(
    `${name}: p95=${result.p95_ms.toFixed(1)}ms target=${target}ms failures=${failures.length}`,
  );
};
try {
  const maintenance = (session) => ({
    ...session,
    query: (sql, values) => session.query(sql, values, { timeoutMs: 120000 }),
    exec: async (sql) => {
      await session.query(sql, [], { timeoutMs: 120000 });
    },
  });
  await migrate({
    ...db,
    ...maintenance(db),
    transaction: (run) => db.transaction((tx) => run(maintenance(tx))),
    withSession: (run) => db.withSession((tx) => run(maintenance(tx))),
  });
  report.database_bytes = (
    await db.query("SELECT pg_database_size(current_database())::text AS bytes")
  ).rows[0].bytes;
  report.scopes = (
    await db.query(
      "SELECT state,plan_year,count(*)::int AS plans FROM plan GROUP BY state,plan_year ORDER BY plan_year,state",
    )
  ).rows;
  report.table_counts = (
    await db.query(
      "SELECT relname,n_live_tup FROM pg_stat_user_tables WHERE relname IN ('plan','rate','service_area_county','snapshot') ORDER BY relname",
    )
  ).rows;
  report.snapshots = (
    await db.query(
      "SELECT snapshot_id,sha256,retrieved_at FROM snapshot WHERE validation_state='ACTIVE' ORDER BY snapshot_id",
    )
  ).rows;
  const cases = [
    { zip: "77002", county: "48201", year: 2026 },
    { zip: "77002", county: "48201", year: 2027 },
    { zip: "33101", county: "12086", year: 2026 },
    { zip: "33101", county: "12086", year: 2027 },
    { zip: "99501", county: "02020", year: 2026 },
    { zip: "82001", county: "56021", year: 2027 },
  ];
  for (const scope of cases) {
    const input = lowestInput({ ...scope, age: 40 });
    await buildLowestPremiums(db, input);
    const fast = await lowestPremiums(db, input),
      slow = await lowestPremiums(db, input, { slow: true });
    assert.deepEqual(
      fast,
      slow,
      "Derived and complete enumeration answers differ",
    );
    if (scope.county === "48201") {
      const files = (
        await db.query(
          `SELECT f.kind,s.sha256 FROM puf_import_file f
        JOIN snapshot s USING(snapshot_id) JOIN puf_active_catalog a USING(import_id)
        WHERE a.state='TX' AND a.plan_year=$1 AND f.kind=ANY($2::text[])`,
          [scope.year, ["plan-attributes", "service-area", "rate"]],
        )
      ).rows;
      assert.equal(files.length, 3);
      const command = [];
      for (const file of files) {
        const path = join(
          importDataDirectory(),
          "raw",
          "cms-exchange-puf",
          file.sha256,
          "payload",
        );
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(path)) hash.update(chunk);
        assert.equal(hash.digest("hex"), file.sha256, "Cached source checksum");
        command.push(`--${file.kind}`, path);
      }
      const request = join(
        dirname(destination),
        `raw-TX-${scope.year}-input.json`,
      );
      const output = join(dirname(destination), `raw-TX-${scope.year}.json`);
      const area = (
        await db.query(
          "SELECT rating_area_id FROM rating_area WHERE county_fips=$1 AND plan_year=$2",
          [scope.county, scope.year],
        )
      ).rows[0].rating_area_id;
      await writeFile(
        request,
        JSON.stringify({
          state: "TX",
          year: scope.year,
          cases: [
            {
              county: scope.county,
              rating_area: area,
              age: 40,
              month: `${scope.year}-01-01`,
            },
          ],
        }),
      );
      await promisify(execFile)(
        "python3",
        [
          fileURLToPath(new URL("./ichra-reference.py", import.meta.url)),
          ...command,
          "--cases",
          request,
          "--output",
          output,
        ],
        { timeout: 120000 },
      );
      const raw = JSON.parse(await readFile(output, "utf8")).cases[0];
      assert.equal(fast.status, raw.bases.gross.status);
      assert.equal(fast.lowest.monthly_cents, raw.bases.gross.monthly_cents);
      assert.deepEqual(fast.ties, raw.bases.gross.plan_ids);
      assert.equal(fast.candidate_count, raw.silver_plan_count);
      report.correctness.push({
        scope,
        raw_file_checksums: files,
        raw_gross: raw.bases.gross,
      });
    }
    const household = await checkHouseholdEnumeration(
      db,
      { ...scope, members },
      false,
    );
    const deps = {
      db,
      lowestPremiums: true,
      lowestPremiumsScope: "full",
      principal: { id: "audit" },
      policy: { canEstimate: () => true },
    };
    const minimum = await callLowestTool(deps, input);
    assert(!minimum.isError, "MCP single-age minimum refused");
    const summary = await getMarketSummary(db, { ...scope, age: 40 });
    const mcpSummary = await callMarketSummaryTool(deps, { ...scope, age: 40 });
    assert(!mcpSummary.isError, JSON.stringify(mcpSummary));
    assert.deepEqual(mcpSummary.structuredContent, summary);
    const benchmark = await benchmarkSilver(db, {
      ...scope,
      year: String(scope.year),
      ages: "40,40,10,8",
    });
    const mcpBenchmark = await callBenchmarkTool(deps, {
      year: scope.year,
      location: { zip: scope.zip, county: scope.county },
      ages: [40, 40, 10, 8],
    });
    assert(!mcpBenchmark.isError, JSON.stringify(mcpBenchmark));
    const { basis, ...native } = mcpBenchmark.structuredContent;
    assert.deepEqual(native, benchmark);
    const householdInput = { ...scope, members };
    const householdMinimum = await householdHandy(db, householdInput);
    for (const [call, summaryMode] of [
      [callLowestTool, false],
      [callMarketSummaryTool, true],
    ]) {
      const answer = await call(deps, householdInput);
      assert(!answer.isError, JSON.stringify(answer));
      const expected = await householdHandy(db, householdInput, summaryMode);
      const { next_cursor, ...content } = answer.structuredContent;
      assert.deepEqual(content, expected);
      assert(
        Buffer.byteLength(JSON.stringify(answer)) + 4096 <= MAX_OUTPUT_BYTES,
      );
    }
    report.correctness.push({
      scope,
      status: fast.status,
      candidates: fast.candidate_count,
      household_status: householdMinimum.status,
      summary_status: summary.status,
      benchmark_status: benchmark.status,
      enumeration: household.results,
    });
    console.log(
      `correctness ${scope.county}/${scope.year}: ${fast.status}, ${fast.candidate_count} candidates`,
    );
  }
  const scope = cases[0],
    input = lowestInput({ ...scope, age: 40 });
  const winner = (await lowestPremiums(db, input)).lowest.plan_id;
  assert(winner);
  const rollback = new Error("synthetic missing-rate rollback");
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.query("DELETE FROM rate WHERE base_plan_id=$1", [winner]);
      const refused = await lowestPremiums(tx, input);
      assert.equal(refused.status, "unknown");
      assert.equal(refused.lowest.monthly_cents, null);
      report.missing_rate_mutant = {
        status: refused.status,
        reason: refused.reason,
      };
      throw rollback;
    }),
    (e) => e === rollback,
  );
  for (const call of [callLowestTool, callMarketSummaryTool, callBenchmarkTool])
    assert((await call({ db, lowestPremiums: false }, input)).isError);
  report.flag_off_mutant = "all three direct tool calls refused";
  for (const other of [
    { zip: "77002", year: 2026 },
    { county: "36061", year: 2027 },
    { county: "48201", year: 2028 },
  ]) {
    const result = await lowestPremiums(db, { ...other, age: 40 });
    if (other.year === 2028) {
      assert.equal(result.status, "unknown");
      assert.equal(result.lowest.monthly_cents, null);
    }
    report.correctness.push({
      scope: other,
      status: result.status,
      reason: result.reason,
    });
  }
  if (!args.includes("--skip-timing")) {
    const inputs = cases.map((scope) => lowestInput({ ...scope, age: 40 }));
    const cache = createResponseCache(measured, undefined, {
      config: loadConfig({}, { version: 1, cache: { enabled: true } }),
      store: new MemoryCache(64 * 1024 * 1024),
    });
    for (const input of inputs)
      await lowestPremiums(measured, input, { cache });
    await timing(
      "derived minimum",
      (i) => lowestPremiums(measured, inputs[i % inputs.length]),
      100,
    );
    await timing(
      "warm minimum cache",
      (i) => lowestPremiums(measured, inputs[i % inputs.length], { cache }),
      25,
    );
    const http = createApp(
      measured,
      {
        lowestPremiums: true,
        lowestPremiumsScope: publicOnly ? "single_age_silver" : "full",
        peerAddress: (request) =>
          request.headers.get("x-audit-source") ?? "192.0.2.1",
      },
      {
        config: loadConfig({}, { version: 1, cache: { enabled: true } }),
        store: new MemoryCache(64 * 1024 * 1024),
      },
    );
    const httpMinimum = async (i) => {
      const fields = Object.fromEntries(
        Object.entries(inputs[i % inputs.length]).map(([key, value]) => [
          key,
          String(value),
        ]),
      );
      const response = await http.request(
        `/v1/lowest-premiums?${new URLSearchParams(fields)}`,
        { headers: { "x-audit-source": `192.0.2.${(i % 16) + 1}` } },
      );
      assert.equal(response.status, 200);
      assert.equal((await response.json()).status, "calculated");
    };
    for (let i = 0; i < inputs.length; i++) await httpMinimum(i);
    await timing("warm HTTP minimum in-process", httpMinimum, 25);
    report.http_minimum_cache = responseCacheFor(measured).stats();
    assert(
      report.http_minimum_cache.hits >= samples,
      "HTTP workload must hit the warm cache",
    );
    await timing(
      "health baseline",
      async () => {
        assert.equal((await http.request("/healthz")).status, 200);
      },
      100,
    );
    await timing(
      "market counts",
      (i) => getMarketSummary(measured, cases[i % cases.length]),
      100,
    );
    await timing(
      "HTTP market counts in-process",
      async (i) => {
        const fields = Object.fromEntries(
          Object.entries(cases[i % cases.length]).map(([key, value]) => [
            key,
            String(value),
          ]),
        );
        const response = await http.request(
          `/v1/market-summary?${new URLSearchParams(fields)}`,
          { headers: { "x-audit-source": `198.51.100.${(i % 16) + 1}` } },
        );
        assert.equal(response.status, 200);
        assert.equal((await response.json()).status, "calculated");
      },
      100,
    );
    if (!publicOnly) {
      await timing(
        "market ranges",
        (i) =>
          getMarketSummary(measured, { ...cases[i % cases.length], age: 40 }),
        100,
      );
      await timing(
        "household minimum",
        (i) =>
          householdHandy(measured, { ...cases[i % cases.length], members }),
        300,
      );
      await timing(
        "household summary",
        (i) =>
          householdHandy(
            measured,
            { ...cases[i % cases.length], members },
            true,
          ),
        300,
      );
      await timing(
        "SLCSP benchmark",
        (i) =>
          benchmarkSilver(measured, {
            ...cases[i % cases.length],
            year: String(cases[i % cases.length].year),
            ages: "40,40,10,8",
          }),
        300,
      );
    }
    const deps = {
      db: measured,
      lowestPremiums: true,
      lowestPremiumsScope: publicOnly ? "single_age_silver" : "full",
      principal: { id: "audit" },
      policy: { canEstimate: () => true },
    };
    const calls = [
      ["MCP minimum", callLowestTool, (i) => inputs[i % inputs.length], 100],
      [
        "MCP summary",
        callMarketSummaryTool,
        (i) => ({ ...cases[i % cases.length], age: 40 }),
        100,
      ],
      [
        "MCP household minimum",
        callLowestTool,
        (i) => ({ ...cases[i % cases.length], members }),
        300,
      ],
      [
        "MCP household summary",
        callMarketSummaryTool,
        (i) => ({ ...cases[i % cases.length], members }),
        300,
      ],
      [
        "MCP benchmark",
        callBenchmarkTool,
        (i) => ({
          year: cases[i % cases.length].year,
          location: {
            zip: cases[i % cases.length].zip,
            county: cases[i % cases.length].county,
          },
          ages: [40, 40, 10, 8],
        }),
        300,
      ],
    ];
    const admittedCalls = publicOnly
      ? [
          calls[0],
          [
            "MCP summary counts",
            callMarketSummaryTool,
            (i) => cases[i % cases.length],
            100,
          ],
        ]
      : calls;
    for (const [name, call, fields, target] of admittedCalls)
      await timing(
        name,
        async (i) => {
          const answer = await call(deps, fields(i));
          assert(!answer.isError, JSON.stringify(answer));
          assert(
            Buffer.byteLength(JSON.stringify(answer)) + 4096 <=
              MAX_OUTPUT_BYTES,
          );
        },
        target,
      );
  }
  report.passed = true;
  report.performance_passed = report.latency.length
    ? report.latency.every((path) => path.meets_target)
    : null;
  report.origin_targets_passed = report.performance_passed === true;
  if (report.performance_passed === false) process.exitCode = 1;
} catch (error) {
  report.failures.push(error.message);
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  await db.close();
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify(report, null, 2) + "\n");
}
console.log(
  `lowest public correctness: ${report.passed ? "PASS" : "FAIL"}; cases=${report.correctness.length} latency_paths=${report.latency.length}; targets=${report.performance_passed === true ? "PASS" : "UNPROVEN"}`,
);
