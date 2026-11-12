// CMS Marketplace API fallback: every answer, row and request, recorded before the plugin port
// and compared after it. Synthetic responses, synthetic key, no network.
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
import {
  AdmissionSession,
  shippedManifestPaths,
} from "../../../src/fetch/index.js";
import type { Transport } from "../../../src/fetch/index.js";
import type { DrugCoverage } from "../../../src/domain/drugs/index.js";
import type { ProviderParticipation } from "../../../src/domain/providers/index.js";
import {
  applyCmsFallback,
  cmsApiAvailability,
  cmsFallbackContext,
  resetCmsClientCounts,
} from "../../../src/ingest/cms-api/fallback.js";
import type { CmsFallbackContext } from "../../../src/ingest/cms-api/fallback.js";
import { applyQuoteFallback } from "../../../src/services/quote-coverage.js";
import { fixture, setup } from "../qhp/formulary-helpers.js";

vi.mock("../../../src/fetch/limiter.js", () => ({
  leaseHost: async () => async () => {},
}));

const golden = new URL("port-equivalence.golden.json", import.meta.url);
const record = process.env.OPENPLANS_RECORD_CMS_PORT === "1";
const plantedKey = "PLANTED-cms-port-key-1a2b3c4d";
const docs = "Synthetic CMS API documentation for offline tests.";
let h: Awaited<ReturnType<typeof setup>>;
let directory: string;
let manifestPath: string;
let sent: string[];
let reply: (url: URL) => { status: number; body: string };
let plan: string;
let rx: string;
let spaced = false;
const actual: Record<string, unknown> = {};

const transport: Transport = async (url) => {
  let status = 200,
    body = "";
  if (url.pathname === "/robots.txt")
    status = url.hostname === "marketplace.api.healthcare.gov" ? 401 : 404;
  else if (url.hostname === "developer.cms.gov") body = docs;
  else {
    if (spaced) await clearSpacing();
    sent.push(url.href.replaceAll(plantedKey, "<key>"));
    ({ status, body } = reply(url));
  }
  return { status, headers: {}, body: Readable.from([body]) };
};
const clearSpacing = () =>
  h.db.query(`UPDATE cms_api_budget SET next_request_at='epoch'`);

function context(
  overrides: Partial<CmsFallbackContext> = {},
): CmsFallbackContext {
  return cmsFallbackContext(h.db, h.db, {
    admission: new AdmissionSession([manifestPath], {
      maxRequests: 100,
      maxTransferBytes: 1024 ** 2,
    }),
    fetchOptions: {
      transport,
      dataDir: directory,
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
    },
    ...overrides,
  })!;
}
function drug(overrides: Partial<DrugCoverage> = {}): DrugCoverage {
  return {
    status: "unknown",
    reason: "source_set_not_available",
    base_hios_id: plan,
    requested_plan_id: plan,
    rxcui: rx,
    plan_year: 2026,
    drug_tier: null,
    tier_status: null,
    cost_sharing: null,
    prior_authorization: null,
    step_therapy: null,
    quantity_limit: null,
    patient_price: null,
    evidence: [],
    snapshot_id: null,
    manifest_snapshot_id: null,
    ...overrides,
  };
}
function provider(
  identity: string,
  overrides: Partial<ProviderParticipation> = {},
): ProviderParticipation {
  return {
    status: "unknown",
    reason: "source_access_denied",
    requested_plan_id: plan,
    base_hios_id: plan,
    identity,
    plan_year: 2026,
    participation_scope: "provider_record",
    snapshot_id: null,
    manifest_snapshot_id: null,
    evidence: [],
    warnings: [],
    ...overrides,
  };
}
/** Every asked plan x code gets `coverage`, or the code's own entry in `byCode`. */
function covered(coverage = "Covered", byCode: Record<string, string> = {}) {
  return (url: URL) => {
    const plans = url.searchParams.get("planids")!.split(",");
    const drugs = url.searchParams.get("drugs")?.split(",");
    const npis = url.searchParams.get("providerids")?.split(",");
    return {
      status: 200,
      body: JSON.stringify({
        coverage: plans.flatMap<Record<string, unknown>>((plan_id) =>
          drugs
            ? drugs.map((rxcui) => ({
                rxcui,
                plan_id,
                coverage: byCode[rxcui] ?? coverage,
                ...(rxcui === "2002" ? { generic_rxcui: "2003" } : {}),
              }))
            : npis!.map((npi) => ({
                npi,
                plan_id,
                coverage: byCode[npi] ?? coverage,
                accepting: "unknown",
                addresses: [{ city: "Synthetic" }],
              })),
        ),
      }),
    };
  };
}

const isoTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
/** Times and the receipt's per-retrieval hash vary by run; everything else must not. */
function normalize(value: unknown): unknown {
  if (value instanceof Date) return "<time>";
  if (typeof value === "string") {
    if (isoTime.test(value)) return "<time>";
    return value
      .replaceAll(directory, "<dir>")
      .replaceAll(plantedKey, "<key>")
      .replace(
        /(cms-marketplace-api:[a-z-]+:\d{4}:[0-9a-f]{16}:[0-9a-f]{16}):[0-9a-f]{16}/g,
        "$1:<retrieval>",
      );
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => {
        if (["latency_ms", "attempt_id", "conflict_id", "id"].includes(key))
          return [key, typeof inner];
        // Spans to a time set in the test differ by milliseconds between runs.
        if (key === "ttl_span" && typeof inner === "string")
          return [key, inner.replace(/\.\d+$/, "")];
        return [key, normalize(inner)];
      }),
    );
  return value;
}
async function rows(sql: string) {
  return (await h.db.query(sql)).rows;
}
async function state() {
  return normalize({
    drugs: await rows(
      `SELECT *,(expired_at-sourced_at)::text AS ttl_span FROM cms_api_drug_coverage ORDER BY plan_id,rxcui,plan_year`,
    ),
    providers: await rows(
      `SELECT *,(expired_at-sourced_at)::text AS ttl_span FROM cms_api_provider_coverage ORDER BY plan_id,npi,plan_year`,
    ),
    attempts: await rows(
      `SELECT endpoint,plan_year,pairs,snapshot_id,outcome,http_status,failure_code,refusal_reason
       FROM cms_api_attempt ORDER BY attempt_id`,
    ),
    conflicts: await rows(
      `SELECT kind,plan_id,identity,plan_year,cms_snapshot_id,cms_coverage,authoritative_status,
        authoritative_snapshot_id,agrees FROM cms_api_conflict ORDER BY plan_id,identity,plan_year`,
    ),
    budget: await rows(
      `SELECT daily_requests,max_daily_requests,min_interval_ms,failure_count,half_open,
        next_request_at>now() AS spaced,blocked_until>now() AS blocked,
        blocked_until>now()+interval '50 minutes' AS blocked_long FROM cms_api_budget`,
    ),
    receipts: await rows(
      `SELECT snapshot_id,source_id,requested_url,final_url,http_status,content_type,compressed_bytes,
        sha256,raw_path,schema_version,parser_version,terms_review_reference,validation_state
       FROM snapshot WHERE source_id='cms-marketplace-api' ORDER BY requested_url,sha256`,
    ),
  });
}

type Step = () => Promise<unknown>;
const scenarios: [
  string,
  (ask: (step: Step) => Promise<void>) => Promise<void>,
][] = [
  [
    "drug covered live, then absorbed, then stale",
    async (ask) => {
      await ask(() => applyCmsFallback("drug", [drug()], context()));
      await ask(() => applyCmsFallback("drug", [drug()], context()));
      await h.db.exec(
        "UPDATE cms_api_drug_coverage SET expired_at=now()-interval '1 day'",
      );
      await ask(() =>
        applyCmsFallback("drug", [drug()], context({ writer: undefined })),
      );
      await h.db.query(
        `UPDATE cms_api_budget SET daily_requests=max_daily_requests`,
      );
      await ask(() => applyCmsFallback("drug", [drug()], context()));
    },
  ],
  [
    "drug statements for known and unknown identities",
    async (ask) => {
      spaced = true;
      for (const coverage of [
        "Covered",
        "GenericCovered",
        "NotCovered",
        "DataNotProvided",
      ]) {
        reply = covered(coverage);
        await ask(() =>
          applyCmsFallback(
            "drug",
            [
              drug({ rxcui: rx, plan_year: 2025 }),
              drug({ rxcui: "999999999999", plan_year: 2025 }),
            ],
            context(),
          ),
        );
        await ask(() =>
          applyCmsFallback(
            "drug",
            [
              drug({ plan_year: 2025 }),
              drug({ rxcui: "999999999999", plan_year: 2025 }),
            ],
            context({ writer: undefined }),
          ),
        );
        await h.db.exec("DELETE FROM cms_api_drug_coverage");
      }
      reply = covered("Covered", { "2002": "GenericCovered" });
      await ask(() =>
        applyCmsFallback("drug", [drug({ rxcui: "2002" })], context()),
      );
    },
  ],
  [
    "provider statements: unknown NPI stays unknown, known NPI is not participating",
    async (ask) => {
      spaced = true;
      reply = covered("Covered", {
        "1000000002": "NotCovered",
        "1234567893": "NotCovered",
        "1000000004": "DataNotProvided",
      });
      const asked = [
        provider("1000000001"),
        provider("1000000002"),
        provider("1234567893"),
        provider("1000000004"),
        provider("12345"),
      ];
      await ask(() => applyCmsFallback("provider", asked, context()));
      await h.db.query(
        `INSERT INTO npi_provider(npi,organization_name,in_scope,state_filter,data_date,snapshot_id)
           VALUES ('1234567893','Synthetic identity',true,'TX','2026-11-10','catalog')`,
      );
      try {
        await ask(() =>
          applyCmsFallback("provider", asked, context({ writer: undefined })),
        );
        await h.db.exec(
          "UPDATE cms_api_provider_coverage SET expired_at=now()-interval '1 day'",
        );
        await ask(() =>
          applyCmsFallback("provider", asked, context({ writer: undefined })),
        );
      } finally {
        await h.db.query("DELETE FROM npi_provider WHERE npi='1234567893'");
      }
    },
  ],
  [
    "grid batching, duplicates, the request cap and unreadable plan ids",
    async (ask) => {
      spaced = true;
      const other = `${plan.slice(0, 10)}9999`;
      await ask(() =>
        applyCmsFallback(
          "drug",
          [
            drug(),
            drug({ rxcui: "1003" }),
            drug({ requested_plan_id: other }),
            drug({ requested_plan_id: other, rxcui: "1004" }),
            drug({ rxcui: "1003" }),
            drug({ requested_plan_id: "not-a-plan" }),
            drug({ plan_year: 2025 }),
            drug({ plan_year: 2027 }),
            drug({ plan_year: 2027, rxcui: "1003" }),
            drug({ plan_year: 2024 }),
            drug({ status: "listed_covered", reason: null }),
            drug({ reason: "rxcui_not_in_rxnorm" }),
          ],
          context(),
        ),
      );
    },
  ],
  [
    "refusals: no key, budget, client share, blocked",
    async (ask) => {
      vi.stubEnv("CMS_API_KEY", "");
      await ask(() => applyCmsFallback("drug", [drug()], context()));
      vi.stubEnv("CMS_API_KEY", plantedKey);
      await h.db.query(
        `UPDATE cms_api_budget SET daily_requests=max_daily_requests`,
      );
      await ask(() => applyCmsFallback("drug", [drug()], context()));
      await h.db.query(
        `UPDATE cms_api_budget SET daily_requests=0,max_daily_requests=20`,
      );
      spaced = true;
      for (const rxcui of ["1001", "1002", "1003"]) {
        await clearSpacing();
        await ask(() =>
          applyCmsFallback(
            "drug",
            [drug({ rxcui })],
            context({ client: "203.0.113.77" }),
          ),
        );
      }
      await ask(() =>
        applyCmsFallback(
          "drug",
          [drug({ rxcui: "1003" })],
          context({ client: "203.0.113.78" }),
        ),
      );
      await h.db.query(
        `UPDATE cms_api_budget SET blocked_until=now()+interval '1 hour'`,
      );
      await ask(() =>
        applyCmsFallback("drug", [drug({ rxcui: "1004" })], context()),
      );
    },
  ],
  [
    "failures: 401, server errors and the trial call, bodies",
    async (ask) => {
      spaced = true;
      reply = () => ({ status: 401, body: '{"message":"synthetic"}' });
      await ask(() => applyCmsFallback("drug", [drug()], context()));
      await ask(() =>
        applyCmsFallback("drug", [drug({ rxcui: "1001" })], context()),
      );
      await h.db.query(
        `UPDATE cms_api_budget SET blocked_until='epoch',failure_window_start=now()`,
      );
      reply = () => ({ status: 503, body: "synthetic outage" });
      for (const rxcui of ["1001", "1002", "1003"])
        await ask(() => applyCmsFallback("drug", [drug({ rxcui })], context()));
      await ask(() =>
        applyCmsFallback("drug", [drug({ rxcui: "1004" })], context()),
      );
      await h.db.query(
        `UPDATE cms_api_budget SET blocked_until=now()-interval '1 second'`,
      );
      reply = covered();
      await ask(() =>
        applyCmsFallback("drug", [drug({ rxcui: "1004" })], context()),
      );
      reply = () => ({ status: 200, body: '{"coverage":[{"plan_id":1}]}' });
      await ask(() =>
        applyCmsFallback("drug", [drug({ rxcui: "1005" })], context()),
      );
      reply = () => ({
        status: 200,
        body: JSON.stringify({ coverage: [], echo: plantedKey }),
      });
      await ask(() =>
        applyCmsFallback("drug", [drug({ rxcui: "1006" })], context()),
      );
      reply = () => ({ status: 200, body: '{"coverage":[]}' });
      await ask(() =>
        applyCmsFallback("drug", [drug({ rxcui: "1007" })], context()),
      );
    },
  ],
  [
    "state-based exchange plans and conflicts with loaded files",
    async (ask) => {
      await h.db.query(
        `INSERT INTO sbe_catalog(import_id,bundle_url,bundle_sha256,serving)
           SELECT import_id,'https://example.invalid/synthetic-sbe.zip',repeat('a',64),true
           FROM puf_active_catalog WHERE state=$1 AND plan_year=2026`,
        [plan.slice(5, 7)],
      );
      try {
        await ask(() => applyCmsFallback("drug", [drug()], context()));
      } finally {
        await h.db.query(
          `DELETE FROM sbe_catalog WHERE bundle_url='https://example.invalid/synthetic-sbe.zip'`,
        );
      }
      reply = covered("NotCovered");
      await ask(() => applyCmsFallback("drug", [drug()], context()));
      await ask(() =>
        applyCmsFallback(
          "drug",
          [drug({ status: "listed_covered", reason: null, snapshot_id: "rx" })],
          context(),
        ),
      );
    },
  ],
  [
    "quotes share one cap across plans and kinds, with freshness labels",
    async (ask) => {
      vi.stubEnv("OPENPLANS_CMS_FALLBACK_QUOTES", "on");
      spaced = true;
      const input = [2025, 2026, 2027].map((plan_year) => ({
        providers: [provider("1000000001", { plan_year })],
        drugs: [drug({ plan_year })],
      }));
      await ask(() =>
        applyQuoteFallback(input, context({ client: "synthetic-quote" })),
      );
      await ask(() =>
        applyQuoteFallback(input, context({ client: "synthetic-quote" })),
      );
      await h.db.exec(
        "UPDATE cms_api_drug_coverage SET expired_at=now()-interval '1 day'",
      );
      await h.db.query(
        `UPDATE cms_api_budget SET daily_requests=max_daily_requests`,
      );
      await ask(() =>
        applyQuoteFallback(input, context({ client: "synthetic-quote" })),
      );
    },
  ],
  [
    "availability counts stored answers",
    async (ask) => {
      await ask(async () => {
        const report = await cmsApiAvailability(h.db);
        return report && [report.configured, [...report.byIssuer]];
      });
      await applyCmsFallback("drug", [drug()], context());
      await ask(async () => {
        const report = await cmsApiAvailability(h.db);
        return report && [report.configured, [...report.byIssuer]];
      });
    },
  ],
  [
    "a storage failure keeps loaded answers and marks eligible ones unavailable",
    async (ask) => {
      const fail = async () => {
        throw new Error("synthetic storage failure");
      };
      const broken = { query: fail, exec: fail };
      await ask(() =>
        applyCmsFallback(
          "drug",
          [
            drug(),
            drug({ status: "listed_covered", reason: null }),
            drug({ reason: "rxcui_not_in_rxnorm" }),
          ],
          context({ reader: broken, writer: broken }),
        ),
      );
    },
  ],
];

beforeAll(async () => {
  h = await setup();
  plan = h.catalog.plans[0].base_plan_id;
  rx = (await fixture("drugs"))[0].rxnorm_id;
});
afterAll(async () => {
  if (record) await writeFile(golden, JSON.stringify(actual, null, 2) + "\n");
  await h?.close();
});
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "openplans-synthetic-cms-port-"));
  vi.stubEnv("OPENPLANS_CMS_FALLBACK", "on");
  vi.stubEnv("CMS_API_KEY", plantedKey);
  const shipped = shippedManifestPaths().find((p) =>
    p.endsWith("cms-marketplace-api.json"),
  )!;
  const manifest = JSON.parse(await readFile(shipped, "utf8"));
  manifest.publishers[0].terms.sha256 = createHash("sha256")
    .update(docs)
    .digest("hex");
  manifestPath = join(directory, "access.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  sent = [];
  spaced = false;
  reply = covered();
  await h.db.exec(
    `DELETE FROM cms_api_conflict; DELETE FROM cms_api_drug_coverage; DELETE FROM cms_api_provider_coverage; DELETE FROM cms_api_attempt;
     DELETE FROM snapshot WHERE source_id='cms-marketplace-api';
     UPDATE record_policy SET default_ttl=CASE name WHEN 'cms_api_fallback' THEN interval '7 days' ELSE interval '1 day' END,stale_window='30 days' WHERE name IN ('cms_api_fallback','cms_api_fallback_no_data');
     UPDATE cms_api_budget SET day_start=(now() AT TIME ZONE 'UTC')::date,next_request_at='epoch',daily_requests=0,blocked_until='epoch',min_interval_ms=1000,
       max_daily_requests=500,failure_count=0,failure_window_start='epoch',half_open=false`,
  );
  resetCmsClientCounts();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

for (const [name, run] of scenarios)
  it(`matches the recorded fallback: ${name}`, async () => {
    const steps: unknown[] = [];
    const raw: unknown[] = [];
    await run(async (step) => {
      sent = [];
      const out = await step();
      raw.push(out);
      steps.push(normalize({ out, sent }));
    });
    const observed = { steps, state: await state() };
    actual[name] = observed;
    if (!record) {
      const expected = JSON.parse(await readFile(golden, "utf8")) as Record<
        string,
        unknown
      >;
      expect(observed).toEqual(normalize(expected[name]));
    }
    // The planted key never reaches an answer, a stored row or a receipt.
    expect(
      JSON.stringify([
        raw,
        await rows("SELECT * FROM cms_api_attempt"),
        await rows(
          "SELECT * FROM snapshot WHERE source_id='cms-marketplace-api'",
        ),
      ]),
    ).not.toContain(plantedKey);
  });
