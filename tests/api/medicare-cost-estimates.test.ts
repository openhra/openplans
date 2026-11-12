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
import { createApp } from "../../src/api/app.js";
import { MemoryCache } from "../../src/api/cache/store.js";
import { medicareRouteDeps, medicareRoutes } from "../../src/api/medicare.js";
import type { MedicareRouteDeps } from "../../src/api/medicare.js";
import { personalizedOnly } from "../../src/api/quotes.js";
import type { QuoteOptions } from "../../src/api/quotes.js";
import { InputError } from "../../src/api/validation.js";
import { loadConfig } from "../../src/config/index.js";
import type { EstimateRequest } from "../../src/domain/medicare/part-d-cost/engine.js";
import type { Transport } from "../../src/fetch/index.js";
import {
  acquireSpuf,
  cachedSpuf,
  importSpuf,
  parseSpufUrl,
} from "../../src/ingest/medicare/spuf.js";
import { runWithScope } from "../../src/plugins/request-scope.js";
import { ReadError } from "../../src/services/errors.js";
import {
  drugCostDeps,
  estimateProvenanceProblems,
  parseDrugCostRequest,
} from "../../src/services/medicare-drug-cost.js";
import type { DrugCostDeps } from "../../src/services/medicare-drug-cost.js";
import {
  loadedDatabase,
  lookup,
  spufArchive,
  spufUrl,
} from "../ingest/medicare/helpers.js";
import type { Loaded } from "../ingest/medicare/helpers.js";

// Synthetic credential and schedules over the fixture cut of the 2026 Q3 Part D files.
type Json = ReturnType<typeof JSON.parse>;
const TOKEN = "synthetic-estimate-grant";
const PLAN = "H0028-042-0";
const PATH = `/v1/medicare/plans/${PLAN}/drug-cost-estimates?year=2026`;
const FILL_ID = "synthetic-fill-7731";
const schedule = (overrides: Record<string, unknown> = {}) => ({
  scenario: "non_lis_no_other_payer",
  channel: "preferred_retail",
  opening_state: { kind: "new_calendar_year" },
  fills: [
    {
      fill_id: FILL_ID,
      date: "2026-02-03",
      rxcui: "860975",
      quantity: "30",
      unit: "tablet",
      days_supply: 30,
    },
  ],
  ...overrides,
});
const catastrophic = {
  kind: "provided",
  as_of: "2026-01-15",
  gross_covered_drug_cost_cents: 900_000,
  troop_cents: 210_000,
  plan_deductible_met_cents: 0,
};

class SpyStore extends MemoryCache {
  sets = 0;
  constructor() {
    super(1 << 20);
  }
  override async set(key: string, value: string, ttl: number) {
    this.sets++;
    return super.set(key, value, ttl);
  }
}

function switches(partD: boolean, estimator: boolean) {
  vi.stubEnv("OPENPLANS_MEDICARE_PART_D", partD ? "on" : "");
  vi.stubEnv("OPENPLANS_MEDICARE_DRUG_COST", estimator ? "on" : "");
}

/** The Medicare router alone, with its error mapping and a probe of the request's cache level. */
function routerApp(
  db: Loaded["db"],
  deps: MedicareRouteDeps,
  options: QuoteOptions = { premiumToken: TOKEN },
) {
  const app = new Hono();
  app.use("*", (c, next) =>
    runWithScope(async (scope) => {
      await next();
      c.res.headers.set("x-test-cache-level", String(scope.level()));
    }),
  );
  app.onError((error, c) => {
    if (error instanceof InputError)
      return c.json({ error: { code: error.code, field: error.field } }, 400);
    if (error instanceof ReadError) return c.json({ error: error.error }, 404);
    throw error;
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
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("Part D drug-cost estimates over HTTP", () => {
  let loaded: Loaded;
  let store: SpyStore;
  let app: ReturnType<typeof createApp>;
  beforeAll(async () => {
    loaded = await loadedDatabase();
    const transport: Transport = async () => ({
      status: 200,
      headers: { "content-type": "application/zip" },
      body: Readable.from([await spufArchive()]),
    });
    const archive = parseSpufUrl(spufUrl)!;
    await acquireSpuf(archive, {
      dataDir: loaded.dataDir,
      dependencies: { lookup, transport },
    });
    await importSpuf(
      loaded.db,
      (await cachedSpuf(archive.kind, loaded.dataDir))[0]!,
    );
    store = new SpyStore();
    app = createApp(
      loaded.db,
      { premiumToken: TOKEN },
      { store, config: loadConfig({}) },
    );
  }, 300_000);
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    await loaded?.cleanup();
  });

  it("stays off by default and names the switch that keeps it off", async () => {
    switches(false, false);
    let response = await post(app, schedule());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      status: "unknown",
      reason: "pending_terms_review",
      bindable_quote: false,
    });
    switches(true, false);
    response = await post(app, schedule());
    expect(await response.json()).toMatchObject({
      status: "unknown",
      reason: "estimator_disabled",
    });
    // The estimator switch alone does not serve Part D data.
    switches(false, true);
    response = await post(app, schedule());
    expect((await response.json()).reason).toBe("pending_terms_review");
  });

  it("needs the personalized-estimate grant and never opens to anonymous callers", async () => {
    switches(true, true);
    const anonymous = await post(app, schedule(), false);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("cache-control")).toBe("no-store");
    const wrong = await app.request(PATH, {
      method: "POST",
      headers: { authorization: "Bearer not-the-token" },
      body: JSON.stringify(schedule()),
    });
    expect(wrong.status).toBe(401);
    // No token configured: closed, even with public household access on.
    const open = createApp(
      loaded.db,
      { premiumToken: undefined, publicHousehold: true },
      { store: new SpyStore(), config: loadConfig({}) },
    );
    const closed = await post(open, schedule());
    expect(closed.status).toBe(503);
    expect(await closed.json()).toEqual({
      error: { code: "AUTH_NOT_CONFIGURED" },
    });
  });

  it("returns filed benefit evidence with sources and unknown amounts without prices", async () => {
    switches(true, true);
    const response = await post(app, schedule());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      plan_key: PLAN,
      contract_year: 2026,
      status: "unknown",
      bindable_quote: false,
      price_basis: "none",
      estimate_scope: "supplied_schedule",
      as_of: "2026-10-07",
      formulary_id: "00026408",
      channel_verification: "unknown",
      opening_origin: "new_calendar_year",
    });
    expect(body.snapshot_ids.length).toBe(2);
    // Benefit type comes from the PBP filing, not the caller.
    expect(body.benefit_type).toMatchObject({
      value: "EA",
      origin: "pbp_filing",
    });
    expect(body.benefit_type.evidence_refs.length).toBeGreaterThan(0);
    expect(body.plan_figures.standard_deductible).toMatchObject({
      status: "value",
      cents: 61500,
    });
    expect(body.plan_figures.out_of_pocket_threshold.cents).toBe(210000);
    const [fill] = body.fills;
    expect(fill).toMatchObject({
      fill_id: FILL_ID,
      tier: 1,
      supply: "30_days",
      status: "unknown",
    });
    expect(fill.listing).toMatchObject({ status: "listed", product: "single" });
    expect(fill.listing.packages[0].proxy_ndc).toBe("70010049105");
    expect(fill.filed_cost_sharing.length).toBeGreaterThan(0);
    for (const row of fill.filed_cost_sharing)
      expect(row.evidence_refs.length).toBeGreaterThan(0);
    expect(fill.figures.patient_pay).toMatchObject({
      status: "unknown",
      cents: null,
    });
    expect(fill.figures.patient_pay.reason).toContain("pricing_not_loaded");
    // Classes the files do not settle stay unknown with the missing source named.
    expect(fill.classification.insulin.origin).toBe("unknown");
    expect(fill.classification.program.origin).toBe(
      "formulary_flag_and_cms_selected_drug_list",
    );
    expect(body.gaps).toContain("pricing_not_loaded");
    expect(body.totals.premiums).toEqual({ status: "not_evaluated" });
    expect(body.totals.calculable_subtotal).toMatchObject({
      cents: 0,
      fills: 0,
      complete: false,
    });
    expect(estimateProvenanceProblems(body)).toEqual([]);
    expect(JSON.stringify(body)).not.toMatch(/not[ _-]?covered/i);
    const ids = body.evidence.map((item: Json) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Byte-stable for the same request.
    const again = await (await post(app, schedule())).text();
    expect(again).toBe(JSON.stringify(body));
  });

  it("labels a supplied opening state and cites it, leaving unsettled amounts unknown", async () => {
    switches(true, true);
    const body = await (
      await post(app, schedule({ opening_state: catastrophic }))
    ).json();
    expect(body.opening_origin).toBe("caller_assertion");
    const fill = body.fills[0];
    const troop = fill.before.troop;
    expect(troop).toMatchObject({ status: "value", cents: 210000 });
    const cited = body.evidence.filter((item: Json) =>
      troop.evidence_refs.includes(item.id),
    );
    expect(cited.map((item: Json) => item.kind)).toEqual(
      expect.arrayContaining(["source_row", "rule", "request"]),
    );
    expect(
      cited.some(
        (item: Json) =>
          item.kind === "request" && item.field === "opening_state",
      ),
    ).toBe(true);
    // Past the threshold the enrollee pays $0 in every valid reading of the open insulin, vaccine
    // and program facts, so the amount is a value. The price still decides the gross cost and the
    // payer split.
    expect(fill.derivation).toContain(
      "catastrophic phase: no cost sharing whatever the price",
    );
    expect(fill.figures.patient_pay).toMatchObject({
      status: "value",
      cents: 0,
    });
    expect(fill.figures.troop_increment).toMatchObject({
      status: "value",
      cents: 0,
    });
    expect(fill.figures.gross_above_threshold.status).toBe("unknown");
    expect(fill.figures.gross_above_threshold.reason).toContain(
      "pricing_not_loaded",
    );
    const rules = body.evidence.filter(
      (item: Json) =>
        fill.figures.patient_pay.evidence_refs.includes(item.id) &&
        item.kind === "rule",
    );
    expect(rules.some((item: Json) => /Catastrophic/.test(item.section))).toBe(
      true,
    );
    expect(body.status).toBe("estimated");
    expect(body.totals.patient_pay).toMatchObject({
      status: "value",
      cents: 0,
    });
    expect(estimateProvenanceProblems(body)).toEqual([]);
  });

  it("keeps an unlisted drug unknown and never calls it not covered", async () => {
    switches(true, true);
    const body = await (
      await post(
        app,
        schedule({
          fills: [{ ...schedule().fills[0], rxcui: "310965" }],
        }),
      )
    ).json();
    expect(body.fills[0].listing.status).toBe("not_listed");
    expect(body.fills[0].figures.patient_pay).toMatchObject({
      status: "unknown",
      reason: "not_listed",
    });
    expect(JSON.stringify(body)).not.toMatch(/not[ _-]?covered/i);
  });

  it("rejects caller-asserted classifications and benefit type", async () => {
    switches(true, true);
    const asserted = await post(
      app,
      schedule({
        fills: [
          {
            ...schedule().fills[0],
            classification: {
              insulin: true,
              acip_vaccine: false,
              program: "selected",
            },
          },
        ],
      }),
    );
    expect(asserted.status).toBe(400);
    expect(await asserted.json()).toEqual({
      error: { code: "UNSUPPORTED_FIELD", field: "body.fills.0" },
    });
    const typed = await post(app, schedule({ benefit_type: "DS" }));
    expect(await typed.json()).toEqual({
      error: { code: "UNSUPPORTED_FIELD", field: "body" },
    });
  });

  it("answers validation, unsupported scenarios and missing plans with the existing shapes", async () => {
    switches(true, true);
    expect((await post(app, "{")).status).toBe(400);
    const unsupported = await (
      await post(app, schedule({ scenario: "lis_full_subsidy" }))
    ).json();
    expect(unsupported).toMatchObject({
      status: "unsupported",
      reason: "scenario_not_supported",
    });
    const average = await (
      await post(app, schedule({ price_basis: "cms_plan_average" }))
    ).json();
    expect(average).toMatchObject({
      status: "unsupported",
      reason: "price_basis_not_supported",
    });
    const order = await post(
      app,
      schedule({
        fills: [
          { ...schedule().fills[0], fill_id: "a", date: "2026-03-01" },
          { ...schedule().fills[0], fill_id: "b", date: "2026-02-01" },
        ],
      }),
    );
    expect(order.status).toBe(400);
    expect(await order.json()).toEqual({
      error: { code: "INVALID_SCHEDULE", field: "body.fills" },
    });
    const tooMany = await post(
      app,
      schedule({
        fills: Array.from({ length: 51 }, (_, i) => ({
          ...schedule().fills[0],
          fill_id: `f${i}`,
        })),
      }),
    );
    expect(tooMany.status).toBe(400);
    const missing = await app.request(
      "/v1/medicare/plans/H9999-001-0/drug-cost-estimates?year=2026",
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify(schedule()),
      },
    );
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("PLAN_NOT_FOUND");
    const year = await app.request(
      `/v1/medicare/plans/${PLAN}/drug-cost-estimates`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify(schedule()),
      },
    );
    expect(year.status).toBe(400);
  });

  it("never caches an estimate and never logs the schedule", async () => {
    switches(true, true);
    const spies = (["log", "info", "warn", "error", "debug"] as const).map(
      (name) => vi.spyOn(console, name),
    );
    try {
      const before = store.sets;
      for (let i = 0; i < 2; i++) {
        const response = await post(
          app,
          schedule({ opening_state: catastrophic }),
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("x-cache")).toBe("bypass");
        expect(response.headers.get("cache-control")).toBe("no-store");
      }
      expect(store.sets).toBe(before);
      const stats = await (await app.request("/v1/cache-stats")).json();
      expect(stats.hits).toBe(0);
      const logged = spies
        .flatMap((spy) => spy.mock.calls)
        .map((call) => JSON.stringify(call))
        .join("\n");
      expect(logged).not.toContain(FILL_ID);
      expect(logged).not.toContain("860975");
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("reports the estimator capability only when its switch is on", async () => {
    switches(true, false);
    const off = await (
      await app.request("/v1/medicare/data-availability")
    ).json();
    expect(JSON.stringify(off)).not.toContain("part_d_drug_cost_estimates");
    switches(true, true);
    const on = await (
      await app.request("/v1/medicare/data-availability")
    ).json();
    const year = on.years.find((item: Json) => item.contract_year === 2026);
    expect(year.part_d_drug_cost_estimates).toMatchObject({
      status: "available",
      access: "personalized_estimate_grant",
      price_basis: ["none"],
      benefit_evidence: { status: "available" },
      benefit_mapping: { status: "available" },
      rules: { status: "available" },
      pricing: { status: "unknown", reason: "pricing_not_loaded" },
      pharmacy_network: { status: "unknown" },
    });
    switches(false, true);
    const gated = await (
      await app.request("/v1/medicare/data-availability")
    ).json();
    expect(
      gated.years.find((item: Json) => item.contract_year === 2026)
        .part_d_drug_cost_estimates,
    ).toMatchObject({ status: "unknown", reason: "pending_terms_review" });
  });

  // ---------- planted mutants: each check passes on the real router and fails on its mutant ----------

  describe("negative controls", () => {
    const withService = (
      service: Partial<DrugCostDeps>,
    ): MedicareRouteDeps => ({
      ...medicareRouteDeps,
      service: { ...drugCostDeps, ...service },
    });

    /** Off by default: no bundle is read and the answer names the switch. */
    async function switchHolds(deps: MedicareRouteDeps): Promise<boolean> {
      switches(true, false);
      let reads = 0;
      const counted: MedicareRouteDeps = {
        ...deps,
        service: {
          ...deps.service,
          readBundle: async (...args) => {
            reads++;
            return deps.service.readBundle(...args);
          },
        },
      };
      const body = await (
        await post(routerApp(loaded.db, counted), schedule())
      ).json();
      vi.unstubAllEnvs();
      return reads === 0 && body.reason === "estimator_disabled";
    }

    /** The request runs at cache level `none`, so no response cache may store it. */
    async function neverStored(deps: MedicareRouteDeps): Promise<boolean> {
      switches(true, true);
      const response = await post(routerApp(loaded.db, deps), schedule());
      vi.unstubAllEnvs();
      return (
        response.status === 200 &&
        response.headers.get("x-test-cache-level") === "none"
      );
    }

    /** A caller cannot assert a classification, and the engine only ever sees unknown. */
    async function evidenceOnly(deps: MedicareRouteDeps): Promise<boolean> {
      switches(true, true);
      const seen: EstimateRequest[] = [];
      const spied: MedicareRouteDeps = {
        ...deps,
        service: {
          ...deps.service,
          estimate: (request) => {
            seen.push(request);
            return deps.service.estimate(request);
          },
        },
      };
      const router = routerApp(loaded.db, spied);
      const asserted = await post(
        router,
        schedule({
          fills: [
            {
              ...schedule().fills[0],
              classification: {
                insulin: true,
                acip_vaccine: false,
                program: "selected",
              },
            },
          ],
        }),
      );
      await post(router, schedule());
      vi.unstubAllEnvs();
      return (
        asserted.status === 400 &&
        seen.length === 1 &&
        seen.every(
          (request) =>
            request.benefit_type === "unknown" &&
            request.fills.every(
              (fill) =>
                fill.classification.insulin === "unknown" &&
                fill.classification.acip_vaccine === "unknown" &&
                fill.classification.program === "unknown",
            ),
        )
      );
    }

    /** No grant, no estimate: anonymous callers are refused even with household access open. */
    async function grantRequired(deps: MedicareRouteDeps): Promise<boolean> {
      switches(true, true);
      const open = { premiumToken: undefined, publicHousehold: true };
      const response = await post(
        routerApp(loaded.db, deps, open),
        schedule(),
        false,
      );
      vi.unstubAllEnvs();
      return response.status === 503;
    }

    it("the switch is ignored", async () => {
      expect(await switchHolds(medicareRouteDeps)).toBe(true);
      expect(await switchHolds(withService({ enabled: () => true }))).toBe(
        false,
      );
    });

    it("an estimate gets cached", async () => {
      expect(await neverStored(medicareRouteDeps)).toBe(true);
      expect(
        await neverStored({ ...medicareRouteDeps, restrict: () => {} }),
      ).toBe(false);
    });

    it("an asserted classification is accepted", async () => {
      expect(await evidenceOnly(medicareRouteDeps)).toBe(true);
      const lenient = withService({
        parse: (body) => {
          const raw = body as { fills: Record<string, unknown>[] };
          const facts = raw.fills.map((fill) => fill.classification);
          const parsed = parseDrugCostRequest({
            ...raw,
            fills: raw.fills.map(({ classification: _, ...fill }) => fill),
          });
          parsed.fills.forEach((fill, i) =>
            Object.assign(fill, { classification: facts[i] }),
          );
          return parsed;
        },
        drugFacts: (fill) =>
          (fill as { classification?: never }).classification ?? {
            insulin: "unknown",
            acip_vaccine: "unknown",
            program: "unknown",
          },
      });
      expect(await evidenceOnly(lenient)).toBe(false);
    });

    it("an anonymous caller gets estimate access", async () => {
      expect(await grantRequired(medicareRouteDeps)).toBe(true);
      expect(
        await grantRequired({ ...medicareRouteDeps, grant: personalizedOnly }),
      ).toBe(false);
    });

    it("a figure loses its source", async () => {
      switches(true, true);
      const body = await (
        await post(app, schedule({ opening_state: catastrophic }))
      ).json();
      expect(estimateProvenanceProblems(body)).toEqual([]);
      body.fills[0].before.troop.evidence_refs = [];
      expect(estimateProvenanceProblems(body)).toContain(
        "$.fills[0].before.troop: value without evidence",
      );
      const relabelled = JSON.parse(
        JSON.stringify(body).replace("not_listed", "not_covered"),
      );
      relabelled.fills[0].listing.reason = "not_covered";
      expect(estimateProvenanceProblems(relabelled)).toContain(
        "an answer never says not covered",
      );
    });
  });
});
