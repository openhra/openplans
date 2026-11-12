#!/usr/bin/env node
/**
 * Cache-only check of the Part D drug-cost estimator on real CMS files. Imports the cached
 * Medicare archives and the newest cached Part D archive of a contract year into a disposable
 * PGlite database. Then it asks the estimate route, over HTTP with a Bearer token, for two
 * schedules per Part D plan: a new calendar year and an opening balance at the out-of-pocket
 * threshold. Each schedule fills, once each, the lowest RxCUI on every tier of the plan's
 * formulary and the lowest RxCUI flagged as a selected drug.
 *
 * Every answer must carry complete provenance, never say "not covered", never report
 * `estimated` (no price source is loaded) and cite only listed documents. A sample of plans, and
 * every answer near the tool's output limit, also runs through the MCP tool, whose data must equal
 * the HTTP body. Planted mutants on real answers, grouped county rows included,
 * must each be caught. The counts of calculated and unknown results, by reason, go to
 * reports/medicare-cost-oracle-<year>.json under the data directory.
 *
 * The CMS worked examples run end to end in tests/ingest/medicare/medicare-cost-oracle.test.ts.
 */
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { createApp } from "../../dist/api/app.js";
import { MemoryCache } from "../../dist/api/cache/store.js";
import { loadConfig } from "../../dist/config/index.js";
import { migrate, migrationsDirectory } from "../../dist/db/migrate.js";
import {
  cachedArchives,
  dataDirectory,
} from "../../dist/ingest/medicare/acquire.js";
import { importMedicare } from "../../dist/ingest/medicare/command.js";
import { cachedSpuf, importSpuf } from "../../dist/ingest/medicare/spuf.js";
import { createMcpHttp } from "../../dist/mcp/http.js";
import { MAX_OUTPUT_BYTES } from "../../dist/mcp/tools.js";
import {
  assertEstimateHonest,
  MEDICARE_ESTIMATE_TOOL,
} from "../../dist/mcp/medicare-estimate.js";
import { estimateProvenanceProblems } from "../../dist/services/medicare-drug-cost.js";

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const year = Number(option("--year") ?? 2026);
// --limit N checks only the first N plans, for a quick local run; realdata.sh checks them all.
const limit = option("--limit") ? Number(option("--limit")) : Infinity;
const dataDir = dataDirectory();
// Synthetic credentials for the disposable app; never a deployment secret.
const API_TOKEN = "synthetic-oracle-api-token";
const MCP_TOKEN = "synthetic-oracle-mcp-token";
const MCP_SAMPLE_EVERY = 97;
const THRESHOLD_CENTS = { 2026: 210000, 2027: 240000 };

const spuf = [
  ...(await cachedSpuf("quarterly", dataDir)),
  ...(await cachedSpuf("monthly", dataDir)),
]
  .filter((entry) => entry.archive.year === year)
  .sort((a, b) => b.archive.label.localeCompare(a.archive.label))[0];
const newest = async (family, match) =>
  (await cachedArchives(family, dataDir)).find(match);
const landscape = await newest("landscape", (e) => e.archive.year === year);
const pbp = await newest("pbp", (e) => e.archive.year === year);
if (!spuf || !landscape || !pbp || !(year in THRESHOLD_CENTS)) {
  console.log(
    `SKIP medicare cost ${year}: Part D, Landscape or PBP archive is not in the cache`,
  );
  process.exit(0);
}

const migrations = await mkdtemp(join(tmpdir(), "medicare-cost-migrations-"));
for (const name of await readdir(migrationsDirectory))
  if (name.endsWith(".sql") && name !== "002_postgis.sql")
    await cp(join(migrationsDirectory, name), join(migrations, name));
const pg = new PGlite();
const db = {
  query: (sql, parameters) => pg.query(sql, parameters),
  exec: async (sql) => void (await pg.exec(sql)),
  close: () => pg.close(),
  transaction: (run) =>
    pg.transaction((tx) =>
      run({
        query: (s, p) => tx.query(s, p),
        exec: async (s) => void (await tx.exec(s)),
      }),
    ),
};
const started = Date.now();
await migrate(db, migrations);
await importMedicare(db, { year }, dataDir);
const imported = await importSpuf(db, spuf);
const snapshot = imported.snapshot_id;

// No console output may carry a schedule; the app logs nothing for this route.
const app = createApp(
  db,
  { premiumToken: API_TOKEN },
  { store: new MemoryCache(1 << 20), config: loadConfig({}) },
);
const mcp = createMcpHttp(db, {
  env: { OPENPLANS_MCP_TOKEN: MCP_TOKEN },
  log: () => {},
});

const plans = (
  await db.query(
    `SELECT DISTINCT contract_id, plan_id, segment_id, formulary_id FROM partd_plan
     WHERE snapshot_id=$1 ORDER BY contract_id, plan_id, segment_id`,
    [snapshot],
  )
).rows.slice(0, limit);
const tierDrugs = new Map();
for (const row of (
  await db.query(
    `SELECT DISTINCT ON (formulary_id, tier) formulary_id, tier, rxcui FROM partd_formulary_drug
     WHERE snapshot_id=$1 AND tier IS NOT NULL ORDER BY formulary_id, tier, rxcui::bigint`,
    [snapshot],
  )
).rows) {
  const list = tierDrugs.get(row.formulary_id) ?? [];
  list.push(row.rxcui);
  tierDrugs.set(row.formulary_id, list);
}
for (const row of (
  await db.query(
    `SELECT DISTINCT ON (formulary_id) formulary_id, rxcui FROM partd_formulary_drug
     WHERE snapshot_id=$1 AND cells->>'SELECTED_DRUG_YN'='Y' ORDER BY formulary_id, rxcui::bigint`,
    [snapshot],
  )
).rows) {
  const list = tierDrugs.get(row.formulary_id) ?? [];
  if (!list.includes(row.rxcui)) list.push(row.rxcui);
  tierDrugs.set(row.formulary_id, list);
}

const planKey = (p) => `${p.contract_id}-${p.plan_id}-${Number(p.segment_id)}`;
function schedule(rxcuis, opening) {
  return {
    scenario: "non_lis_no_other_payer",
    channel: "standard_retail",
    opening_state:
      opening === "new_calendar_year"
        ? { kind: "new_calendar_year" }
        : {
            kind: "provided",
            as_of: `${year}-01-01`,
            gross_covered_drug_cost_cents: THRESHOLD_CENTS[year] * 4,
            troop_cents: THRESHOLD_CENTS[year],
            plan_deductible_met_cents: 0,
          },
    fills: rxcuis.slice(0, 10).map((rxcui, index) => ({
      fill_id: `f${index + 1}`,
      date: `${year}-02-${String(index + 2).padStart(2, "0")}`,
      rxcui,
      quantity: "30",
      unit: "each",
      days_supply: 30,
    })),
  };
}
const timing = { requests: 0, ms: 0 };
async function viaHttp(key, body, token = API_TOKEN) {
  const begin = performance.now();
  try {
    return await request(key, body, token);
  } finally {
    timing.requests++;
    timing.ms += performance.now() - begin;
  }
}
async function request(key, body, token) {
  const response = await app.request(
    `/v1/medicare/plans/${key}/drug-cost-estimates?year=${year}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    },
  );
  return { status: response.status, body: await response.json() };
}
async function viaMcp(key, body) {
  const response = await mcp.fetch(
    new Request("http://127.0.0.1/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": MEDICARE_ESTIMATE_TOOL,
        authorization: `Bearer ${MCP_TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: MEDICARE_ESTIMATE_TOOL,
          arguments: { plan_key: key, year, ...body },
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": {
              name: "medicare-cost-oracle",
              version: "1",
            },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    }),
  );
  assert.equal(response.status, 200, `mcp ${key}`);
  return (await response.json()).result.structuredContent;
}

// Access and switches, on real data.
const firstKey = planKey(plans[0]);
const firstBody = schedule(
  tierDrugs.get(plans[0].formulary_id) ?? ["1"],
  "new_calendar_year",
);
delete process.env.OPENPLANS_MEDICARE_DRUG_COST;
process.env.OPENPLANS_MEDICARE_PART_D = "on";
const disabled = await viaHttp(firstKey, firstBody);
assert.equal(disabled.status, 200);
assert.equal(disabled.body.reason, "estimator_disabled");
process.env.OPENPLANS_MEDICARE_DRUG_COST = "on";
assert.equal((await viaHttp(firstKey, firstBody, null)).status, 401);
assert.equal((await viaHttp(firstKey, firstBody, "wrong-token")).status, 401);

const fillFigures = [
  "patient_pay",
  "troop_increment",
  "gross_below_threshold",
  "gross_above_threshold",
  "selected_drug_subsidy",
  "manufacturer_discount",
  "covered_plan_paid",
  "non_covered_plan_paid",
];
const bump = (counts, key) => (counts[key] = (counts[key] ?? 0) + 1);
const empty = () => ({ calculated: 0, unknown: 0, unknown_by_reason: {} });
const summary = {
  plans: { total: plans.length, answered: 0, by_status: {} },
  single_fill_closed_by_reason: {},
  mcp_result_too_large: [],
  requests: { total: 0, by_status: {} },
  fills: { total: 0, ...empty(), by_status: {} },
  patient_pay: empty(),
  figures: empty(),
  totals_patient_pay: empty(),
  by_opening: {},
  benefit_type_origin: {},
};
const record = (bucket, figure) => {
  if (figure.status === "value") bucket.calculated++;
  else {
    bucket.unknown++;
    bump(bucket.unknown_by_reason, figure.reason);
  }
};
const problems = [];
let mcpChecked = 0;
let firstAnswer = null;
// The first answer that cites a plan's county rows as one group, for the group mutants.
let groupedAnswer = null;
let groupedRequest = null;

/**
 * With no price loaded, an amount can be calculated only where the price cannot change it: a fill
 * that starts in the catastrophic phase, where the enrollee pays $0.
 */
function priceFreeProblems(answer) {
  const found = [];
  for (const fill of answer.fills ?? []) {
    const pay = fill.figures.patient_pay;
    if (
      pay.status === "value" &&
      (pay.cents !== 0 || fill.standard_phase?.begin !== "C")
    )
      found.push(`${fill.fill_id}: calculated without a price source`);
  }
  if (
    answer.status === "estimated" &&
    !(answer.fills ?? []).every(
      (fill) => fill.figures.patient_pay.status === "value",
    )
  )
    found.push("estimated with an unknown fill");
  return found;
}

/** Checks one answer and counts its figures. Returns false for a closed answer. */
function check(key, label, answer, bucket) {
  const found = estimateProvenanceProblems(answer);
  if (found.length) problems.push(`${key} ${label}: ${found[0]}`);
  for (const problem of priceFreeProblems(answer))
    problems.push(`${key} ${label}: ${problem}`);
  if (!answer.fills) return false;
  const documents = new Set(answer.rules_documents.map((doc) => doc.id));
  for (const item of answer.evidence)
    if (item.kind === "rule" && !documents.has(item.document))
      problems.push(`${key} ${label}: rule ${item.document} not listed`);
  if (!bucket) return true;
  for (const fill of answer.fills) {
    summary.fills.total++;
    bucket.fills++;
    bump(summary.fills.by_status, fill.status);
    if (fill.status === "estimated") summary.fills.calculated++;
    else {
      summary.fills.unknown++;
      bump(
        summary.fills.unknown_by_reason,
        fill.figures.patient_pay.reason ?? "unknown",
      );
    }
    record(summary.patient_pay, fill.figures.patient_pay);
    record(bucket.patient_pay, fill.figures.patient_pay);
    for (const name of fillFigures) record(summary.figures, fill.figures[name]);
    if (
      fill.figures.patient_pay.status === "value" &&
      fill.figures.patient_pay.cents < 0
    )
      problems.push(`${key} ${fill.fill_id}: negative patient pay`);
  }
  return true;
}

for (const [index, plan] of plans.entries()) {
  const key = planKey(plan);
  const rxcuis = tierDrugs.get(plan.formulary_id) ?? [];
  if (!rxcuis.length) {
    bump(summary.plans.by_status, "no_tiered_drug_in_formulary");
    continue;
  }
  // The whole schedule at once: the plan-level answer.
  const whole = await viaHttp(key, schedule(rxcuis, "new_calendar_year"));
  summary.requests.total++;
  if (whole.status !== 200) {
    bump(summary.requests.by_status, `http_${whole.status}`);
    bump(
      summary.plans.by_status,
      `http_${whole.status}:${whole.body?.error?.code}`,
    );
    continue;
  }
  summary.plans.answered++;
  bump(summary.requests.by_status, whole.body.status);
  bump(
    summary.plans.by_status,
    whole.body.reason
      ? `${whole.body.status}:${whole.body.reason}`
      : whole.body.status,
  );
  if (check(key, "whole schedule", whole.body, null))
    record(summary.totals_patient_pay, whole.body.totals.patient_pay);
  // Each drug alone, from both opening states: the fill-level answers.
  for (const [n, rxcui] of rxcuis.slice(0, 10).entries())
    for (const opening of ["new_calendar_year", "at_out_of_pocket_threshold"]) {
      const body = schedule([rxcui], opening);
      const { status, body: answer } = await viaHttp(key, body);
      summary.requests.total++;
      if (status !== 200) {
        bump(summary.requests.by_status, `http_${status}`);
        continue;
      }
      bump(summary.requests.by_status, answer.status);
      const bucket = (summary.by_opening[opening] ??= {
        fills: 0,
        patient_pay: empty(),
      });
      if (!check(key, `${rxcui} ${opening}`, answer, bucket)) {
        bump(summary.single_fill_closed_by_reason, answer.reason);
        continue;
      }
      firstAnswer ??= answer;
      if (
        !groupedAnswer &&
        answer.evidence.some((item) => item.kind === "source_rows")
      ) {
        groupedAnswer = answer;
        groupedRequest = { key, body };
      }
      if (opening === "new_calendar_year" && n === 0)
        bump(summary.benefit_type_origin, answer.benefit_type.origin);
      const bytes = Buffer.byteLength(JSON.stringify(answer));
      // A sample of plans, and every answer large enough to come near the tool's output limit.
      const nearLimit = 2 * bytes + 16 * 1024 > MAX_OUTPUT_BYTES;
      if ((index % MCP_SAMPLE_EVERY === 0 && n === 0) || nearLimit) {
        const output = await viaMcp(key, body);
        mcpChecked++;
        // The tool sends the answer twice (structured and as text) plus its envelope, and refuses,
        // never truncates, a result over its output limit. The refusal is expected only for an
        // answer within 16 KiB of half that limit.
        if (output.error?.code === "RESULT_TOO_LARGE" && nearLimit)
          summary.mcp_result_too_large.push({ plan: key, opening, bytes });
        else if (output.error)
          problems.push(
            `${key} ${opening}: mcp ${output.error.code} (${bytes} bytes)`,
          );
        else if (JSON.stringify(output.data) !== JSON.stringify(answer))
          problems.push(`${key} ${opening}: mcp data differs from http`);
      }
    }
}

// Planted mutants on a real answer: each must be caught by the checks above.
assert.ok(
  firstAnswer,
  `no plan produced an estimate answer: ${JSON.stringify(summary.plans)}`,
);
const clone = () => JSON.parse(JSON.stringify(firstAnswer));
const controls = {};
{
  const mutant = clone();
  mutant.fills[0].figures.patient_pay = {
    status: "value",
    cents: 0,
    reason: null,
    evidence_refs: [],
  };
  controls.value_without_evidence =
    estimateProvenanceProblems(mutant).length > 0;
}
{
  const mutant = clone();
  mutant.fills[0].figures.patient_pay.reason = null;
  mutant.fills[0].figures.patient_pay.status = "unknown";
  controls.unknown_without_reason =
    estimateProvenanceProblems(mutant).length > 0;
}
{
  const mutant = clone();
  mutant.fills[0].listing.reason = "not covered";
  controls.not_covered_wording = estimateProvenanceProblems(mutant).length > 0;
}
{
  // A fill from a new calendar year reported as calculated.
  const mutant = clone();
  mutant.fills[0].figures.patient_pay = {
    status: "value",
    cents: 0,
    reason: null,
    evidence_refs: [mutant.evidence[0].id],
  };
  mutant.fills[0].standard_phase = { begin: "D", end: "D" };
  controls.calculated_before_threshold = priceFreeProblems(mutant).length > 0;
}
{
  const mutant = clone();
  mutant.evidence = mutant.evidence.slice(1);
  controls.dangling_evidence = estimateProvenanceProblems(mutant).length > 0;
}
{
  const key = firstAnswer.plan_key;
  const body = schedule(
    firstAnswer.fills.map((fill) => fill.rxcui),
    "new_calendar_year",
  );
  const output = await viaMcp(key, body);
  const changed = JSON.parse(JSON.stringify(output));
  changed.data.totals.calculable_subtotal.cents += 1;
  let caught = false;
  try {
    assertEstimateHonest(changed, output.data);
  } catch {
    caught = true;
  }
  controls.mcp_cent_changed = caught;
}

{
  // A grouped county row dropped, or a group without its shared values.
  assert.ok(groupedAnswer, "no answer cited a group of county rows");
  const output = await viaMcp(groupedRequest.key, groupedRequest.body);
  const caught = (edit, check) => {
    const mutant = JSON.parse(JSON.stringify(output));
    edit(mutant.data.evidence.find((item) => item.kind === "source_rows"));
    try {
      return check(mutant);
    } catch {
      return true;
    }
  };
  controls.group_row_dropped = caught(
    (group) => group.source_rows.pop(),
    (mutant) => {
      assertEstimateHonest(mutant, output.data);
      return false;
    },
  );
  controls.group_values_missing = caught(
    (group) => delete group.values[group.fields[0]],
    (mutant) => estimateProvenanceProblems(mutant.data).length > 0,
  );
  controls.mcp_differs_from_http =
    JSON.stringify(output.data) === JSON.stringify(groupedAnswer) &&
    caught(
      (group) => (group.kind = "source_row"),
      (mutant) => {
        assertEstimateHonest(mutant, groupedAnswer);
        return false;
      },
    );
}

const report = {
  year,
  ...(Number.isFinite(limit) ? { limit } : {}),
  kind: spuf.archive.kind,
  as_of_label: spuf.archive.label,
  snapshot_id: snapshot,
  checked_at: new Date().toISOString(),
  elapsed_ms: Date.now() - started,
  schedules:
    "per plan: the lowest RxCUI on each formulary tier plus the lowest selected-drug RxCUI (at most 10). One request fills them all from a new calendar year (plans.by_status). Then each drug alone, one 30-day standard-retail fill, from a new calendar year and from an opening TrOOP at the out-of-pocket threshold (fills, patient_pay, figures).",
  prices: "none loaded",
  mcp_checked: mcpChecked,
  http_ms_per_request: timing.requests
    ? Math.round(timing.ms / timing.requests)
    : null,
  summary,
  problems: problems.slice(0, 50),
  problem_count: problems.length,
  negative_controls: controls,
};
await mkdir(join(dataDir, "reports"), { recursive: true });
await writeFile(
  join(dataDir, "reports", `medicare-cost-oracle-${year}.json`),
  JSON.stringify(report, null, 2) + "\n",
);
await db.close();
await rm(migrations, { recursive: true, force: true });
console.log(
  JSON.stringify({ ...report, problems: report.problems.slice(0, 5) }),
);
assert.equal(
  problems.length,
  0,
  `medicare cost ${year}: ${problems.length} problems`,
);
for (const [name, caught] of Object.entries(controls))
  assert.ok(caught, `negative control ${name} was not caught`);
console.log(`PASS medicare cost ${year}`);
