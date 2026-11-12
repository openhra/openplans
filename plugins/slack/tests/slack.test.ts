import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { eventPayloadSchemas } from "@openplans/plugin-sdk";
import type {
  Event,
  EventInput,
  EventType,
  OpenPlansPlugin,
} from "@openplans/plugin-sdk";
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
import { loadConfig } from "../../../src/config/index.js";
import type { Database } from "../../../src/db/database.js";
import { migrate } from "../../../src/db/migrate.js";
import type {
  AdmissionManifest,
  PublisherPolicy,
  Transport,
} from "../../../src/fetch/index.js";
import { createEventBus } from "../../../src/plugins/events.js";
import { pluginFetch } from "../../../src/plugins/fetch.js";
import type { PluginFetchSettings } from "../../../src/plugins/fetch.js";
import { loadPlugins } from "../../../src/plugins/loader.js";
import {
  loadForTest,
  plantMutant,
} from "../../../src/plugins/testing/index.js";
import { deliverEvents } from "../../../src/worker/deliver-events.js";
import type { DurableSubscriber } from "../../../src/worker/deliver-events.js";
import { coreMigrations, testDatabase } from "../../../tests/pglite.js";

// The default export reads the webhook host when it is first imported.
vi.hoisted(() => {
  process.env.OPENPLANS_SLACK_HOST = "slack-receiver.test";
});
// Deliveries must never take a pacing lease; the mock records any call.
vi.mock("../../../src/fetch/limiter.js", () => ({
  leaseHost: vi.fn(async () => async () => {}),
}));
import { leaseHost } from "../../../src/fetch/limiter.js";

import plugin, {
  createSlackPlugin,
  DEFAULT_HOST,
  MESSAGE_FIELDS,
  messageText,
  SLACK_EVENTS,
  SlackError,
  URL_SECRET,
} from "../src/index.js";

// Every host, URL, policy and event here is synthetic. Nothing posts to Slack: the receiver
// runs on loopback and the injected transport carries https://slack-receiver.test to it.
const HOST = "slack-receiver.test";
const HOOK_PATH = "/services/TSYNTH000/BSYNTH000/synthetic0123456789abcd";
const URL_VALUE = `https://${HOST}${HOOK_PATH}`;
const terms = "Synthetic receiver accepts event posts.";
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const indexPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));

interface Received {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}
let server: Server;
let port: number;
let received: Received[];
let hookStatus: number;
let hookHeaders: Record<string, string>;
let directory: string;
let admitted: string;
let unknownHost: string;
let heldHost: string;

const transport: Transport = (url, context) =>
  new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: url.pathname + url.search,
        method: context.method ?? "GET",
        headers: {
          ...context.headers,
          host: url.host,
          ...(context.body && {
            "content-length": String(context.body.length),
          }),
        },
      },
      (response) =>
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: response,
        }),
    );
    outgoing.on("error", reject);
    outgoing.end(context.body);
  });

function publisher(state: PublisherPolicy["state"]): PublisherPolicy {
  const now = Date.now();
  return {
    host: HOST,
    state,
    evidence: [
      {
        url: `https://${HOST}/terms`,
        observedAt: new Date(now).toISOString(),
        status: 200,
      },
    ],
    scope: { products: ["events"], states: ["TX"], years: [2026] },
    discoveryUrls: [URL_VALUE],
    permittedPaths: ["/services"],
    delegates: [],
    attribution: "Synthetic receiver",
    updatePolicy: "Operator review",
    delayMs: 5000,
    jobCaps: { maxRequests: 200, maxTransferBytes: 1024 ** 2 },
    // The manifest format needs a robots record; a delivery never reads it.
    robots: {
      url: `https://${HOST}/robots.txt`,
      status: 200,
      sha256: digest("User-agent: *\nAllow: /\n"),
      checkedAt: new Date(now).toISOString(),
    },
    terms: {
      url: `https://${HOST}/terms`,
      disposition: "allowed",
      sha256: digest(terms),
      reviewedAt: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now + 48 * 60 * 60 * 1000).toISOString(),
    },
  };
}
async function saveManifest(name: string, publishers: PublisherPolicy[]) {
  const path = join(directory, name);
  const manifest = {
    version: 1,
    publishers: publishers.length
      ? publishers
      : [{ ...publisher("allowed"), host: "other.test" }],
  } as AdmissionManifest;
  await writeFile(path, JSON.stringify(manifest));
  return path;
}

beforeAll(async () => {
  server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const path = incoming.url ?? "/";
      received.push({
        method: incoming.method ?? "GET",
        path,
        headers: incoming.headers,
        body: Buffer.concat(chunks),
      });
      if (path === HOOK_PATH) {
        outgoing.writeHead(hookStatus, hookHeaders);
        return void outgoing.end(hookStatus === 200 ? "ok" : "");
      }
      outgoing.writeHead(path.startsWith("/services") ? 200 : 404);
      outgoing.end();
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
});

let db: Database;
let cleanupMigrations: () => Promise<void>;
beforeEach(async () => {
  vi.stubEnv("OPENPLANS_EGRESS_FILE", "");
  vi.stubEnv("OPENPLANS_EGRESS_SHA256", "");
  vi.stubEnv("OPENPLANS_EGRESS_COUNTRY", "");
  vi.mocked(leaseHost).mockClear();
  received = [];
  hookStatus = 200;
  hookHeaders = {};
  directory = await mkdtemp(join(tmpdir(), "openplans-synthetic-slack-"));
  admitted = await saveManifest("admitted.json", [publisher("allowed")]);
  unknownHost = await saveManifest("unknown.json", []);
  heldHost = await saveManifest("held.json", [publisher("terms-restricted")]);
  db = testDatabase(new PGlite());
  const core = await coreMigrations();
  cleanupMigrations = core.cleanup;
  await migrate(db, core.directory);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  server.closeAllConnections();
  await db.close();
  await cleanupMigrations();
  await rm(directory, { recursive: true, force: true });
});

const fetchSettings = (manifest: string): PluginFetchSettings => ({
  manifestPaths: [manifest],
  dataDir: join(directory, "data"),
  testing: {
    transport,
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
  },
});

class Exit extends Error {
  constructor(readonly code: number) {
    super("exit");
  }
}

/** Loads one plugin module through the production loader, as the worker does. */
async function load(
  settings: {
    packagePath?: string;
    manifest?: string;
    options?: unknown;
    env?: Record<string, string>;
  } = {},
) {
  const lines: string[] = [];
  const config = loadConfig(
    {},
    {
      version: 1,
      plugins: [
        {
          package: settings.packagePath ?? indexPath,
          ...(settings.options !== undefined && { options: settings.options }),
        },
      ],
    },
  );
  const manifest = settings.manifest ?? admitted;
  try {
    const loaded = await loadPlugins(config, "worker", {
      env: settings.env ?? { [URL_SECRET]: URL_VALUE },
      manifestPaths: [manifest],
      fetchFor: (pluginManifest) =>
        pluginFetch(pluginManifest, fetchSettings(manifest)),
      writeLog: (line) => lines.push(line),
      exit: (code) => {
        throw new Exit(code);
      },
    });
    const subscribers: DurableSubscriber[] = loaded.registries.events
      .filter(({ spec }) => spec.durable)
      .map(({ plugin: name, spec }) => ({
        plugin: name,
        type: spec.type,
        subscriber: spec.subscriber,
        handler: spec.handler,
      }));
    return { lines, subscribers, refusal: undefined };
  } catch (error) {
    if (!(error instanceof Exit)) throw error;
    return {
      lines,
      subscribers: [],
      refusal: JSON.parse(lines.at(-1) ?? "{}") as Record<string, string>,
    };
  }
}

/** Loads a plugin object with the admitted loopback post and returns its durable subscribers. */
async function loadObject(target: OpenPlansPlugin, options?: unknown) {
  const loaded = await loadForTest(target, {
    db,
    options,
    secrets: { [URL_SECRET]: URL_VALUE },
    fetch: pluginFetch(target.manifest, fetchSettings(admitted)),
  });
  const subscribers: DurableSubscriber[] =
    loaded.registrations.subscriptions.map((entry) => ({
      plugin: target.manifest.name,
      type: entry.type as EventType,
      subscriber: entry.options.subscriber,
      handler: entry.handler as (event: Event) => Promise<void>,
    }));
  return { subscribers, logs: loaded.logs as Record<string, unknown>[] };
}

const posts = () => received.filter(({ method }) => method === "POST");
const postedTexts = () =>
  posts().map(
    ({ body }) => (JSON.parse(body.toString("utf8")) as { text: string }).text,
  );

/** Nothing logged may carry the webhook URL or its path. */
function assertQuiet(lines: readonly string[]) {
  const text = lines.join("\n");
  for (const value of [URL_VALUE, HOOK_PATH, "TSYNTH000", "synthetic0123"])
    expect(text).not.toContain(value);
}

// One valid payload per catalog type. Fields outside the allow map carry values a message must
// never show: a URL, a host name, a file path.
const catalogPayloads: { [T in EventType]: Event<T>["payload"] } = {
  "release.deployed": {
    version: "1.4.0",
    imageId: "registry.leak.test/openplans@sha256:abc",
    previousVersion: "1.3.2",
  },
  "snapshot.activated": { sourceId: "cms-puf", snapshotId: "s1", rows: 3 },
  "snapshot.quarantined": {
    sourceId: "cms-puf",
    snapshotId: "s1",
    reasonCode: "schema_drift",
  },
  "ingest.started": { sourceId: "cms-puf", command: ["ingest"], scope: {} },
  "ingest.completed": {
    sourceId: "cms-puf",
    command: ["ingest"],
    durationMs: 5,
    snapshotIds: ["s1"],
  },
  "ingest.failed": {
    sourceId: "cms-puf",
    command: ["ingest", "--file", "/srv/leak/path.csv"],
    reasonCode: "exit_1",
  },
  "readiness.failed": { check: "bootstrap.migrate", reasonCode: "exit_1" },
  "audit.failed": { step: "row_provenance", reasonCode: "missing_rule" },
  "passthrough.budget_exhausted": { sourceId: "cms-api", dailyMax: 500 },
  "passthrough.breaker_open": {
    sourceId: "cms-api",
    untilAt: "2026-11-11T01:00:00.000Z",
  },
  "cache.flushed": { reason: "operator" },
  "health.changed": { component: "db", from: "ok", to: "degraded" },
  "record_policy.changed": {
    policy: "default",
    ttl: null,
    staleWindow: "P1D",
  },
  "plugin.loaded": { plugins: [{ name: "x", version: "1" }] },
};

const expectedText: Record<string, string> = {
  "release.deployed":
    "OpenPlans: Release 1.4.0 deployed. Previous version: 1.3.2.",
  "ingest.failed": "OpenPlans: Ingest failed for cms-puf: exit_1.",
  "readiness.failed":
    "OpenPlans: Readiness check bootstrap.migrate failed: exit_1.",
  "audit.failed": "OpenPlans: Audit step row_provenance failed: missing_rule.",
  "passthrough.budget_exhausted":
    "OpenPlans: Fallback budget used up for cms-api: all 500 requests for today are spent.",
  "passthrough.breaker_open":
    "OpenPlans: Fallback paused for cms-api after failed calls, until 2026-11-11T01:00:00.000Z.",
  "health.changed": "OpenPlans: Health of db changed from ok to degraded.",
};

function eventOf<T extends EventType>(type: T, n = 0): Event<T> {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    type,
    emittedAt: "2026-11-11T00:00:00.000Z",
    emittedBy: "worker",
    idempotencyKey: `synthetic-${type}-${n}`,
    payload: catalogPayloads[type],
  } as Event<T>;
}

async function emit(events: EventInput[]) {
  const bus = createEventBus({ db, log: () => {} });
  const registry = bus.registry({ kind: "core", name: "worker" });
  for (const event of events) await registry.emit(event);
}

/** Emits one event of every catalog type through the outbox and delivers them. */
async function deliverCatalog(subscribers: DurableSubscriber[]) {
  const logs: string[] = [];
  const log = (entry: Record<string, unknown>) =>
    logs.push(JSON.stringify(entry));
  await deliverEvents(db, subscribers, { log });
  await emit(
    (Object.keys(catalogPayloads) as EventType[]).map(
      (type) =>
        ({
          type,
          idempotencyKey: `synthetic-catalog-${type}`,
          payload: catalogPayloads[type],
        }) as EventInput,
    ),
  );
  const report = await deliverEvents(db, subscribers, { log });
  return { report, logs };
}

/** The check a mutant that posts an event outside the settled set must fail. */
function assertOnlySettledPosts() {
  expect(postedTexts().sort()).toEqual(Object.values(expectedText).sort());
}

describe("messages", () => {
  it("covers the settled seven events, in catalog order", () => {
    expect(SLACK_EVENTS).toEqual([
      "release.deployed",
      "ingest.failed",
      "readiness.failed",
      "audit.failed",
      "passthrough.budget_exhausted",
      "passthrough.breaker_open",
      "health.changed",
    ]);
  });

  it("withholds a pause end that is not a plain timestamp", () => {
    for (const untilAt of [
      "https://leak.test/x",
      "2026-11-11 01:00:00+00",
      "until hooks.slack.com",
    ])
      expect(
        messageText({
          type: "passthrough.breaker_open",
          payload: { sourceId: "cms-marketplace-api", untilAt },
        }),
      ).toBe(
        "OpenPlans: Fallback paused for cms-marketplace-api after failed calls, until [withheld].",
      );
  });

  it.each(Object.keys(expectedText))(
    "renders %s from allowed payload keys only",
    (type) => {
      const fields = MESSAGE_FIELDS[type]!;
      const schemaKeys = Object.keys(
        eventPayloadSchemas[type as EventType].shape,
      );
      for (const name of fields) expect(schemaKeys).toContain(name);
      const event = eventOf(type as EventType);
      expect(messageText(event)).toBe(expectedText[type]);
      // A canary under every key outside the allow map, including keys the catalog lacks.
      const poisoned = { ...event.payload } as Record<string, unknown>;
      for (const name of [...schemaKeys, "url", "path", "extra"])
        if (!fields.includes(name))
          poisoned[name] = `canary-${name}-https://leak.test/x`;
      const text = messageText({
        type: event.type,
        payload: poisoned,
      } as never);
      expect(text).toBe(expectedText[type]);
      expect(text).not.toContain("canary");
      for (const leak of ["leak.test", "/srv/", "registry", "@", "://"])
        expect(text).not.toContain(leak);
    },
  );

  it("withholds an allowed value that is not a short code", () => {
    for (const value of [
      "https://leak.test/x",
      "/srv/data/file.csv",
      "ops@leak",
      "two words",
      "<!channel>",
    ]) {
      const text = messageText({
        type: "ingest.failed",
        payload: { sourceId: "cms-puf", command: [], reasonCode: value },
      });
      expect(text).toBe("OpenPlans: Ingest failed for cms-puf: [withheld].");
    }
    expect(
      messageText({
        type: "release.deployed",
        payload: { version: "2.0.0", imageId: "i", previousVersion: null },
      }),
    ).toBe("OpenPlans: Release 2.0.0 deployed. Previous version: unknown.");
  });

  it("has no message for an event outside the settled set", () => {
    expect(messageText(eventOf("cache.flushed"))).toBeUndefined();
  });
});

describe("delivery to a loopback receiver", () => {
  it("posts one message per settled event and nothing for the rest of the catalog", async () => {
    const { lines, subscribers, refusal } = await load();
    expect(refusal).toBeUndefined();
    expect(subscribers.map(({ type }) => type)).toEqual(SLACK_EVENTS);
    expect(new Set(subscribers.map(({ subscriber }) => subscriber))).toEqual(
      new Set(["slack"]),
    );
    const { report, logs } = await deliverCatalog(subscribers);
    expect(report).toMatchObject({ delivered: 7, retried: 0 });
    assertOnlySettledPosts();
    for (const post of posts()) {
      expect(post.path).toBe(HOOK_PATH);
      expect(post.headers["content-type"]).toBe("application/json");
      expect(Object.keys(JSON.parse(post.body.toString("utf8")))).toEqual([
        "text",
      ]);
    }
    // A delivery is a POST only: no robots or terms read, no pacing lease.
    expect(received.every(({ method }) => method === "POST")).toBe(true);
    expect(leaseHost).not.toHaveBeenCalled();
    assertQuiet([...lines, ...logs]);
  });

  it("posts only the chosen events at or above minSeverity", async () => {
    const { subscribers } = await load({
      options: {
        events: ["release.deployed", "health.changed"],
        minSeverity: "warning",
      },
    });
    expect(subscribers.map(({ type }) => type)).toEqual([
      "release.deployed",
      "health.changed",
    ]);
    const health = subscribers.find(({ type }) => type === "health.changed")!;
    const release = subscribers.find(
      ({ type }) => type === "release.deployed",
    )!;
    await release.handler(eventOf("release.deployed"));
    const change = (to: "ok" | "degraded" | "down", n: number) =>
      health.handler({
        ...eventOf("health.changed", n),
        payload: { component: "api", from: "ok", to },
      });
    await change("ok", 1);
    await change("degraded", 2);
    await change("down", 3);
    expect(postedTexts()).toEqual([
      "OpenPlans: Health of api changed from ok to degraded.",
      "OpenPlans: Health of api changed from ok to down.",
    ]);
  });

  it("throws on HTTP 500 and logs the type and status only", async () => {
    hookStatus = 500;
    const { lines, subscribers } = await load();
    const handler = subscribers.find(({ type }) => type === "ingest.failed")!;
    await expect(
      handler.handler(eventOf("ingest.failed")),
    ).rejects.toBeInstanceOf(SlackError);
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(lines.at(-1)!)).toEqual({
      event: "slack_failed",
      event_type: "ingest.failed",
      code: "http_status",
      status: 500,
      plugin: "@openplans/plugin-slack",
    });
    assertQuiet(lines);
  });

  it.each([301, 302, 307, 308])(
    "refuses to follow a %s redirect",
    async (status) => {
      hookStatus = status;
      hookHeaders = { location: `https://${HOST}/services/elsewhere` };
      const { lines, subscribers } = await load();
      await expect(
        subscribers[0]!.handler(eventOf("release.deployed")),
      ).rejects.toBeInstanceOf(SlackError);
      expect(received.map(({ path }) => path)).not.toContain(
        "/services/elsewhere",
      );
      expect(posts()).toHaveLength(1);
      expect(JSON.parse(lines.at(-1)!)).toMatchObject({
        code: "too_many_redirects",
      });
      assertQuiet(lines);
    },
  );
});

describe("rate limit", () => {
  it("sends 20 messages for 50 events in one minute, then one summary", async () => {
    let clock = Date.now();
    const target = createSlackPlugin({ host: HOST, now: () => clock });
    const { subscribers, logs } = await loadObject(target, {
      events: ["ingest.failed"],
    });
    // One event a second: all 50 arrive within the minute.
    const ticking = subscribers.map((entry) => ({
      ...entry,
      handler: async (event: Event) => {
        clock += 1_000;
        await entry.handler(event);
      },
    }));
    // The outbox clock stands still within a run, so a held event is not retried in the same run.
    let outboxClock = clock;
    const now = () => new Date(outboxClock);
    await deliverEvents(db, ticking, { now });
    await emit(
      Array.from({ length: 50 }, (_, n) => ({
        type: "ingest.failed" as const,
        idempotencyKey: `synthetic-burst-${n}`,
        payload: { sourceId: "cms-puf", command: [], reasonCode: "exit_1" },
      })),
    );
    clock += 1_000;
    const first = await deliverEvents(db, ticking, { now });
    expect(first).toMatchObject({ delivered: 20, retried: 30 });
    expect(postedTexts()).toEqual(
      Array(20).fill("OpenPlans: Ingest failed for cms-puf: exit_1."),
    );
    expect(logs.filter(({ event }) => event === "slack_held")).toHaveLength(30);
    clock += 61_000;
    outboxClock += 120_000;
    const second = await deliverEvents(db, ticking, { now });
    expect(second).toMatchObject({ delivered: 30, retried: 0 });
    expect(postedTexts()).toHaveLength(21);
    expect(postedTexts().at(-1)).toBe(
      "OpenPlans: The rate limit held back 30 more ingest failures.",
    );
    const { rows } = await db.query<{ pending: number }>(
      "SELECT count(*)::int AS pending FROM plugin_event_delivery WHERE delivered_at IS NULL",
    );
    expect(rows[0]!.pending).toBe(0);
  });

  it("gives the message back to the budget when a post fails", async () => {
    const clock = Date.parse("2026-11-11T00:00:00.000Z");
    const target = createSlackPlugin({ host: HOST, now: () => clock });
    const { subscribers } = await loadObject(target, {
      events: ["readiness.failed"],
    });
    hookStatus = 500;
    for (let n = 0; n < 25; n++)
      await expect(
        subscribers[0]!.handler(eventOf("readiness.failed", n)),
      ).rejects.toMatchObject({ code: "slack_post_failed" });
    hookStatus = 200;
    for (let n = 0; n < 20; n++)
      await subscribers[0]!.handler(eventOf("readiness.failed", 100 + n));
    expect(posts()).toHaveLength(45);
  });
});

describe("load-time refusals", () => {
  it.each([
    ["unknown", () => unknownHost, "unknown"],
    ["not allowed", () => heldHost, "terms-restricted"],
  ])(
    "refuses the plugin when the webhook host is %s in the manifest",
    async (_label, manifest, reason) => {
      const { subscribers, refusal, lines } = await load({
        manifest: manifest(),
      });
      expect(subscribers).toEqual([]);
      expect(refusal).toEqual({
        plugin: "@openplans/plugin-slack",
        code: "plugin_network_host_not_allowed",
        reason,
      });
      expect(received).toEqual([]);
      assertQuiet(lines);
    },
  );

  it("refuses a URL on a host the plugin did not declare, without logging it", async () => {
    const { refusal, lines } = await load({
      env: { [URL_SECRET]: `https://elsewhere.test${HOOK_PATH}` },
    });
    expect(refusal).toEqual({
      plugin: "@openplans/plugin-slack",
      code: "plugin_setup_failed",
    });
    expect(lines.join("\n")).not.toContain("elsewhere");
    assertQuiet(lines);
  });

  it.each([
    ["plain HTTP", `http://${HOST}${HOOK_PATH}`],
    ["credentials", `https://user:pass@${HOST}${HOOK_PATH}`],
    ["not a URL", "slack"],
  ])("refuses a webhook URL with %s", async (_label, value) => {
    const { refusal } = await load({ env: { [URL_SECRET]: value } });
    expect(refusal).toMatchObject({ code: "plugin_setup_failed" });
  });

  it("refuses a missing URL", async () => {
    expect((await load({ env: {} })).refusal).toMatchObject({
      code: "plugin_secret_missing",
    });
  });

  it.each([
    [{ events: [] }],
    [{ events: ["cache.flushed"] }],
    [{ events: ["ingest.failed", "ingest.failed"] }],
    [{ minSeverity: "debug" }],
    [{ channel: "general" }],
  ])("refuses options %j", async (options) => {
    const { refusal } = await load({ options });
    expect(refusal).toMatchObject({ code: "plugin_options_invalid" });
  });

  it("declares hooks.slack.com unless OPENPLANS_SLACK_HOST names another host", () => {
    expect(DEFAULT_HOST).toBe("hooks.slack.com");
    expect(createSlackPlugin().manifest.capabilities).toEqual({
      network: ["hooks.slack.com"],
      secrets: [URL_SECRET],
    });
    expect(plugin.manifest.capabilities).toEqual({
      network: [HOST],
      secrets: [URL_SECRET],
    });
  });

  it("refuses a post to a host the plugin did not declare", async () => {
    const fetch = pluginFetch(plugin.manifest, fetchSettings(admitted));
    await expect(
      fetch.post!(`https://other.test${HOOK_PATH}`, {
        body: Buffer.from("{}"),
        contentType: "application/json",
      }),
    ).rejects.toMatchObject({ code: "host_not_allowed" });
    expect(received).toEqual([]);
  });

  it("throws when the host offers no post", async () => {
    const { registrations } = await loadForTest(plugin, {
      db,
      secrets: { [URL_SECRET]: URL_VALUE },
    });
    const handler = registrations.subscriptions[0]!.handler as (
      e: Event,
    ) => Promise<void>;
    await expect(handler(eventOf("release.deployed"))).rejects.toMatchObject({
      code: "slack_post_unavailable",
    });
  });
});

describe("planted mutants", () => {
  async function mutantPath(before: string, after: string) {
    const mutant = await plantMutant(
      new URL("../src/index.ts", import.meta.url),
      before,
      after,
    );
    const module = (await import(mutant.path)) as {
      createSlackPlugin: typeof createSlackPlugin;
    };
    expect(typeof module.createSlackPlugin).toBe("function");
    return mutant;
  }

  it("a logged URL fails the log check", async () => {
    hookStatus = 500;
    const mutant = await mutantPath(
      "code: failureCode(error),",
      "code: failureCode(error), detail: url,",
    );
    try {
      const { lines, subscribers } = await load({ packagePath: mutant.path });
      await expect(
        subscribers[0]!.handler(eventOf("release.deployed")),
      ).rejects.toThrow();
      expect(() => assertQuiet(lines)).toThrow();
    } finally {
      await mutant.cleanup();
    }
  });

  it("an event outside the settled set, once posted, fails the delivery check", async () => {
    const mutant = await mutantPath(
      '"health.changed": {',
      `"cache.flushed": {
        fields: ["reason"],
        severity: () => "info",
        text: (p) => \`Cache flushed: \${code(p.reason)}.\`,
        plural: "cache flushes",
      },
      "health.changed": {`,
    );
    try {
      const { subscribers } = await load({ packagePath: mutant.path });
      await deliverCatalog(subscribers);
      expect(postedTexts()).toContain("OpenPlans: Cache flushed: operator.");
      expect(() => assertOnlySettledPosts()).toThrow();
    } finally {
      await mutant.cleanup();
    }
  });

  /**
   * Two host guards stop a redirect: the redirect limit in fetchTransient and the one-request
   * budget of the per-post session. With both removed the Slack post follows the redirect,
   * which the redirect test catches.
   */
  it("a followed redirect fails the redirect check", async () => {
    hookStatus = 307;
    hookHeaders = { location: `https://${HOST}/services/elsewhere` };
    const transient = await plantMutant(
      new URL("../../../src/fetch/transient.ts", import.meta.url),
      "evidence.redirect_chain.length >= (options.maxRedirects ?? 5)",
      "evidence.redirect_chain.length >= 5",
    );
    const fetchModule = await plantMutant(
      new URL("../../../src/plugins/fetch.ts", import.meta.url),
      "maxRequests: 1",
      "maxRequests: 10",
    );
    try {
      vi.resetModules();
      vi.doMock(
        "../../../src/fetch/transient.js",
        () => import(transient.path),
      );
      const mutated = (await import(fetchModule.path)) as {
        pluginFetch: typeof pluginFetch;
      };
      const loaded = await loadForTest(plugin, {
        db,
        secrets: { [URL_SECRET]: URL_VALUE },
        fetch: mutated.pluginFetch(plugin.manifest, fetchSettings(admitted)),
      });
      const handler = loaded.registrations.subscriptions[0]!.handler as (
        e: Event,
      ) => Promise<void>;
      await handler(eventOf("release.deployed")).catch(() => {});
      // The redirect test's assertion, which the mutant must break.
      expect(() =>
        expect(received.map(({ path }) => path)).not.toContain(
          "/services/elsewhere",
        ),
      ).toThrow();
    } finally {
      vi.doUnmock("../../../src/fetch/transient.js");
      vi.resetModules();
      await transient.cleanup();
      await fetchModule.cleanup();
    }
  });
});
