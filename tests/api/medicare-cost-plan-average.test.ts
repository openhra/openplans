// Plan-average prices through the HTTP route and the MCP tool, over the fixture cut of the 2026 Q3
// Part D files. The credentials and schedules are synthetic; prices and fees are the fixture's
// CMS rows. Expected cents are worked out by hand from those rows, not taken from the engine.
import { Readable } from "node:stream";
import { Hono } from "hono";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { medicareRouteDeps, medicareRoutes } from "../../src/api/medicare.js";
import type { MedicareRouteDeps } from "../../src/api/medicare.js";
import type { QuoteOptions } from "../../src/api/quotes.js";
import { InputError } from "../../src/api/validation.js";
import type { Transport } from "../../src/fetch/index.js";
import {
  acquireSpuf,
  cachedSpuf,
  importSpuf,
  parseSpufUrl,
} from "../../src/ingest/medicare/spuf.js";
import {
  assertEstimateHonest,
  boundsPresentedAsCost,
  callEstimateTool,
  estimateOutputSchema,
  estimateToolHooks,
} from "../../src/mcp/medicare-estimate.js";
import type { EstimateToolHooks } from "../../src/mcp/medicare-estimate.js";
import type { McpDependencies } from "../../src/mcp/server.js";
import { runWithScope } from "../../src/plugins/request-scope.js";
import { ReadError } from "../../src/services/errors.js";
import {
  drugCostDeps,
  estimateProvenanceProblems,
  figureOut,
} from "../../src/services/medicare-drug-cost.js";
import type { DrugCostDeps } from "../../src/services/medicare-drug-cost.js";
import {
  loadedDatabase,
  lookup,
  spufArchive,
  spufUrl,
} from "../ingest/medicare/helpers.js";
import type { Loaded } from "../ingest/medicare/helpers.js";

type Json = ReturnType<typeof JSON.parse>;
const TOKEN = "synthetic-plan-average-grant";
const PLAN = "H0028-042-0";
const PATH = `/v1/medicare/plans/${PLAN}/drug-cost-estimates?year=2026`;
const FILL_ID = "synthetic-fill-4410";
/**
 * Fixture rows behind the expected cents: plan H0028-042-0 lists RxCUI 860975 under proxy NDC
 * 70010049105, whose 30-day unit cost is 0.086. Its in-area retail pharmacies are all standard
 * (not preferred) and file brand and generic 30-day fees of 0.3 or 0.5. So 30 units cost
 * 30 x 0.086 = $2.58, $2.88 with the lowest fee and $3.08 with the highest.
 */
const UNIT_COST_TOTAL = 258;
const LOWEST = 288;
const HIGHEST = 308;
const schedule = (overrides: Record<string, unknown> = {}) => ({
  scenario: "non_lis_no_other_payer",
  price_basis: "cms_plan_average",
  channel: "standard_retail",
  opening_state: { kind: "new_calendar_year" },
  fills: [
    {
      fill_id: FILL_ID,
      date: "2026-02-03",
      rxcui: "860975",
      quantity: "30",
      unit: "ndc_unit",
      days_supply: 30,
    },
  ],
  ...overrides,
});

function switches(prices: boolean, estimator = true) {
  vi.stubEnv("OPENPLANS_MEDICARE_PART_D", "on");
  vi.stubEnv("OPENPLANS_MEDICARE_DRUG_COST", estimator ? "on" : "");
  vi.stubEnv("OPENPLANS_MEDICARE_DRUG_COST_PRICES", prices ? "on" : "");
}

function routerApp(
  db: Loaded["db"],
  deps: MedicareRouteDeps = medicareRouteDeps,
  options: QuoteOptions = { premiumToken: TOKEN },
) {
  const app = new Hono();
  app.use("*", (_c, next) => runWithScope(async () => next()));
  app.onError((error, c) => {
    if (error instanceof InputError)
      return c.json({ error: { code: error.code, field: error.field } }, 400);
    if (error instanceof ReadError) return c.json({ error: error.error }, 404);
    return c.json({ error: { code: "INTERNAL" } }, 500);
  });
  app.route("/v1", medicareRoutes(db, options, deps));
  return app;
}
const post = (app: { request: Hono["request"] }, body: unknown, auth = true) =>
  app.request(PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: JSON.stringify(body),
  });
const withService = (service: Partial<DrugCostDeps>): MedicareRouteDeps => ({
  ...medicareRouteDeps,
  service: { ...drugCostDeps, ...service },
});
/** Counts engine runs, so a test can tell whether anything was calculated. */
function counted(service: Partial<DrugCostDeps> = {}) {
  const runs = { estimate: 0 };
  const deps = withService({
    ...service,
    estimate: (request) => {
      runs.estimate++;
      return (service.estimate ?? drugCostDeps.estimate)(request);
    },
  });
  return { deps, runs };
}
const grantedDeps = (db: Loaded["db"]): McpDependencies => ({
  db,
  cursorSecret: "synthetic-plan-average-cursor",
  principal: { id: "personalized" },
  policy: { canEstimate: () => true },
  medicareEstimateGrant: true,
  pluginTools: [],
});

async function importTables(
  loaded: Loaded,
  tables?: Parameters<typeof importSpuf>[2],
) {
  const archive = parseSpufUrl(spufUrl)!;
  const cached = (await cachedSpuf(archive.kind, loaded.dataDir))[0]!;
  await importSpuf(loaded.db, cached, tables);
}

let loaded: Loaded;
beforeAll(async () => {
  loaded = await loadedDatabase();
  const transport: Transport = async () => ({
    status: 200,
    headers: { "content-type": "application/zip" },
    body: Readable.from([await spufArchive()]),
  });
  await acquireSpuf(parseSpufUrl(spufUrl)!, {
    dataDir: loaded.dataDir,
    dependencies: { lookup, transport },
  });
  // Core tables only: the release has no prices or fee ranges yet.
  await importTables(loaded);
}, 300_000);
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  await loaded?.cleanup();
});

const fillOf = (answer: Json) => answer.fills[0];
const ask = async (
  deps: MedicareRouteDeps = medicareRouteDeps,
  body = schedule(),
) => (await post(routerApp(loaded.db, deps), body)).json();

/** The setting on and no prices loaded: the answer names why, and nothing is calculated. */
async function noCalculationWithoutPrices(
  service: Partial<DrugCostDeps>,
  reason: string,
): Promise<boolean> {
  switches(true);
  const { deps, runs } = counted(service);
  const body = await ask(deps);
  vi.unstubAllEnvs();
  return (
    runs.estimate === 0 &&
    body.status === "unknown" &&
    body.reason === reason &&
    !("fills" in body)
  );
}

/** Without the Bearer token there is no plan-average answer, and the engine never runs. */
async function tokenRequired(deps: MedicareRouteDeps): Promise<boolean> {
  switches(true);
  const runs = counted();
  const guarded = { ...deps, service: runs.deps.service };
  const anonymous = await post(
    routerApp(loaded.db, guarded),
    schedule(),
    false,
  );
  const wrong = await routerApp(loaded.db, guarded).request(PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer not-the-token",
    },
    body: JSON.stringify(schedule()),
  });
  const unconfigured = await post(
    routerApp(loaded.db, guarded, {
      premiumToken: undefined,
      publicHousehold: true,
    }),
    schedule(),
    false,
  );
  vi.unstubAllEnvs();
  return (
    anonymous.status === 401 &&
    wrong.status === 401 &&
    unconfigured.status === 503 &&
    runs.runs.estimate === 0
  );
}

/** A bounded figure keeps both ends in the answer, over HTTP and MCP alike. */
async function boundsKept(service: Partial<DrugCostDeps>): Promise<boolean> {
  switches(true);
  const deps = withService(service);
  const response = await post(routerApp(loaded.db, deps), schedule());
  const hooks: EstimateToolHooks = {
    ...estimateToolHooks,
    service: deps.service,
  };
  const tool = await callEstimateTool(
    grantedDeps(loaded.db),
    { plan_key: PLAN, year: 2026, ...schedule() },
    0,
    hooks,
  );
  vi.unstubAllEnvs();
  if (response.status !== 200) return false;
  const output = tool.structuredContent as Json;
  const gross = fillOf(output.data ?? {})?.price?.figures?.gross;
  return (
    output.error === null &&
    gross?.status === "bounded" &&
    gross.cents === null &&
    gross.minimum_cents === LOWEST &&
    gross.maximum_cents === HIGHEST
  );
}

/** Writes a bounded figure as one amount at its low end: the error the checks must catch. */
const oneNumber: DrugCostDeps["figure"] = (value, refs) =>
  value.status === "bounded"
    ? {
        status: "value",
        cents: value.minimum_cents,
        reason: null,
        evidence_refs: refs,
      }
    : figureOut(value, refs);

// Runs first, while the release still has no pricing table.
describe("plan-average prices before they are loaded", () => {
  it("refuses the basis while its setting is off, and the estimator switch still comes first", async () => {
    switches(false);
    expect(await ask()).toMatchObject({
      status: "unsupported",
      reason: "price_basis_not_supported",
    });
    switches(true, false);
    expect(await ask()).toMatchObject({
      status: "unknown",
      reason: "estimator_disabled",
    });
  });

  it("answers unknown and calculates nothing with the setting on and no prices; planted mutant: a calculation still attempted is caught", async () => {
    expect(await noCalculationWithoutPrices({}, "pricing_not_loaded")).toBe(
      true,
    );
    // A service that skips the load check prices every fill and runs the engine.
    expect(
      await noCalculationWithoutPrices(
        { pricesProblem: async () => null },
        "pricing_not_loaded",
      ),
    ).toBe(false);
  });

  it("keeps cms_plan_average out of data-availability until prices are loaded", async () => {
    switches(true);
    const body = await (
      await routerApp(loaded.db).request("/v1/medicare/data-availability")
    ).json();
    const year = body.years.find((item: Json) => item.contract_year === 2026);
    expect(year.part_d_drug_cost_estimates).toMatchObject({
      price_basis: ["none"],
      pricing: {
        status: "unknown",
        reason: "pricing_not_loaded",
        switch: "on",
      },
    });
  });
});

describe("plan-average prices without fee ranges", () => {
  beforeAll(async () => {
    await importTables(loaded, ["pricing"]);
  }, 300_000);

  it("names the missing fee ranges and calculates nothing", async () => {
    expect(
      await noCalculationWithoutPrices({}, "dispensing_fees_not_loaded"),
    ).toBe(true);
  });
});

describe("plan-average prices once loaded", () => {
  beforeAll(async () => {
    await importTables(loaded, ["dispensing_fee"]);
  }, 300_000);

  it("bounds the gross cost by the lowest and highest fee and keeps the unit cost total", async () => {
    switches(true);
    const answer = await ask();
    const fill = fillOf(answer);
    expect(fill.price).toMatchObject({
      basis: "cms_plan_average",
      unit_cost: "0.0860",
      quantity_basis: "caller_asserted_ndc_units",
      readings: ["unit_cost", "lowest_fee", "highest_fee"],
    });
    const figures = fill.price.figures;
    expect(figures.unit_cost_total).toMatchObject({
      status: "value",
      cents: UNIT_COST_TOTAL,
    });
    expect(figures.total_lowest_fee).toMatchObject({ cents: LOWEST });
    expect(figures.total_highest_fee).toMatchObject({ cents: HIGHEST });
    expect(figures.gross).toMatchObject({
      status: "bounded",
      cents: null,
      minimum_cents: LOWEST,
      maximum_cents: HIGHEST,
      reason: "dispensing_fee_unknown",
    });
    // Later amounts the fee moves stay unknown with the fee as their reason.
    expect(fill.after.gross_covered_drug_cost).toMatchObject({
      status: "unknown",
      reason: "dispensing_fee_unknown",
    });
    expect(answer.assumptions.join(" ")).toContain("never one value");
    expect(estimateProvenanceProblems(answer)).toEqual([]);
  });

  it("cites the pricing row and each fee range with its snapshot, file, SHA-256 and row", async () => {
    switches(true);
    const answer = await ask();
    const cited = new Set(fillOf(answer).price.figures.gross.evidence_refs);
    const items = answer.evidence.filter((item: Json) => cited.has(item.id));
    const snapshot = answer.snapshot_ids.find((id: string) =>
      id.startsWith("cms-partd-spuf-quarterly-2026"),
    );
    expect(items).toContainEqual(
      expect.objectContaining({
        kind: "source_row",
        snapshot_id: snapshot,
        table: "pricing",
        source_row: 10,
        fields: ["UNIT_COST"],
      }),
    );
    const fees = items.filter((item: Json) => item.kind === "fee_range");
    expect(fees.map((item: Json) => item.fee_type).sort()).toEqual([
      "brand",
      "generic",
      "selected",
    ]);
    for (const fee of fees) {
      expect(fee).toMatchObject({
        snapshot_id: snapshot,
        table: "dispensing_fee",
        source_files: ["pharmacy networks file  PPUF_2026Q3 part 1.zip"],
        channel: "standard_retail",
        days_supply: 30,
      });
      expect(fee.source_sha256[0]).toMatch(/^[0-9a-f]{64}$/);
      expect(fee.first_source_row).toBeGreaterThan(1);
    }
  });

  it("leaves mail order and a fee-less channel unknown with their reasons", async () => {
    switches(true);
    const mail = await ask(
      medicareRouteDeps,
      schedule({ channel: "standard_mail" }),
    );
    expect(fillOf(mail).price.figures.gross).toMatchObject({
      status: "unknown",
      reason: "unit_cost_retail_only",
    });
    // Every in-area pharmacy of this plan is a standard one: no preferred fee to read.
    const preferred = await ask(
      medicareRouteDeps,
      schedule({ channel: "preferred_retail" }),
    );
    expect(fillOf(preferred).price.figures.gross).toMatchObject({
      status: "unknown",
      reason: "dispensing_fee_unknown",
    });
    const tablets = await ask(
      medicareRouteDeps,
      schedule({
        fills: [{ ...schedule().fills[0], unit: "tablet" }],
      }),
    );
    expect(fillOf(tablets).price.figures.gross).toMatchObject({
      status: "unknown",
      reason: "quantity_unit_not_ndc_unit",
    });
  });

  it("lists cms_plan_average in data-availability only with the setting on, and hides the section with the estimator off", async () => {
    const section = async () => {
      const body = await (
        await routerApp(loaded.db).request("/v1/medicare/data-availability")
      ).json();
      return body.years.find((item: Json) => item.contract_year === 2026)
        .part_d_drug_cost_estimates;
    };
    switches(true);
    expect(await section()).toMatchObject({
      price_basis: ["none", "cms_plan_average"],
      pricing: { status: "available", switch: "on" },
    });
    switches(false);
    expect(await section()).toMatchObject({
      price_basis: ["none"],
      pricing: { status: "available", switch: "off" },
    });
    switches(true, false);
    expect(await section()).toBeUndefined();
  });

  it("gives the MCP tool the same bounded answer, which passes its honesty check", async () => {
    switches(true);
    const route = await ask();
    const tool = await callEstimateTool(grantedDeps(loaded.db), {
      plan_key: PLAN,
      year: 2026,
      ...schedule(),
    });
    const output = tool.structuredContent as Json;
    expect(output.error, JSON.stringify(output.error)).toBeNull();
    expect(estimateOutputSchema.safeParse(output).success).toBe(true);
    expect(output.data).toEqual(route);
    expect(output.notes.join(" ")).toContain("never one cost");
    expect(boundsPresentedAsCost(output.data)).toEqual([]);
    expect(() => assertEstimateHonest(output, route)).not.toThrow();
  });

  it("the MCP honesty check refuses a bound passed off as an exact cost", async () => {
    switches(true);
    const tool = await callEstimateTool(grantedDeps(loaded.db), {
      plan_key: PLAN,
      year: 2026,
      ...schedule(),
    });
    const output = tool.structuredContent as Json;
    // The same edit on both sides, as if the service itself had written it.
    const tampered = (edit: (gross: Json) => void) => {
      const copy = structuredClone(output);
      edit(fillOf(copy.data).price.figures.gross);
      return () => assertEstimateHonest(copy, copy.data);
    };
    expect(tampered((gross) => (gross.cents = LOWEST))).toThrow(
      /INTERNAL_HONESTY_CHECK/,
    );
    expect(tampered((gross) => (gross.status = "value"))).toThrow(
      /INTERNAL_HONESTY_CHECK/,
    );
    expect(
      tampered((gross) => {
        gross.status = "value";
        gross.cents = LOWEST;
        gross.reason = null;
        delete gross.minimum_cents;
        delete gross.maximum_cents;
      }),
    ).toThrow(/INTERNAL_HONESTY_CHECK/);
    expect(
      tampered((gross) => {
        delete gross.maximum_cents;
      }),
    ).toThrow(/INTERNAL_HONESTY_CHECK/);
  });

  describe("planted mutants", () => {
    it("a bounded answer rendered as one number is caught", async () => {
      expect(await boundsKept({})).toBe(true);
      expect(await boundsKept({ figure: oneNumber })).toBe(false);
    });

    it("the route answering without a token is caught", async () => {
      expect(await tokenRequired(medicareRouteDeps)).toBe(true);
      const open: MedicareRouteDeps = {
        ...medicareRouteDeps,
        grant: () => async (_c, next) => {
          await next();
        },
      };
      expect(await tokenRequired(open)).toBe(false);
    });
  });
});
