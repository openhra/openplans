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
 * Usage: DATABASE_URL=... node scripts/oracle/surface-sweep.mjs [--year 2026] [--state TX]...
 *   [--counties N] [--concurrency N] [--report FILE] [--optional]
 * --counties takes the first N counties of each state (default: all). --optional
 * (scripts/realdata.sh) prints SKIP and exits 0 when DATABASE_URL is not set.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rebaseImports, replaceSyntax } from "../source-mutation.mjs";
import { mutateSource, sourceControls } from "./source-controls.mjs";
import { checkResponse, summarize } from "./surface-sweep-logic.mjs";

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
const years = many("--year").map(Number);
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
const { createDatabase } = await import("../../dist/db/database.js");
const { createApp } = await import("../../dist/api/app.js");
const toolsUrl = new URL("../../dist/mcp/tools.js", import.meta.url);
const { callTool } = await import(toolsUrl.href);

const db = createDatabase(process.env.DATABASE_URL);
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
// Outcomes per surface (HTTP status or MCP error code), so a request the sweep built wrongly
// shows up as a column of 400s instead of passing quietly.
const outcomes = {};
const seconds = {};
function record(surface, input, response, items, started) {
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
  for (const kind of checkResponse({ ...response, items }))
    failures.push({
      class: kind,
      surface,
      input,
      status: response.status,
      body: JSON.stringify(response.body).slice(0, 600),
    });
}
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
    items?.(response.body, response.status),
    started,
  );
  return response.body;
}
async function mcp(tool, input, items, call = callTool) {
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
  record(`mcp ${tool}`, input, response, items?.(response.body), started);
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
  const ichra = {
    plan_start: start,
    employee: { date_of_birth: `${year - AGE - 1}-10-01` },
    residence: location,
    hra: { self_only_annual_cents: 300_000 },
    income: [{ measure: "household", annual_cents: INCOME * 100 }],
  };
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
  await mcp("search_medicare_plans", { year, location }, dataList("plans"));
  const medicare = location.zip
    ? `zip=${location.zip}`
    : `county_fips=${location.county}`;
  await rest(
    "GET /v1/medicare/plans",
    `/v1/medicare/plans?${medicare}&year=${year}`,
    undefined,
    listAt("plans"),
    target,
  );
  await mcp(
    "search",
    { query: "silver", entity: "plan", location, year },
    undefined,
  );
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
      locations.push({
        state: scope.state,
        year,
        location: { county },
        statePlan,
      });
      const zip = zips.get(county);
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
  // Inside dist/, so the copies resolve the same packages as the built modules they replace.
  const directory = await mkdtemp(
    fileURLToPath(new URL("../../dist/.surface-sweep-", import.meta.url)),
  );
  try {
    const projectionUrl = new URL(
      `../../dist/${sourceControls.mcpPlanKey.path}.js`,
      import.meta.url,
    );
    const projection = join(directory, "projection.mjs");
    await writeFile(
      projection,
      rebaseImports(
        mutateSource(
          await readFile(projectionUrl, "utf8"),
          sourceControls.mcpPlanKey,
        ),
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
    const mutant = await import(pathToFileURL(tools).href);
    const before = failures.length;
    for (const target of ny.slice(0, 5))
      await mcp(
        "search_plans",
        { year: target.year, location: target.location },
        dataList("plans"),
        mutant.callTool,
      );
    const caught = failures
      .splice(before)
      .filter((f) => f.class === "internal_honesty_check");
    requests -= Math.min(ny.length, 5);
    return {
      status: caught.length ? "caught" : "missed",
      counties: ny.slice(0, 5).map((t) => t.location.county),
      caught: caught.length,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const started = Date.now();
let report;
try {
  const work = await targets();
  if (!work.scopes.length) throw new Error("no loaded catalog in the database");
  console.log(
    `surface sweep: ${work.scopes.length} state-years, ${work.locations.length} locations, concurrency ${concurrency}`,
  );
  await pool(work.perState, sweepState);
  let done = 0;
  await pool(work.locations, async (target) => {
    await sweepLocation(target);
    if (++done % 500 === 0)
      console.log(
        `  ${done}/${work.locations.length} locations, ${requests} requests, ${failures.length} failures`,
      );
  });
  const mutant = await plantedMutant(work);
  const classes = summarize(failures);
  report = {
    generated_at: new Date().toISOString(),
    status: failures.length || mutant.status === "missed" ? "fail" : "pass",
    scopes: work.scopes.map((s) => `${s.state} ${s.plan_year}`),
    locations: work.locations.length,
    requests,
    failures: failures.length,
    classes,
    planted_mutant: mutant,
    outcomes,
    surface_seconds: Object.fromEntries(
      Object.entries(seconds).map(([k, v]) => [k, Math.round(v)]),
    ),
    seconds: Math.round((Date.now() - started) / 1000),
    all_failures: failures,
  };
} finally {
  await db.close();
}
await mkdir(dirname(reportFile), { recursive: true });
await writeFile(reportFile, JSON.stringify(report, null, 2) + "\n");
for (const c of report.classes)
  console.log(
    `  ${c.class} ${c.surface}: ${c.count} (e.g. ${JSON.stringify(c.examples[0].input)})`,
  );
console.log(
  `${report.status === "pass" ? "PASS" : "FAIL"} surface sweep: ${report.requests} requests over ${report.locations} locations in ${report.scopes.length} state-years, ${report.failures} failures in ${report.classes.length} classes; planted mutant ${report.planted_mutant.status}`,
);
if (report.status !== "pass") process.exitCode = 1;
