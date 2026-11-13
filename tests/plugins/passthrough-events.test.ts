// Pass-through events from the CMS source through the outbox to the Slack plugin. Synthetic
// catalog, synthetic key, injected transport; nothing reaches the network or Slack.
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { eventPayloadSchemas } from "@openplans/plugin-sdk";
import type { AdmittedFetch, Event } from "@openplans/plugin-sdk";
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
import type { DrugCoverage } from "../../src/domain/drugs/index.js";
import {
  AdmissionSession,
  shippedManifestPaths,
} from "../../src/fetch/index.js";
import type { Transport } from "../../src/fetch/index.js";
import type * as Fallback from "../../src/ingest/cms-api/fallback.js";
import type * as PassThrough from "../../src/plugins/sources/passthrough.js";
import { loadApiPlugins } from "../../src/plugins/api.js";
import { loadForTest } from "../../src/plugins/testing/index.js";
import { createCoreEvents } from "../../src/plugins/worker.js";
import { deliverEvents } from "../../src/worker/deliver-events.js";
import type { DurableSubscriber } from "../../src/worker/deliver-events.js";
import {
  createSlackPlugin,
  messageText,
  URL_SECRET,
} from "../../plugins/slack/src/index.js";
import { setup } from "../ingest/qhp/formulary-helpers.js";
import { importMutant, plantMutantFile } from "../mutant-file.js";

vi.mock("../../src/fetch/limiter.js", () => ({
  leaseHost: async () => async () => {},
}));

const plantedKey = "PLANTED-cms-key-5e4d3c2b1a09";
const docs = "Synthetic CMS API documentation for offline tests.";
const SLACK_HOST = "slack-receiver.test";
const SLACK_URL = `https://${SLACK_HOST}/services/TSYNTH000/BSYNTH000/synthetic0123456789abcd`;
const fixtures = fileURLToPath(
  new URL("../fixtures/plugins/", import.meta.url),
);
const src = (path: string) => new URL(`../../src/${path}`, import.meta.url);

type Modules = {
  fallback: typeof Fallback;
  passthrough: typeof PassThrough;
};

let h: Awaited<ReturnType<typeof setup>>;
let directory: string;
let manifestPath: string;
let plan: string;
let sent: URL[];
let reply: () => { status: number; body: string };

const transport: Transport = async (url) => {
  sent.push(new URL(url.href));
  let status = 200,
    body = "";
  if (url.pathname === "/robots.txt")
    status = url.hostname === "marketplace.api.healthcare.gov" ? 401 : 404;
  else if (url.hostname === "developer.cms.gov") body = docs;
  else ({ status, body } = reply());
  return { status, headers: {}, body: Readable.from([body]) };
};
const dataCalls = () => sent.filter((url) => url.pathname.startsWith("/api/"));

function answer(rxcui: string): DrugCoverage {
  return {
    status: "unknown",
    reason: "source_set_not_available",
    base_hios_id: plan,
    requested_plan_id: plan,
    rxcui,
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
  };
}

/** The API host's wiring: core events on a connection of their own, plus an in-process listener. */
function wire(m: Modules, heard: Event[]) {
  const events = createCoreEvents({
    open: () => ({ ...h.db, close: async () => {} }),
    host: "api",
    subscriptions: (
      ["passthrough.budget_exhausted", "passthrough.breaker_open"] as const
    ).map((type) => ({
      plugin: "@synthetic/listener",
      spec: {
        type,
        subscriber: "synthetic-listener",
        durable: false,
        handler: async (event: Event) => {
          heard.push(event);
        },
      },
    })),
  });
  m.passthrough.configureHostPassThrough({
    operatorLevels: {},
    operatorTtls: {},
    events: { emit: (event) => events.emit(event as never) },
  });
  m.fallback.resetCmsClientCounts();
}

async function ask(m: Modules, rxcui: string) {
  await h.db.query(`UPDATE cms_api_budget SET next_request_at='epoch'`);
  sent = [];
  const context = m.fallback.cmsFallbackContext(h.db, h.db, {
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
  return (
    await m.fallback.applyCmsFallback("drug", [answer(rxcui)], context)
  )[0]!;
}

const outbox = async () =>
  (
    await h.db.query<{
      event_type: string;
      idempotency_key: string;
      emitted_by: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT event_type,idempotency_key,emitted_by,payload FROM plugin_event_outbox
       WHERE event_type LIKE 'passthrough.%' ORDER BY emitted_at`,
    )
  ).rows;

/** Today's allowance is spent: three questions are refused, and the event fires once. */
async function exhaustedScenario(m: Modules) {
  const heard: Event[] = [];
  wire(m, heard);
  await h.db.query(
    `UPDATE cms_api_budget SET day_start=(now() AT TIME ZONE 'UTC')::date,daily_requests=max_daily_requests`,
  );
  const reasons: (string | null)[] = [];
  let calls = 0;
  for (const rxcui of ["4001", "4002", "4003"]) {
    reasons.push((await ask(m, rxcui)).reason);
    calls += dataCalls().length;
  }
  return {
    reasons,
    calls,
    heard: heard.map((event) => [event.type, event.payload]),
    rows: (await outbox()).length,
  };
}
const exhaustedExpected = {
  reasons: Array(3).fill("cms_api_budget_exhausted"),
  calls: 0,
  heard: [
    [
      "passthrough.budget_exhausted",
      { sourceId: "cms-marketplace-api", dailyMax: 500 },
    ],
  ],
  rows: 1,
};

/** A copy of passthrough.ts with one change, and a fallback.ts copy that imports it. */
async function mutant(anchor: string, replacement: string) {
  const core = await readFile(src("plugins/sources/passthrough.ts"), "utf8");
  expect(core.split(anchor)).toHaveLength(2);
  const passthrough = await plantMutantFile(
    src("plugins/sources/passthrough.ts"),
    core.replace(anchor, replacement),
  );
  let fallback: Awaited<ReturnType<typeof plantMutantFile>> | undefined;
  const cleanup = async () => {
    await fallback?.cleanup();
    await passthrough.cleanup();
  };
  try {
    const wired = (
      await readFile(src("ingest/cms-api/fallback.ts"), "utf8")
    ).replaceAll(
      /"(?:\.\.\/)+plugins\/sources\/passthrough\.js"/g,
      JSON.stringify(passthrough.url.href),
    );
    // The fallback copy must import the planted core, not the real one.
    expect(wired).toContain(passthrough.url.href);
    fallback = await plantMutantFile(src("ingest/cms-api/fallback.ts"), wired);
    return {
      modules: {
        passthrough: await importMutant<typeof PassThrough>(
          passthrough.url,
          "configureHostPassThrough",
        ),
        fallback: await importMutant<typeof Fallback>(
          fallback.url,
          "applyCmsFallback",
        ),
      },
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

let real: Modules;

beforeAll(async () => {
  h = await setup();
  plan = h.catalog.plans[0].base_plan_id;
  real = {
    fallback: await import("../../src/ingest/cms-api/fallback.js"),
    passthrough: await import("../../src/plugins/sources/passthrough.js"),
  };
}, 120_000);
afterAll(async () => {
  await h?.close();
});
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "openplans-synthetic-events-"));
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
  reply = () => ({ status: 200, body: JSON.stringify({ coverage: [] }) });
  await h.db.exec(
    `DELETE FROM plugin_event_delivery; DELETE FROM plugin_event_outbox;
     DELETE FROM cms_api_drug_coverage; DELETE FROM cms_api_attempt;
     UPDATE cms_api_budget SET next_request_at='epoch',daily_requests=0,blocked_until='epoch',min_interval_ms=1000,
       max_daily_requests=500,failure_count=0,failure_window_start='epoch',half_open=false`,
  );
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe("passthrough.budget_exhausted", () => {
  it("an exhausted budget gives one outbox row, and the Slack plugin posts it", async () => {
    // The Slack plugin as the worker loads it, posting through a recording fetch.
    const posted: { url: string; text: string }[] = [];
    const fetch = Object.assign(
      async () => {
        throw new Error("Slack never downloads");
      },
      {
        post: async (url: string, request: { body: Buffer }) => {
          posted.push({
            url,
            text: (
              JSON.parse(request.body.toString("utf8")) as { text: string }
            ).text,
          });
          return { status: 200 };
        },
      },
    ) as unknown as AdmittedFetch;
    const slack = await loadForTest(createSlackPlugin({ host: SLACK_HOST }), {
      db: h.db,
      secrets: { [URL_SECRET]: SLACK_URL },
      fetch,
    });
    const subscribers: DurableSubscriber[] =
      slack.registrations.subscriptions.map((entry) => ({
        plugin: "@openplans/plugin-slack",
        type: entry.type as DurableSubscriber["type"],
        subscriber: entry.options.subscriber,
        handler: entry.handler as DurableSubscriber["handler"],
      }));
    expect(subscribers.map((s) => s.type)).toContain(
      "passthrough.budget_exhausted",
    );
    // The first run records when the subscriber started; it hears events from then on.
    await deliverEvents(h.db, subscribers);

    expect(await exhaustedScenario(real)).toEqual(exhaustedExpected);
    const [row] = await outbox();
    expect(row).toMatchObject({
      event_type: "passthrough.budget_exhausted",
      emitted_by: "api",
      payload: { sourceId: "cms-marketplace-api", dailyMax: 500 },
    });
    expect(row!.idempotency_key).toMatch(
      /^passthrough\.budget_exhausted:cms-marketplace-api:\d{4}-\d{2}-\d{2}$/,
    );
    expect(
      eventPayloadSchemas["passthrough.budget_exhausted"].safeParse(
        row!.payload,
      ).success,
    ).toBe(true);
    // The refusals are recorded as before.
    expect(
      (await h.db.query(`SELECT outcome,refusal_reason FROM cms_api_attempt`))
        .rows,
    ).toEqual(
      Array(3).fill({
        outcome: "refused",
        refusal_reason: "cms_api_budget_exhausted",
      }),
    );

    const report = await deliverEvents(h.db, subscribers);
    expect(report.delivered).toBe(1);
    expect(posted).toEqual([
      {
        url: SLACK_URL,
        text: "OpenPlans: Fallback budget used up for cms-marketplace-api: all 500 requests for today are spent.",
      },
    ]);
    // Another process (a fresh core) refused later the same day adds no row.
    expect(await exhaustedScenario(real)).toEqual({
      ...exhaustedExpected,
      rows: 1,
    });
    await slack.close();
  });

  it("negative control: a call refused for spacing alone emits nothing", async () => {
    const heard: Event[] = [];
    wire(real, heard);
    reply = () => ({ status: 200, body: JSON.stringify({ coverage: [] }) });
    expect((await ask(real, "5001")).reason).not.toBe(
      "cms_api_budget_exhausted",
    );
    // Within the 1 s spacing the next call is refused with the budget's reason.
    sent = [];
    const context = real.fallback.cmsFallbackContext(h.db, h.db, {
      admission: new AdmissionSession([manifestPath], {
        maxRequests: 100,
        maxTransferBytes: 1024 ** 2,
      }),
      fetchOptions: { transport, dataDir: directory },
    });
    const [spaced] = await real.fallback.applyCmsFallback(
      "drug",
      [answer("5002")],
      context,
    );
    expect(spaced!.reason).toBe("cms_api_budget_exhausted");
    expect(heard).toEqual([]);
    expect(await outbox()).toEqual([]);
  });

  it("catches a planted mutant: the event on every refused call instead of once", async () => {
    const planted = await mutant(
      "    if (exhaustedOn.get(source.id) === day) return;\n",
      "",
    );
    try {
      expect(await exhaustedScenario(planted.modules)).not.toEqual(
        exhaustedExpected,
      );
    } finally {
      await planted.cleanup();
    }
  });
});

describe("passthrough.breaker_open", () => {
  it("three server errors open the breaker once; a failed trial call adds nothing", async () => {
    const heard: Event[] = [];
    wire(real, heard);
    reply = () => ({ status: 503, body: "synthetic outage" });
    for (let i = 0; i < 4; i++)
      expect((await ask(real, "6001")).reason).toBe("cms_api_unavailable");
    expect(heard.map((event) => event.type)).toEqual([
      "passthrough.breaker_open",
    ]);
    const payload = heard[0]!.payload as { sourceId: string; untilAt: string };
    expect(payload.sourceId).toBe("cms-marketplace-api");
    expect(
      eventPayloadSchemas["passthrough.breaker_open"].safeParse(payload)
        .success,
    ).toBe(true);
    const until = (
      await h.db.query<{ blocked_until: Date }>(
        `SELECT blocked_until FROM cms_api_budget`,
      )
    ).rows[0]!.blocked_until;
    expect(payload.untilAt).toBe(new Date(until).toISOString());
    expect(messageText(heard[0]!)).toBe(
      `OpenPlans: Fallback paused for cms-marketplace-api after failed calls, until ${payload.untilAt}.`,
    );
    // The pause ends; the trial call fails and the pause goes on without a second event.
    await h.db.query(
      `UPDATE cms_api_budget SET blocked_until=now()-interval '1 second'`,
    );
    expect((await ask(real, "6001")).reason).toBe("cms_api_unavailable");
    expect(heard).toHaveLength(1);
    expect(await outbox()).toHaveLength(1);
  });

  it("a 429 pauses calls for an hour and reports it once", async () => {
    const heard: Event[] = [];
    wire(real, heard);
    reply = () => ({ status: 429, body: "synthetic limit" });
    expect((await ask(real, "7001")).reason).toBe("cms_api_unavailable");
    expect((await ask(real, "7001")).reason).toBe("cms_api_unavailable");
    expect(heard.map((event) => event.type)).toEqual([
      "passthrough.breaker_open",
    ]);
    expect(await outbox()).toHaveLength(1);
  });
});

describe("API host wiring", () => {
  it("passes core events to the pass-through core when a database is configured", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "openplans-events-wiring-"));
    const path = join(scratch, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        plugins: [{ package: "./synthetic-alpha/index.mjs" }],
      }),
    );
    const load = (env: Record<string, string>, host?: "api" | "stdio") =>
      loadApiPlugins({
        env: {
          OPENPLANS_CONFIG: path,
          SYNTHETIC_ALPHA_SECRET: "synthetic",
          ...env,
        },
        host,
        baseDirectory: fixtures,
        writeLog: () => {},
        exit: (code) => {
          throw new Error(`exit ${code}`);
        },
      });
    try {
      for (const [env, host, wired] of [
        [
          { DATABASE_URL: "postgres://synthetic@127.0.0.1:1/none" },
          "api",
          true,
        ],
        [{}, "api", false],
        [
          { DATABASE_URL: "postgres://synthetic@127.0.0.1:1/none" },
          "stdio",
          false,
        ],
      ] as const) {
        const loaded = await load(env, host);
        try {
          expect(
            real.passthrough.passThroughHostSettings().events !== undefined,
          ).toBe(wired);
        } finally {
          await loaded.teardown();
        }
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
