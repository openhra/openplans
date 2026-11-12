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
import { loadPlugins } from "../../../src/plugins/index.js";
import { pluginToolDefinition } from "../../../src/plugins/mcp-tools.js";
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
  healthStateSchema,
  HISTORY_LIMIT,
  nextHealth,
  operatorStatusSchema,
  PLUGIN_NAME,
  publicStatusSchema,
  publicView,
  renderStatusHtml,
  runHealthProbe,
} from "../src/index.js";
import type { HealthState, StatusData } from "../src/index.js";
import type * as viewsModule from "../src/views.js";

// Seeds are relative to the real clock, because the default plugin reads the time itself.
const NOW = new Date(Math.floor(Date.now() / 60_000) * 60_000);
const OPERATOR = "synthetic-operator-secret";
const indexFile = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const viewsFile = fileURLToPath(new URL("../src/views.ts", import.meta.url));
const readFile = fileURLToPath(new URL("../src/read.ts", import.meta.url));
const shipped = fileURLToPath(
  new URL("../../../data/access/federal-publishers.json", import.meta.url),
);
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
        fetched_children, validation_state, activated_at, raw_path, requested_url) VALUES
      ('synthetic-fresh.1', 'synthetic-fresh', '${"a".repeat(64)}', '${hoursAgo(2)}', 0, 0,
        'ACTIVE', '${hoursAgo(2)}', '/srv/synthetic/raw/fresh', 'https://synthetic.invalid/a'),
      ('synthetic-old.1', 'synthetic-old', '${"b".repeat(64)}', '${hoursAgo(24 * 10)}', 0, 0,
        'ACTIVE', '${hoursAgo(24 * 10)}', '/srv/synthetic/raw/old', 'https://synthetic.invalid/b');
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
async function app(options: { operator?: string; file?: string } = {}) {
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
    const body = await first.json();
    expect(hasExactlyPublicFields(body)).toBe(true);
    expect(publicStatusSchema.parse(body)).toEqual(body);
    expect(body).toMatchObject({
      api: "ok",
      db: "ok",
      data: { states: 2, years: [2025, 2026] },
      sources: [
        { id: "synthetic-fresh", freshness: "<1d" },
        { id: "synthetic-old", freshness: "<30d" },
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
    expect(body.data.status_counts.catalog).toMatchObject({
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
    const body = await ok.json();
    expect(operatorStatusSchema.parse(body)).toEqual(body);
    const paths = keyPaths(body);
    for (const field of OPERATOR_ONLY) expect(paths).toContain(field);
    for (const field of PUBLIC_FIELDS.filter((f) => !f.startsWith("plugins")))
      expect(paths).toContain(field);
    expect(body.sources[0]).toEqual({
      id: "synthetic-fresh",
      freshness: "<1d",
      retrieved_at: hoursAgo(2),
      snapshot_id: "synthetic-fresh.1",
    });
    expect(body.worker.last_ingest[1].reason_codes).toEqual([
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
    const publicBody = await (await api.request("/status.json")).json();
    const operatorBody = await (
      await api.request("/status/operator.json", bearer(OPERATOR))
    ).json();
    expect(leaks(publicBody)).toEqual([]);
    expect(leaks(operatorBody)).toEqual([]);
    // The seeded command carried a path; the operator view keeps the event but not the path.
    const completed = operatorBody.events.recent.find(
      (event: { type: string }) => event.type === "ingest.completed",
    );
    expect(completed.payload.command).toEqual([
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
    expect(html).not.toMatch(/<script|<link|<img|src=|@import|https?:\/\//i);
    expect(html).toContain("synthetic-fresh");
    expect(html).not.toContain("synthetic-fresh.1");
    expect(html).not.toMatch(LOCATION);
    const operator = await (
      await api.request("/status/operator", bearer(OPERATOR))
    ).text();
    expect(operator).toContain("synthetic-fresh.1");
    expect(operator).toContain("Coverage by issuer");
    expect(operator).not.toMatch(/<script|<link|https?:\/\//i);
    expect(operator).not.toMatch(LOCATION);
  });

  it("escapes every value it prints", () => {
    const view = publicView(
      sample({
        sources: [{ id: "<b>x</b>", retrieved: null, snapshotId: "s" }],
      }),
    );
    const html = renderStatusHtml(view);
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>x</b>");
  });

  it("get_status returns the public JSON", async () => {
    // The core host's availability service, as the loader supplies it.
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
      const output = await tool.handler(
        {},
        { db, signal: AbortSignal.timeout(5000) },
      );
      expect(hasExactlyPublicFields(output)).toBe(true);
      expect("status" in (output as object)).toBe(false);
      // The kit app has no route wrapper, so compare with the real host's answer. The kit's
      // config turns the cache off and lists no plugins, and the kit has no core host;
      // everything else is the same read.
      const route = await (await (await app()).request("/status.json")).json();
      expect(output).toMatchObject({ cache: { enabled: false }, plugins: 0 });
      expect({
        ...(output as object),
        cache: route.cache,
        plugins: route.plugins,
        version: route.version,
        // Without a host, whether a loaded plugin serves a source is unknown.
        passthrough: (
          output as { passthrough: { enabled: boolean | null }[] }
        ).passthrough.map((row, i) => {
          expect([null, route.passthrough[i].enabled]).toContain(row.enabled);
          return { ...row, enabled: route.passthrough[i].enabled };
        }),
      }).toEqual(route);
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
      );
      expect(body.db).toBe("down");
      expect(body.sources).toBeNull();
      expect(body.data).toEqual({
        states: null,
        years: null,
        status_counts: null,
      });
      expect(publicStatusSchema.parse(body)).toEqual(body);
      expect(renderStatusHtml(body)).toContain("Sources could not be read.");
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
    sources: [{ id: "synthetic", retrieved: NOW, snapshotId: "synthetic.1" }],
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

  async function hostedApp(target: Database, file = indexFile) {
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
    const body = await response.json();
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
        version: "0.1.0",
        apiVersion: "0.1",
        sha256: sha,
        enabled: true,
      },
    ]);
    expect(identities(body.plugins)).toEqual(
      identities([{ name: PLUGIN_NAME, version: "0.1.0", sha256: sha! }]),
    );
    const pass = body.passthrough.find(
      (row: { id: string }) => row.id === "synthetic-pass",
    );
    expect(pass.hit_rate).toBe(0.5);
    // No loaded plugin serves synthetic-pass in this process.
    expect(pass.enabled).toBe(false);
    expect(leaks(body)).toEqual([]);
    resetPassThrough();
  });

  it("keeps the public view to the public fields when the host supplies everything", async () => {
    await countLookups();
    const api = await hostedApp(pooled());
    const body = await (await api.request("/status.json")).json();
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
    expect(html).not.toMatch(LOCATION);
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
      const body = await (await app.request(route.path)).json();
      expect(body.plugins).toEqual([
        {
          name: "local plugin",
          version: null,
          apiVersion: "0.1",
          sha256: null,
          enabled: true,
        },
      ]);
      expect(body.pool.waiting).toBeNull();
      expect(body.cache.hits).toBeNull();
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
      const body = JSON.parse(
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
      { name: PLUGIN_NAME, version: "0.1.0", sha256: sha },
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
      ).json();
      expect(body.plugins[0].sha256).toMatch(/^[a-f0-9]{64}$/);
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
    ).json();
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
      const body = await (await api.request("/status.json")).json();
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
      const body = JSON.parse(JSON.stringify(views.publicView(sample())));
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
