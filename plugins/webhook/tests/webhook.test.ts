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
import type { Event, EventInput } from "@openplans/plugin-sdk";
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
  checkEventPayloads,
  loadForTest,
  plantMutant,
} from "../../../src/plugins/testing/index.js";
import { deliverEvents } from "../../../src/worker/deliver-events.js";
import type { DurableSubscriber } from "../../../src/worker/deliver-events.js";
import { coreMigrations, testDatabase } from "../../../tests/pglite.js";

// The default export reads the receiver host when it is first imported.
vi.hoisted(() => {
  process.env.OPENPLANS_WEBHOOK_HOST = "receiver.test";
});
// Pacing has its own tests. Collection GETs here need no wall-clock waits; deliveries must
// never take a lease at all.
vi.mock("../../../src/fetch/limiter.js", () => ({
  leaseHost: vi.fn(async () => async () => {}),
}));
import { leaseHost } from "../../../src/fetch/limiter.js";
import { fetchTransient } from "../../../src/fetch/transient.js";
import { AdmissionSession } from "../../../src/fetch/admission.js";

import plugin, {
  createWebhookPlugin,
  EVENT_ID_HEADER,
  HMAC_SECRET,
  signBody,
  SIGNATURE_HEADER,
  URL_SECRET,
  verifySignature,
  webhookBody,
  WebhookError,
} from "../src/index.js";

// Every host, secret, policy and event here is synthetic. The receiver runs on loopback; the
// injected transport carries requests for https://receiver.test to it.
const HOST = "receiver.test";
const SECRET = "synthetic-webhook-secret-0123456789abcdef";
const HOOK_PATH = "/hooks/openplans-7f3a";
const URL_VALUE = `https://${HOST}${HOOK_PATH}`;
const robots = "User-agent: *\nAllow: /\n";
const terms = "Synthetic receiver accepts signed event posts.";
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
let hang: boolean;
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
    permittedPaths: ["/hooks"],
    delegates: [],
    attribution: "Synthetic receiver",
    updatePolicy: "Operator review",
    delayMs: 5000,
    jobCaps: { maxRequests: 200, maxTransferBytes: 1024 ** 2 },
    robots: {
      url: `https://${HOST}/robots.txt`,
      status: 200,
      sha256: digest(robots),
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
      if (path === "/robots.txt") return void outgoing.end(robots);
      if (path === "/terms") return void outgoing.end(terms);
      if (path === HOOK_PATH) {
        if (hang) return;
        outgoing.writeHead(hookStatus, hookHeaders);
        return void outgoing.end();
      }
      outgoing.writeHead(path.startsWith("/hooks") ? 204 : 404);
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
  hookStatus = 204;
  hookHeaders = {};
  hang = false;
  directory = await mkdtemp(join(tmpdir(), "openplans-synthetic-webhook-"));
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
  options: {
    packagePath?: string;
    manifest?: string;
    events?: unknown;
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
          package: options.packagePath ?? indexPath,
          options: { events: options.events ?? ["readiness.failed"] },
        },
      ],
    },
  );
  const manifest = options.manifest ?? admitted;
  try {
    const loaded = await loadPlugins(config, "worker", {
      env: options.env ?? { [URL_SECRET]: URL_VALUE, [HMAC_SECRET]: SECRET },
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

const event: Event<"readiness.failed"> = {
  id: "5d1c3a8e-8a52-4f39-9c1f-3f2b0f0d6a11",
  type: "readiness.failed",
  emittedAt: "2026-11-11T00:00:00.000Z",
  emittedBy: "worker",
  idempotencyKey: "synthetic-readiness-1",
  payload: { check: "bootstrap.migrate", reasonCode: "exit_1" },
};

const posts = () => received.filter(({ method }) => method === "POST");

/** What a receiver checks: method, headers, signature and the unchanged catalog payload. */
function assertSignedDelivery(post: Received | undefined, sent: Event) {
  expect(post).toBeDefined();
  expect(post!.path).toBe(HOOK_PATH);
  expect(post!.headers["content-type"]).toBe("application/json");
  expect(post!.headers[EVENT_ID_HEADER]).toBe(sent.id);
  const signature = post!.headers[SIGNATURE_HEADER];
  expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
  expect(verifySignature(SECRET, post!.body, signature as string)).toBe(true);
  const body = JSON.parse(post!.body.toString("utf8")) as Event;
  expect(body).toEqual(sent);
  const schema = eventPayloadSchemas[body.type];
  expect(schema.strict().parse(body.payload)).toEqual(sent.payload);
  expect(checkEventPayloads({ [body.type]: schema })).toEqual([]);
}

/** Nothing the plugin or the host logged may carry the URL, its path or the secret. */
function assertQuiet(lines: readonly string[]) {
  const text = lines.join("\n");
  for (const value of [SECRET, URL_VALUE, HOOK_PATH])
    expect(text).not.toContain(value);
}

const readinessInput: EventInput = {
  type: "readiness.failed",
  idempotencyKey: "synthetic-delivery-1",
  payload: { check: "bootstrap.migrate", reasonCode: "exit_1" },
};

async function emitAndDeliver(
  subscribers: DurableSubscriber[],
  input: EventInput = readinessInput,
) {
  const logs: string[] = [];
  const log = (entry: Record<string, unknown>) =>
    logs.push(JSON.stringify(entry));
  // The first run records the subscriber's install time; later events reach it.
  await deliverEvents(db, subscribers, { log });
  const bus = createEventBus({ db, log });
  await bus.registry({ kind: "core", name: "worker" }).emit(input);
  const report = await deliverEvents(db, subscribers, { log });
  const { rows } = await db.query<{
    attempts: number;
    delivered_at: unknown;
    last_error_code: string | null;
  }>(
    "SELECT attempts, delivered_at, last_error_code FROM plugin_event_delivery",
  );
  const { rows: outbox } = await db.query<Record<string, unknown>>(
    `SELECT event_id AS id, event_type AS type, emitted_by AS "emittedBy",
            idempotency_key AS "idempotencyKey", payload, emitted_at
       FROM plugin_event_outbox`,
  );
  return { report, rows, outbox, logs };
}

describe("signature", () => {
  it("matches the documented test vector", () => {
    // Also in the README; `openssl dgst -sha256 -hmac` gives the same hex.
    const body = Buffer.from(
      '{"id":"00000000-0000-4000-8000-000000000001","type":"readiness.failed",' +
        '"emittedAt":"2026-01-01T00:00:00.000Z","emittedBy":"worker",' +
        '"idempotencyKey":"test-vector-1","payload":{"check":"bootstrap.migrate","reasonCode":"exit_1"}}',
    );
    const secret = "openplans-webhook-test-vector-secret";
    const expected =
      "sha256=f520254edfab39c7a21486788f69e668a5b79215d096bf27a6f1cbc63a53d7b5";
    expect(signBody(secret, body)).toBe(expected);
    expect(verifySignature(secret, body, expected)).toBe(true);
    expect(
      webhookBody({
        id: "00000000-0000-4000-8000-000000000001",
        type: "readiness.failed",
        emittedAt: "2026-01-01T00:00:00.000Z",
        emittedBy: "worker",
        idempotencyKey: "test-vector-1",
        payload: { check: "bootstrap.migrate", reasonCode: "exit_1" },
      }).equals(body),
    ).toBe(true);
  });

  it("rejects a changed body, another secret, a missing or malformed header", () => {
    const body = webhookBody(event);
    const header = signBody(SECRET, body);
    expect(verifySignature(SECRET, body, header)).toBe(true);
    expect(verifySignature(SECRET, Buffer.from(`${body} `), header)).toBe(
      false,
    );
    expect(verifySignature(`${SECRET}x`, body, header)).toBe(false);
    expect(verifySignature(SECRET, body, undefined)).toBe(false);
    expect(verifySignature(SECRET, body, header.toUpperCase())).toBe(false);
    expect(verifySignature(SECRET, body, header.slice(7))).toBe(false);
  });
});

describe("delivery to a loopback receiver", () => {
  it("posts the outbox event as signed JSON and marks it delivered", async () => {
    const { lines, subscribers, refusal } = await load();
    expect(refusal).toBeUndefined();
    expect(subscribers).toHaveLength(1);
    expect(subscribers[0]).toMatchObject({
      plugin: "@openplans/plugin-webhook",
      type: "readiness.failed",
      subscriber: "webhook",
    });
    const { report, rows, outbox, logs } = await emitAndDeliver(subscribers);
    expect(report).toMatchObject({ delivered: 1, retried: 0 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ attempts: 1, last_error_code: null });
    expect(rows[0]!.delivered_at).not.toBeNull();
    const row = outbox[0]!;
    const stored = {
      id: row.id,
      type: row.type,
      emittedAt: new Date(row.emitted_at as string).toISOString(),
      emittedBy: row.emittedBy,
      idempotencyKey: row.idempotencyKey,
      payload: row.payload,
    } as Event;
    // A delivery is one POST: no robots or terms read, no pacing lease.
    expect(received.map(({ method, path }) => `${method} ${path}`)).toEqual([
      `POST ${HOOK_PATH}`,
    ]);
    expect(leaseHost).not.toHaveBeenCalled();
    assertSignedDelivery(posts()[0], stored);
    assertQuiet([...lines, ...logs]);
  });

  it("posts a rollback event unchanged when the operator lists it", async () => {
    const { subscribers, refusal } = await load({
      events: ["release.rolled_back"],
    });
    expect(refusal).toBeUndefined();
    expect(subscribers.map(({ type }) => type)).toEqual([
      "release.rolled_back",
    ]);
    const { report, outbox } = await emitAndDeliver(subscribers, {
      type: "release.rolled_back",
      idempotencyKey: "synthetic-rollback-1",
      payload: {
        version: "1.3.2",
        imageId: "sha256:" + "a".repeat(64),
        fromVersion: "1.4.0",
      },
    });
    expect(report).toMatchObject({ delivered: 1, retried: 0 });
    const row = outbox[0]!;
    assertSignedDelivery(posts()[0], {
      id: row.id,
      type: row.type,
      emittedAt: new Date(row.emitted_at as string).toISOString(),
      emittedBy: row.emittedBy,
      idempotencyKey: row.idempotencyKey,
      payload: row.payload,
    } as Event);
  });

  it("never requests robots or terms, and takes no pacing lease, across posts", async () => {
    const { subscribers } = await load();
    await subscribers[0]!.handler(event);
    await subscribers[0]!.handler({ ...event, id: event.id.replace("a", "b") });
    expect(received.map(({ method, path }) => `${method} ${path}`)).toEqual([
      `POST ${HOOK_PATH}`,
      `POST ${HOOK_PATH}`,
    ]);
    expect(leaseHost).not.toHaveBeenCalled();
  });

  it("throws on HTTP 500, so the outbox schedules a retry", async () => {
    hookStatus = 500;
    const { lines, subscribers } = await load();
    await expect(subscribers[0]!.handler(event)).rejects.toBeInstanceOf(
      WebhookError,
    );
    const { report, rows, logs } = await emitAndDeliver(subscribers);
    expect(report).toMatchObject({ delivered: 0, retried: 1 });
    expect(rows[0]).toMatchObject({
      attempts: 1,
      delivered_at: null,
      last_error_code: "handler_failed",
    });
    // One attempt per delivery: the outbox owns retries.
    expect(posts()).toHaveLength(2);
    const failures = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.event === "webhook_failed");
    expect(failures[0]).toEqual({
      event: "webhook_failed",
      event_type: "readiness.failed",
      code: "http_status",
      status: 500,
      plugin: "@openplans/plugin-webhook",
    });
    assertQuiet([...lines, ...logs]);
  });

  it.each([301, 302, 307, 308])(
    "refuses to follow a %s redirect",
    async (status) => {
      hookStatus = status;
      hookHeaders = { location: `https://${HOST}/hooks/elsewhere` };
      const { lines, subscribers } = await load();
      await expect(subscribers[0]!.handler(event)).rejects.toBeInstanceOf(
        WebhookError,
      );
      expect(received.map(({ path }) => path)).not.toContain(
        "/hooks/elsewhere",
      );
      expect(posts()).toHaveLength(1);
      expect(JSON.parse(lines.at(-1)!)).toMatchObject({
        code: "too_many_redirects",
      });
      assertQuiet(lines);
    },
  );

  it("gives up on a receiver that does not answer within 5 s", async () => {
    const { lines, subscribers } = await load();
    hang = true;
    const started = Date.now();
    await expect(subscribers[0]!.handler(event)).rejects.toBeInstanceOf(
      WebhookError,
    );
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(4_500);
    expect(elapsed).toBeLessThan(8_000);
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ code: "read_timeout" });
  });
});

describe("load-time refusals", () => {
  it.each([
    ["unknown", () => unknownHost, "unknown"],
    ["not allowed", () => heldHost, "terms-restricted"],
  ])(
    "refuses the plugin when the receiver host is %s in the manifest",
    async (_label, manifest, reason) => {
      const { subscribers, refusal, lines } = await load({
        manifest: manifest(),
      });
      expect(subscribers).toEqual([]);
      expect(refusal).toEqual({
        plugin: "@openplans/plugin-webhook",
        code: "plugin_network_host_not_allowed",
        reason,
      });
      expect(received).toEqual([]);
      assertQuiet(lines);
    },
  );

  it("refuses a URL whose host is not the declared host, without logging it", async () => {
    const other = `https://elsewhere.test${HOOK_PATH}`;
    const { refusal, lines } = await load({
      env: { [URL_SECRET]: other, [HMAC_SECRET]: SECRET },
    });
    expect(refusal).toEqual({
      plugin: "@openplans/plugin-webhook",
      code: "plugin_setup_failed",
    });
    expect(lines.join("\n")).not.toContain("elsewhere");
    assertQuiet(lines);
  });

  it.each([
    ["plain HTTP", `http://${HOST}${HOOK_PATH}`],
    ["credentials", `https://user:pass@${HOST}${HOOK_PATH}`],
    ["not a URL", "receiver"],
  ])("refuses a receiver URL with %s", async (_label, value) => {
    const { refusal } = await load({
      env: { [URL_SECRET]: value, [HMAC_SECRET]: SECRET },
    });
    expect(refusal).toMatchObject({ code: "plugin_setup_failed" });
  });

  it("refuses a missing or short secret", async () => {
    expect(
      (await load({ env: { [URL_SECRET]: URL_VALUE } })).refusal,
    ).toMatchObject({ code: "plugin_secret_missing" });
    expect(
      (
        await load({
          env: { [URL_SECRET]: URL_VALUE, [HMAC_SECRET]: "short" },
        })
      ).refusal,
    ).toMatchObject({ code: "plugin_setup_failed" });
  });

  it.each([[[]], [["no.such_event"]], [["ingest.failed", "ingest.failed"]]])(
    "refuses events option %j",
    async (events) => {
      const { refusal } = await load({ events });
      expect(refusal).toMatchObject({ code: "plugin_options_invalid" });
    },
  );

  it("declares no network host when none is configured, and then refuses setup", async () => {
    const bare = createWebhookPlugin();
    expect(bare.manifest.capabilities?.network).toEqual([]);
    expect(plugin.manifest.capabilities).toEqual({
      network: [HOST],
      secrets: [URL_SECRET, HMAC_SECRET],
    });
    await expect(
      loadForTest(bare, {
        options: { events: ["readiness.failed"] },
        secrets: { [URL_SECRET]: URL_VALUE, [HMAC_SECRET]: SECRET },
      }),
    ).rejects.toMatchObject({ code: "webhook_url_invalid" });
  });
});

/** An ordinary admitted GET to the same host: the collection path. */
function collectionGet(fetch: typeof fetchTransient = fetchTransient) {
  return fetch(`https://${HOST}/hooks/feed`, {
    admission: new AdmissionSession([admitted]),
    allowHosts: [HOST],
    dataDir: join(directory, "data"),
    maxAttempts: 1,
    ...fetchSettings(admitted).testing,
  });
}
const paths = () => received.map(({ method, path }) => `${method} ${path}`);

describe("host fetch", () => {
  it("still reads robots and terms, under a pacing lease, for an ordinary GET", async () => {
    await collectionGet();
    expect(paths()).toEqual([
      "GET /robots.txt",
      "GET /terms",
      "GET /hooks/feed",
    ]);
    expect(leaseHost).toHaveBeenCalled();
  });

  it("refuses a delivery whose host is no longer allowed, before any request", async () => {
    const fetch = pluginFetch(plugin.manifest, fetchSettings(heldHost));
    await expect(
      fetch.post!(URL_VALUE, {
        body: Buffer.from("{}"),
        contentType: "application/json",
      }),
    ).rejects.toMatchObject({ code: "admission_denied" });
    expect(received).toEqual([]);
  });

  it.each([
    ["without a body", { requestBody: undefined }],
    ["with redirects", { maxRedirects: 1 }],
    ["with retries", { maxAttempts: 2 }],
    ["without a deadline", { deadlineMs: undefined }],
    ["with a deadline over 5 s", { deadlineMs: 5_001 }],
  ])("refuses a delivery %s", async (_label, change) => {
    await expect(
      fetchTransient(URL_VALUE, {
        purpose: "delivery",
        admission: new AdmissionSession([admitted]),
        allowHosts: [HOST],
        dataDir: join(directory, "data"),
        maxRedirects: 0,
        maxAttempts: 1,
        deadlineMs: 5_000,
        requestBody: {
          contentType: "application/json",
          body: Buffer.from("{}"),
        },
        ...fetchSettings(admitted).testing,
        ...change,
      }),
    ).rejects.toMatchObject({ code: "invalid_options" });
    expect(received).toEqual([]);
  });

  it("refuses a header outside x-openplans-*", async () => {
    const fetch = pluginFetch(plugin.manifest, fetchSettings(admitted));
    await expect(
      fetch.post!(URL_VALUE, {
        body: Buffer.from("{}"),
        contentType: "application/json",
        headers: { authorization: "synthetic" },
      }),
    ).rejects.toMatchObject({ code: "invalid_options" });
    expect(received).toEqual([]);
  });

  it("refuses a host the plugin did not declare", async () => {
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
    const { subscriptions } = (
      await loadForTest(plugin, {
        options: { events: ["readiness.failed"] },
        secrets: { [URL_SECRET]: URL_VALUE, [HMAC_SECRET]: SECRET },
      })
    ).registrations;
    const handler = subscriptions[0]!.handler as (e: Event) => Promise<void>;
    await expect(handler(event)).rejects.toMatchObject({
      code: "webhook_post_unavailable",
    });
  });
});

describe("planted mutants", () => {
  async function mutantPlugin(before: string, after: string) {
    const mutant = await plantMutant(
      new URL("../src/index.ts", import.meta.url),
      before,
      after,
    );
    const module = (await import(mutant.path)) as {
      createWebhookPlugin: typeof createWebhookPlugin;
    };
    expect(typeof module.createWebhookPlugin).toBe("function");
    return { mutant, path: mutant.path };
  }

  it("an unsigned post fails the signature check", async () => {
    const { mutant, path } = await mutantPlugin(
      "[SIGNATURE_HEADER]: signBody(secret, body),",
      "",
    );
    try {
      const { subscribers } = await load({ packagePath: path });
      await subscribers[0]!.handler(event);
      expect(() => assertSignedDelivery(posts()[0], event)).toThrow();
    } finally {
      await mutant.cleanup();
    }
  });

  it("a logged secret fails the log check", async () => {
    hookStatus = 500;
    const { mutant, path } = await mutantPlugin(
      "code: failureCode(error),",
      "code: failureCode(error), detail: secret,",
    );
    try {
      const { lines, subscribers } = await load({ packagePath: path });
      await expect(subscribers[0]!.handler(event)).rejects.toThrow();
      expect(() => assertQuiet(lines)).toThrow();
    } finally {
      await mutant.cleanup();
    }
  });

  it("a GET that skips robots fails the collection check", async () => {
    const mutant = await plantMutant(
      new URL("../../../src/fetch/transient.ts", import.meta.url),
      'const delivery = options.purpose === "delivery";',
      "const delivery = true;",
    );
    try {
      const module = (await import(mutant.path)) as {
        fetchTransient: typeof fetchTransient;
      };
      await collectionGet(module.fetchTransient);
      // The collection test's assertion, which the mutant must break.
      expect(() =>
        expect(paths()).toEqual([
          "GET /robots.txt",
          "GET /terms",
          "GET /hooks/feed",
        ]),
      ).toThrow();
      expect(paths()).toEqual(["GET /hooks/feed"]);
    } finally {
      await mutant.cleanup();
    }
  });

  /**
   * Two guards stop a delivery redirect: the redirect limit in fetchTransient and the one-request
   * budget of the per-post session. Each alone must still refuse; with both removed the redirect
   * is followed, which the redirect test would catch.
   */
  async function redirectOutcome(guards: { limit: boolean; budget: boolean }) {
    hookStatus = 307;
    hookHeaders = { location: `https://${HOST}/hooks/elsewhere` };
    const transient = guards.limit
      ? undefined
      : await plantMutant(
          new URL("../../../src/fetch/transient.ts", import.meta.url),
          "evidence.redirect_chain.length >= (options.maxRedirects ?? 5)",
          "evidence.redirect_chain.length >= 5",
        );
    const fetchModule = guards.budget
      ? undefined
      : await plantMutant(
          new URL("../../../src/plugins/fetch.ts", import.meta.url),
          "maxRequests: 1",
          "maxRequests: 10",
        );
    try {
      vi.resetModules();
      if (transient)
        vi.doMock(
          "../../../src/fetch/transient.js",
          () => import(transient.path),
        );
      const mutated = (await import(
        fetchModule?.path ?? "../../../src/plugins/fetch.js"
      )) as { pluginFetch: typeof pluginFetch };
      const fetch = mutated.pluginFetch(
        plugin.manifest,
        fetchSettings(admitted),
      );
      const body = webhookBody(event);
      return await fetch.post!(URL_VALUE, {
        body,
        contentType: "application/json",
        headers: { [SIGNATURE_HEADER]: signBody(SECRET, body) },
      }).then(
        () => "followed",
        () => "refused",
      );
    } finally {
      vi.doUnmock("../../../src/fetch/transient.js");
      vi.resetModules();
      await transient?.cleanup();
      await fetchModule?.cleanup();
    }
  }

  it("each redirect guard alone still refuses", async () => {
    expect(await redirectOutcome({ limit: false, budget: true })).toBe(
      "refused",
    );
    expect(await redirectOutcome({ limit: true, budget: false })).toBe(
      "refused",
    );
    expect(received.map(({ path }) => path)).not.toContain("/hooks/elsewhere");
  });

  it("a followed redirect fails the redirect check", async () => {
    expect(await redirectOutcome({ limit: false, budget: false })).toBe(
      "followed",
    );
    expect(received.map(({ path }) => path)).toContain("/hooks/elsewhere");
  });
});
