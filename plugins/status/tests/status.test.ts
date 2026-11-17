import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkerContext } from "@openplans/plugin-sdk";
import {
  PASSTHROUGH_OPENING_REASONS,
  pluginManifestSchema,
} from "@openplans/plugin-sdk";
import { createApp } from "../../../src/api/app.js";
import { hasCredentials } from "../../../src/api/cache/index.js";
import { MemoryCache } from "../../../src/api/cache/store.js";
import { loadConfig } from "../../../src/config/index.js";
import type { Database } from "../../../src/db/database.js";
import { migrate } from "../../../src/db/migrate.js";
import { rowProvenanceLeaks } from "../../../src/db/row-provenance.js";
import { MAX_OUTPUT_BYTES, messageBytes } from "../../../src/mcp/tools.js";
import { loadPlugins } from "../../../src/plugins/index.js";
import {
  callPluginTool,
  pluginToolDefinition,
} from "../../../src/plugins/mcp-tools.js";
import { packageSha256 } from "../../../src/plugins/package-hash.js";
import { hostAvailability } from "../../../src/plugins/status-host.js";
import {
  createPassThrough,
  resetPassThrough,
} from "../../../src/plugins/sources/passthrough.js";
import {
  checkEventPayloads,
  checkRouteResponses,
  EVENT_PAYLOAD_ALLOWED_NAMES,
  loadForTest,
  plantMutant,
} from "../../../src/plugins/testing/index.js";
import { loadWorkerPlugins } from "../../../src/plugins/worker.js";
import { runWorker } from "../../../src/worker/commands.js";
import { coreMigrations, testDatabase } from "../../../tests/pglite.js";
import plugin, {
  ageBucket,
  applicationVersion,
  createStatusPlugin,
  GET_STATUS_MAX_BYTES,
  getStatusInputSchema,
  getStatusSchema,
  getStatusView,
  healthStateSchema,
  HISTORY_LIMIT,
  nextHealth,
  operatorStatusSchema,
  operatorView,
  PLUGIN_NAME,
  publicStatusSchema,
  publicView,
  publisherDate,
  renderStatusHtml,
  runHealthProbe,
} from "../src/index.js";
import type {
  GetStatus,
  HealthState,
  OperatorStatus,
  PublicStatus,
  StatusData,
} from "../src/index.js";
import type * as mcpModule from "../src/mcp.js";
import type * as readModule from "../src/read.js";
import type * as viewsModule from "../src/views.js";

// Seeds are relative to the real clock, because the default plugin reads the time itself.
const NOW = new Date(Math.floor(Date.now() / 60_000) * 60_000);
const OPERATOR = "synthetic-operator-secret";
const indexFile = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const mcpFile = fileURLToPath(new URL("../src/mcp.ts", import.meta.url));
const viewsFile = fileURLToPath(new URL("../src/views.ts", import.meta.url));
const readFile = fileURLToPath(new URL("../src/read.ts", import.meta.url));
const shipped = fileURLToPath(
  new URL("../../../data/access/federal-publishers.json", import.meta.url),
);
// A synthetic Last-Modified header for the fresh source; the old source records none.
const SYNTHETIC_LAST_MODIFIED = "Fri, 30 Oct 2026 13:15:27 GMT";
const hoursAgo = (hours: number) =>
  new Date(NOW.getTime() - hours * 3_600_000).toISOString();

/** Every key path of a JSON value; array items share the `*` segment. */
function keyPaths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value))
    return [...new Set(value.flatMap((item) => keyPaths(item, `${prefix}*.`)))];
  if (value && typeof value === "object")
    return Object.entries(value).flatMap(([key, child]) => [
      `${prefix}${key}`,
      ...keyPaths(child, `${prefix}${key}.`),
    ]);
  return [];
}
function strings(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object")
    return Object.values(value).flatMap(strings);
  return typeof value === "string" ? [value] : [];
}

// Design 5.11, public column, as key paths. Arrays are seeded so their item keys appear.
const PUBLIC_FIELDS = [
  "version",
  "api",
  "db",
  "data",
  "data.states",
  "data.years",
  "data.status_counts",
  ...["catalog", "premium", "provider", "formulary"].flatMap((kind) => [
    `data.status_counts.${kind}`,
    ...[
      "not_yet_verified",
      "available",
      "partial",
      "unknown",
      "unavailable",
      "unsupported",
      "stale",
      "conflicted",
    ].map((status) => `data.status_counts.${kind}.${status}`),
  ]),
  "sources",
  "sources.*.id",
  "sources.*.freshness",
  "sources.*.published_at",
  "sources.*.published_from",
  "worker",
  "worker.last_ingest",
  "worker.last_ingest.*.source",
  "worker.last_ingest.*.last_success",
  "cache",
  "cache.enabled",
  "passthrough",
  "passthrough.*.id",
  "passthrough.*.enabled",
  "passthrough.*.budget",
  "passthrough.*.level",
  "plugins",
  "health_transitions",
  "health_transitions.last_change",
].sort();
const hasExactlyPublicFields = (body: unknown) =>
  JSON.stringify(keyPaths(body).sort()) === JSON.stringify(PUBLIC_FIELDS);

const OPERATOR_ONLY = [
  "pool",
  "data.issuers",
  "sources.*.retrieved_at",
  "sources.*.snapshot_id",
  "worker.last_ingest.*.last_success_at",
  "worker.last_ingest.*.reason_codes",
  "worker.last_ingest.*.durations_ms",
  "cache.backend",
  "cache.hits",
  "cache.bytes",
  "passthrough.*.daily_requests",
  "passthrough.*.max_daily_requests",
  "passthrough.*.blocked_until",
  "passthrough.*.hit_rate",
  "plugins.*.name",
  "plugins.*.sha256",
  "events.recent",
  "events.recent.*.payload",
  "health_transitions.history",
];

// The event payload scanner's names, applied to the JSON the routes serve.
const FORBIDDEN_NAME =
  /zip|age|income|tobacco|household|members|body|url|path|host|key|token|secret|password|connection/i;
const LOCATION =
  /\/(?:Users|Volumes|home|var|tmp|app|data|etc|srv)\/|:\/\/|localhost|127\.0\.0\.1|postgres|[a-z0-9._-]+@[a-z0-9-]+\.[a-z]/i;

// The header link home is the only URL a status page may carry.
const withoutHome = (html: string) =>
  html.replace('<nav><a href="https://plans.openhra.com/">', "<nav><a>");

function leaks(body: unknown): string[] {
  const names = keyPaths(body)
    .map((path) => path.split(".").at(-1)!)
    .filter((name) => FORBIDDEN_NAME.test(name))
    .filter((name) => !EVENT_PAYLOAD_ALLOWED_NAMES.has(name));
  const values = strings(body).filter((value) => LOCATION.test(value));
  return [
    ...names.map((name) => `name ${name}`),
    ...values.map((value) => `value ${value}`),
    ...rowProvenanceLeaks(body),
    ...(hasCredentials(body) ? ["credential-like key"] : []),
  ];
}

let db: Database;
let cleanup: () => Promise<void>;

async function seed(target: Database) {
  await target.exec(`
    INSERT INTO source (source_id, publisher, source_kind) VALUES
      ('synthetic-fresh', 'Synthetic publisher', 'synthetic'),
      ('synthetic-old', 'Synthetic publisher', 'synthetic');
    INSERT INTO snapshot (snapshot_id, source_id, sha256, retrieved_at, expected_children,
        fetched_children, validation_state, activated_at, raw_path, requested_url, last_modified) VALUES
      ('synthetic-fresh.1', 'synthetic-fresh', '${"a".repeat(64)}', '${hoursAgo(2)}', 0, 0,
        'ACTIVE', '${hoursAgo(2)}', '/srv/synthetic/raw/fresh', 'https://synthetic.invalid/a',
        '${SYNTHETIC_LAST_MODIFIED}'),
      ('synthetic-old.1', 'synthetic-old', '${"b".repeat(64)}', '${hoursAgo(24 * 10)}', 0, 0,
        'ACTIVE', '${hoursAgo(24 * 10)}', '/srv/synthetic/raw/old', 'https://synthetic.invalid/b',
        NULL);
    INSERT INTO data_availability (state, plan_year, market, issuer_id, catalog_status,
        premium_status, provider_status, formulary_status, snapshot_id) VALUES
      ('TX', 2026, 'individual', '11111', 'available', 'available', 'partial', 'unknown', 'synthetic-fresh.1'),
      ('TX', 2026, 'individual', NULL, 'available', 'partial', 'unknown', 'unknown', 'synthetic-fresh.1'),
      ('VT', 2025, 'individual', '22222', 'stale', 'unknown', 'unknown', 'unknown', 'synthetic-old.1');
    INSERT INTO plugin_event_outbox (event_id, event_type, idempotency_key, emitted_by, emitted_at, payload) VALUES
      ('00000000-0000-4000-8000-000000000001', 'ingest.completed', 'synthetic-1', 'core', '${hoursAgo(3)}',
        '{"sourceId":"synthetic-fresh","command":["ingest","puf","import","--dir","/srv/synthetic/raw"],"durationMs":1200,"snapshotIds":["synthetic-fresh.1"]}'),
      ('00000000-0000-4000-8000-000000000002', 'ingest.failed', 'synthetic-2', 'core', '${hoursAgo(1)}',
        '{"sourceId":"synthetic-old","command":["ingest","puf"],"reasonCode":"fetch_admission_denied"}');
    INSERT INTO passthrough_budget (source_id, max_daily_requests, daily_requests)
      VALUES ('synthetic-pass', 2, 2);
    INSERT INTO passthrough_attempt (source_id, kind, level, pairs, outcome)
      VALUES ('synthetic-pass', 'synthetic', 'memory', 1, 'answered');
    INSERT INTO plugin_state (plugin, key, value) VALUES ('${PLUGIN_NAME}', 'health',
      '{"components":{"db":{"state":"ok","since":"${hoursAgo(30)}"}},
        "history":[{"component":"db","from":"down","to":"ok","at":"${hoursAgo(30)}"}]}');
  `);
}

beforeAll(async () => {
  db = testDatabase(new PGlite());
  const core = await coreMigrations();
  cleanup = core.cleanup;
  await migrate(db, core.directory);
  await seed(db);
});
afterAll(async () => {
  await db.close();
  await cleanup();
});

const config = (operator?: string) =>
  loadConfig(operator ? { OPENPLANS_OPERATOR_TOKEN: operator } : {});

async function registries(
  file = indexFile,
  statusHost?: Parameters<typeof loadPlugins>[2] extends infer O
    ? O extends { statusHost?: infer H }
      ? H
      : never
    : never,
) {
  const lines: string[] = [];
  const loaded = await loadPlugins(
    loadConfig({}, { version: 1, plugins: [{ package: file }] }),
    "api",
    {
      env: {},
      statusHost,
      manifestPaths: [shipped],
      writeLog: (line) => lines.push(line),
      exit: (code) => {
        throw new Error(`exit ${code}: ${lines.join(" ")}`);
      },
    },
  );
  return loaded.registries;
}

/** The real host: route wrapper, response cache, core routes. Every JSON reply is column-checked. */
interface JsonResponse extends Response {
  json<T = unknown>(): Promise<T>;
}
interface JsonApp {
  request(
    input: string,
    init?: RequestInit,
  ): JsonResponse | Promise<JsonResponse>;
}

async function app(
  options: { operator?: string; file?: string } = {},
): Promise<JsonApp> {
  return checkRouteResponses(
    createApp(
      db,
      { premiumToken: undefined, trustedProxies: [] },
      {
        store: new MemoryCache(1024 * 1024),
        config: config(options.operator),
        plugins: await registries(options.file),
      },
    ),
  );
}

const bearer = (token: string) => ({
  headers: { Authorization: `Bearer ${token}` },
});

describe("@openplans/plugin-status", () => {
  it("has a valid manifest and loads on the api and worker hosts", async () => {
    expect(pluginManifestSchema.parse(plugin.manifest).name).toBe(PLUGIN_NAME);
    const loaded = await registries();
    expect(
      loaded.routes.map(({ spec }) => `${spec.method} ${spec.path}`),
    ).toEqual([
      "GET /status",
      "GET /status.json",
      "GET /status/operator",
      "GET /status/operator.json",
    ]);
    expect(
      loaded.routes.map(({ spec }) => [spec.exposure, spec.cache?.ttlSeconds]),
    ).toEqual([
      ["public", 30],
      ["public", 30],
      ["operator", undefined],
      ["operator", undefined],
    ]);
    const worker = await loadWorkerPlugins({
      env: { OPENPLANS_PLUGINS: indexFile },
      exit: (code) => {
        throw new Error(`exit ${code}`);
      },
    });
    expect(worker.schedules.map(({ spec }) => spec)).toEqual([
      {
        name: "health-probe",
        cron: "* * * * *",
        command: ["status-page", "health-probe"],
        maxRunMs: 30_000,
      },
    ]);
  });

  it("serves exactly the public fields at /status.json, cached for 30 seconds", async () => {
    const api = await app();
    const first = await api.request("/status.json");
    expect(first.status).toBe(200);
    expect(first.headers.get("x-cache")).toBe("miss");
    const body = await first.json<PublicStatus>();
    expect(hasExactlyPublicFields(body)).toBe(true);
    expect(publicStatusSchema.parse(body)).toEqual(body);
    expect(body).toMatchObject({
      api: "ok",
      db: "ok",
      data: { states: 2, years: [2025, 2026] },
      sources: [
        {
          id: "synthetic-fresh",
          freshness: "<1d",
          published_at: "2026-10-30",
          published_from: "last_modified",
        },
        {
          id: "synthetic-old",
          freshness: "<30d",
          published_at: null,
          published_from: null,
        },
      ],
      worker: {
        last_ingest: [
          { source: "synthetic-fresh", last_success: "<1d" },
          { source: "synthetic-old", last_success: "unknown" },
        ],
      },
      cache: { enabled: true },
      passthrough: [
        {
          id: "cms-marketplace-api",
          enabled: false,
          budget: "ok",
          level: "stored",
        },
        {
          // The core host knows no loaded plugin serves it.
          id: "synthetic-pass",
          enabled: false,
          budget: "exhausted",
          level: "memory",
        },
      ],
      plugins: 1,
      health_transitions: { last_change: "<7d" },
    });
    expect(body.data.status_counts!.catalog).toMatchObject({
      available: 2,
      stale: 1,
    });
    const second = await api.request("/status.json");
    expect(second.headers.get("x-cache")).toBe("hit");
    // A bearer header bypasses the cache but still gets only the public view.
    const withHeader = await api.request("/status.json", bearer(OPERATOR));
    expect(hasExactlyPublicFields(await withHeader.json())).toBe(true);
  });

  it("answers operator detail only with the operator token", async () => {
    const unset = await app();
    expect((await unset.request("/status/operator.json")).status).toBe(404);
    expect(
      (await unset.request("/status/operator.json", bearer(OPERATOR))).status,
    ).toBe(404);
    const api = await app({ operator: OPERATOR });
    const missing = await api.request("/status/operator.json");
    expect(missing.status).toBe(401);
    expect(await missing.text()).not.toContain("snapshot_id");
    expect(
      (await api.request("/status/operator.json", bearer("wrong"))).status,
    ).toBe(401);
    expect((await api.request("/status/operator")).status).toBe(401);
    const ok = await api.request("/status/operator.json", bearer(OPERATOR));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(ok.headers.get("x-cache")).toBe("bypass");
    const body = await ok.json<OperatorStatus>();
    expect(operatorStatusSchema.parse(body)).toEqual(body);
    const paths = keyPaths(body);
    for (const field of OPERATOR_ONLY) expect(paths).toContain(field);
    for (const field of PUBLIC_FIELDS.filter((f) => !f.startsWith("plugins")))
      expect(paths).toContain(field);
    expect(body.sources![0]).toEqual({
      id: "synthetic-fresh",
      freshness: "<1d",
      published_at: "2026-10-30",
      published_from: "last_modified",
      retrieved_at: hoursAgo(2),
      snapshot_id: "synthetic-fresh.1",
    });
    expect(body.worker.last_ingest![1]!.reason_codes).toEqual([
      "fetch_admission_denied",
    ]);
    expect(body.data.issuers).toHaveLength(3);
    expect(body.health_transitions.history).toHaveLength(1);
    // Host-only values are unknown here, never zero.
    expect(body.pool.waiting).toBeNull();
    expect(body.cache.hits).toBeNull();
  });

  it("never shows paths, hosts, mailboxes, row columns or credentials at either level", async () => {
    const api = await app({ operator: OPERATOR });
    const publicBody = await (
      await api.request("/status.json")
    ).json<PublicStatus>();
    const operatorBody = await (
      await api.request("/status/operator.json", bearer(OPERATOR))
    ).json<OperatorStatus>();
    expect(leaks(publicBody)).toEqual([]);
    expect(leaks(operatorBody)).toEqual([]);
    // The seeded command carried a path; the operator view keeps the event but not the path.
    const completed = operatorBody.events.recent!.find(
      (event: { type: string }) => event.type === "ingest.completed",
    );
    expect((completed!.payload as { command: string[] }).command).toEqual([
      "ingest",
      "puf",
      "import",
      "--dir",
      "<redacted>",
    ]);
    // The scanner is not blind: a planted path and a planted email are reported.
    expect(leaks({ ...publicBody, version: "/srv/x/y" })).toHaveLength(1);
    expect(
      leaks({
        ...publicBody,
        version: `ops${String.fromCharCode(64)}example.org`,
      }),
    ).toHaveLength(1);
    expect(leaks({ ...publicBody, host_name: "x" })).toHaveLength(1);
  });

  it("passes the kit's payload scanner for both views and the event catalog", () => {
    expect(
      checkEventPayloads({
        public: publicStatusSchema,
        operator: operatorStatusSchema,
        health: healthStateSchema,
      }),
    ).toEqual([]);
    expect(checkEventPayloads()).toEqual([]);
  });

  it("renders the HTML page in light and dark with no scripts or external files", async () => {
    const api = await app({ operator: OPERATOR });
    const response = await api.request("/status");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'",
    );
    const html = await response.text();
    expect(html).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
    );
    expect(html).toContain("color-scheme: light dark");
    expect(html).toMatch(
      /@media \(prefers-color-scheme: dark\) \{\s*:root \{ --bg: #121212; --fg: #ececec;/,
    );
    expect(html).toContain("--bg: #ffffff; --fg: #1a1a1a;");
    expect(html).toContain('<nav><a href="https://plans.openhra.com/">');
    expect(withoutHome(html)).not.toMatch(
      /<script|<link|<img|src=|@import|https?:\/\//i,
    );
    expect(html).toContain("<details><summary>synthetic-fresh <span");
    expect(html).toContain("synthetic-fresh");
    expect(html).not.toContain("synthetic-fresh.1");
    expect(withoutHome(html)).not.toMatch(LOCATION);
    const operator = await (
      await api.request("/status/operator", bearer(OPERATOR))
    ).text();
    expect(operator).toContain("synthetic-fresh.1");
    expect(operator).toContain("Coverage by issuer");
    expect(withoutHome(operator)).not.toMatch(/<script|<link|https?:\/\//i);
    expect(withoutHome(operator)).not.toMatch(LOCATION);
  });

  it("escapes every value it prints", () => {
    const view = publicView(
      sample({
        sources: [
          {
            id: "<b>x</b>",
            retrieved: null,
            snapshotId: "s",
            published: null,
            publishedFrom: null,
          },
        ],
      }),
    );
    const html = renderStatusHtml(view);
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>x</b>");
  });

  it("get_status keeps a useful summary and exposes paged public detail", async () => {
    const loaded = await loadForTest(
      createStatusPlugin({
        now: () => NOW,
        host: { dataAvailability: hostAvailability },
      }),
      { db },
    );
    try {
      const tool = loaded.registrations.mcpTools[0] as Parameters<
        typeof pluginToolDefinition
      >[0];
      expect(tool.name).toBe("get_status");
      expect(pluginToolDefinition(tool).annotations?.readOnlyHint).toBe(true);
      expect(tool.outputSchema).toBe(getStatusSchema);
      const output = getStatusSchema.parse(
        await tool.handler({}, { db, signal: AbortSignal.timeout(5000) }),
      );
      const route = await (
        await (await app()).request("/status.json")
      ).json<PublicStatus>();
      expect(hasExactlyPublicFields(route)).toBe(true);
      expect(output).toMatchObject({
        api: route.api,
        db: route.db,
        data: route.data,
        cache: { enabled: false },
        plugins: 0,
        section: "summary",
        details: null,
        page: null,
        truncated: false,
        sources: { total: route.sources!.length },
        worker: { total: route.worker.last_ingest!.length },
        passthrough: { total: route.passthrough!.length },
      });
      expect(JSON.stringify(output)).not.toContain("published_at");
      const detail = getStatusSchema.parse(
        await tool.handler(
          { section: "sources", offset: 1, limit: 1 },
          { db, signal: AbortSignal.timeout(5000) },
        ),
      );
      expect(detail.details).toEqual(
        route
          .sources!.slice(1, 2)
          .map(({ id, freshness, published_at, published_from }) => ({
            id,
            freshness,
            published_at,
            published_from,
          })),
      );
      expect(detail.page).toMatchObject({
        offset: 1,
        limit: 1,
        total: route.sources!.length,
        omitted: 0,
      });
    } finally {
      await loaded.close();
    }
  });

  it("without the host's availability service, coverage is unknown rather than the stored table", async () => {
    const loaded = await loadForTest(createStatusPlugin({ now: () => NOW }), {
      db,
    });
    try {
      const tool = loaded.registrations.mcpTools[0] as Parameters<
        typeof pluginToolDefinition
      >[0];
      const output = (await tool.handler(
        {},
        { db, signal: AbortSignal.timeout(5000) },
      )) as { data: unknown };
      expect(output.data).toEqual({
        states: null,
        years: null,
        status_counts: null,
      });
    } finally {
      await loaded.close();
    }
  });

  it("reports a down database without failing the page", async () => {
    const down = {
      query: async () => {
        throw new Error("synthetic outage");
      },
      exec: async () => {},
      transaction: async () => {
        throw new Error("synthetic outage");
      },
      close: async () => {},
    } as Database;
    const loaded = await loadForTest(createStatusPlugin({ now: () => NOW }), {
      db: down,
    });
    try {
      const tool = loaded.registrations.mcpTools[0] as Parameters<
        typeof pluginToolDefinition
      >[0];
      const body = JSON.parse(
        JSON.stringify(
          await tool.handler(
            {},
            { db: down, signal: AbortSignal.timeout(5000) },
          ),
        ),
      ) as GetStatus;
      expect(body.db).toBe("down");
      expect(body.sources).toBeNull();
      expect(body.data).toEqual({
        states: null,
        years: null,
        status_counts: null,
      });
      expect(getStatusSchema.parse(body)).toEqual(body);
      const rest = publicStatusSchema.parse(
        await (await loaded.app.request("/status.json")).json(),
      );
      expect(rest.db).toBe("down");
      expect(publicStatusSchema.parse(rest)).toEqual(rest);
      expect(renderStatusHtml(rest)).toContain("Sources could not be read.");
    } finally {
      await loaded.close();
    }
  });

  it("reads the application version from the core package.json", () => {
    const cli = fileURLToPath(
      new URL("../../../src/worker/cli.ts", import.meta.url),
    );
    expect(applicationVersion(cli)).toMatch(/^\d+\.\d+\.\d+/);
    expect(applicationVersion(indexFile)).toMatch(/^\d+\.\d+\.\d+/);
    expect(applicationVersion("/nonexistent/entry.js")).toBeUndefined();
  });

  it("buckets ages", () => {
    const at = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);
    expect(
      [1, 23, 24, 24 * 7 - 1, 24 * 7, 24 * 30, 24 * 400].map((h) =>
        ageBucket(at(h), NOW),
      ),
    ).toEqual(["<1d", "<1d", "<7d", "<7d", "<30d", "older", "older"]);
    expect(ageBucket(null, NOW)).toBe("unknown");
  });
});

function sample(overrides: Partial<StatusData> = {}): StatusData {
  return {
    now: NOW,
    version: "0.0.0",
    db: "ok",
    poolWaiting: null,
    availability: [],
    sources: [
      {
        id: "synthetic",
        retrieved: NOW,
        snapshotId: "synthetic.1",
        published: null,
        publishedFrom: null,
      },
    ],
    ingests: [
      {
        source: "synthetic",
        lastSuccess: NOW,
        reasonCodes: [],
        durationsMs: [],
      },
    ],
    cache: { enabled: true, backend: "memory", stats: null },
    passthrough: [
      {
        id: "synthetic-pass",
        enabled: true,
        level: "memory",
        exhausted: false,
        dailyRequests: 1,
        maxDailyRequests: 2,
        blockedUntil: null,
        hitRate: null,
      },
    ],
    plugins: [
      {
        name: "synthetic",
        version: null,
        apiVersion: null,
        sha256: null,
        enabled: true,
      },
    ],
    events: [],
    health: { lastChange: null, history: [] },
    ...overrides,
  };
}

describe("health-probe", () => {
  function fakeWorker(flaps: boolean[]) {
    const stored = new Map<string, unknown>();
    const emitted: { idempotencyKey: string; payload: unknown }[] = [];
    let tick = 0;
    const ctx: Pick<WorkerContext, "db" | "events" | "state" | "log"> = {
      db: {
        reader: {
          query: async <Row>(sql: string) => {
            if (sql === "SELECT 1" && !flaps[tick])
              throw new Error("synthetic outage");
            if (sql.includes("core:schedule:deliver-events"))
              return {
                rows: [
                  {
                    tick: new Date(NOW.getTime() + tick * 60_000).toISOString(),
                  },
                ] as Row[],
              };
            return { rows: [] as Row[] };
          },
          exec: async () => {},
        } as WorkerContext["db"]["reader"],
      },
      events: {
        on: () => {},
        emit: async (event) => {
          emitted.push({
            idempotencyKey: event.idempotencyKey,
            payload: event.payload,
          });
        },
      },
      state: {
        get: async (key) => structuredClone(stored.get(key)),
        set: async (key, value) => {
          stored.set(key, structuredClone(value));
        },
        delete: async (key) => {
          stored.delete(key);
        },
      },
      log: () => {},
    };
    const run = async () => {
      const code = await runHealthProbe(ctx, {
        now: () => new Date(NOW.getTime() + tick * 60_000),
      });
      tick++;
      return code;
    };
    return { run, emitted, stored };
  }

  it("emits once per transition across three ticks with a flapping database", async () => {
    const probe = fakeWorker([true, false, true, true]);
    expect([await probe.run(), await probe.run(), await probe.run()]).toEqual([
      0, 0, 0,
    ]);
    expect(probe.emitted.map((e) => e.payload)).toEqual([
      { component: "db", from: "ok", to: "down" },
      { component: "db", from: "down", to: "ok" },
    ]);
    // A fourth, steady tick emits nothing.
    await probe.run();
    expect(probe.emitted).toHaveLength(2);
    const state = healthStateSchema.parse(probe.stored.get("health"));
    expect(state.history.map((h) => h.to)).toEqual(["ok", "down"]);
    expect(state.components.worker?.state).toBe("ok");
  });

  it("repeats the idempotency key when the state write fails, so the outbox keeps one row", async () => {
    const previous: HealthState = {
      components: { db: { state: "ok", since: NOW.toISOString() } },
      history: [],
    };
    const first = nextHealth(previous, { db: "down" }, NOW);
    const retry = nextHealth(
      previous,
      { db: "down" },
      new Date(NOW.getTime() + 60_000),
    );
    expect(first.changes).toHaveLength(1);
    expect(retry.changes).toHaveLength(1);
    const keys: string[] = [];
    for (const time of [NOW, new Date(NOW.getTime() + 60_000)]) {
      await runHealthProbe(
        {
          db: {
            reader: {
              query: async (sql: string) => {
                if (sql === "SELECT 1") throw new Error("synthetic outage");
                return { rows: [] };
              },
              exec: async () => {},
            } as unknown as WorkerContext["db"]["reader"],
          },
          events: {
            on: () => {},
            emit: async (event) => {
              keys.push(event.idempotencyKey);
            },
          },
          state: {
            get: async () => previous,
            set: async () => {
              throw new Error("synthetic write failure");
            },
            delete: async () => {},
          },
          log: () => {},
        },
        { now: () => time },
      );
    }
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("keeps the last 50 transitions", () => {
    let state: HealthState | undefined;
    for (let i = 0; i < 60; i++)
      state = nextHealth(
        state,
        { db: i % 2 ? "down" : "ok" },
        new Date(NOW.getTime() + i * 60_000),
      ).state;
    expect(state!.history).toHaveLength(HISTORY_LIMIT);
  });

  it("runs through the worker: writes plugin_state and one health.changed row per transition", async () => {
    const target = testDatabase(new PGlite());
    const core = await coreMigrations();
    try {
      await migrate(target, core.directory);
      const plugins = await loadWorkerPlugins({
        env: { OPENPLANS_PLUGINS: indexFile },
        exit: (code) => {
          throw new Error(`exit ${code}`);
        },
      });
      const run = async () => {
        const err: string[] = [];
        const code = await runWorker(
          ["status-page", "health-probe"],
          () => ({ ...target, close: async () => {} }),
          { out: () => {}, error: (line) => err.push(line) },
          undefined,
          plugins.commands,
          { subscriptions: plugins.subscriptions },
        );
        return { code, err };
      };
      // No deliver-events tick yet: worker is down. Then the scheduler ticks: worker is ok.
      expect((await run()).code).toBe(0);
      await target.query(
        `INSERT INTO plugin_state (plugin, key, value)
         VALUES ('openplans', 'core:schedule:deliver-events', jsonb_build_object('tick', now()::text))`,
      );
      const second = await run();
      expect(second.code).toBe(0);
      expect(second.err.join("\n")).not.toMatch(LOCATION);
      await run();
      const { rows: outbox } = await target.query<{
        event_type: string;
        payload: unknown;
      }>(
        "SELECT event_type, payload FROM plugin_event_outbox WHERE event_type = 'health.changed'",
      );
      expect(outbox).toEqual([
        {
          event_type: "health.changed",
          payload: { component: "worker", from: "down", to: "ok" },
        },
      ]);
      const { rows: state } = await target.query<{
        plugin: string;
        key: string;
      }>("SELECT plugin, key FROM plugin_state WHERE key = 'health'");
      expect(state).toEqual([{ plugin: PLUGIN_NAME, key: "health" }]);
    } finally {
      await target.close();
      await core.cleanup();
    }
  });
});

describe("host data from core", () => {
  const statusRoot = fileURLToPath(new URL("..", import.meta.url));
  const coreVersion = (
    JSON.parse(
      readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as { version: string }
  ).version;
  const reason = PASSTHROUGH_OPENING_REASONS[0]!;

  /** The API database with a pool that reports waits; createApp's cache is keyed by it. */
  const pooled = (): Database => ({ ...db, poolWaiting: () => 2 });

  async function hostedApp(
    target: Database,
    file = indexFile,
  ): Promise<JsonApp> {
    return checkRouteResponses(
      createApp(
        target,
        { premiumToken: undefined, trustedProxies: [] },
        {
          store: new MemoryCache(1024 * 1024),
          config: config(OPERATOR),
          plugins: await registries(file, { database: target }),
        },
      ),
    );
  }

  /** One memory-level lookup for synthetic-pass: one of two questions is kept. */
  async function countLookups() {
    resetPassThrough();
    const store = new MemoryCache(1024 * 1024);
    await store.set(
      "openplans:passthrough:v1:synthetic-pass:synthetic:P1|A|2026",
      JSON.stringify({ outcome: "answered", answer: {}, negative: false }),
      60,
    );
    const source = {
      id: "synthetic-pass",
      kind: "passthrough",
      kinds: ["synthetic"],
      cache: { level: "memory" },
      eligibility: { openingReasons: [reason], accepts: () => true },
      question: (_kind: string, answer: { code: string }) => ({
        planId: "P1",
        identity: answer.code,
        year: 2026,
      }),
      manifest: { accessMode: "open" },
    };
    await createPassThrough({
      sources: () => [source as never],
      cacheStore: store,
    }).apply(
      "synthetic",
      ["A", "B"].map((code) => ({ status: "unknown", reason, code })),
      { reader: db } as never,
    );
  }

  /** The release audit's comparison: name, version and package hash, in any order. */
  const identities = (
    entries: { name: string; version: string | null; sha256: string | null }[],
  ) =>
    entries
      .map(({ name, version, sha256 }) => [name, version, sha256].join(" "))
      .sort();

  it("fills the operator view with pool waits, cache counters, plugin hashes, hit rate and the core version", async () => {
    await countLookups();
    const target = pooled();
    const api = await hostedApp(target);
    await api.request("/status.json");
    await api.request("/status.json");
    const response = await api.request(
      "/status/operator.json",
      bearer(OPERATOR),
    );
    expect(response.status).toBe(200);
    const body = await response.json<OperatorStatus>();
    expect(operatorStatusSchema.parse(body)).toEqual(body);
    expect(body.version).toBe(coreVersion);
    expect(body.pool).toEqual({ waiting: 2 });
    expect(body.cache).toMatchObject({
      enabled: true,
      backend: "memory",
      hits: 1,
      misses: 1,
    });
    expect(body.cache.bypasses).toBeGreaterThanOrEqual(1);
    expect(typeof body.cache.bytes).toBe("number");
    const sha = await packageSha256(statusRoot);
    expect(sha).toMatch(/^[a-f0-9]{64}$/);
    expect(body.plugins).toEqual([
      {
        name: PLUGIN_NAME,
        version: "0.1.7",
        apiVersion: "0.1",
        sha256: sha,
        enabled: true,
      },
    ]);
    expect(identities(body.plugins)).toEqual(
      identities([{ name: PLUGIN_NAME, version: "0.1.7", sha256: sha! }]),
    );
    const pass = body.passthrough!.find(
      (row: { id: string }) => row.id === "synthetic-pass",
    );
    expect(pass!.hit_rate).toBe(0.5);
    // No loaded plugin serves synthetic-pass in this process.
    expect(pass!.enabled).toBe(false);
    expect(leaks(body)).toEqual([]);
    resetPassThrough();
  });

  it("keeps the public view to the public fields when the host supplies everything", async () => {
    await countLookups();
    const api = await hostedApp(pooled());
    const body = await (await api.request("/status.json")).json<PublicStatus>();
    expect(hasExactlyPublicFields(body)).toBe(true);
    expect(body).toMatchObject({ version: coreVersion, plugins: 1 });
    expect(leaks(body)).toEqual([]);
    const text = JSON.stringify(body);
    const sha = (await packageSha256(statusRoot))!;
    expect(text).not.toContain(sha);
    expect(text).not.toContain(PLUGIN_NAME);
    expect(text).not.toContain("hit_rate");
    const html = await (await api.request("/status")).text();
    expect(html).not.toContain(sha);
    expect(withoutHome(html)).not.toMatch(LOCATION);
    resetPassThrough();
  });

  it("drops host plugin values that could carry a location or a malformed hash", async () => {
    const loaded = await loadForTest(
      createStatusPlugin({
        now: () => NOW,
        host: {
          plugins: () => [
            {
              name: "/srv/synthetic/plugin",
              version: "1.0.0 /srv",
              apiVersion: "0.1",
              sha256: "not-a-hash",
              enabled: true,
            },
          ],
          poolWaiting: () => -1,
          cacheStats: () => ({ hits: 1.5, misses: 0, bypasses: 0, bytes: 0 }),
        },
      }),
      { db },
    );
    try {
      const route = loaded.registrations.routes.find(
        (spec) => spec.path === "/status/operator.json",
      )!;
      const { Hono } = await import("hono");
      const app = new Hono();
      app.use("*", async (c, next) => {
        c.set("pluginDb" as never, db as never);
        await next();
      });
      app.get(route.path, route.handler as never);
      const body: unknown = await (await app.request(route.path)).json();
      expect((body as OperatorStatus).plugins).toEqual([
        {
          name: "local plugin",
          version: null,
          apiVersion: "0.1",
          sha256: null,
          enabled: true,
        },
      ]);
      expect((body as OperatorStatus).pool.waiting).toBeNull();
      expect((body as OperatorStatus).cache.hits).toBeNull();
      expect(leaks(body)).toEqual([]);
    } finally {
      await loaded.close();
    }
  });

  it("planted mutant: pool waits copied into the public serialiser fail the public-fields test", async () => {
    const mutant = await plantMutant(
      viewsFile,
      "cache: { enabled: status.cache.enabled },",
      "cache: { enabled: status.cache.enabled }, pool: { waiting: status.poolWaiting },",
    );
    try {
      const views = (await import(mutant.path)) as typeof viewsModule;
      const body: unknown = JSON.parse(
        JSON.stringify(views.publicView(sample({ poolWaiting: 2 }))),
      );
      expect(hasExactlyPublicFields(body)).toBe(false);
      expect(views.publicStatusSchema.safeParse(body).success).toBe(false);
    } finally {
      await mutant.cleanup();
    }
  });

  it("planted mutant: a wrong plugin hash fails the approved-list comparison", async () => {
    const sha = (await packageSha256(statusRoot))!;
    const approved = identities([
      { name: PLUGIN_NAME, version: "0.1.7", sha256: sha },
    ]);
    const read = await plantMutant(
      readFile,
      "sha256: entry.sha256 && SHA256.test(entry.sha256) ? entry.sha256 : null,",
      'sha256: entry.sha256 && SHA256.test(entry.sha256) ? entry.sha256.replace(/^./, (c) => (c === "0" ? "1" : "0")) : null,',
    );
    const index = await plantMutant(
      indexFile,
      'import { readStatus } from "./read.js";',
      `import { readStatus } from ${JSON.stringify(read.path)};`,
    );
    try {
      const api = await hostedApp(pooled(), index.path);
      const body = await (
        await api.request("/status/operator.json", bearer(OPERATOR))
      ).json<OperatorStatus>();
      expect(body.plugins[0]!.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(identities(body.plugins)).not.toEqual(approved);
    } finally {
      await index.cleanup();
      await read.cleanup();
    }
    // The real module matches the approved list.
    const body = await (
      await (
        await hostedApp(pooled())
      ).request("/status/operator.json", bearer(OPERATOR))
    ).json<OperatorStatus>();
    expect(identities(body.plugins)).toEqual(approved);
  });
});

describe("planted mutants", () => {
  it("the operator serialiser on the public route fails the public-fields test", async () => {
    const mutant = await plantMutant(
      indexFile,
      'c.json(publicView(await read(c.get("pluginDb"))))',
      'c.json(operatorView(await read(c.get("pluginDb"))))',
    );
    try {
      const api = createApp(
        db,
        { premiumToken: undefined, trustedProxies: [] },
        {
          store: new MemoryCache(1024 * 1024),
          config: config(),
          plugins: await registries(mutant.path),
        },
      );
      const body: unknown = await (await api.request("/status.json")).json();
      expect(hasExactlyPublicFields(body)).toBe(false);
      expect(keyPaths(body)).toContain("sources.*.snapshot_id");
    } finally {
      await mutant.cleanup();
    }
    // The real module passes the same check.
    const real = await (await (await app()).request("/status.json")).json();
    expect(hasExactlyPublicFields(real)).toBe(true);
  });

  it("an operator field copied into the public serialiser fails the public-fields test", async () => {
    const mutant = await plantMutant(
      viewsFile,
      "cache: { enabled: status.cache.enabled },",
      "cache: { enabled: status.cache.enabled, backend: status.cache.backend },",
    );
    try {
      const views = (await import(mutant.path)) as typeof viewsModule;
      const body: unknown = JSON.parse(
        JSON.stringify(views.publicView(sample())),
      );
      expect(hasExactlyPublicFields(body)).toBe(false);
      expect(views.publicStatusSchema.safeParse(body).success).toBe(false);
    } finally {
      await mutant.cleanup();
    }
    expect(
      hasExactlyPublicFields(JSON.parse(JSON.stringify(publicView(sample())))),
    ).toBe(true);
  });

  it("an operator route declared public fails the token test", async () => {
    const mutant = await plantMutant(
      indexFile,
      'path: "/status/operator.json", exposure: "operator",',
      'path: "/status/operator.json", exposure: "public",',
    );
    try {
      const api = createApp(
        db,
        { premiumToken: undefined, trustedProxies: [] },
        {
          store: new MemoryCache(1024 * 1024),
          config: config(OPERATOR),
          plugins: await registries(mutant.path),
        },
      );
      const response = await api.request("/status/operator.json");
      expect(response.status).toBe(200);
      expect(keyPaths(await response.json())).toContain("data.issuers");
    } finally {
      await mutant.cleanup();
    }
  });
});

// The public fields /status.json served before publisher dates, frozen. New fields may be added;
// none of these may go or change meaning.
const PUBLIC_FIELDS_0_1_3_BEFORE_DATES = PUBLIC_FIELDS.filter(
  (field) => !field.startsWith("sources.*.published_"),
);
const PUBLISHED_FIELDS = ["sources.*.published_at", "sources.*.published_from"];

/** No publisher date may come from anything but the publisher's own records. */
function guessesNothing(date: typeof publisherDate): boolean {
  const none = {
    publisher_date: null,
    last_modified: null,
    retrieved_date: "2026-11-14",
    schema_version: null,
  };
  return [
    none,
    { ...none, last_modified: "not a date" },
    // A Medicare release snapshot imported before the fix, with no dated file name and no
    // Last-Modified header, holds the retrieval date as its release date. Those rows stay.
    {
      ...none,
      publisher_date: "2026-11-14",
      schema_version: "cms-medicare-pbp",
    },
  ].every((row) => {
    const result = date(row);
    return result.published === null && result.publishedFrom === null;
  });
}

describe("publisher dates", () => {
  const SNAPSHOTS = ["synthetic-release.1", "synthetic-standin.1"];
  async function withDatedSnapshots<T>(run: () => Promise<T>): Promise<T> {
    // A dated release with a Last-Modified too, and a Medicare release whose stored date is
    // only the retrieval date.
    await db.exec(`
      INSERT INTO source (source_id, publisher, source_kind) VALUES
        ('synthetic-release', 'Synthetic publisher', 'synthetic'),
        ('synthetic-standin', 'Synthetic publisher', 'synthetic');
      INSERT INTO snapshot (snapshot_id, source_id, sha256, retrieved_at, expected_children,
          fetched_children, validation_state, activated_at, publisher_updated_at, last_modified,
          schema_version) VALUES
        ('${SNAPSHOTS[0]}', 'synthetic-release', '${"c".repeat(64)}', '${hoursAgo(5)}', 0, 0,
          'ACTIVE', '${hoursAgo(5)}', '2026-09-01', 'Tue, 12 Aug 2025 13:22:12 GMT',
          'cms-medicare-landscape'),
        ('${SNAPSHOTS[1]}', 'synthetic-standin', '${"d".repeat(64)}', '2026-11-14T15:00:00Z', 0, 0,
          'ACTIVE', '2026-11-14T15:00:00Z', '2026-11-14', NULL, 'cms-medicare-pbp');`);
    try {
      return await run();
    } finally {
      await db.exec(`
        DELETE FROM snapshot WHERE snapshot_id IN ('${SNAPSHOTS.join("','")}');
        DELETE FROM source WHERE source_id IN ('synthetic-release', 'synthetic-standin');`);
    }
  }

  it("reads unknown when the import recorded no publisher date, never a guess", async () => {
    expect(guessesNothing(publisherDate)).toBe(true);
    const body = await (
      await (await app()).request("/status.json")
    ).json<PublicStatus>();
    expect(body.sources!.find((s) => s.id === "synthetic-old")).toEqual({
      id: "synthetic-old",
      freshness: "<30d",
      published_at: null,
      published_from: null,
    });
    const html = renderStatusHtml(body);
    expect(html).toContain(
      '<tr><td class="token">synthetic-old</td><td>under 30 days ago</td><td class="token date">unknown</td></tr>',
    );
    expect(html).toContain(
      "1 snapshot, retrieved under 30 days ago; publisher date unknown",
    );
    const standIn = await withDatedSnapshots(async () =>
      (
        await (await (await app()).request("/status.json")).json<PublicStatus>()
      ).sources!.find((s) => s.id === "synthetic-standin"),
    );
    expect(standIn).toMatchObject({ published_at: null, published_from: null });
  });

  it("shows the recorded release date first, then the Last-Modified date", async () => {
    expect(
      publisherDate({
        publisher_date: "2026-09-01",
        last_modified: "Tue, 12 Aug 2025 13:22:12 GMT",
        retrieved_date: "2026-11-14",
        schema_version: "rxnorm-rrf",
      }),
    ).toEqual({ published: "2026-09-01", publishedFrom: "release_date" });
    // Last-Modified is read in UTC.
    expect(
      publisherDate({
        publisher_date: null,
        last_modified: "Sat, 31 Oct 2026 23:30:00 -0500",
        retrieved_date: "2026-11-14",
        schema_version: null,
      }),
    ).toEqual({ published: "2026-11-01", publishedFrom: "last_modified" });
    const api = await app({ operator: OPERATOR });
    const [body, operator] = await withDatedSnapshots(async () => [
      await (await api.request("/status.json")).json<PublicStatus>(),
      await (
        await api.request("/status/operator.json", bearer(OPERATOR))
      ).json<OperatorStatus>(),
    ]);
    expect(publicStatusSchema.parse(body)).toEqual(body);
    expect(body.sources!.find((s) => s.id === "synthetic-release")).toEqual({
      id: "synthetic-release",
      freshness: "<1d",
      published_at: "2026-09-01",
      published_from: "release_date",
    });
    expect(
      operator.sources!.find((s) => s.id === "synthetic-release"),
    ).toMatchObject({ published_at: "2026-09-01", retrieved_at: hoursAgo(5) });
    const html = renderStatusHtml(operator);
    expect(html).toContain(
      `<td class="token">${hoursAgo(5)}</td><td class="token date">2026-09-01</td>`,
    );
    expect(html).toContain(
      "Published is the publisher&#39;s own date for that copy",
    );
  });

  it("only adds fields: every earlier field keeps its name and meaning", async () => {
    const api = await app({ operator: OPERATOR });
    const body = await (await api.request("/status.json")).json<PublicStatus>();
    const paths = keyPaths(body);
    expect(
      paths.filter((p) => !PUBLIC_FIELDS_0_1_3_BEFORE_DATES.includes(p)).sort(),
    ).toEqual(PUBLISHED_FIELDS);
    for (const field of PUBLIC_FIELDS_0_1_3_BEFORE_DATES)
      expect(paths).toContain(field);
    const operator = await (
      await api.request("/status/operator.json", bearer(OPERATOR))
    ).json<OperatorStatus>();
    for (const field of ["id", "freshness", "retrieved_at", "snapshot_id"])
      expect(Object.keys(operator.sources![0]!)).toContain(field);
    // freshness is still the retrieval age: an old publisher date does not age a fresh copy.
    const view = publicView(
      sample({
        sources: [
          {
            id: "synthetic",
            retrieved: NOW,
            snapshotId: "synthetic.1",
            published: "2019-01-01",
            publishedFrom: "release_date",
          },
        ],
      }),
    );
    expect(view.sources![0]!.freshness).toBe("<1d");
    expect(operatorView(sample()).sources![0]!.freshness).toBe("<1d");
  });

  it("planted mutant: falling back to the retrieval date is caught", async () => {
    const mutant = await plantMutant(
      readFile,
      "return { published: null, publishedFrom: null };",
      'return { published: row.retrieved_date, publishedFrom: "release_date" };',
    );
    try {
      const read = (await import(mutant.path)) as typeof readModule;
      expect(guessesNothing(read.publisherDate)).toBe(false);
    } finally {
      await mutant.cleanup();
    }
  });

  it("planted mutant: ignoring the Medicare stand-in date is caught", async () => {
    const mutant = await plantMutant(readFile, "&& !standIn)", ")");
    try {
      const read = (await import(mutant.path)) as typeof readModule;
      expect(guessesNothing(read.publisherDate)).toBe(false);
    } finally {
      await mutant.cleanup();
    }
  });

  it("planted mutant: freshness taken from the publisher date is caught", async () => {
    const mutant = await plantMutant(
      viewsFile,
      `freshness: ageBucket(source.retrieved, status.now),
        published_at: source.published,
        published_from: source.publishedFrom,
      })) ?? null,`,
      `freshness: ageBucket(source.published ? new Date(source.published) : null, status.now),
        published_at: source.published,
        published_from: source.publishedFrom,
      })) ?? null,`,
    );
    try {
      const views = (await import(mutant.path)) as typeof viewsModule;
      const view = views.publicView(
        sample({
          sources: [
            {
              id: "synthetic",
              retrieved: NOW,
              snapshotId: "synthetic.1",
              published: "2019-01-01",
              publishedFrom: "release_date",
            },
          ],
        }),
      );
      expect(view.sources![0]!.freshness).not.toBe("<1d");
    } finally {
      await mutant.cleanup();
    }
  });
});

// A synthetic catalog shaped like the hosted service's in November 2026: 777 sources in 16
// families. Exchange files for 30 states and 3 plan years and state-exchange files for 19 states,
// each a bundle ID plus six file IDs, and 14 single sources. Most carry a Last-Modified date, a
// few a release date and the rest none. The IDs follow the real naming; the dates are synthetic.
const EXCHANGE_STATES =
  "AK AL AR AZ DE FL GA HI IA IN KS LA MI MO MS MT NC ND NE NH OH OK OR SC SD TN TX UT WI WY".split(
    " ",
  );
const STATE_EXCHANGE_STATES =
  "CA CO CT DC ID IL KY MA MD ME MN NJ NM NV NY PA RI VT WA".split(" ");
const FILE_KINDS = [
  "",
  ":benefits-and-cost-sharing",
  ":business-rules",
  ":network",
  ":plan-attributes",
  ":rate",
  ":service-area",
];
const SINGLE_SOURCES = [
  "census-county-outlines-2024",
  "census-geocoder-batch",
  "census-zcta-county-2020",
  "census-zcta-gazetteer-2021",
  "cms-marketplace-api",
  "cms-medicare-landscape",
  "cms-medicare-service-area",
  "cms-nppes",
  "cms-partd-spuf-monthly",
  "cms-partd-spuf-quarterly",
  "cms-rating-areas",
  "openplans-rating-rules-2025",
  "openplans-rating-rules-2026",
  "openplans-rating-rules-2027",
];

function hostedSizeStatus(): StatusData {
  const ids = [
    ...SINGLE_SOURCES,
    ...[2025, 2026, 2027].flatMap((year) =>
      EXCHANGE_STATES.flatMap((state) =>
        FILE_KINDS.map((kind) => `cms-exchange-puf:${year}:${state}${kind}`),
      ),
    ),
    ...STATE_EXCHANGE_STATES.flatMap((state) =>
      FILE_KINDS.map((kind) => `cms_sbe_puf:2026:${state}${kind}`),
    ),
  ];
  return sample({
    version: "0.4.9",
    sources: ids.map((id, i) => {
      const dated = i % 7 !== 0;
      const from = i < 5 ? "release_date" : "last_modified";
      return {
        id,
        retrieved: new Date(NOW.getTime() - (i % 2 ? 3 : 12) * 86_400_000),
        snapshotId: `${id}.1`,
        published: dated
          ? `2025-${String((i % 12) + 1).padStart(2, "0")}-12`
          : null,
        publishedFrom: dated ? from : null,
      };
    }),
  });
}

/** The bytes the MCP host counts against MAX_OUTPUT_BYTES for this answer. */
const answerBytes = (output: unknown) =>
  messageBytes(output as Parameters<typeof messageBytes>[0]);
// Synthetic stress catalog: every source family and file kind in all 56 jurisdictions,
// with one import and pass-through row per source and coverage rollups across 100 years.
function worstCaseStatus(): StatusData {
  const jurisdictions =
    "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY AS GU MP PR VI".split(
      " ",
    );
  const source = hostedSizeStatus().sources![0]!;
  const sources = jurisdictions.flatMap((state) =>
    [2025, 2026, 2027].flatMap((year) =>
      [
        ...SINGLE_SOURCES,
        ...FILE_KINDS.map((kind) => `cms-exchange-puf${kind}`),
      ].map((family) => ({
        ...source,
        id: `${family}:${year}:${state}`,
      })),
    ),
  );
  return sample({
    sources,
    ingests: sources.map(({ id }) => ({
      source: id,
      lastSuccess: NOW,
      reasonCodes: [],
      durationsMs: [],
    })),
    passthrough: sources.map(({ id }) => ({
      ...sample().passthrough![0]!,
      id,
    })),
    availability: jurisdictions.flatMap((state) =>
      Array.from({ length: 100 }, (_, i) => ({
        state,
        year: 2000 + i,
        market: "synthetic",
        issuer_id: null,
        catalog: "available" as const,
        premium: "partial" as const,
        provider: "unknown" as const,
        formulary: "unknown" as const,
        snapshot_id: null,
      })),
    ),
  });
}

function statusTool(status: StatusData) {
  return {
    name: "get_status",
    title: "Service status",
    description: "synthetic",
    inputSchema: getStatusInputSchema,
    outputSchema: getStatusSchema,
    readOnly: true as const,
    handler: async (args: unknown) =>
      getStatusView(status, getStatusInputSchema.parse(args)),
  };
}

async function callStatus(status: StatusData, args = {}) {
  return callPluginTool(
    { db },
    statusTool(status),
    args,
    AbortSignal.timeout(5000),
  );
}

describe("bounded get_status", () => {
  it("summarizes the hosted catalog in under 64 KiB", async () => {
    const status = hostedSizeStatus();
    const output = getStatusSchema.parse(getStatusView(status));
    expect(output.sources!.total).toBe(777);
    expect(
      output.sources!.freshness["<7d"] + output.sources!.freshness["<30d"],
    ).toBe(777);
    expect(output.details).toBeNull();
    expect(output.truncated).toBe(false);
    expect(answerBytes(output)).toBeLessThan(GET_STATUS_MAX_BYTES);
    const result = await callStatus(status);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual(output);
  });

  it("all 56 jurisdictions with every source and growing rollups stay under 64 KiB", async () => {
    const status = worstCaseStatus();
    expect(new Set(status.availability!.map((row) => row.state)).size).toBe(56);
    expect(status.sources!.length).toBeGreaterThan(3000);
    for (const section of [
      "summary",
      "sources",
      "worker",
      "passthrough",
    ] as const) {
      const output = getStatusSchema.parse(
        getStatusView(status, { section, limit: 100 }),
      );
      expect(output.data.states).toBe(56);
      expect(output.sources!.total).toBe(status.sources!.length);
      expect(output.worker!.total).toBe(status.ingests!.length);
      expect(output.data.years).toHaveLength(20);
      expect(output.truncated).toBe(true);
      expect(output.data.status_counts!.catalog.available).toBe(5600);
      if (section === "summary") expect(output.details).toBeNull();
      if (section === "sources") {
        expect(output.details!.every((row) => "published_at" in row)).toBe(
          true,
        );
        expect(
          output.details!.every(
            (row) =>
              "published_at" in row &&
              (!row.published_at ||
                (row.published_at.length === 10 &&
                  row.published_from !== null)),
          ),
        ).toBe(true);
      }
      expect(answerBytes(output)).toBeLessThan(GET_STATUS_MAX_BYTES);
      const result = await callStatus(status, { section, limit: 100 });
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual(output);
    }
  });

  it("pages every detail section without losing or repeating rows", () => {
    const status = hostedSizeStatus();
    status.ingests = status.sources!.map(({ id }) => ({
      ...sample().ingests![0]!,
      source: id,
    }));
    status.passthrough = status.sources!.map(({ id }) => ({
      ...sample().passthrough![0]!,
      id,
    }));
    for (const section of ["sources", "worker", "passthrough"] as const) {
      const seen: string[] = [];
      let offset: number | null = 0;
      while (offset !== null) {
        const output: GetStatus = getStatusView(status, {
          section,
          offset,
          limit: 100,
        });
        expect(getStatusSchema.safeParse(output).success).toBe(true);
        expect(output.truncated).toBe(false);
        expect(output.page!.omitted).toBe(0);
        expect(answerBytes(output)).toBeLessThan(GET_STATUS_MAX_BYTES);
        seen.push(
          ...output.details!.map((row) =>
            "source" in row ? row.source : row.id,
          ),
        );
        offset = output.page!.next_offset;
      }
      expect(seen).toEqual(status.sources!.map((row) => row.id));
    }
    expect(
      getStatusView(status, { section: "sources", offset: 10000 }).page!
        .next_offset,
    ).toBeNull();
  });

  it("unknown reads stay unknown and empty reads stay empty", () => {
    const unknown = getStatusView(
      sample({
        availability: null,
        sources: null,
        ingests: null,
        passthrough: null,
        db: "down",
      }),
      { section: "sources" },
    );
    expect(unknown).toMatchObject({
      db: "down",
      sources: null,
      worker: null,
      passthrough: null,
      page: { total: null },
      truncated: false,
    });
    const empty = getStatusView(
      sample({ sources: [], ingests: [], passthrough: [] }),
      { section: "worker" },
    );
    expect(empty).toMatchObject({
      sources: { total: 0 },
      worker: { total: 0 },
      passthrough: { total: 0 },
      details: [],
      page: { total: 0, next_offset: null },
    });
    expect(getStatusSchema.safeParse(unknown).success).toBe(true);
    expect(getStatusSchema.safeParse(empty).success).toBe(true);
  });

  it("rejects invalid inputs and uses bounded defaults", async () => {
    expect(getStatusInputSchema.parse({})).toEqual({
      section: "summary",
      offset: 0,
      limit: 50,
    });
    for (const args of [
      { section: "operator" },
      { offset: -1 },
      { offset: 0.5 },
      { limit: 0 },
      { limit: 101 },
      { state: "TX" },
    ]) {
      const result = await callStatus(sample(), args);
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error?.code).toBe("INVALID_INPUT");
    }
  });

  it("omits oversized Unicode and escaped IDs without returning a size error", async () => {
    const status = sample({ version: "🩺".repeat(100000) });
    const hugeId = '"\\\n🩺'.repeat(10000);
    status.sources = [
      { ...status.sources![0]!, id: hugeId },
      { ...status.sources![0]!, id: "synthetic-small" },
    ];
    status.ingests = [
      { ...status.ingests![0]!, source: hugeId },
      { ...status.ingests![0]!, source: "synthetic-small" },
    ];
    status.passthrough = [
      { ...status.passthrough![0]!, id: hugeId },
      { ...status.passthrough![0]!, id: "synthetic-small" },
    ];
    for (const section of [
      "summary",
      "sources",
      "worker",
      "passthrough",
    ] as const) {
      const result = await callStatus(status, { section, limit: 1 });
      expect(result.isError).toBeUndefined();
      const output = getStatusSchema.parse(result.structuredContent);
      expect(answerBytes(output)).toBeLessThan(GET_STATUS_MAX_BYTES);
      expect(output.truncated).toBe(true);
      if (section !== "summary") {
        expect(output.details).toEqual([]);
        expect(output.page).toMatchObject({ omitted: 1, next_offset: 1 });
        const next = getStatusView(status, { section, offset: 1 });
        expect(next.details).toHaveLength(1);
        expect(next.page!.next_offset).toBeNull();
      }
    }
  });

  it("the byte guard bounds a full page of medium escaped IDs", () => {
    const status = sample();
    status.sources = Array.from({ length: 100 }, (_, i) => ({
      ...status.sources![0]!,
      id: `${i}${'"\\\n🩺'.repeat(100)}`,
    }));
    const output = getStatusView(status, { section: "sources", limit: 100 });
    expect(output.details!.length).toBeGreaterThan(0);
    expect(output.page!.omitted).toBeGreaterThan(0);
    expect(output.details!.length + output.page!.omitted).toBe(100);
    expect(output.truncated).toBe(true);
    expect(answerBytes(output)).toBeLessThan(GET_STATUS_MAX_BYTES);
  });

  it("/status.json keeps its complete public fields and publisher dates", () => {
    const view = publicView(hostedSizeStatus());
    expect(hasExactlyPublicFields(JSON.parse(JSON.stringify(view)))).toBe(true);
    expect(view.sources!.filter((s) => s.published_at).length).toBeGreaterThan(
      600,
    );
    expect(answerBytes(view)).toBeGreaterThan(MAX_OUTPUT_BYTES);
  });

  it("planted mutant: disabling the byte guard fails the 64 KiB bound", async () => {
    const mutant = await plantMutant(
      mcpFile,
      "if (resultBytes(view) >= GET_STATUS_MAX_BYTES)",
      "if (false)",
    );
    try {
      const mcp = (await import(mutant.path)) as typeof mcpModule;
      const status = sample();
      status.sources = [
        { ...status.sources![0]!, id: "synthetic".repeat(20000) },
      ];
      const output = mcp.getStatusView(status, { section: "sources" });
      expect(answerBytes(output) < GET_STATUS_MAX_BYTES).toBe(false);
      expect(output.truncated).toBe(false);
      const tool = { ...statusTool(status), handler: async () => output };
      const result = await callPluginTool(
        { db },
        tool,
        {},
        AbortSignal.timeout(5000),
      );
      expect(result.structuredContent.error?.code).toBe("RESULT_TOO_LARGE");
    } finally {
      await mutant.cleanup();
    }
  });
});
