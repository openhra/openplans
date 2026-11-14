#!/usr/bin/env node
/**
 * Cache-only sweep of every public read route and MCP tool over a loaded database
 * (DATABASE_URL). For each loaded state and plan year it asks about every county once by county and once by one of the
 * county's ZIP codes, then adds New York and Vermont counties and a few ZIP codes outside the
 * loaded geography. Each location goes to the native REST routes (/v1/plans, /v1/quotes,
 * /v1/premium-quotes, /v1/benchmark, /v1/ichra/affordability), the compatibility plan search and
 * the MCP tools. Each state and year also goes to /v1/data-availability and the state-level MCP
 * tools. Requests run in process against createApp and callTool; nothing is fetched.
 *
 * The pass rule is checkResponse in surface-sweep-logic.mjs: never a 5xx, never
 * INTERNAL_HONESTY_CHECK, never an empty answer without a reason code. Every failure is kept with
 * its inputs in reports/surface-sweep.json under the data directory, grouped by class.
 *
 * Planted mutant: when a New York catalog is loaded, the sweep runs search_plans for New York
 * counties through a copy of the MCP tools whose projection reads a HIOS-shaped plan_key as a
 * state plan key (the old behavior), and fails unless that copy produces INTERNAL_HONESTY_CHECK.
 *
 * Loaded data beside the catalog: provider search per ZIP; provider detail, participation, drug
 * search and coverage for samples of each loaded state and year; the Medicare plan routes and the
 * Part D drug list for the plan keys the searches return. Part D serving is on and the drug-cost
 * estimator is off; its routes must refuse. A second planted mutant reports unknown
 * participation as not_listed, and check_provider_network through it must produce
 * INTERNAL_HONESTY_CHECK. scripts/oracle/README.md lists the rules.
 *
 * Each location also asks for ICHRA affordability under the look-back safe harbor, which prices
 * the employer's LCSP from January of the year before the plan year; that answer needs the prior
 * year's catalog loaded.
 *
 * Usage: DATABASE_URL=... node scripts/oracle/surface-sweep.mjs [--year 2026] [--state TX]...
 *   [--counties N] [--concurrency N] [--report FILE] [--optional] [--providers N] [--drugs N]
 *   [--medicare-plans N] [--estimator-checks N] [--lookback-only]
 * --counties takes the first N counties of each state (default: all). --lookback-only asks each
 * location only the look-back questions and skips every other surface. --optional
 * (scripts/realdata.sh) prints SKIP and exits 0 when DATABASE_URL is not set.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rebaseImports, replaceSyntax } from "../source-mutation.mjs";
import { mutateSource, sourceControls } from "./source-controls.mjs";
import {
  checkResponse,
  refusedEstimate,
  summarize,
} from "./surface-sweep-logic.mjs";

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const many = (name) =>
  args.flatMap((arg, i) => (arg === name ? [args[i + 1]] : []));
const dataDir =
  process.env.OPENPLANS_DATA_DIR ?? join(homedir(), ".local/share/openplans");
const reportFile =
  option("--report") ?? join(dataDir, "reports", "surface-sweep.json");
const countyLimit = option("--counties") ? Number(option("--counties")) : null;
const concurrency = Number(option("--concurrency") ?? 4);
const count = (name, fallback) => Number(option(name) ?? fallback);
// Per loaded state and year: sampled NPIs (NPPES and directory listings each), RxCUIs (QHP and
// Part D formularies each); across the run: Medicare plan keys, and the first keys that also
// ask the off estimator.
const providerLimit = count("--providers", 150);
const drugLimit = count("--drugs", 25);
const medicareLimit = count("--medicare-plans", 400);
const estimatorChecks = count("--estimator-checks", 25);
const years = many("--year").map(Number);
const lookbackOnly = args.includes("--lookback-only");
const states = many("--state");

if (!process.env.DATABASE_URL) {
  if (args.includes("--optional")) {
    console.log(
      "SKIP surface sweep: no loaded database (set OPENPLANS_SURFACE_SWEEP_DATABASE_URL)",
    );
    process.exit(0);
  }
  console.error("FAIL surface sweep: set DATABASE_URL to a loaded database");
  process.exit(1);
}

// The sweep's own credentials, set only in this process; the compatibility API reads its key
// from the environment.
const TOKEN = "surface-sweep-token";
process.env.OPENPLANS_COMPAT_API_KEY = TOKEN;
// Part D serving is on, so the plan drug list answers from whatever Part D release is loaded. The
// drug-cost estimator and its plan-average prices stay off; the sweep checks that they refuse.
process.env.OPENPLANS_MEDICARE_PART_D = "on";
delete process.env.OPENPLANS_MEDICARE_DRUG_COST;
delete process.env.OPENPLANS_MEDICARE_DRUG_COST_PRICES;
const { createDatabase } = await import("../../dist/db/database.js");
const { createApp } = await import("../../dist/api/app.js");
const toolsUrl = new URL("../../dist/mcp/tools.js", import.meta.url);
const { callTool } = await import(toolsUrl.href);
const { createResponseCache } = await import("../../dist/api/cache/index.js");

const db = createDatabase(process.env.DATABASE_URL);
// Sample selection scans whole directory and formulary tables, past the API's read timeout.
const samplerUrl = new URL(process.env.DATABASE_URL);
samplerUrl.searchParams.set("query_timeout", "600000");
const sampler = createDatabase(samplerUrl.href);
// Each request comes from its own address in the 198.18.0.0/15 test range, so the per-source
// limits of the public quote tier never answer for the data.
let peer = 0;
const app = createApp(db, {
  premiumToken: TOKEN,
  peerAddress: () => `198.18.${(++peer >> 8) & 255}.${peer & 255}`,
});
const headers = {
  "content-type": "application/json",
  authorization: `Bearer ${TOKEN}`,
  "X-Api-Key": TOKEN,
};
const grant = {
  principal: { id: "surface-sweep" },
  policy: { canEstimate: () => true },
};

// SYNTHETIC household, employee and identifiers used as request inputs only.
const AGE = 40;
const INCOME = 40_000;
const RXCUI = "861007";
const NPI = "1234567893";
// ZIP codes the loaded geography is not expected to hold (Puerto Rico, Guam, an unassigned
// code), plus New York, Vermont and a few other states' ZIPs that a batch may not have loaded.
const EXTRA_ZIPS = [
  "00001",
  "00601",
  "96910",
  "10001",
  "12207",
  "05401",
  "90210",
  "02108",
  "20001",
  "30303",
];
// Vermont's 14 counties and a few New York counties; the sweep adds every loaded county too.
const VT_COUNTIES = [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27].map(
  (n) => `50${String(n).padStart(3, "0")}`,
);
const NY_COUNTIES = [
  "36001",
  "36005",
  "36047",
  "36061",
  "36081",
  "36085",
  "36103",
  "36119",
];
// Counties a batch may not have loaded: Los Angeles, the District of Columbia, Fulton GA, and
// county equivalents in Puerto Rico and Guam.
const EXTRA_COUNTIES = ["06037", "11001", "13121", "72001", "66010"];

let requests = 0;
const failures = [];
const medicareKeys = new Map();
const loadedCounts = {};
// Outcomes per surface (HTTP status or MCP error code), so a request the sweep built wrongly
// shows up as a column of 400s instead of passing quietly.
const outcomes = {};
const seconds = {};
/**
 * `checks` holds the answer's `items` (see checkResponse), its separate `records` and an optional
 * `refusal` flag for routes that must refuse. A bare function is the items selector.
 */
function record(surface, input, response, checks, started) {
  const { items, records, refusal } = checks;
  requests++;
  seconds[surface] = (seconds[surface] ?? 0) + (Date.now() - started) / 1000;
  const code =
    response.body?.error?.code ??
    (typeof response.body?.error === "string" ? response.body.error : null);
  let shape = "";
  if (Array.isArray(items)) shape = items.length ? " items" : " empty";
  const outcome = `${response.status}${code ? ` ${code}` : ""}${shape}`;
  outcomes[surface] ??= {};
  outcomes[surface][outcome] = (outcomes[surface][outcome] ?? 0) + 1;
  const kinds = checkResponse({ ...response, items, records });
  if (refusal && !refusedEstimate(response))
    kinds.push("estimator_not_refused");
  for (const kind of kinds)
    failures.push({
      class: kind,
      surface,
      input,
      status: response.status,
      body: JSON.stringify(response.body).slice(0, 600),
    });
}
const selectors = (select, body, status) => {
  const { items, records, refusal } =
    typeof select === "function" ? { items: select } : (select ?? {});
  return {
    items: items?.(body, status),
    records: records?.(body, status),
    refusal,
  };
};
async function rest(surface, path, body, items, input) {
  const started = Date.now();
  let response;
  try {
    let r;
    // The public quote tier admits four requests at once; a 429 is the sweep's own crowding,
    // not an answer about the data, so it waits and asks again.
    for (let attempt = 0; ; attempt++) {
      r = await app.request(
        path,
        body === undefined
          ? { headers }
          : { method: "POST", headers, body: JSON.stringify(body) },
      );
      if (r.status !== 429 || attempt === 50) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    response = {
      status: r.status,
      body: await r.json().catch(() => null),
      gaps: r.headers.get("x-openplans-gaps") ?? "",
    };
  } catch (error) {
    response = {
      status: 599,
      body: { thrown: String(error?.message ?? error) },
    };
  }
  record(
    surface,
    input ?? { path, body },
    response,
    selectors(items, response.body, response.status),
    started,
  );
  return response.body;
}
async function mcp(
  tool,
  input,
  items,
  call = callTool,
  surface = `mcp ${tool}`,
) {
  const started = Date.now();
  let response;
  try {
    const content = (await call({ db, ...grant }, tool, input))
      .structuredContent;
    response = {
      status: content?.status === "error" ? 400 : 200,
      body: content,
    };
  } catch (error) {
    response = {
      status: 599,
      body: { thrown: String(error?.message ?? error) },
    };
  }
  record(
    surface,
    input,
    response,
    selectors(items, response.body, response.status),
    started,
  );
  return response.body;
}

// Item selectors: the answer's list, or [answer] when it has a value.
const failed = (status) => status !== undefined && status >= 400;
const listAt = (key) => (body, status) =>
  !failed(status) && Array.isArray(body?.[key]) ? body[key] : [];
const dataList = (key) => (body) =>
  Array.isArray(body?.data?.[key]) ? body.data[key] : [];
const present = (test) => (body, status) =>
  !failed(status) && test(body) ? [body] : [];
const priced = (body) => body?.slcsp_monthly_cents != null;
const calculated = (body) => body?.status === "calculated";
const mcpKnown = (body) => body?.status !== "error" && body?.data != null;

const firstPlan = (...bodies) => {
  for (const body of bodies) {
    const plans = body?.plans ?? body?.quotes ?? body?.data?.plans ?? [];
    const id = plans.find(Boolean);
    const ref = id?.plan_id ?? id?.base_plan_id ?? id?.plan_ref ?? id?.id;
    if (typeof ref === "string") return ref;
  }
  return null;
};

async function sweepLocation(target) {
  const { year, location } = target;
  const query = location.zip
    ? `zip=${location.zip}`
    : `county=${location.county}`;
  const start = `${year}-01-01`;
  const ichra = {
    plan_start: start,
    employee: { date_of_birth: `${year - AGE - 1}-10-01` },
    residence: location,
    hra: { self_only_annual_cents: 300_000 },
    income: [{ measure: "household", annual_cents: INCOME * 100 }],
  };
  // Under the look-back safe harbor the employer's LCSP comes from the prior year's January catalog.
  const lookBack = { ...ichra, safe_harbors: { look_back: true } };
  await rest(
    "POST /v1/ichra/affordability look-back",
    "/v1/ichra/affordability",
    lookBack,
    present(calculated),
    { ...target, look_back: true },
  );
  await mcp(
    "check_ichra_affordability",
    lookBack,
    present((body) => calculated(body?.data)),
    callTool,
    "mcp check_ichra_affordability look-back",
  );
  if (lookbackOnly) return;
  const plans = await rest(
    "GET /v1/plans",
    `/v1/plans?${query}&year=${year}`,
    undefined,
    listAt("plans"),
    target,
  );
  const quotes = await rest(
    "POST /v1/quotes",
    "/v1/quotes",
    { ...location, year, members: [{ age: AGE }] },
    listAt("quotes"),
    target,
  );
  const searched = await mcp(
    "search_plans",
    { year, location },
    dataList("plans"),
  );
  const quoted = await mcp(
    "quote_plans",
    { year, location, members: [{ age: AGE }] },
    dataList("quotes"),
  );
  const plan = firstPlan(plans, quotes, searched, quoted) ?? target.statePlan;
  await rest(
    "GET /v1/benchmark",
    `/v1/benchmark?${query}&year=${year}&ages=${AGE}`,
    undefined,
    present(priced),
    target,
  );
  await rest(
    "POST /v1/ichra/affordability",
    "/v1/ichra/affordability",
    ichra,
    present(calculated),
    target,
  );
  await mcp(
    "check_ichra_affordability",
    ichra,
    present((body) => calculated(body?.data)),
  );
  const county = location.county ?? target.county;
  if (county)
    await rest(
      "POST compat search",
      "/compat/v1/plans/medical/search",
      {
        fips_code: county,
        ...(location.zip ? { zip_code: location.zip } : {}),
        market: "individual",
        applicants: [{ age: AGE, smoker: false, child: false }],
        enrollment_date: start,
        household_income: INCOME,
        household_size: 1,
        tax_filing: "single",
        per_page: 50,
      },
      listAt("plans"),
      target,
    );
  if (plan) {
    const members = [{ age: AGE, tobacco: false, relationship: "subscriber" }];
    await rest(
      "POST /v1/premium-quotes",
      "/v1/premium-quotes",
      {
        plan_ids: [plan],
        ...location,
        coverage_start: start,
        members,
        household_income_annual: INCOME,
        household_size: 1,
        tax_filing: "single",
      },
      listAt("quotes"),
      { ...target, plan },
    );
    await mcp(
      "quote_premiums",
      {
        plan_refs: [plan],
        location,
        coverage_start: start,
        members,
        household: { income_annual: INCOME, size: 1, tax_filing: "single" },
      },
      dataList("quotes"),
    );
    await mcp("get_plan", { plan_ref: plan, year }, present(mcpKnown));
  }
  if (location.zip)
    await mcp("lookup_geography", { zip: location.zip }, present(mcpKnown));
  const medicareFound = await mcp(
    "search_medicare_plans",
    { year, location },
    dataList("plans"),
  );
  const medicare = location.zip
    ? `zip=${location.zip}`
    : `county_fips=${location.county}`;
  const medicareListed = await rest(
    "GET /v1/medicare/plans",
    `/v1/medicare/plans?${medicare}&year=${year}`,
    undefined,
    listAt("plans"),
    target,
  );
  // Plan keys for the plan-level Medicare routes, each with a ZIP inside its service area.
  const zip = location.zip ?? target.zip;
  for (const plan of [
    ...(medicareFound?.data?.plans ?? []),
    ...(medicareListed?.plans ?? []),
  ])
    if (typeof plan?.plan_key === "string" && target.state)
      medicareKeys.set(`${year} ${plan.plan_key}`, {
        year,
        key: plan.plan_key,
        zip,
        state: target.state,
      });
  await mcp(
    "search",
    { query: "silver", entity: "plan", location, year },
    undefined,
  );
  if (location.zip) await sweepProviderSearch(target);
}

/**
 * Searches over a loaded source. An empty list is a whole answer when the response says the
 * source is loaded: a provider search with status `available` (an NPPES release covers the ZIP's
 * state; `meta.unlocated` counts addresses with no point), MCP status `ok`, or a drug search with
 * `terminology_status: "available"`. Without that statement an empty list needs a reason.
 */
const searchList = (list, whole, body) => {
  if (!Array.isArray(list)) return [];
  if (list.length) return list;
  return whole ? [body] : [];
};
const providerList = (body, status) =>
  failed(status)
    ? []
    : searchList(body?.providers, body?.status === "available", body);
const mcpProviderList = (body) =>
  searchList(body?.data?.providers, body?.status === "ok", body);
const drugList = (body, status) => {
  const data = body?.data ?? body;
  return failed(status)
    ? []
    : searchList(
        data?.candidates,
        data?.terminology_status === "available",
        body,
      );
};
/** The sampled plans, or the state's first catalog plan when no issuer sample was taken. */
const samplePlans = (sample, statePlan) => {
  if (sample?.issuerPlans.length) return sample.issuerPlans;
  return statePlan ? [statePlan.slice(0, 14)] : [];
};

/** Provider search around one ZIP on the native, MCP and compatibility surfaces. */
async function sweepProviderSearch(target) {
  const { year, location } = target;
  const zip = location.zip;
  await rest(
    "GET /v1/providers",
    `/v1/providers?zip=${zip}&radius_miles=10`,
    undefined,
    providerList,
    target,
  );
  await rest(
    "GET /v1/providers by name",
    `/v1/providers?zip=${zip}&radius_miles=25&name=SMITH`,
    undefined,
    providerList,
    target,
  );
  await mcp(
    "search_providers",
    { zip, radius_miles: 10, year },
    mcpProviderList,
  );
  await rest(
    "POST compat providers search",
    "/compat/v1/providers/search",
    { zip_code: zip, radius: 10, per_page: 25 },
    listAt("providers"),
    target,
  );
  await mcp(
    "search",
    { query: "smith", entity: "provider", location, year },
    undefined,
  );
}

// Answers that hold one result: its own status, unless it is unknown, counts as the answer.
const answered = (body, status) =>
  !failed(status) &&
  body &&
  typeof body === "object" &&
  body.status !== undefined &&
  body.status !== "unknown"
    ? [body]
    : [];
const itself = (body, status) =>
  !failed(status) && body && typeof body === "object" ? [body] : [];
const dataRecords = (key) => (body) =>
  Array.isArray(body?.data?.[key]) ? body.data[key] : [];
const hasKey = (key) => (body) => body?.[key] != null;

/**
 * Sampled identities, plans and drugs of one loaded state and year: NPPES identities with a
 * practice address in the state, issuer provider-directory listings (NPI and plan pairs), one
 * plan per issuer, and RxCUIs from the loaded QHP and Part D formularies. Every query answers
 * empty when its tables are empty.
 */
async function loadedSample({ state, year }) {
  const read = async (sql, parameters) =>
    (await sampler.query(sql, parameters)).rows;
  const nppes = (
    await read(
      `SELECT DISTINCT a.npi FROM npi_address a WHERE a.kind='practice' AND a.state=$1
       ORDER BY a.npi LIMIT $2`,
      [state, providerLimit],
    )
  ).map((r) => r.npi);
  const pairs = await read(
    `SELECT DISTINCT ON (r.npi) r.npi, p.base_hios_id AS plan FROM provider_active_set a
     JOIN provider_shard s ON s.source_set_id=a.snapshot_id
     JOIN qhp_provider_plan p ON p.snapshot_id=s.snapshot_id
     JOIN qhp_provider_record r ON r.snapshot_id=p.snapshot_id AND r.record_id=p.record_id
     WHERE a.state=$1 AND a.plan_year=$2 AND p.plan_year=$2 AND r.npi IS NOT NULL
     ORDER BY r.npi, p.base_hios_id LIMIT $3`,
    [state, year, providerLimit],
  );
  const issuerPlans = (
    await read(
      // Issuers with a loaded directory or formulary first, so coverage answers include evidence.
      `SELECT base_plan_id FROM (
         SELECT DISTINCT ON (left(p.base_plan_id, 5)) p.base_plan_id FROM plan p
         JOIN puf_active_catalog a ON p.snapshot_id = a.import_id || ':plan-attributes'
         WHERE a.state=$1 AND a.plan_year=$2 ORDER BY left(p.base_plan_id, 5), p.base_plan_id) x
       ORDER BY NOT EXISTS (
         SELECT 1 FROM provider_active_set s WHERE s.issuer_id=left(x.base_plan_id, 5)
           AND s.state=$1 AND s.plan_year=$2
         UNION ALL SELECT 1 FROM formulary_active_set s WHERE s.issuer_id=left(x.base_plan_id, 5)
           AND s.state=$1 AND s.plan_year=$2), base_plan_id`,
      [state, year],
    )
  ).map((r) => r.base_plan_id);
  const rxcuis = await read(
    `WITH current_rx AS (
       SELECT r.snapshot_id FROM rx_release r JOIN snapshot s USING(snapshot_id)
       WHERE s.validation_state='ACTIVE' ORDER BY r.source_version DESC LIMIT 1),
     qhp AS (SELECT DISTINCT e.rxcui FROM formulary_active_set a
       JOIN formulary_shard s ON s.source_set_id=a.snapshot_id
       JOIN formulary_edge e ON e.snapshot_id=s.snapshot_id
       WHERE a.state=$1 AND a.plan_year=$2 ORDER BY 1 LIMIT $3),
     partd AS (SELECT DISTINCT f.rxcui FROM partd_formulary_drug f
       JOIN partd_release r ON r.snapshot_id=f.snapshot_id AND r.contract_year=$2
       ORDER BY 1 LIMIT $3)
     SELECT x.rxcui, (SELECT c.name FROM rx_concept c, current_rx cr
       WHERE c.snapshot_id=cr.snapshot_id AND c.rxcui=x.rxcui ORDER BY c.tty, c.name LIMIT 1) AS name
     FROM (SELECT rxcui FROM qhp UNION SELECT rxcui FROM partd) x ORDER BY 1`,
    [state, year, drugLimit],
  );
  // A real RxCUI and one no release holds, so every coverage surface also answers for an absent drug.
  const drugs = [
    ...rxcuis,
    { rxcui: RXCUI, name: "metformin" },
    { rxcui: "99999999", name: null },
  ].filter(
    (d, i, all) => all.findIndex((other) => other.rxcui === d.rxcui) === i,
  );
  return {
    nppes,
    pairs,
    issuerPlans: issuerPlans.slice(0, 10),
    drugs,
  };
}

/** Provider detail and participation, drug search and coverage for one loaded state and year. */
async function sweepLoaded(scope) {
  const { state, year, statePlan } = scope;
  const sample = await loadedSample(scope);
  loadedCounts[`${state} ${year}`] = {
    nppes: sample.nppes.length,
    directory_pairs: sample.pairs.length,
    issuer_plans: sample.issuerPlans.length,
    drugs: sample.drugs.length,
  };
  const input = { state, year };
  const plans = samplePlans(sample, statePlan);
  const npis = [
    ...new Set([...sample.pairs.map((p) => p.npi), ...sample.nppes, NPI]),
  ];
  await pool(npis, async (npi) => {
    await rest(
      "GET /v1/providers/:npi",
      `/v1/providers/${npi}?year=${year}`,
      undefined,
      present(hasKey("npi")),
      { ...input, npi },
    );
    await rest(
      "GET compat providers/:npi",
      `/compat/v1/providers/${npi}`,
      undefined,
      itself,
      { ...input, npi },
    );
    await mcp("search_providers", { npi, year }, dataList("providers"));
    const listed = sample.pairs.find((p) => p.npi === npi)?.plan;
    for (const plan of new Set([listed ?? plans[0], ...plans.slice(0, 2)]))
      if (plan)
        await rest(
          "GET /v1/plans/:id/providers/:npi",
          `/v1/plans/${plan}/providers/${npi}?year=${year}`,
          undefined,
          { items: answered, records: itself },
          { ...input, plan, npi },
        );
    if (plans.length)
      await mcp(
        "check_provider_network",
        {
          plan_ids: [...new Set([listed ?? plans[0], ...plans])].slice(0, 10),
          npis: [npi],
          year,
        },
        { records: dataRecords("results") },
      );
  });
  await pool(sample.drugs, async ({ rxcui, name }) => {
    await rest(
      "GET /v1/drugs/:rxcui",
      `/v1/drugs/${rxcui}`,
      undefined,
      present(hasKey("rxcui")),
      { ...input, rxcui },
    );
    const term = (name ?? "zzzz").split(/[\s/]+/)[0];
    await rest(
      "GET /v1/drugs",
      `/v1/drugs?q=${encodeURIComponent(term)}`,
      undefined,
      drugList,
      { ...input, term },
    );
    await mcp("search_drugs", { query: term }, drugList);
    await rest(
      "GET compat drugs",
      `/compat/v1/drugs?search_term=${encodeURIComponent(term)}`,
      undefined,
      listAt("drugs"),
      { ...input, term },
    );
    await mcp("search", { query: term, entity: "drug" }, undefined);
    for (const plan of plans)
      await rest(
        "GET /v1/plans/:id/drugs/:rxcui",
        `/v1/plans/${plan}/drugs/${rxcui}?year=${year}`,
        undefined,
        { items: answered, records: itself },
        { ...input, plan, rxcui },
      );
  });
  for (let at = 0; plans.length && at < sample.drugs.length; at += 10)
    await mcp(
      "check_drug_coverage",
      {
        plan_ids: plans,
        rxcuis: sample.drugs.slice(at, at + 10).map((d) => d.rxcui),
        year,
      },
      { records: dataRecords("results") },
    );
  // Quotes that carry provider and drug questions, and the compatibility search that names them.
  const county = (
    await db
      .query(
        "SELECT county_fips FROM rating_area WHERE state=$1 AND plan_year=$2 ORDER BY 1 LIMIT 1",
        [state, year],
      )
      .catch(() => ({ rows: [] }))
  ).rows[0]?.county_fips;
  if (county) {
    await mcp(
      "quote_plans",
      {
        year,
        location: { county },
        members: [{ age: AGE }],
        npis: npis.slice(0, 3),
        rxcuis: sample.drugs.slice(0, 3).map((d) => d.rxcui),
      },
      {
        items: dataList("quotes"),
        records: (body) =>
          (body?.data?.quotes ?? []).flatMap((q) => [
            ...(q.providers ?? []),
            ...(q.drugs ?? []),
          ]),
      },
    );
    await rest(
      "POST compat search with providers and drugs",
      "/compat/v1/plans/medical/search",
      {
        fips_code: county,
        market: "individual",
        applicants: [{ age: AGE, smoker: false, child: false }],
        enrollment_date: `${year}-01-01`,
        household_income: INCOME,
        household_size: 1,
        tax_filing: "single",
        per_page: 50,
        providers: npis.slice(0, 2).map((npi) => ({ npi })),
        drug_packages: [{ id: sample.drugs[0].rxcui }],
      },
      listAt("plans"),
      { ...input, county },
    );
  }
  await rest(
    "GET compat specialties",
    "/compat/v1/specialties",
    undefined,
    undefined,
    input,
  );
  return sample;
}

/** A fill schedule for the estimator refusal checks. SYNTHETIC: no person's prescriptions. */
const FILL_SCHEDULE = {
  scenario: "surface-sweep",
  channel: "preferred_retail",
  opening_state: { kind: "new_calendar_year" },
  fills: [
    {
      fill_id: "f1",
      date: "2026-02-01",
      rxcui: RXCUI,
      quantity: "30",
      unit: "tablet",
      days_supply: 30,
    },
  ],
};

/** The plan-level Medicare routes for one plan key, and the refusals of the off estimator. */
async function sweepMedicarePlan({ year, key, zip, state }, index, drugs) {
  const input = { state, year, key };
  const path = `/v1/medicare/plans/${encodeURIComponent(key)}`;
  await rest(
    "GET /v1/medicare/plans/:key",
    `${path}?year=${year}`,
    undefined,
    present(hasKey("plan_key")),
    input,
  );
  for (const part of ["benefits", "service-area", "lineage"])
    await rest(
      `GET /v1/medicare/plans/:key/${part}`,
      `${path}/${part}?year=${year}`,
      undefined,
      itself,
      input,
    );
  for (const rxcui of drugs)
    await rest(
      "GET /v1/medicare/plans/:key/drugs",
      `${path}/drugs?year=${year}&rxcui=${rxcui}`,
      undefined,
      { items: answered, records: itself },
      { ...input, rxcui },
    );
  if (zip)
    await rest(
      "GET /v1/medicare/plans/:key/pharmacies",
      `${path}/pharmacies?year=${year}&zip=${zip}`,
      undefined,
      { items: answered, records: itself },
      { ...input, zip },
    );
  if (index < estimatorChecks) {
    for (const price_basis of ["none", "cms_plan_average"])
      await rest(
        "POST /v1/medicare/plans/:key/drug-cost-estimates",
        `${path}/drug-cost-estimates?year=${year}`,
        { ...FILL_SCHEDULE, price_basis },
        { refusal: true },
        { ...input, price_basis },
      );
    await mcpHttpEstimate({ plan_key: key, year, ...FILL_SCHEDULE }, input);
  }
}

// The MCP estimate tool is registered only while the estimator is on, so its refusal is a
// protocol answer: tools/list must not name it and tools/call must answer a JSON-RPC error.
const MCP_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "surface-sweep", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
};
async function mcpHttp(method, params) {
  const r = await app.request("http://127.0.0.1/mcp", {
    method: "POST",
    headers: {
      ...headers,
      accept: "application/json, text/event-stream",
      "MCP-Protocol-Version":
        MCP_META["io.modelcontextprotocol/protocolVersion"],
      "Mcp-Method": method,
      ...(params.name ? { "Mcp-Name": params.name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: { ...params, _meta: MCP_META },
    }),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function mcpHttpEstimate(args, input) {
  const started = Date.now();
  const tool = "estimate_medicare_drug_costs";
  let response;
  try {
    const listed = await mcpHttp("tools/list", {});
    const names = (listed.body?.result?.tools ?? []).map((t) => t.name);
    const called = await mcpHttp("tools/call", { name: tool, arguments: args });
    const error = called.body?.error;
    // A JSON-RPC error carries a numeric code; the refusal check reads it as a reason string.
    if (names.includes(tool))
      response = { status: 200, body: { listed: true, called: called.body } };
    else if (error)
      response = {
        status: 400,
        body: { error: { code: `jsonrpc_${error.code}` } },
      };
    else
      response = {
        status: called.status,
        body: called.body?.result ?? called.body,
      };
  } catch (error) {
    response = {
      status: 599,
      body: { thrown: String(error?.message ?? error) },
    };
  }
  record(`mcp http ${tool}`, input, response, { refusal: true }, started);
}

async function sweepState({ state, year, statePlan }) {
  const input = { state, year };
  // Inventories list what is loaded, so an empty one is the whole answer (get_data_status also
  // says `loaded: false`); only the 5xx and honesty rules apply to them.
  await rest(
    "GET /v1/data-availability",
    `/v1/data-availability?state=${state}&year=${year}`,
    undefined,
    undefined,
    input,
  );
  await mcp("get_data_status", { state, year }, undefined);
  for (const kind of ["carriers", "networks"])
    await mcp("list_carriers_networks", { state, year, kind }, undefined);
  if (statePlan) {
    await mcp(
      "check_drug_coverage",
      { plan_ids: [statePlan.slice(0, 14)], rxcuis: [RXCUI], year },
      undefined,
    );
    await mcp(
      "check_provider_network",
      { plan_ids: [statePlan.slice(0, 14)], npis: [NPI], year },
      undefined,
    );
  }
}

async function targets() {
  const loaded = (
    await db.query(
      `SELECT DISTINCT state, plan_year FROM puf_active_catalog
       UNION SELECT DISTINCT state, plan_year FROM state_rate_active ORDER BY 2, 1`,
    )
  ).rows.filter(
    (r) =>
      (!years.length || years.includes(r.plan_year)) &&
      (!states.length || states.includes(r.state)),
  );
  const sweptYears = [...new Set(loaded.map((r) => r.plan_year))];
  const scopes = [...loaded];
  for (const year of sweptYears)
    for (const state of ["NY", "VT"])
      if (
        !scopes.some((s) => s.state === state && s.plan_year === year) &&
        (!states.length || states.includes(state))
      )
        scopes.push({ state, plan_year: year, unloaded: true });
  const locations = [],
    perState = [];
  for (const scope of scopes) {
    const year = scope.plan_year;
    let counties = (
      await db.query(
        "SELECT DISTINCT county_fips FROM rating_area WHERE state=$1 AND plan_year=$2 ORDER BY 1",
        [scope.state, year],
      )
    ).rows.map((r) => r.county_fips);
    if (!counties.length)
      counties = { VT: VT_COUNTIES, NY: NY_COUNTIES }[scope.state] ?? [];
    if (countyLimit !== null) counties = counties.slice(0, countyLimit);
    const zips = new Map(
      (
        await db.query(
          `SELECT DISTINCT ON (county_fips) county_fips, zcta FROM zcta_county
           WHERE county_fips = ANY($1) ORDER BY county_fips, arealand_part DESC, zcta`,
          [counties],
        )
      ).rows.map((r) => [r.county_fips, r.zcta]),
    );
    const statePlan =
      (
        await db.query(
          "SELECT base_plan_id FROM plan p JOIN puf_active_catalog a ON p.snapshot_id = a.import_id || ':plan-attributes' WHERE a.state=$1 AND a.plan_year=$2 ORDER BY 1 LIMIT 1",
          [scope.state, year],
        )
      ).rows[0]?.base_plan_id ?? null;
    perState.push({ state: scope.state, year, statePlan });
    for (const county of counties) {
      const zip = zips.get(county);
      locations.push({
        state: scope.state,
        year,
        location: { county },
        statePlan,
        zip,
      });
      if (zip)
        locations.push({
          state: scope.state,
          year,
          county,
          location: { zip },
          statePlan,
        });
    }
  }
  for (const year of sweptYears) {
    for (const zip of EXTRA_ZIPS)
      locations.push({ state: null, year, location: { zip }, statePlan: null });
    for (const county of EXTRA_COUNTIES)
      locations.push({
        state: null,
        year,
        location: { county },
        statePlan: null,
      });
  }
  // A loaded state's county in a plan year with no catalog.
  const unloadedYear = Math.min(...sweptYears) - 1;
  for (const scope of loaded.slice(0, 3)) {
    const first = locations.find(
      (t) => t.state === scope.state && t.location.county,
    );
    if (first) locations.push({ ...first, year: unloadedYear });
  }
  return { scopes: loaded, sweptYears, locations, perState };
}

async function pool(items, run) {
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < items.length) await run(items[next++]);
    }),
  );
}

/** Loads a copy of the MCP tools whose projection has one source control applied. */
async function mutantTools(control) {
  // Inside dist/, so the copies resolve the same packages as the built modules they replace.
  const directory = await mkdtemp(
    fileURLToPath(new URL("../../dist/.surface-sweep-", import.meta.url)),
  );
  const projectionUrl = new URL(
    `../../dist/${control.path}.js`,
    import.meta.url,
  );
  const projection = join(directory, "projection.mjs");
  await writeFile(
    projection,
    rebaseImports(
      mutateSource(await readFile(projectionUrl, "utf8"), control),
      projectionUrl,
    ),
  );
  const tools = join(directory, "tools.mjs");
  await writeFile(
    tools,
    rebaseImports(
      replaceSyntax(
        await readFile(toolsUrl, "utf8"),
        '"./projection.js"',
        JSON.stringify(pathToFileURL(projection).href),
      ),
      toolsUrl,
    ),
  );
  return {
    callTool: (await import(pathToFileURL(tools).href)).callTool,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

/**
 * Runs MCP calls through a mutant copy of the tools; the mutant is caught when the calls produce
 * INTERNAL_HONESTY_CHECK. The calls do not count as sweep requests or failures.
 */
async function caughtBy(control, calls) {
  const mutant = await mutantTools(control);
  try {
    const before = failures.length,
      counted = requests;
    for (const [tool, input, items] of calls)
      await mcp(tool, input, items, (deps, name, value) =>
        // A fresh response cache: the shared one already holds the real tools' answers.
        mutant.callTool(
          { ...deps, cache: createResponseCache(db) },
          name,
          value,
        ),
      );
    requests = counted;
    return failures
      .splice(before)
      .filter((f) => f.class === "internal_honesty_check").length;
  } finally {
    await mutant.cleanup();
  }
}

/** search_plans for New York counties through a copy of the MCP tools with the old projection. */
async function plantedMutant(work) {
  const ny = work.locations.filter(
    (t) =>
      t.state === "NY" &&
      t.location.county &&
      work.scopes.some((s) => s.state === "NY" && s.plan_year === t.year),
  );
  if (!ny.length)
    return { status: "skipped", reason: "no_new_york_catalog_loaded" };
  const caught = await caughtBy(
    sourceControls.mcpPlanKey,
    ny
      .slice(0, 5)
      .map((t) => [
        "search_plans",
        { year: t.year, location: t.location },
        dataList("plans"),
      ]),
  );
  return {
    status: caught ? "caught" : "missed",
    counties: ny.slice(0, 5).map((t) => t.location.county),
    caught,
  };
}

/**
 * Provider-route mutant: a projection that reports an unknown participation answer as
 * `not_listed`, claiming the plan's directory was read in full. check_provider_network for the
 * first sampled identities of each loaded state must fail with INTERNAL_HONESTY_CHECK.
 */
async function plantedProviderMutant(work) {
  const calls = [];
  for (const scope of work.loadedStates) {
    const sample = work.samples.get(`${scope.state} ${scope.year}`);
    const plans = samplePlans(sample, scope.statePlan);
    if (!plans.length) continue;
    for (const npi of [...(sample?.nppes ?? []).slice(0, 2), NPI])
      calls.push([
        "check_provider_network",
        { plan_ids: plans, npis: [npi], year: scope.year },
        { records: dataRecords("results") },
      ]);
  }
  if (!calls.length) return { status: "skipped", reason: "no_catalog_plan" };
  const caught = await caughtBy(sourceControls.mcpParticipation, calls);
  return {
    status: caught ? "caught" : "missed",
    calls: calls.length,
    caught,
  };
}

const started = Date.now();
let report;
try {
  const work = await targets();
  if (!work.scopes.length) throw new Error("no loaded catalog in the database");
  console.log(
    `surface sweep: ${work.scopes.length} state-years, ${work.locations.length} locations, concurrency ${concurrency}`,
  );
  if (!lookbackOnly) await pool(work.perState, sweepState);
  let done = 0;
  await pool(work.locations, async (target) => {
    await sweepLocation(target);
    if (++done % 500 === 0)
      console.log(
        `  ${done}/${work.locations.length} locations, ${requests} requests, ${failures.length} failures`,
      );
  });
  // Plan-level and loaded-data surfaces: provider detail and participation, drug search and
  // coverage per loaded state, then the Medicare plan routes for the keys the searches returned.
  work.loadedStates = work.perState.filter((p) =>
    work.scopes.some((s) => s.state === p.state && s.plan_year === p.year),
  );
  work.samples = new Map();
  if (!lookbackOnly)
    for (const scope of work.loadedStates)
      work.samples.set(
        `${scope.state} ${scope.year}`,
        await sweepLoaded(scope),
      );
  const keys = [...medicareKeys.values()]
    .sort((a, b) => `${a.year} ${a.key}`.localeCompare(`${b.year} ${b.key}`))
    .slice(0, medicareLimit);
  const partDDrugs = [
    ...new Set(
      [...work.samples.values()].flatMap((s) => s.drugs.map((d) => d.rxcui)),
    ),
  ].slice(0, 5);
  let index = 0;
  if (!lookbackOnly)
    await pool(keys, (key) => sweepMedicarePlan(key, index++, partDDrugs));
  console.log(
    `  loaded surfaces: ${JSON.stringify(loadedCounts)}, ${keys.length} Medicare plans; ${requests} requests, ${failures.length} failures`,
  );
  const skipped = { status: "skipped", reason: "lookback_only" };
  const mutant = lookbackOnly ? skipped : await plantedMutant(work);
  const providerMutant = lookbackOnly
    ? skipped
    : await plantedProviderMutant(work);
  const classes = summarize(failures);
  report = {
    generated_at: new Date().toISOString(),
    status:
      failures.length ||
      mutant.status === "missed" ||
      providerMutant.status === "missed"
        ? "fail"
        : "pass",
    scopes: work.scopes.map((s) => `${s.state} ${s.plan_year}`),
    locations: work.locations.length,
    requests,
    failures: failures.length,
    classes,
    planted_mutant: mutant,
    planted_provider_mutant: providerMutant,
    loaded_samples: loadedCounts,
    medicare_plans: keys.length,
    outcomes,
    surface_seconds: Object.fromEntries(
      Object.entries(seconds).map(([k, v]) => [k, Math.round(v)]),
    ),
    seconds: Math.round((Date.now() - started) / 1000),
    all_failures: failures,
  };
} finally {
  await db.close();
  await sampler.close();
}
await mkdir(dirname(reportFile), { recursive: true });
await writeFile(reportFile, JSON.stringify(report, null, 2) + "\n");
for (const c of report.classes)
  console.log(
    `  ${c.class} ${c.surface}: ${c.count} (e.g. ${JSON.stringify(c.examples[0].input)})`,
  );
console.log(
  `${report.status === "pass" ? "PASS" : "FAIL"} surface sweep: ${report.requests} requests over ${report.locations} locations in ${report.scopes.length} state-years, ${report.failures} failures in ${report.classes.length} classes; planted mutants ${report.planted_mutant.status} (plan key), ${report.planted_provider_mutant.status} (provider)`,
);
if (report.status !== "pass") process.exitCode = 1;
