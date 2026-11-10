// Synthetic transport and key; the catalog and terminology use public fixture cuts.
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
    UPDATE cms_api_budget SET day_start=(now() AT TIME ZONE 'UTC')::date, daily_requests=0,next_request_at='epoch',blocked_until='epoch',max_daily_requests=500,half_open=false;`);
  const factory = coverageService.quoteFallbackContext;
  vi.spyOn(coverageService, "quoteFallbackContext").mockImplementation(
    (db, client) => {
      if (!factory(db, client)) return undefined;
      return cmsFallbackContext(db, db, {
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
const app = () =>
  createApp(h.db, {
    peerAddress: (request) =>
      request.headers.get("x-synthetic-peer") ?? "192.0.2.1",
  });
async function native(extra = {}) {
  const response = await app().request("/v1/quotes", {
    method: "POST",
    headers,
    body: JSON.stringify(quoteBody({ npis: [npi], rxcuis: [rx], ...extra })),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<Awaited<ReturnType<typeof quotePlans>>>;
}
async function compat(extra = {}) {
  const response = await app().request(`${BASE}/plans/medical/search`, {
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
    native: "98f13a532a75b0d4ae88d1e1e5e01d2c4088b666d65d626717e32d3c069c32b2",
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
