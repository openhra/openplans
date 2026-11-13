// Synthetic transport and key; the catalog and terminology use public fixture cuts.
import { Hono } from "hono";
import { callTool } from "../../../src/mcp/tools.js";
import { assertHonest, outputSchemas } from "../../../src/mcp/schemas.js";
import type { DrugCoverage } from "../../../src/domain/drugs/index.js";
import type { ProviderParticipation } from "../../../src/domain/providers/index.js";
import type { SqlSession } from "../../../src/db/database.js";
import type * as QuoteRoutes from "../../../src/api/quotes.js";
import { replaceSyntax } from "../../source-mutation.js";
import type * as NodeCrypto from "node:crypto";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import type { quotePlans } from "../../../src/services/quotes.js";
import type { CmsApiEvidence } from "../../../src/ingest/cms-api/fallback.js";
import { createApp } from "../../../src/api/app.js";
import * as coverageService from "../../../src/services/quote-coverage.js";
import {
  cmsFallbackContext,
  resetCmsClientCounts,
} from "../../../src/ingest/cms-api/fallback.js";
import {
  AdmissionSession,
  shippedManifestPaths,
} from "../../../src/fetch/index.js";
import type { Transport } from "../../../src/fetch/index.js";
import { BASE, headers, searchBody, setup } from "./helpers.js";
import { assertShape } from "./shape.js";
import { quoteBody } from "../../api/quote-fixture.js";
import { importMutant, withMutantFile } from "../../mutant-file.js";

vi.mock("node:crypto", async (importOriginal) => {
  const crypto = await importOriginal<typeof NodeCrypto>();
  return {
    ...crypto,
    randomUUID: () => "00000000-0000-4000-8000-000000000004",
  };
});

vi.mock("../../../src/fetch/limiter.js", () => ({
  leaseHost: async () => async () => {},
}));
interface CompatBody {
  plans: {
    providers: {
      npi: number;
      in_network: boolean | null;
      addresses: unknown[];
    }[];
  }[];
  coverages: {
    plan_id: string;
    drug_package_id: string | number;
    tier: string | null;
    prior_authorization: boolean | null;
    step_therapy: boolean | null;
    quantity_limit: boolean | null;
  }[];
}
let h: Awaited<ReturnType<typeof setup>>;
let directory: string;
let manifestPath: string;
let sent: URL[];
let responseCoverage: string;
let rx: string;
const plan = "87226TX0100013";
const npi = "1000000000";
const docs = "Synthetic CMS documentation for quote tests.";
const transport: Transport = async (url) => {
  if (url.pathname === "/robots.txt")
    return {
      status: url.hostname === "marketplace.api.healthcare.gov" ? 401 : 404,
      headers: {},
      body: Readable.from([""]),
    };
  if (url.hostname === "developer.cms.gov")
    return { status: 200, headers: {}, body: Readable.from([docs]) };
  sent.push(new URL(url));
  const kind = url.pathname.includes("providers") ? "npi" : "rxcui";
  const ids = url.searchParams
    .get(kind === "npi" ? "providerids" : "drugs")!
    .split(",");
  const plans = url.searchParams.get("planids")!.split(",");
  // Clear only spacing in this offline fixture so both calls can run without sleeping.
  await h.db.query("UPDATE cms_api_budget SET next_request_at='epoch'");
  return {
    status: 200,
    headers: {},
    body: Readable.from([
      JSON.stringify({
        coverage: plans.flatMap((plan_id) =>
          ids.map((id) => ({
            plan_id,
            [kind]: id,
            coverage: responseCoverage,
          })),
        ),
      }),
    ]),
  };
};
beforeAll(async () => {
  h = await setup();
  rx = (
    await h.db.query<{ rxcui: string }>(
      "SELECT rxcui FROM rx_concept WHERE suppress='N' ORDER BY rxcui LIMIT 1",
    )
  ).rows[0]!.rxcui;
});
afterAll(async () => h?.close());
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "openplans-quote-fallback-"));
  vi.stubEnv("OPENPLANS_CMS_FALLBACK", "on");
  vi.stubEnv("OPENPLANS_CMS_FALLBACK_QUOTES", "on");
  vi.stubEnv("CMS_API_KEY", "synthetic-quote-cms-key");
  const manifest = JSON.parse(
    await readFile(
      shippedManifestPaths().find((p) =>
        p.endsWith("cms-marketplace-api.json"),
      )!,
      "utf8",
    ),
  );
  manifest.publishers[0]!.terms.sha256 = createHash("sha256")
    .update(docs)
    .digest("hex");
  manifestPath = join(directory, "access.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  sent = [];
  responseCoverage = "Covered";
  resetCmsClientCounts();
  await h.db
    .exec(`DELETE FROM cms_api_conflict; DELETE FROM cms_api_drug_coverage; DELETE FROM cms_api_provider_coverage; DELETE FROM cms_api_attempt;
    UPDATE record_policy SET default_ttl=CASE name WHEN 'cms_api_fallback' THEN interval '7 days' ELSE interval '1 day' END,stale_window='30 days' WHERE name IN ('cms_api_fallback','cms_api_fallback_no_data');
    UPDATE cms_api_budget SET day_start=(now() AT TIME ZONE 'UTC')::date, daily_requests=0,next_request_at='epoch',blocked_until='epoch',max_daily_requests=500,half_open=false,failure_count=0,failure_window_start=now();`);
  const factory = coverageService.quoteFallbackContext;
  vi.spyOn(coverageService, "quoteFallbackContext").mockImplementation(
    (db, client, writer = db) => {
      if (!factory(db, client)) return undefined;
      return cmsFallbackContext(db, writer, {
        client,
        admission: new AdmissionSession([manifestPath], {
          maxRequests: 100,
          maxTransferBytes: 1024 ** 2,
        }),
        fetchOptions: {
          transport,
          dataDir: directory,
          lookup: async () => [{ address: "8.8.8.8", family: 4 }],
        },
      });
    },
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
const productionDb = (): SqlSession => ({
  ...h.db,
  withRequest: (_signal, run, options) =>
    h.db.transaction(async (tx) => {
      await tx.exec(
        options?.readOnly === false
          ? "SET TRANSACTION READ WRITE"
          : "SET TRANSACTION READ ONLY",
      );
      return run(tx);
    }),
});
const app = () =>
  createApp(productionDb(), {
    peerAddress: (request) =>
      request.headers.get("x-synthetic-peer") ?? "192.0.2.1",
  });
async function native(
  extra = {},
  api: Pick<ReturnType<typeof app>, "request"> = app(),
) {
  const response = await api.request("/v1/quotes", {
    method: "POST",
    headers,
    body: JSON.stringify(quoteBody({ npis: [npi], rxcuis: [rx], ...extra })),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<Awaited<ReturnType<typeof quotePlans>>>;
}
async function compat(
  extra = {},
  api: Pick<ReturnType<typeof app>, "request"> = app(),
) {
  const response = await api.request(`${BASE}/plans/medical/search`, {
    method: "POST",
    headers,
    body: JSON.stringify(
      searchBody({
        ids: [plan],
        providers: [{ npi }],
        drug_packages: [{ id: "synthetic-package", rx_cui_id: rx }],
        ...extra,
      }),
    ),
  });
  expect(response.status).toBe(200);
  return { response, body: (await response.json()) as CompatBody };
}
function labelled(
  answer: { cms_api?: CmsApiEvidence },
  freshness = "refetched",
) {
  expect(answer.cms_api).toMatchObject({
    sourced_by: "cms-marketplace-api",
    freshness,
  });
}

it("fills native quote cells, batches across plans, and labels live, fresh and stale answers", async () => {
  const first = await native({ plan_ids: undefined });
  expect(first.quotes.length).toBeGreaterThan(1);
  expect(sent).toHaveLength(2);
  for (const quote of first.quotes) {
    expect(quote.providers[0]!.status).toBe("listed_participating");
    expect(quote.drugs[0]!.status).toBe("listed_covered");
    labelled(quote.providers[0]!);
    labelled(quote.drugs[0]!);
  }
  sent = [];
  const fresh = await native({ plan_ids: undefined });
  labelled(fresh.quotes[0]!.providers[0]!, "fresh");
  expect(sent).toEqual([]);
  await h.db.query(
    "UPDATE cms_api_provider_coverage SET expired_at=now()-interval '1 day'",
  );
  await h.db.query(
    "UPDATE cms_api_budget SET blocked_until=now()+interval '1 hour'",
  );
  const stale = await native({ plan_ids: undefined });
  labelled(stale.quotes[0]!.providers[0]!, "stale");
  expect(stale.quotes[0]!.providers[0]!.status).toBe("listed_participating");
  expect(sent).toEqual([]);
});

it("keeps compatibility keys and nests provenance in the existing gaps header", async () => {
  const { body, response } = await compat();
  expect(body.plans[0]!.providers).toEqual([
    { npi: Number(npi), in_network: true, addresses: [] },
  ]);
  const drug = body.coverages[0]!;
  assertShape(
    {
      plan_id: plan,
      drug_package_id: "synthetic-package",
      tier: null,
      prior_authorization: null,
      step_therapy: null,
      quantity_limit: null,
    },
    drug,
  );
  expect(Object.keys(drug).sort()).toEqual(
    [
      "plan_id",
      "drug_package_id",
      "tier",
      "prior_authorization",
      "step_therapy",
      "quantity_limit",
    ].sort(),
  );
  expect(drug.tier).toBeNull();
  expect(JSON.stringify(body)).not.toContain("cms_api");
  const gaps = response.headers.get("x-openplans-gaps")!;
  expect(gaps).toContain(
    `coverage:${plan}:provider:${npi}:listed_participating:sourced_by=cms-marketplace-api:freshness=refetched`,
  );
  expect(gaps).toContain(
    `coverage:${plan}:drug:synthetic-package:listed_covered:sourced_by=cms-marketplace-api:freshness=refetched`,
  );
  expect(gaps).toContain("drug_coverage_flag_does_not_supply_tier");
});

it("keeps DataNotProvided unknown in both responses", async () => {
  responseCoverage = "DataNotProvided";
  const result = await native();
  for (const cell of [
    result.quotes[0]!.providers[0]!,
    result.quotes[0]!.drugs[0]!,
  ]) {
    expect(cell.status).toBe("unknown");
    expect(cell.covered).toBeUndefined();
    labelled(cell);
  }
  const resultCompat = await compat();
  expect(resultCompat.body.plans[0]!.providers[0]!.in_network).toBeNull();
  expect(resultCompat.body.coverages[0]!.tier).toBeNull();
  expect(resultCompat.response.headers.get("x-openplans-gaps")).toContain(
    "unknown:cms_api_data_not_provided",
  );
});

it.each(["budget", "breaker", "client"])(
  "keeps refusals unknown across the quote: %s",
  async (refusal) => {
    if (refusal === "budget")
      await h.db.query(
        "UPDATE cms_api_budget SET daily_requests=max_daily_requests",
      );
    if (refusal === "breaker")
      await h.db.query(
        "UPDATE cms_api_budget SET blocked_until=now()+interval '1 hour'",
      );
    if (refusal === "client")
      await h.db.query("UPDATE cms_api_budget SET max_daily_requests=10");
    const result = await native({ plan_ids: undefined });
    const reasons = {
      budget: "cms_api_budget_exhausted",
      breaker: "cms_api_unavailable",
      client: "cms_api_request_cap",
    };
    const reason = reasons[refusal as keyof typeof reasons];
    expect(sent).toHaveLength(refusal === "client" ? 1 : 0);
    for (const quote of result.quotes) {
      expect(quote.drugs[0]!).toMatchObject({ status: "unknown", reason });
      if (refusal !== "client")
        expect(quote.providers[0]!).toMatchObject({
          status: "unknown",
          reason,
        });
    }
    if (refusal === "client") {
      const again = await compat({ providers: [{ npi: "1000000001" }] });
      expect(again.body.plans[0]!.providers[0]!.in_network).toBeNull();
      expect(sent).toHaveLength(1);
    }
  },
);

it("requires the local RxNorm match and never translates med_id", async () => {
  const result = await native({ npis: [], rxcuis: ["999999999999"] });
  expect(result.quotes[0]!.drugs[0]!).toMatchObject({
    status: "unknown",
    reason: "rxcui_not_in_rxnorm",
  });
  expect(sent).toEqual([]);
  const resultCompat = await compat({
    providers: [],
    drug_packages: [{ med_id: 12345 }],
  });
  expect(resultCompat.body.coverages[0]!.tier).toBeNull();
  expect(resultCompat.response.headers.get("x-openplans-gaps")).toContain(
    "drug_identity_requires_rxnorm",
  );
  expect(sent).toEqual([]);
});

// Response byte hashes recorded from the develop fixture responses before this wiring.
it("leaves native and compatibility response bytes unchanged with the quote switch off", async () => {
  await native();
  sent = [];
  const expected = {
    native: "f0be5a7d7bc6295b91b5a11f5f6af6232a282772d6a36e0f3c1d017d9486d2e4",
    compat: "903988b143c112191de7020fd685f79e63c1a50c45a1dbf5536c020cc868a1ce",
  };
  for (const value of [undefined, "off"]) {
    vi.stubEnv("OPENPLANS_CMS_FALLBACK_QUOTES", value);
    for (const [kind, path, body] of [
      ["native", "/v1/quotes", quoteBody({ npis: [npi], rxcuis: [rx] })],
      [
        "compat",
        `${BASE}/plans/medical/search`,
        searchBody({
          ids: [plan],
          providers: [{ npi }],
          drug_packages: [{ id: "synthetic-package", rx_cui_id: rx }],
        }),
      ],
    ] as const) {
      const response = await app().request(path, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      const bytes = await response.text();
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        expected[kind],
      );
      if (kind === "compat")
        expect(response.headers.get("x-openplans-gaps")).toBe(
          "off_exchange_catalog_incomplete, subsidies_unavailable, plan_metadata_and_benefit_summaries_unmapped, vendor_network_ids_unavailable, carrier_ids_are_cms_issuer_ids, network_ids_are_cms_network_ids, default_plan_order_unverified, provider_and_drug_coverage_unavailable, variant_cost_sharing_unknown, standard_on_exchange_variant_defaulted",
        );
    }
    expect(sent).toEqual([]);
  }
});

it.each(["primary switch", "key"])(
  "requires the %s as well as the quote switch",
  async (missing) => {
    if (missing === "primary switch")
      vi.stubEnv("OPENPLANS_CMS_FALLBACK", "off");
    else vi.stubEnv("CMS_API_KEY", "");
    const result = await native();
    expect(result.quotes[0]!.providers[0]!.status).toBe("unknown");
    expect(sent).toEqual([]);
    const facade = await compat();
    expect(facade.body.coverages).toEqual([]);
    expect(facade.response.headers.get("x-openplans-gaps")).toContain(
      "provider_and_drug_coverage_unavailable",
    );
    expect(sent).toEqual([]);
  },
);

it("shares the two-call cap over a compatibility page with many plans and both coverage kinds", async () => {
  const { body, response } = await compat({
    ids: undefined,
    per_page: 30,
    providers: [{ npi }, { npi: "1000000001" }],
  });
  expect(body.plans).toHaveLength(30);
  expect(sent).toHaveLength(2);
  expect(
    body.plans
      .slice(20)
      .every((p) => p.providers.every((cell) => cell.in_network === null)),
  ).toBe(true);
  expect(body.coverages.every((cell) => cell.tier === null)).toBe(true);
  expect(response.headers.get("x-openplans-gaps")).toContain(
    "unknown:cms_api_request_cap",
  );
});

const coverageCases = ["npis", "rxcuis", "both", "neither"].flatMap((inputs) =>
  ["off", "on"].flatMap((switchValue) =>
    [false, true].map((rxnorm) => ({ inputs, switchValue, rxnorm })),
  ),
);
async function coverageMatrixCase(
  { inputs, switchValue, rxnorm }: (typeof coverageCases)[number],
  api: Pick<ReturnType<typeof app>, "request"> = app(),
) {
  vi.stubEnv("OPENPLANS_CMS_FALLBACK_QUOTES", switchValue);
  const rxTables = ["rx_release", "rx_concept", "rx_relation", "rx_ndc"];
  if (!rxnorm) {
    for (const table of rxTables)
      await h.db.exec(
        `CREATE TEMP TABLE quote_saved_${table} AS TABLE ${table}`,
      );
    for (const table of [...rxTables].reverse())
      await h.db.exec(`DELETE FROM ${table}`);
    expect((await h.db.query("SELECT * FROM rx_release")).rows).toEqual([]);
  }
  responseCoverage = "DataNotProvided";
  const npis = inputs === "npis" || inputs === "both" ? ["1234567893"] : [];
  const rxcuis =
    inputs === "rxcuis" || inputs === "both" ? [rxnorm ? rx : "860975"] : [];
  try {
    await h.db.exec(
      "UPDATE cms_api_budget SET daily_requests=1,max_daily_requests=200",
    );
    const result = await native(
      {
        zip: undefined,
        plan_ids: ["87226TX0100011"],
        npis,
        rxcuis,
      },
      api,
    );
    expect(result.quotes).toHaveLength(1);
    expect(result.quotes[0]!.providers).toHaveLength(npis.length);
    expect(result.quotes[0]!.drugs).toHaveLength(rxcuis.length);
    for (const cell of [
      ...result.quotes[0]!.providers,
      ...result.quotes[0]!.drugs,
    ]) {
      expect(cell.status).toBe("unknown");
      expect(cell.reason).toBeTruthy();
      if (switchValue === "on" && cell.reason !== "rxcui_not_in_rxnorm") {
        expect(cell.reason).toBe("cms_api_data_not_provided");
        labelled(cell);
      }
    }
    if (!rxnorm && rxcuis.length)
      expect(result.quotes[0]!.drugs[0]!.reason).toBe("rxcui_not_in_rxnorm");
    const facade = await compat({
      ids: ["87226TX0100011"],
      providers: npis.map((npi) => ({ npi })),
      drug_packages: rxcuis.map((rx_cui_id) => ({
        id: "synthetic-package",
        rx_cui_id,
      })),
    });
    expect(facade.body.plans).toHaveLength(1);
    if (switchValue === "on") {
      expect(
        (facade.body.plans[0]!.providers ?? []).every(
          (p) => p.in_network === null,
        ),
      ).toBe(true);
      expect(facade.body.coverages.every((d) => d.tier === null)).toBe(true);
      if (!rxnorm && rxcuis.length)
        expect(facade.response.headers.get("x-openplans-gaps")).toContain(
          "rxcui_not_in_rxnorm",
        );
    }
  } finally {
    if (!rxnorm) {
      for (const table of rxTables) {
        await h.db.exec(
          `INSERT INTO ${table} SELECT * FROM quote_saved_${table}`,
        );
        await h.db.exec(`DROP TABLE quote_saved_${table}`);
      }
    }
  }
}
it.each(coverageCases)(
  "quote coverage matrix $inputs switch=$switchValue RxNorm=$rxnorm",
  (testCase) => coverageMatrixCase(testCase),
);

it("negative control: the matrix rejects the original read-only fallback writer", async () => {
  const source = new URL("../../../src/api/quotes.ts", import.meta.url);
  await withMutantFile(
    source,
    replaceSyntax(
      await readFile(source, "utf8"),
      "boundedDatabase(db, deadline, { readOnly: false })",
      "scoped",
    ),
    async (temporary) => {
      const mutant = await importMutant<typeof QuoteRoutes>(
        temporary,
        "quoteRoutes",
      );
      const api = new Hono().onError((_error, c) =>
        c.json({ error: "synthetic_failure" }, 500),
      );
      api.route("/v1", mutant.quoteRoutes(productionDb(), {}));
      await expect(
        coverageMatrixCase(
          { inputs: "both", switchValue: "on", rxnorm: false },
          api,
        ),
      ).rejects.toThrow();
    },
  );
});

it.each([
  ["absorbed read", /FROM cms_api_(?:drug|provider)_coverage c/],
  ["exchange lookup", /JOIN sbe_catalog/],
  ["budget reservation", /UPDATE cms_api_budget SET\s+daily_requests=/],
  ["snapshot write", /INSERT INTO snapshot/],
  ["absorption", /INSERT INTO cms_api_(?:drug|provider)_coverage/],
  ["audit write", /INSERT INTO cms_api_attempt/],
] as const)(
  "degrades %s failures in native and compatibility coverage",
  async (_stage, pattern) => {
    let hits = 0;
    const broken: SqlSession = {
      ...h.db,
      query: async (sql, parameters) => {
        if (pattern.test(sql)) {
          hits++;
          throw new Error("synthetic fallback storage failure");
        }
        return h.db.query(sql, parameters);
      },
    };
    const api = createApp(broken);
    const result = await native({}, api);
    for (const cell of [
      ...result.quotes[0]!.providers,
      ...result.quotes[0]!.drugs,
    ]) {
      expect(cell).toMatchObject({
        status: "unknown",
        reason: "cms_api_unavailable",
      });
      expect(cell.cms_api).toBeUndefined();
    }
    await h.db.exec(
      "DELETE FROM cms_api_drug_coverage; DELETE FROM cms_api_provider_coverage; UPDATE cms_api_budget SET next_request_at='epoch',blocked_until='epoch',half_open=false,failure_count=0,failure_window_start=now()",
    );
    const facade = await compat({}, api);
    expect(facade.body.plans[0]!.providers[0]!.in_network).toBeNull();
    expect(facade.body.coverages[0]!.tier).toBeNull();
    expect(facade.response.headers.get("x-openplans-gaps")).toContain(
      "unknown:cms_api_unavailable",
    );
    expect(hits).toBeGreaterThanOrEqual(4);
  },
);

it("rejects fallback writes in the production-style read-only scope", async () => {
  await expect(
    productionDb().withRequest!(new AbortController().signal, (session) =>
      session.query("UPDATE cms_api_budget SET next_request_at='epoch'"),
    ),
  ).rejects.toThrow(/read-only transaction/);
});

it("returns the request deadline after a fallback write is cancelled", async () => {
  const controller = new AbortController();
  const db = productionDb();
  const scoped = db.withRequest!;
  let writes = 0;
  db.withRequest = (signal, run, options) => {
    if (options?.readOnly === false) {
      writes++;
      controller.abort();
      signal.throwIfAborted();
    }
    return scoped(signal, run, options);
  };
  const response = await createApp(db).request("/v1/quotes", {
    method: "POST",
    headers,
    signal: controller.signal,
    body: JSON.stringify(quoteBody({ npis: [npi], rxcuis: [] })),
  });
  expect(writes).toBe(1);
  expect(response.status).toBe(504);
  expect(await response.json()).toEqual({
    error: { code: "REQUEST_DEADLINE" },
  });
});

// Synthetic identities and CMS statements exercise every public coverage projection.
const cmsStatements = [
  "Covered",
  "GenericCovered",
  "NotCovered",
  "DataNotProvided",
];
it.each(
  cmsStatements.flatMap((statement) =>
    [false, true].map((known) => ({ statement, known })),
  ),
)(
  "projects $statement with local identity=$known across coverage routes, quotes, compatibility and MCP",
  async ({ statement, known }) => {
    const providerId = "1234567893";
    const drugId = known ? rx : "999999999999";
    if (known)
      await h.db.query(
        `INSERT INTO npi_provider(npi,organization_name,in_scope,state_filter,data_date,snapshot_id)
        SELECT $1,'Synthetic identity',true,'TX','2026-11-10',snapshot_id FROM rx_release LIMIT 1`,
        [providerId],
      );
    try {
      responseCoverage = statement;
      // GenericCovered is a drug-only CMS flag. Providers must reject that response.
      let providerStatus = "unknown",
        drugStatus = "unknown";
      if (statement === "Covered") providerStatus = "listed_participating";
      if (statement === "NotCovered" && known)
        providerStatus = "explicitly_not_participating";
      if (known && ["Covered", "GenericCovered"].includes(statement))
        drugStatus = "listed_covered";
      if (known && statement === "NotCovered")
        drugStatus = "explicitly_not_covered";
      const assertCell = (
        cell: ProviderParticipation | DrugCoverage,
        kind: "provider" | "drug",
      ) => {
        expect(cell.status).toBe(
          kind === "provider" ? providerStatus : drugStatus,
        );
        if (kind === "drug" && !known) {
          expect(cell.reason).toBe("rxcui_not_in_rxnorm");
          expect(cell.cms_api).toBeUndefined();
        } else if (kind === "provider" && statement === "GenericCovered") {
          expect(cell.cms_api).toBeUndefined();
        } else {
          expect(cell.cms_api).toMatchObject({
            coverage: statement,
            sourced_by: "cms-marketplace-api",
          });
          if (cell.status === "unknown") {
            expect(cell.covered).toBeUndefined();
            expect(cell.reason).toBe(
              statement === "NotCovered"
                ? "cms_api_reports_not_covered"
                : "cms_api_data_not_provided",
            );
          } else
            expect(cell.covered).toBe(
              ["Covered", "GenericCovered"].includes(statement),
            );
        }
      };
      // Quote fetches first, then the other routes read the same stored statements.
      if (statement === "GenericCovered")
        await native({ npis: [], rxcuis: [drugId] });
      const quoted = await native({ npis: [providerId], rxcuis: [drugId] });
      assertCell(quoted.quotes[0]!.providers[0]!, "provider");
      assertCell(quoted.quotes[0]!.drugs[0]!, "drug");
      const api = app();
      for (const [kind, code, collection, route] of [
        ["provider", providerId, "npis", "provider-participation"],
        ["drug", drugId, "rxcuis", "drug-coverage"],
      ] as const) {
        // Invalid provider flags open a breaker; the remaining projections must stay unknown.
        const single = await api.request(
          `/v1/plans/${plan}/${kind}s/${code}?year=2026`,
        );
        expect(single.status).toBe(200);
        assertCell(await single.json(), kind);
        const batch = await api.request(`/v1/${route}`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            plan_ids: [plan],
            [collection]: [code],
            year: 2026,
          }),
        });
        expect(batch.status).toBe(200);
        const cells = (await batch.json()) as {
          results: (ProviderParticipation | DrugCoverage)[];
        };
        assertCell(cells.results[0]!, kind);
        const tool =
          kind === "provider"
            ? "check_provider_network"
            : "check_drug_coverage";
        const output = (
          await callTool({ db: h.db }, tool, {
            plan_ids: [plan],
            [collection]: [code],
            year: 2026,
          })
        ).structuredContent;
        expect(output.status).not.toBe("error");
        const parsed = outputSchemas[tool].parse(output);
        const cell = parsed.data!.results[0]!;
        if (cell.cms_api && cell.status !== "unknown") {
          for (const mutate of [
            (c: NonNullable<typeof cell.cms_api>) => {
              c.coverage = "DataNotProvided";
            },
            (c: NonNullable<typeof cell.cms_api>) => {
              c.snapshot_id = "synthetic-missing-receipt";
            },
            (c: NonNullable<typeof cell.cms_api>) => {
              c.sourced_at = "2000-01-01T00:00:00Z";
            },
          ]) {
            const mutant = structuredClone(parsed);
            mutate(mutant.data!.results[0]!.cms_api!);
            expect(() => assertHonest(tool, mutant)).toThrow();
          }
          const unlabelled = structuredClone(parsed);
          delete unlabelled.data!.results[0]!.cms_api;
          expect(() => assertHonest(tool, unlabelled)).toThrow();
        }
        expect(cell.status).toBe(
          kind === "provider" ? providerStatus : drugStatus,
        );
        if (
          (kind === "provider" && statement !== "GenericCovered") ||
          (kind === "drug" && known)
        ) {
          expect(cell.cms_api).toMatchObject({
            coverage: statement,
            sourced_by: "cms-marketplace-api",
          });
          if (cell.status === "unknown")
            expect(cell.gaps).toContain(
              statement === "NotCovered"
                ? "cms_api_reports_not_covered"
                : "cms_api_data_not_provided",
            );
        }
      }
      const mcpQuote = outputSchemas.quote_plans.parse(
        (
          await callTool({ db: h.db }, "quote_plans", {
            year: 2026,
            location: { county: "48201" },
            members: [{ age: 35 }],
            plan_refs: [plan],
            npis: [providerId],
            rxcuis: [drugId],
          })
        ).structuredContent,
      );
      expect(mcpQuote.status).not.toBe("error");
      expect(mcpQuote.data!.quotes[0]!.providers[0]!.status).toBe(
        providerStatus,
      );
      expect(mcpQuote.data!.quotes[0]!.drugs[0]!.status).toBe(drugStatus);
      const facade = await compat({
        providers: [{ npi: providerId }],
        drug_packages: [{ id: "synthetic-package", rx_cui_id: drugId }],
      });
      const networkStatus: Record<string, boolean | null> = {
        listed_participating: true,
        explicitly_not_participating: false,
        unknown: null,
      };
      expect(facade.body.plans[0]!.providers[0]!.in_network).toBe(
        networkStatus[providerStatus],
      );
      expect(facade.body.coverages[0]!.tier).toBe(
        drugStatus === "explicitly_not_covered" ? "not_covered" : null,
      );
      if (statement === "NotCovered" && !known)
        expect(facade.response.headers.get("x-openplans-gaps")).toContain(
          "unknown:cms_api_reports_not_covered:sourced_by=cms-marketplace-api",
        );
    } finally {
      await h.db.query("DELETE FROM npi_provider WHERE npi=$1", [providerId]);
    }
  },
);
