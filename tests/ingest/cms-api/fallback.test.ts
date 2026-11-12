import type * as Fallback from "../../../src/ingest/cms-api/fallback.js";
// CMS Marketplace API coverage fallback. Synthetic responses, synthetic key, no network.
import type * as QuoteCoverage from "../../../src/services/quote-coverage.js";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
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
import {
  AdmissionSession,
  shippedManifestPaths,
} from "../../../src/fetch/index.js";
import type { Transport } from "../../../src/fetch/index.js";
import { drugCoverage } from "../../../src/domain/drugs/repository.js";
import type { DrugCoverage } from "../../../src/domain/drugs/index.js";
import type { ProviderParticipation } from "../../../src/domain/providers/index.js";
import {
  OPENING_REASONS,
  applyCmsFallback,
  cmsApiAvailability,
  cmsFallbackContext,
  resetCmsClientCounts,
} from "../../../src/ingest/cms-api/fallback.js";
import type { CmsFallbackContext } from "../../../src/ingest/cms-api/fallback.js";
import {
  CMS_API_EXPORT_EXCLUDED_RAW,
  CMS_API_EXPORT_EXCLUDED_TABLES,
  pgDumpExcludeArgs,
} from "../../../src/ingest/cms-api/export.js";
import { importFormulary } from "../../../src/ingest/qhp/formulary.js";
import { fixture, scope, setup } from "../qhp/formulary-helpers.js";

vi.mock("../../../src/fetch/limiter.js", () => ({
  leaseHost: async () => async () => {},
}));

const plantedKey = "PLANTED-cms-key-0f9e8d7c6b5a";
const docs = "Synthetic CMS API documentation for offline tests.";
let h: Awaited<ReturnType<typeof setup>>;
let directory: string;
let manifestPath: string;
let sent: URL[];
let reply: (url: URL) => { status: number; body: string };
let plan: string;
let rx: string;

const transport: Transport = async (url) => {
  sent.push(new URL(url.href));
  let status = 200,
    body = "";
  if (url.pathname === "/robots.txt")
    status = url.hostname === "marketplace.api.healthcare.gov" ? 401 : 404;
  else if (url.hostname === "developer.cms.gov") body = docs;
  else ({ status, body } = reply(url));
  return { status, headers: {}, body: Readable.from([body]) };
};
const dataCalls = () => sent.filter((url) => url.pathname.startsWith("/api/"));

/**
 * Planted mutants of the pass-through core that runs the CMS source. Writes a mutated copy of
 * src/plugins/sources/passthrough.ts plus copies of the modules above it that import the copy,
 * and returns their URLs; `cleanup` removes them.
 */
async function coreMutant(
  name: string,
  anchor: string,
  replacement: string,
): Promise<{ fallback: URL; quote: URL; cleanup: () => Promise<void> }> {
  const at = (path: string) => new URL(`../../../src/${path}`, import.meta.url);
  const core = await readFile(at("plugins/sources/passthrough.ts"), "utf8");
  expect(core).toContain(anchor);
  const written = [
    at(`plugins/sources/.passthrough-mutant-${name}.ts`),
    at(`ingest/cms-api/.fallback-mutant-${name}.ts`),
    at(`services/.quote-coverage-mutant-${name}.ts`),
  ];
  await writeFile(written[0]!, core.replace(anchor, replacement));
  for (const [source, target] of [
    ["ingest/cms-api/fallback.ts", written[1]!],
    ["services/quote-coverage.ts", written[2]!],
  ] as const)
    await writeFile(
      target,
      (await readFile(at(source), "utf8")).replaceAll(
        "plugins/sources/passthrough.js",
        `plugins/sources/.passthrough-mutant-${name}.js`,
      ),
    );
  return {
    fallback: written[1]!,
    quote: written[2]!,
    cleanup: async () => {
      for (const url of written) await rm(url, { force: true });
    },
  };
}

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
function answer(overrides: Partial<DrugCoverage> = {}): DrugCoverage {
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
function covered(coverage = "Covered") {
  return (url: URL) => {
    const plans = url.searchParams.get("planids")!.split(",");
    const drugs = url.searchParams.get("drugs")!.split(",");
    return {
      status: 200,
      body: JSON.stringify({
        coverage: plans.flatMap((plan_id) =>
          drugs.map((rxcui) => ({ rxcui, plan_id, coverage })),
        ),
      }),
    };
  };
}
async function dump(): Promise<string> {
  const tables = (
    await h.db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`,
    )
  ).rows.map((row) => row.table_name);
  const out: string[] = [];
  for (const table of tables)
    out.push(
      JSON.stringify((await h.db.query(`SELECT * FROM "${table}"`)).rows),
    );
  return out.join("\n");
}
async function files(path = directory): Promise<string> {
  const out: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    out.push(
      entry.isDirectory() ? await files(full) : await readFile(full, "utf8"),
    );
  }
  return out.join("\n");
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
  directory = await mkdtemp(join(tmpdir(), "openplans-synthetic-cms-api-"));
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
  reply = covered();
  await h.db.exec(
    `DELETE FROM cms_api_conflict; DELETE FROM cms_api_drug_coverage; DELETE FROM cms_api_provider_coverage; DELETE FROM cms_api_attempt;
     UPDATE record_policy SET default_ttl=CASE name WHEN 'cms_api_fallback' THEN interval '7 days' ELSE interval '1 day' END,stale_window='30 days' WHERE name IN ('cms_api_fallback','cms_api_fallback_no_data');
     UPDATE cms_api_budget SET next_request_at='epoch',daily_requests=0,blocked_until='epoch',min_interval_ms=1000,
       max_daily_requests=500,failure_count=0,failure_window_start='epoch',half_open=false`,
  );
  resetCmsClientCounts();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});
const spacing = () =>
  h.db.query(`UPDATE cms_api_budget SET next_request_at='epoch'`);

describe("CMS API coverage fallback", () => {
  it("starts from an unknown answer with an opening reason from loaded files", async () => {
    const local = await drugCoverage(h.db, plan, rx, 2026);
    expect(local.status).toBe("unknown");
    expect(OPENING_REASONS).toContain(local.reason);
  });

  it("negative control: flag off leaves the answer unknown and makes no call", async () => {
    const built = context();
    vi.stubEnv("OPENPLANS_CMS_FALLBACK", "");
    expect(cmsFallbackContext(h.db, h.db)).toBeUndefined();
    // Even a context built while the flag was on does nothing once it is off.
    const [out] = await applyCmsFallback("drug", [answer()], built);
    expect(out).toMatchObject({
      status: "unknown",
      reason: "source_set_not_available",
    });
    expect(out!.cms_api).toBeUndefined();
    expect(sent).toEqual([]);
  });

  it("negative control: no key leaves the answer unknown and makes no call", async () => {
    vi.stubEnv("CMS_API_KEY", "");
    const [out] = await applyCmsFallback("drug", [answer()], context());
    expect(out).toMatchObject({
      status: "unknown",
      reason: "cms_api_not_configured",
    });
    expect(sent).toEqual([]);
  });

  it("negative control: an exhausted budget leaves the answer unknown and records the refusal", async () => {
    await h.db.query(
      `UPDATE cms_api_budget SET daily_requests=max_daily_requests`,
    );
    const [out] = await applyCmsFallback("drug", [answer()], context());
    expect(out).toMatchObject({
      status: "unknown",
      reason: "cms_api_budget_exhausted",
    });
    expect(sent).toEqual([]);
    const attempts = (
      await h.db.query(`SELECT outcome,refusal_reason FROM cms_api_attempt`)
    ).rows;
    expect(attempts).toEqual([
      { outcome: "refused", refusal_reason: "cms_api_budget_exhausted" },
    ]);
  });

  it("answers, labels and absorbs; the key and request values stay out of every record", async () => {
    const logs: unknown[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, method).mockImplementation((...args) => {
        logs.push(args);
      });
    const [out] = await applyCmsFallback("drug", [answer()], context());
    expect(out).toMatchObject({
      status: "listed_covered",
      reason: null,
      covered: true,
    });
    const snapshot = (
      await h.db.query<{
        source_id: string;
        retrieved_at: Date;
        snapshot_id: string;
      }>(
        `SELECT source_id,retrieved_at,snapshot_id FROM snapshot WHERE snapshot_id=$1`,
        [out!.cms_api!.snapshot_id],
      )
    ).rows[0]!;
    expect(out!.cms_api).toMatchObject({
      sourced_by: "cms-marketplace-api",
      sourced_at: new Date(snapshot.retrieved_at).toISOString(),
      sourced_slug: snapshot.snapshot_id,
      served_from: "live",
      coverage: "Covered",
    });
    expect(snapshot.source_id).toBe("cms-marketplace-api");
    // The key goes only to the data request; robots and docs reads never carry it.
    const data = dataCalls();
    expect(data).toHaveLength(1);
    expect(data[0]!.searchParams.get("apikey")).toBe(plantedKey);
    expect(sent.filter((url) => url.href.includes(plantedKey))).toHaveLength(1);
    const everything =
      (await dump()) + (await files()) + JSON.stringify([out, logs]);
    expect(everything).not.toContain(plantedKey);
    expect(logs).toEqual([]);
    const audit = JSON.stringify(
      (await h.db.query(`SELECT * FROM cms_api_attempt`)).rows,
    );
    expect(audit).not.toContain(plan);
    expect(audit).not.toContain(rx);
    const stored = (
      await h.db.query<{ requested_url: string }>(
        `SELECT requested_url FROM snapshot WHERE snapshot_id=$1`,
        [snapshot.snapshot_id],
      )
    ).rows[0]!.requested_url;
    expect(stored).not.toContain(plan);
    expect(stored).not.toContain(rx);

    // The same question again is served from the absorbed row without a call.
    sent = [];
    const [again] = await applyCmsFallback("drug", [answer()], context());
    expect(again!.cms_api!.served_from).toBe("absorbed");
    expect(sent).toEqual([]);
  });

  it("read-only scopes serve absorbed rows but never call or write", async () => {
    const readOnly = { ...context(), writer: undefined };
    let [out] = await applyCmsFallback("drug", [answer()], readOnly);
    expect(out).toMatchObject({
      status: "unknown",
      reason: "source_set_not_available",
    });
    expect(sent).toEqual([]);
    await applyCmsFallback("drug", [answer()], context());
    sent = [];
    [out] = await applyCmsFallback("drug", [answer()], readOnly);
    expect(out!.cms_api!.served_from).toBe("absorbed");
    expect(sent).toEqual([]);
  });

  it("makes at most 2 calls per inbound request; the rest stay unknown with cms_api_request_cap", async () => {
    await h.db.query(`UPDATE cms_api_budget SET min_interval_ms=1000`);
    const ctx = context();
    const answers = [2025, 2026, 2027].map((plan_year) =>
      answer({ plan_year }),
    );
    // Budget spacing would refuse the 2nd call within 1 s; clear it between calls.
    const original = ctx.fetchOptions!.transport!;
    ctx.fetchOptions!.transport = async (url, c) => {
      await spacing();
      return original(url, c);
    };
    const out = await applyCmsFallback("drug", answers, ctx);
    expect(dataCalls()).toHaveLength(2);
    expect(out.filter((a) => a.status === "listed_covered")).toHaveLength(2);
    expect(out.filter((a) => a.reason === "cms_api_request_cap")).toHaveLength(
      1,
    );
  });

  it("paces calls 1 s apart through the shared budget row", async () => {
    const ctx = context();
    await applyCmsFallback("drug", [answer({ plan_year: 2025 })], ctx);
    const [second] = await applyCmsFallback(
      "drug",
      [answer({ plan_year: 2027 })],
      context(),
    );
    expect(second!.reason).toBe("cms_api_budget_exhausted");
    expect(dataCalls()).toHaveLength(1);
  });

  it("negative control: an API answer never overwrites or outranks loaded files", async () => {
    // Absorb a CMS "NotCovered" first, then load the issuer's own file, which lists the drug.
    reply = covered("NotCovered");
    await applyCmsFallback("drug", [answer()], context());
    await h.replace(await fixture("drugs"));
    await importFormulary(h.db, scope);
    const hash = async () =>
      createHash("sha256")
        .update(
          JSON.stringify(
            (await h.db.query(`SELECT * FROM formulary_edge ORDER BY 1,2,3,4`))
              .rows,
          ),
        )
        .digest("hex");
    const before = await hash();
    sent = [];
    const local = await drugCoverage(h.db, plan, rx, 2026);
    expect(local.status).toBe("listed_covered");
    const [out] = await applyCmsFallback("drug", [local], context());
    expect(out).toEqual(local);
    expect(sent).toEqual([]);
    expect(await hash()).toBe(before);
    const shadow = (
      await h.db.query(
        `SELECT cms_coverage,authoritative_status,agrees FROM cms_api_conflict`,
      )
    ).rows;
    expect(shadow).toEqual([
      {
        cms_coverage: "NotCovered",
        authoritative_status: "listed_covered",
        agrees: false,
      },
    ]);
    const absorbed = (
      await h.db.query(`SELECT coverage FROM cms_api_drug_coverage`)
    ).rows;
    expect(absorbed).toEqual([{ coverage: "NotCovered" }]);
  });

  it("negative control: a mislabelled sourced_by or sourced_at is never stored", async () => {
    await applyCmsFallback("drug", [answer()], context());
    const row = (
      await h.db.query<Record<string, unknown>>(
        `SELECT * FROM cms_api_drug_coverage`,
      )
    ).rows[0]!;
    const insert = (rxcui: string, by: string, at: unknown) =>
      h.db.query(
        `INSERT INTO cms_api_drug_coverage(plan_id,rxcui,plan_year,coverage,snapshot_id,source_row,expires_at,sourced_by,sourced_at,sourced_slug)
        VALUES($1,$5,2026,'Covered',$2,1,now()+interval '1 day',$3,$4,$2)`,
        [row.plan_id, row.snapshot_id, by, at, rxcui],
      );
    // The table constraints refuse a label that disagrees with the receipt. Where the row
    // provenance trigger is installed it rewrites the label from the receipt first.
    // Either way no mislabelled row may be stored.
    const mislabelled: [string, unknown][] = [
      ["cms-exchange-puf:2026:TX", row.sourced_at],
      ["openplans", row.sourced_at],
      ["cms-marketplace-api", new Date(0)],
    ];
    for (const [index, [by, at]] of mislabelled.entries())
      await insert(String(990 + index), by, at).catch(() => undefined);
    await expect(
      insert("999", "cms-marketplace-api", row.sourced_at),
    ).resolves.toBeDefined();
    const stored = (
      await h.db.query<Record<string, unknown>>(
        `SELECT sourced_by,sourced_at,sourced_slug,snapshot_id FROM cms_api_drug_coverage`,
      )
    ).rows;
    expect(stored.length).toBeGreaterThan(1);
    for (const kept of stored) {
      expect(kept.sourced_by).toBe("cms-marketplace-api");
      expect(kept.sourced_at).toEqual(row.sourced_at);
      expect(kept.sourced_slug).toBe(kept.snapshot_id);
    }
  });

  it("does not open a call for reasons that mean the question has no answer anywhere", async () => {
    for (const reason of [
      "plan_not_in_catalog",
      "rxcui_not_in_rxnorm",
      "invalid_year",
    ]) {
      const [out] = await applyCmsFallback(
        "drug",
        [answer({ reason })],
        context(),
      );
      expect(out!.reason).toBe(reason);
    }
    expect(sent).toEqual([]);
  });

  it("DataNotProvided stays unknown with its own reason", async () => {
    reply = covered("DataNotProvided");
    const [out] = await applyCmsFallback("drug", [answer()], context());
    expect(out).toMatchObject({
      status: "unknown",
      reason: "cms_api_data_not_provided",
    });
    expect(out!.cms_api!.coverage).toBe("DataNotProvided");
  });

  it("opens the breaker on 401 and refuses the next question without a call", async () => {
    reply = () => ({ status: 401, body: '{"message":"synthetic"}' });
    const [first] = await applyCmsFallback("drug", [answer()], context());
    expect(first!.reason).toBe("cms_api_unavailable");
    sent = [];
    await spacing();
    const [second] = await applyCmsFallback("drug", [answer()], context());
    expect(second!.reason).toBe("cms_api_unavailable");
    expect(dataCalls()).toEqual([]);
  });

  it("rejects a body that echoes the key and stores nothing from it", async () => {
    reply = () => ({
      status: 200,
      body: JSON.stringify({ coverage: [], echo: plantedKey }),
    });
    const [out] = await applyCmsFallback("drug", [answer()], context());
    expect(out!.status).toBe("unknown");
    expect((await dump()) + (await files())).not.toContain(plantedKey);
  });

  it("provider coverage: Covered and NotCovered are labelled and absorbed per NPI", async () => {
    reply = (url) => {
      const plans = url.searchParams.get("planids")!.split(",");
      return {
        status: 200,
        body: JSON.stringify({
          coverage: plans.flatMap((plan_id) => [
            {
              npi: "1000000001",
              plan_id,
              coverage: "Covered",
              accepting: "unknown",
              addresses: [],
            },
            {
              npi: "1000000002",
              plan_id,
              coverage: "NotCovered",
              accepting: "unknown",
              addresses: [],
            },
          ]),
        }),
      };
    };
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
    const out = await applyCmsFallback(
      "provider",
      [provider("1000000001"), provider("1000000002")],
      context(),
    );
    expect(dataCalls()).toHaveLength(1);
    expect(dataCalls()[0]!.pathname).toBe("/api/v1/providers/covered");
    expect(
      out.map((a) => [a.status, a.covered, a.cms_api?.sourced_by]),
    ).toEqual([
      ["listed_participating", true, "cms-marketplace-api"],
      ["unknown", undefined, "cms-marketplace-api"],
    ]);
    const rows = (
      await h.db.query(
        `SELECT npi,coverage FROM cms_api_provider_coverage ORDER BY npi`,
      )
    ).rows;
    expect(rows).toEqual([
      { npi: "1000000001", coverage: "Covered" },
      { npi: "1000000002", coverage: "NotCovered" },
    ]);
  });
  it("one client gets at most a tenth of the daily allowance; other clients still get answers", async () => {
    await h.db.query(`UPDATE cms_api_budget SET max_daily_requests=20`);
    const client = "203.0.113.77";
    const ask = async (rxcui: string, from: string) => {
      await spacing();
      return (
        await applyCmsFallback(
          "drug",
          [answer({ rxcui })],
          context({ client: from }),
        )
      )[0]!;
    };
    expect((await ask("1001", client)).status).toBe("listed_covered");
    expect((await ask("1002", client)).status).toBe("listed_covered");
    const third = await ask("1003", client);
    expect(third).toMatchObject({
      status: "unknown",
      reason: "cms_api_request_cap",
    });
    expect(dataCalls()).toHaveLength(2);
    expect(
      (
        await h.db.query(
          `SELECT refusal_reason FROM cms_api_attempt WHERE outcome='refused'`,
        )
      ).rows,
    ).toEqual([{ refusal_reason: "cms_api_client_share" }]);
    // An answer stored earlier is still served to the capped client, without a call.
    expect((await ask("1001", client)).cms_api!.served_from).toBe("absorbed");
    expect((await ask("1003", "198.51.100.9")).status).toBe("listed_covered");
    expect(dataCalls()).toHaveLength(3);
    // The client name is counted in memory only.
    expect((await dump()) + (await files())).not.toContain(client);
  });

  it("three server errors within five minutes pause calls; one trial call resumes them", async () => {
    const ask = async (rxcui: string) => {
      await spacing();
      sent = [];
      return (
        await applyCmsFallback("drug", [answer({ rxcui })], context())
      )[0]!;
    };
    const elapse = () =>
      h.db.query(
        `UPDATE cms_api_budget SET blocked_until=now()-interval '1 second',
          failure_window_start=failure_window_start-interval '16 minutes'`,
      );
    reply = () => ({ status: 503, body: "synthetic outage" });
    // Two failures followed by a quiet spell do not open the breaker.
    await ask("2001");
    await ask("2001");
    await h.db.query(
      `UPDATE cms_api_budget SET failure_window_start=now()-interval '6 minutes'`,
    );
    for (let round = 0; round < 2; round++) {
      expect((await ask("2001")).reason).toBe("cms_api_unavailable");
      expect(dataCalls()).toHaveLength(1);
    }
    // The third failure inside the window opens it.
    expect((await ask("2001")).reason).toBe("cms_api_unavailable");
    expect(dataCalls()).toHaveLength(1);
    expect((await ask("2001")).reason).toBe("cms_api_unavailable");
    expect(dataCalls()).toEqual([]);
    // After the pause one trial call goes out. It fails, so calls stay paused.
    await elapse();
    expect((await ask("2001")).reason).toBe("cms_api_unavailable");
    expect(dataCalls()).toHaveLength(1);
    expect((await ask("2001")).reason).toBe("cms_api_unavailable");
    expect(dataCalls()).toEqual([]);
    // The next trial call succeeds and closes the breaker.
    await elapse();
    reply = covered();
    expect((await ask("2001")).status).toBe("listed_covered");
    expect((await ask("2002")).status).toBe("listed_covered");
    expect(dataCalls()).toHaveLength(1);
    expect(
      (
        await h.db.query(
          `SELECT half_open,failure_count,blocked_until<=now() AS open FROM cms_api_budget`,
        )
      ).rows,
    ).toEqual([{ half_open: false, failure_count: 0, open: true }]);
  });

  it("spends no call on a plan whose catalog comes from a state-based exchange", async () => {
    await h.db.query(
      `INSERT INTO sbe_catalog(import_id,bundle_url,bundle_sha256,serving)
       SELECT import_id,'https://example.invalid/synthetic-sbe.zip',repeat('a',64),true
       FROM puf_active_catalog WHERE state=$1 AND plan_year=2026`,
      [plan.slice(5, 7)],
    );
    try {
      const [out] = await applyCmsFallback("drug", [answer()], context());
      expect(out).toMatchObject({
        status: "unknown",
        reason: "cms_api_state_not_served",
      });
      expect(sent).toEqual([]);
      expect((await h.db.query(`SELECT 1 FROM cms_api_attempt`)).rows).toEqual(
        [],
      );
    } finally {
      await h.db.query(
        `DELETE FROM sbe_catalog WHERE bundle_url='https://example.invalid/synthetic-sbe.zip'`,
      );
    }
    // The same plan is asked about once the state's catalog is a HealthCare.gov one again.
    const [out] = await applyCmsFallback("drug", [answer()], context());
    expect(out!.status).toBe("listed_covered");
  });

  it("the documented backup leaves out every table that holds API-sourced rows", async () => {
    await applyCmsFallback("drug", [answer()], context());
    await spacing();
    await h.db.query(
      `UPDATE cms_api_budget SET daily_requests=max_daily_requests`,
    );
    await applyCmsFallback("drug", [answer({ rxcui: "3001" })], context());
    const tables = (
      await h.db.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.columns
         WHERE table_schema='public' AND column_name='sourced_by'`,
      )
    ).rows.map((row) => row.table_name);
    const holding: string[] = [];
    for (const table of tables)
      if (
        (
          await h.db.query(
            `SELECT 1 FROM "${table}" WHERE sourced_by LIKE 'cms-marketplace-%' LIMIT 1`,
          )
        ).rows.length
      )
        holding.push(table);
    expect(holding).toContain("cms_api_drug_coverage");
    expect(holding).toContain("cms_api_attempt");
    // Receipts stay in a dump. They hold a hash and a redacted URL, not the answer.
    expect(
      holding.filter(
        (table) =>
          table !== "snapshot" &&
          !CMS_API_EXPORT_EXCLUDED_TABLES.includes(table),
      ),
    ).toEqual([]);
    const named = tables.filter(
      (table) => /^cms_(api|zip)_/.test(table) && !table.endsWith("_budget"),
    );
    expect([...CMS_API_EXPORT_EXCLUDED_TABLES].sort()).toEqual(named.sort());
    const guide = await readFile(
      new URL("../../../docs/self-host.md", import.meta.url),
      "utf8",
    );
    for (const argument of pgDumpExcludeArgs())
      expect(guide).toContain(argument);
    expect(guide).toContain(`--exclude='${CMS_API_EXPORT_EXCLUDED_RAW}'`);
  });

  it("reports stored answers per issuer, state and year, and nothing when the fallback is off", async () => {
    await applyCmsFallback("drug", [answer()], context());
    const report = (await cmsApiAvailability(h.db))!;
    expect(report.configured).toBe(true);
    expect(
      report.byIssuer.get(`${plan.slice(0, 5)}|${plan.slice(5, 7)}|2026`),
    ).toMatchObject({ configured: true, absorbed_rows: 1 });
    expect(JSON.stringify([...report.byIssuer])).not.toContain(plantedKey);
    vi.stubEnv("CMS_API_KEY", "");
    expect((await cmsApiAvailability(h.db))!.configured).toBe(false);
    vi.stubEnv("OPENPLANS_CMS_FALLBACK", "");
    expect(await cmsApiAvailability(h.db)).toBeNull();
  });
});

it("uses expired_at for fresh answers and the policy stale window for stale serving", async () => {
  const first = await applyCmsFallback("drug", [answer()], context());
  expect(first[0]!.cms_api!.served_from).toBe("live");
  sent = [];
  expect(
    (
      await applyCmsFallback("drug", [answer()], context({ writer: undefined }))
    )[0]!.cms_api!.served_from,
  ).toBe("absorbed");
  expect(dataCalls()).toHaveLength(0);
  await h.db.exec(
    "UPDATE cms_api_drug_coverage SET expired_at=now()-interval '2 days'",
  );
  const stale = await applyCmsFallback(
    "drug",
    [answer()],
    context({ writer: undefined }),
  );
  expect(stale[0]!.cms_api!.served_from).toBe("absorbed_stale");
  await h.db.exec(
    "UPDATE record_policy SET stale_window='1 day' WHERE name='cms_api_fallback'",
  );
  const expired = await applyCmsFallback(
    "drug",
    [answer()],
    context({ writer: undefined }),
  );
  expect(expired[0]!.status).toBe("unknown");
  expect(expired[0]!.cms_api).toBeUndefined();
  await spacing();
  const refreshed = await applyCmsFallback("drug", [answer()], context());
  expect(
    (
      await h.db.query(
        "SELECT outcome,failure_code,refusal_reason FROM cms_api_attempt ORDER BY attempt_id DESC LIMIT 1",
      )
    ).rows[0],
  ).toEqual({ outcome: "absorbed", failure_code: null, refusal_reason: null });
  expect(refreshed[0]!.cms_api!.served_from).toBe("live");
  expect(dataCalls()).toHaveLength(1);
  expect(refreshed[0]!.cms_api!.snapshot_id).not.toBe(
    first[0]!.cms_api!.snapshot_id,
  );
});

it("does not use the legacy expires_at field for freshness", async () => {
  await applyCmsFallback("drug", [answer()], context());
  // Planted legacy-alias mutant. The source of truth still forces a refetch.
  await h.db
    .exec(`UPDATE cms_api_drug_coverage SET expired_at=now()-interval '1 day';
    ALTER TABLE cms_api_drug_coverage DISABLE TRIGGER zz_record_policy;
    UPDATE cms_api_drug_coverage SET expires_at=now()+interval '100 days';
    ALTER TABLE cms_api_drug_coverage ENABLE TRIGGER zz_record_policy;`);
  sent = [];
  await spacing();
  const refreshed = await applyCmsFallback("drug", [answer()], context());
  expect(dataCalls()).toHaveLength(1);
  expect(
    (
      await h.db.query(
        "SELECT outcome,failure_code,refusal_reason FROM cms_api_attempt ORDER BY attempt_id DESC LIMIT 1",
      )
    ).rows[0],
  ).toEqual({ outcome: "absorbed", failure_code: null, refusal_reason: null });
  expect(refreshed[0]!.cms_api!.served_from).toBe("live");
});

it("operator no-data TTL changes govern new answers without changing unknown to not covered", async () => {
  await h.db.exec(
    "UPDATE record_policy SET default_ttl='2 hours' WHERE name='cms_api_fallback_no_data'",
  );
  reply = covered("DataNotProvided");
  const out = await applyCmsFallback("drug", [answer()], context());
  expect(out[0]!.status).toBe("unknown");
  expect(
    (
      await h.db
        .query(`SELECT record_policy,record_ttl::text,expired_at=sourced_at+interval '2 hours' AS correct
    FROM cms_api_drug_coverage`)
    ).rows[0],
  ).toEqual({
    record_policy: "cms_api_fallback_no_data",
    record_ttl: "02:00:00",
    correct: true,
  });
});

describe("quote fallback request contracts", () => {
  beforeEach(() => vi.stubEnv("OPENPLANS_CMS_FALLBACK_QUOTES", "on"));

  async function callContext() {
    const ctx = context({ client: "synthetic-quote-client" });
    const original = ctx.fetchOptions!.transport!;
    ctx.fetchOptions!.transport = async (url, options) => {
      await spacing();
      return original(url, options);
    };
    return ctx;
  }

  async function capContract(module: typeof QuoteCoverage) {
    const input = [2025, 2026, 2027].map((plan_year) => ({
      providers: [],
      drugs: [answer({ plan_year })],
    }));
    const out = await module.applyQuoteFallback(input, await callContext());
    expect(dataCalls()).toHaveLength(2);
    expect(out[2]!.drugs[0]).toMatchObject({
      status: "unknown",
      reason: "cms_api_request_cap",
    });
  }

  async function officialContract(module: typeof QuoteCoverage) {
    const other = "00010TX0000002";
    const established = answer({ status: "listed_covered", reason: null });
    // Synthetic matrix: one established cell surrounded by three eligible missing-source cells.
    const input = [
      { providers: [], drugs: [established, answer({ rxcui: "999997" })] },
      {
        providers: [],
        drugs: [
          answer({ requested_plan_id: other }),
          answer({ requested_plan_id: other, rxcui: "999997" }),
        ],
      },
    ];
    const out = await module.applyQuoteFallback(input, await callContext());
    expect(out[0]!.drugs[0]).toEqual(established);
    expect(out[0]!.drugs[1]!.status).toBe("listed_covered");
    expect(dataCalls().length).toBeGreaterThan(0);
    for (const url of dataCalls()) {
      const asksKnown =
        url.searchParams.get("planids")!.split(",").includes(plan) &&
        url.searchParams.get("drugs")!.split(",").includes(rx);
      expect(asksKnown).toBe(false);
    }
  }

  it("keeps the issuer file answer when quote coverage reads an established pair", async () => {
    await h.replace(await fixture("drugs"));
    await importFormulary(h.db, scope);
    const module = await import("../../../src/services/quote-coverage.js");
    const local = await module.readQuoteCoverage(h.db, plan, [], [rx], 2026);
    expect(local.drugs[0]!.status).toBe("listed_covered");
    const [out] = await module.applyQuoteFallback([local], await callContext());
    expect(out).toEqual(local);
    expect(dataCalls()).toEqual([]);
  });

  it("keeps officially answered cells out of batch cross-products", async () => {
    await officialContract(
      await import("../../../src/services/quote-coverage.js"),
    );
  });
  it("keeps one call cap across all quote plans", async () => {
    await capContract(await import("../../../src/services/quote-coverage.js"));
  });

  it.each(["official-first", "cap"])(
    "negative control: rejects a %s source mutant",
    async (kind) => {
      const mutant =
        kind === "cap"
          ? await coreMutant(
              `quote-${kind}`,
              "if (remaining(scope, source) <= 0)",
              "if (false)",
            )
          : // Treat settled pairs as eligible, so batches cross officially answered cells.
            await coreMutant(
              `quote-${kind}`,
              "if (eligible(source, answer, question)) pairs.push(pair);",
              "if (true) pairs.push(pair);",
            );
      try {
        const module = (await import(
          /* @vite-ignore */ mutant.quote.href
        )) as typeof QuoteCoverage;
        await expect(
          kind === "cap" ? capContract(module) : officialContract(module),
        ).rejects.toThrow();
      } finally {
        await mutant.cleanup();
      }
    },
  );
});

it("preserves local coverage and identity reasons when shadow reads fail", async () => {
  const local = answer({ status: "listed_covered", reason: null });
  const unmapped = answer({ reason: "rxcui_not_in_rxnorm" });
  const fail = async () => {
    throw new Error("synthetic shadow storage failure");
  };
  const broken = { query: fail, exec: fail };
  const result = await applyCmsFallback(
    "drug",
    [answer(), local, unmapped],
    context({ reader: broken, writer: broken }),
  );
  expect(result[0]).toMatchObject({
    status: "unknown",
    reason: "cms_api_unavailable",
  });
  expect(result[1]).toEqual(local);
  expect(result[2]).toEqual(unmapped);
  expect(sent).toEqual([]);
});

const projectionCases = [
  "Covered",
  "GenericCovered",
  "NotCovered",
  "DataNotProvided",
].flatMap((statement) => [false, true].map((known) => ({ statement, known })));
it.each(projectionCases)(
  "reprojects stored drug $statement with identity=$known",
  async ({ statement, known }) => {
    const rxcui = known ? rx : "999999999999";
    reply = covered(statement);
    const local = answer({ rxcui });
    const first = (await applyCmsFallback("drug", [local], context()))[0]!;
    const check = (out: DrugCoverage) => {
      expect(out.cms_api).toMatchObject({
        coverage: statement,
        sourced_by: "cms-marketplace-api",
      });
      let status = "listed_covered";
      if (statement === "NotCovered") status = "explicitly_not_covered";
      if (
        statement === "DataNotProvided" ||
        (statement === "NotCovered" && !known)
      )
        status = "unknown";
      expect(out.status).toBe(status);
      expect(out.covered).toBe(
        status === "unknown" ? undefined : statement !== "NotCovered",
      );
      if (statement === "NotCovered" && !known)
        expect(out.reason).toBe("cms_api_reports_not_covered");
    };
    check(first);
    sent = [];
    check(
      (
        await applyCmsFallback("drug", [local], context({ writer: undefined }))
      )[0]!,
    );
    await h.db.exec(
      "UPDATE cms_api_drug_coverage SET expired_at=now()-interval '1 day'",
    );
    const stale = (
      await applyCmsFallback("drug", [local], context({ writer: undefined }))
    )[0]!;
    check(stale);
    expect(stale.cms_api!.served_from).toBe("absorbed_stale");
    expect(sent).toEqual([]);
  },
);

it("rechecks identity on stored NotCovered reads without changing the stored CMS statement", async () => {
  reply = covered("NotCovered");
  await applyCmsFallback("drug", [answer()], context());
  await h.db.exec(
    "UPDATE snapshot SET validation_state='QUARANTINED' WHERE snapshot_id='rx'",
  );
  try {
    const out = (
      await applyCmsFallback("drug", [answer()], context({ writer: undefined }))
    )[0]!;
    expect(out.status).toBe("unknown");
    expect(out.covered).toBeUndefined();
    expect(out.reason).toBe("cms_api_reports_not_covered");
    expect(
      (await h.db.query("SELECT coverage FROM cms_api_drug_coverage")).rows,
    ).toEqual([{ coverage: "NotCovered" }]);
  } finally {
    await h.db.exec(
      "UPDATE snapshot SET validation_state='ACTIVE' WHERE snapshot_id='rx'",
    );
  }
});

it("negative control: rejects a projection mutant that treats every identity as known", async () => {
  const planted = await coreMutant(
    "identity",
    "known.has(pair.question.identity)",
    "true",
  );
  try {
    const mutant = (await import(
      /* @vite-ignore */ planted.fallback.href
    )) as typeof Fallback;
    reply = covered("NotCovered");
    const out = (
      await mutant.applyCmsFallback(
        "drug",
        [answer({ rxcui: "999999999999" })],
        context(),
      )
    )[0]!;
    expect(() => expect(out.status).toBe("unknown")).toThrow();
    expect(out.covered).toBe(false);
  } finally {
    await planted.cleanup();
  }
});

it("rechecks NPPES identity for fresh and stale stored provider negatives", async () => {
  const identity = "1234567893";
  const provider: ProviderParticipation = {
    status: "unknown",
    reason: "source_set_not_available",
    requested_plan_id: plan,
    base_hios_id: plan,
    identity,
    plan_year: 2026,
    participation_scope: "provider_record",
    snapshot_id: null,
    manifest_snapshot_id: null,
    evidence: [],
    warnings: [],
  };
  reply = (url) => ({
    status: 200,
    body: JSON.stringify({
      coverage: url.searchParams
        .get("planids")!
        .split(",")
        .map((plan_id) => ({ plan_id, npi: identity, coverage: "NotCovered" })),
    }),
  });
  const live = (await applyCmsFallback("provider", [provider], context()))[0]!;
  expect(live).toMatchObject({
    status: "unknown",
    reason: "cms_api_reports_not_covered",
  });
  expect(live.covered).toBeUndefined();
  sent = [];
  for (const stale of [false, true]) {
    if (stale)
      await h.db.exec(
        "UPDATE cms_api_provider_coverage SET expired_at=now()-interval '1 day'",
      );
    for (const known of [false, true, false]) {
      if (known)
        await h.db.query(
          `INSERT INTO npi_provider(npi,organization_name,in_scope,state_filter,data_date,snapshot_id)
        VALUES ($1,'Synthetic identity',true,'TX','2026-11-10','catalog')`,
          [identity],
        );
      else
        await h.db.query("DELETE FROM npi_provider WHERE npi=$1", [identity]);
      const out = (
        await applyCmsFallback(
          "provider",
          [provider],
          context({ writer: undefined }),
        )
      )[0]!;
      expect(out.status).toBe(
        known ? "explicitly_not_participating" : "unknown",
      );
      expect(out.covered).toBe(known ? false : undefined);
      expect(out.cms_api).toMatchObject({
        coverage: "NotCovered",
        sourced_by: "cms-marketplace-api",
        served_from: stale ? "absorbed_stale" : "absorbed",
      });
      expect(
        (await h.db.query("SELECT coverage FROM cms_api_provider_coverage"))
          .rows,
      ).toEqual([{ coverage: "NotCovered" }]);
    }
  }
  expect(sent).toEqual([]);
});
