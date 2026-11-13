// The CMS Marketplace API source package on the pass-through core, with planted mutants of the
// package. Synthetic responses, synthetic key, no network.
import { createHash } from "node:crypto";
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as Package from "@openplans/source-cms-marketplace-api";
import type { PassThroughSource, Question } from "@openplans/plugin-sdk";
import { parse_hios } from "../../../src/domain/hios/index.js";
import type { DrugCoverage } from "../../../src/domain/drugs/index.js";
import type { ProviderParticipation } from "../../../src/domain/providers/index.js";
import {
  AdmissionSession,
  shippedManifestPaths,
} from "../../../src/fetch/index.js";
import type { Transport } from "../../../src/fetch/index.js";
import {
  applyCmsFallback,
  cmsFallbackContext,
} from "../../../src/ingest/cms-api/fallback.js";
import type { CmsFallbackContext } from "../../../src/ingest/cms-api/fallback.js";
import { implicitPassThroughSources } from "../../../src/plugins/core-plugin.js";
import { createPassThrough } from "../../../src/plugins/sources/passthrough.js";
import { fixture, setup } from "../qhp/formulary-helpers.js";
import { importMutant } from "../../mutant-file.js";

vi.mock("../../../src/fetch/limiter.js", () => ({
  leaseHost: async () => async () => {},
}));

type Source = PassThroughSource<Question, unknown>;
type Factory = (typeof Package)["createCmsMarketplaceSource"];
const plantedKey = "PLANTED-cms-mutant-key-9z8y7x";
const docs = "Synthetic CMS API documentation for offline tests.";
const packageSource = fileURLToPath(
  new URL("../../../plugins/source-cms-marketplace-api/src/", import.meta.url),
);
let h: Awaited<ReturnType<typeof setup>>;
let directory: string;
let manifestPath: string;
let reply: (url: URL) => { status: number; body: string };
let plan: string;
let rx: string;
const logs: string[] = [];

const transport: Transport = async (url) => {
  let status = 200,
    body = "";
  if (url.pathname === "/robots.txt")
    status = url.hostname === "marketplace.api.healthcare.gov" ? 401 : 404;
  else if (url.hostname === "developer.cms.gov") body = docs;
  else ({ status, body } = reply(url));
  return { status, headers: {}, body: Readable.from([body]) };
};
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
const drug = (overrides: Partial<DrugCoverage> = {}): DrugCoverage => ({
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
});
const provider = (identity: string): ProviderParticipation => ({
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
});
const coverage =
  (statement: string) =>
  (url: URL): { status: number; body: string } => {
    const plans = url.searchParams.get("planids")!.split(",");
    const drugs = url.searchParams.get("drugs")?.split(",");
    const npis = url.searchParams.get("providerids")?.split(",") ?? [];
    return {
      status: 200,
      body: JSON.stringify({
        coverage: plans.flatMap<Record<string, unknown>>((plan_id) =>
          drugs
            ? drugs.map((rxcui) => ({ rxcui, plan_id, coverage: statement }))
            : npis.map((npi) => ({ npi, plan_id, coverage: statement })),
        ),
      }),
    };
  };

/** A copy of the package source with one planted change, loaded as its own module. */
async function plantedFactory(
  file: string,
  anchor: string,
  replacement: string,
): Promise<{ factory: Factory; cleanup: () => Promise<void> }> {
  const copy = await mkdtemp(join(packageSource, ".mutant-"));
  const cleanup = () => rm(copy, { recursive: true, force: true });
  try {
    for (const name of await readdir(packageSource))
      if (name.endsWith(".ts"))
        await cp(join(packageSource, name), join(copy, name));
    const text = await readFile(join(copy, file), "utf8");
    expect(text).toContain(anchor);
    await writeFile(join(copy, file), text.replace(anchor, replacement));
    const module = await importMutant<typeof Package>(
      new URL(`file://${join(copy, "index.ts")}`),
      "createCmsMarketplaceSource",
    );
    return { factory: module.createCmsMarketplaceSource, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
const host = { planBase: (id: string) => parse_hios(id).base };
/** Runs `answers` through a core that has only `source` registered. */
const through = (source: unknown) =>
  createPassThrough({ sources: () => [source as Source] });

/** An NPI CMS calls NotCovered but NPPES does not know stays unknown, never not participating. */
async function unknownNpiContract(factory: Factory) {
  reply = coverage("NotCovered");
  const [out] = await through(factory(host)).apply(
    "provider",
    [provider("1999999999")],
    context(),
  );
  expect(out).toMatchObject({
    status: "unknown",
    reason: "cms_api_reports_not_covered",
  });
  expect(out!.covered).toBeUndefined();
}
/** Each call takes one from the shared daily allowance; the allowance then refuses. */
async function budgetContract(factory: Factory) {
  await h.db.query(`UPDATE cms_api_budget SET max_daily_requests=2`);
  const core = through(factory(host));
  const unspaced = () =>
    h.db.query(`UPDATE cms_api_budget SET next_request_at='epoch'`);
  for (const rxcui of ["1001", "1002"]) {
    await unspaced();
    expect(
      (await core.apply("drug", [drug({ rxcui })], context()))[0]!.status,
    ).toBe("listed_covered");
  }
  await unspaced();
  expect(
    (
      await h.db.query<{ daily_requests: number }>(
        "SELECT daily_requests FROM cms_api_budget",
      )
    ).rows[0]!.daily_requests,
  ).toBe(2);
  const [third] = await core.apply(
    "drug",
    [drug({ rxcui: "1003" })],
    context(),
  );
  expect(third!.reason).toBe("cms_api_budget_exhausted");
}
/** The key reaches only the request: never a log line, a stored row or a cached file. */
async function keyContract(factory: Factory) {
  reply = () => ({ status: 503, body: "synthetic outage" });
  await through(factory(host)).apply("drug", [drug()], context());
  reply = coverage("Covered");
  await h.db.query(`UPDATE cms_api_budget SET next_request_at='epoch'`);
  await through(factory(host)).apply(
    "drug",
    [drug({ rxcui: "1004" })],
    context(),
  );
  const tables = (
    await h.db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`,
    )
  ).rows.map((row) => row.table_name);
  let everything = logs.join("\n");
  for (const table of tables)
    everything += JSON.stringify(
      (await h.db.query(`SELECT * FROM "${table}"`)).rows,
    );
  expect(everything).not.toContain(plantedKey);
}
/** Answers are stored rows under migration 992's record policies. */
async function storedContract(factory: Factory) {
  await through(factory(host)).apply("drug", [drug()], context());
  expect(
    (
      await h.db.query(
        `SELECT record_policy,sourced_by,expired_at>now() AS fresh FROM cms_api_drug_coverage`,
      )
    ).rows,
  ).toEqual([
    {
      record_policy: "cms_api_fallback",
      sourced_by: "cms-marketplace-api",
      fresh: true,
    },
  ]);
}

beforeAll(async () => {
  h = await setup();
  plan = h.catalog.plans[0].base_plan_id;
  rx = (await fixture("drugs"))[0].rxnorm_id;
});
afterAll(async () => {
  await h?.close();
});
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "openplans-synthetic-cms-mutant-"));
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
  reply = coverage("Covered");
  logs.length = 0;
  for (const method of ["log", "info", "warn", "error", "debug"] as const)
    vi.spyOn(console, method).mockImplementation((...args) => {
      logs.push(JSON.stringify(args));
    });
  await h.db.exec(
    `DELETE FROM cms_api_conflict; DELETE FROM cms_api_drug_coverage; DELETE FROM cms_api_provider_coverage; DELETE FROM cms_api_attempt;
     UPDATE cms_api_budget SET day_start=(now() AT TIME ZONE 'UTC')::date,next_request_at='epoch',daily_requests=0,blocked_until='epoch',min_interval_ms=1000,
       max_daily_requests=500,failure_count=0,failure_window_start='epoch',half_open=false`,
  );
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

describe("@openplans/source-cms-marketplace-api", () => {
  it("is the implicit source while OPENPLANS_CMS_FALLBACK=on, and absent otherwise", async () => {
    expect(implicitPassThroughSources().map((s) => s.id)).toEqual([
      "cms-marketplace-api",
    ]);
    const source = implicitPassThroughSources()[0]!;
    expect(source.cache.level).toBe("stored");
    expect(source.storage?.excludedTables).toEqual([
      ...Package.CMS_API_EXPORT_EXCLUDED_TABLES,
    ]);
    vi.stubEnv("OPENPLANS_CMS_FALLBACK", "");
    expect(implicitPassThroughSources()).toEqual([]);
    // Switch off: apply is a no-op even with a context built while it was on.
    const built = context();
    const answers = [drug()];
    expect(await applyCmsFallback("drug", answers, built)).toBe(answers);
  });

  it("builds the call shape and maps every statement", () => {
    const questions = [
      {
        kind: "drug" as const,
        planId: "00010TX0000001",
        identity: "1",
        year: 2026,
      },
      {
        kind: "drug" as const,
        planId: "00010TX0000002",
        identity: "2",
        year: 2026,
      },
      {
        kind: "drug" as const,
        planId: "00010TX0000001",
        identity: "2",
        year: 2026,
      },
    ];
    expect(Package.buildRequest(questions, "drug")).toEqual({
      path: "/api/v1/drugs/covered",
      query: {
        year: "2026",
        drugs: "1,2",
        planids: "00010TX0000001,00010TX0000002",
      },
    });
    const mapped = Package.mapResponse(
      {
        coverage: ["Covered", "NotCovered", "DataNotProvided"].map(
          (coverage, i) => ({
            plan_id: "00010TX0000001",
            rxcui: String(i),
            coverage,
          }),
        ),
      },
      questions,
      "drug",
    );
    expect(
      mapped.map((m) => [
        m.outcome,
        "negative" in m && m.negative,
        m.sourceRow,
      ]),
    ).toEqual([
      ["answer", false, 1],
      ["answer", true, 2],
      ["no_data", false, 3],
    ]);
    expect(() =>
      Package.mapResponse({ coverage: [{ plan_id: 1 }] }, questions, "drug"),
    ).toThrow("invalid row");
  });

  const cases: [
    string,
    (f: Factory) => Promise<void>,
    string,
    string,
    string,
  ][] = [
    [
      "an unknown NPI stays unknown (mutant: it becomes not participating)",
      unknownNpiContract,
      "source.ts",
      'evidence.coverage === "NotCovered" && !identityKnown',
      "false",
    ],
    [
      "each call is counted on the budget row (mutant: the reservation does not count)",
      budgetContract,
      "storage.ts",
      "ELSE daily_requests+1 END",
      "ELSE daily_requests END",
    ],
    [
      "the key stays out of logs and rows (mutant: the attempt log carries it)",
      keyContract,
      "storage.ts",
      "attempt.failure,",
      "attempt.failure && `${attempt.failure}:${process.env.CMS_API_KEY}`,",
    ],
    [
      "answers are stored rows (mutant: the source declares memory)",
      storedContract,
      "source.ts",
      'level: "stored",',
      'level: "memory",',
    ],
  ];
  for (const [name, contract, file, anchor, replacement] of cases) {
    it(`${name}: the package passes`, async () => {
      await contract(Package.createCmsMarketplaceSource);
    });
    it(`${name}: the planted mutant is caught`, async () => {
      const planted = await plantedFactory(file, anchor, replacement);
      try {
        await expect(contract(planted.factory)).rejects.toThrow();
      } finally {
        await planted.cleanup();
      }
    });
  }
});
