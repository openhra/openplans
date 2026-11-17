import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Hono } from "hono";
import { createResponseCache } from "../../src/api/cache/index.js";
import { createApp } from "../../src/api/app.js";
import type { SqlSession } from "../../src/db/database.js";
import {
  censusRows,
  ichraAffordabilityBatch,
} from "../../src/services/ichra-batch.js";
import { connect } from "../mcp/client.js";
import { configDependencies } from "../../src/mcp/policy.js";
import { loadConfig } from "../../src/config/index.js";
import { useRecorder, createRecorder } from "../../src/telemetry/observer.js";
import { setup, TOKEN } from "../compat/v1/helpers.js";

// SYNTHETIC employees and operator settings over an unmodified cached CMS rate cut.
const employee = (extra = {}) => ({
  plan_start: "2026-01-01",
  employee: { date_of_birth: "1985-10-01" },
  residence: { zip: "77002" },
  hra: { self_only_annual_cents: 312_789 },
  income: [{ measure: "household", annual_cents: 4_118_923 }],
  ...extra,
});
const rows = (inputs: unknown[]) => ({
  rows: inputs.map((input, index) => ({ row: index + 1, input })),
});
interface TestBatch {
  selection_universe: string;
  rows: {
    status: string;
    result: unknown;
    error?: { code: string; field: string };
  }[];
  counts: {
    submitted: number;
    calculated: number;
    unknown: number;
    invalid: number;
  };
}
const path = "/v1/ichra/affordability/batch";
let h: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => {
  await h?.close();
});
afterEach(() => {
  vi.restoreAllMocks();
  useRecorder(undefined);
});
const appFor = (db = h.db, options = {}) =>
  createApp(db, {
    premiumToken: TOKEN,
    tpa: { enabled: true, privateIngress: true },
    ...options,
  });
async function send(
  app: ReturnType<typeof createApp>,
  payload: unknown,
  auth: string | undefined = `Bearer ${TOKEN}`,
  route = path,
  signal?: AbortSignal,
) {
  return app.request(route, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(auth ? { authorization: auth } : {}),
    },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
    signal,
  });
}
function exact(actual: unknown, expected: unknown) {
  expect(JSON.stringify(actual), "canonical employee answer bytes").toBe(
    JSON.stringify(expected),
  );
}
function noValues(text: string) {
  for (const value of [
    "1985-10-01",
    "4118923",
    "312789",
    "synthetic-census-secret",
    "77002",
  ])
    expect(text).not.toContain(value);
}

describe("private census access", () => {
  it("is default-off, requires private ingress and a configured credential even with household access open", async () => {
    expect(loadConfig({}).tpa).toEqual({
      enabled: false,
      privateIngress: false,
    });
    for (const [options, status] of [
      [{ tpa: { enabled: false, privateIngress: true } }, 404],
      [{ tpa: { enabled: true, privateIngress: false } }, 503],
      [{ premiumToken: undefined, publicHousehold: true }, 503],
    ] as const) {
      const response = await send(appFor(h.db, options), rows([employee()]));
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    const app = appFor();
    for (const auth of [undefined, "Bearer wrong-synthetic-token"]) {
      const response = await send(app, rows([employee()]), auth ?? "");
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });
  it("accepts the typed file config and the explicit on switches", () => {
    expect(
      loadConfig({ OPENPLANS_TPA: "on", OPENPLANS_TPA_PRIVATE_INGRESS: "on" })
        .tpa,
    ).toEqual({ enabled: true, privateIngress: true });
    expect(
      loadConfig(
        {},
        { version: 1, tpa: { enabled: true, privateIngress: true } },
      ).tpa.enabled,
    ).toBe(true);
  });
  it("batch size test refuses cap+1 before any read", async () => {
    const query = vi.fn();
    const app = createApp(
      { query, exec: vi.fn() },
      { premiumToken: TOKEN, tpa: { enabled: true, privateIngress: true } },
    );
    const response = await send(
      app,
      rows(Array.from({ length: 26 }, () => employee())),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "INVALID_BATCH" } });
    expect(query).not.toHaveBeenCalled();
  });
  it("refuses malformed, empty, oversized and extra-field envelopes without echoing input", async () => {
    for (const payload of [
      "{",
      { rows: [] },
      { rows: [], "synthetic-census-secret": 1 },
      "x".repeat(65_537),
    ]) {
      const response = await send(appFor(), payload);
      expect(response.status).toBe(400);
      noValues(await response.text());
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });
});

describe("canonical row answers", () => {
  it("employee equality test preserves exact bytes in a mixed 25-row batch", async () => {
    const inputs = Array.from({ length: 25 }, (_, i) =>
      employee({
        plan_start: i % 3 === 0 ? "2027-01-01" : "2026-01-01",
        lcsp_premium_basis: i % 2 ? "gross" : "ehb_portion",
        safe_harbors: { look_back: i % 5 === 0 },
      }),
    );
    const app = appFor();
    const response = await send(app, rows(inputs));
    expect(response.status).toBe(200);
    const batch = (await response.json()) as TestBatch;
    expect(batch.rows).toHaveLength(25);
    expect(batch.counts.submitted).toBe(25);
    for (let i = 0; i < inputs.length; i++) {
      const single = await send(
        app,
        inputs[i],
        `Bearer ${TOKEN}`,
        "/v1/ichra/affordability",
      );
      expect(single.status).toBe(200);
      exact(batch.rows[i]!.result, await single.json());
    }
  });
  it("identity field test rejects names, SSNs and unknown keys per row, leaving valid siblings unchanged", async () => {
    const inputs = [
      employee({
        employee: {
          date_of_birth: "1985-10-01",
          name: "synthetic-census-secret",
        },
      }),
      employee({ ssn: "synthetic-census-secret" }),
      employee({
        employee: {
          date_of_birth: "1985-10-01",
          "synthetic-census-secret.with.dots": 1,
        },
      }),
      employee(),
    ];
    const response = await send(appFor(), rows(inputs));
    expect(response.status).toBe(200);
    const batch = (await response.json()) as TestBatch;
    expect(batch.rows.map((r: { status: string }) => r.status)).toEqual([
      "invalid",
      "invalid",
      "invalid",
      "calculated",
    ]);
    expect(batch.counts).toEqual({
      submitted: 4,
      calculated: 1,
      unknown: 0,
      invalid: 3,
    });
    for (const row of batch.rows.slice(0, 3)) {
      expect(row.error).toEqual({ code: "UNKNOWN_FIELD", field: "input" });
      noValues(JSON.stringify(row));
    }
  });
  it("operator market restriction test refuses selectors and preserves the public-universe answer", async () => {
    const app = appFor();
    const response = await send(app, {
      rows: [
        { row: 1, input: employee(), class_ref: "synthetic-class" },
        {
          row: 2,
          input: employee({
            market_restriction: { exclude_plan_ids: ["87226TX0100011"] },
          }),
        },
      ],
    });
    const batch = (await response.json()) as TestBatch;
    expect(batch.selection_universe).toBe("public");
    exact(
      batch.rows[0]!.result,
      await (
        await send(
          app,
          employee(),
          `Bearer ${TOKEN}`,
          "/v1/ichra/affordability",
        )
      ).json(),
    );
    expect(batch.rows[1]!.status).toBe("invalid");
  });
  it("keeps ordinals local and rejects extra row fields and free text classes", async () => {
    const response = await send(appFor(), {
      rows: [
        { row: 7, input: employee() },
        { row: 2, input: employee(), name: "synthetic-census-secret" },
        { row: 3, input: employee(), class_ref: "free text class" },
        {
          row: 4,
          input: employee({ residence: { zip: "77002", county: "12001" } }),
        },
        { row: 5, input: employee() },
      ],
    });
    const batch = (await response.json()) as TestBatch;
    expect(batch.rows.map((r: { status: string }) => r.status)).toEqual([
      "invalid",
      "invalid",
      "invalid",
      "invalid",
      "calculated",
    ]);
  });
});

it("log and cache privacy test scans success, invalid, unauthorized and fatal-read output", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const cacheEntries: unknown[] = [];
  const get = vi.fn(async (key: string) => {
    cacheEntries.push(key);
    return null;
  });
  const set = vi.fn(async (...entry: unknown[]) => {
    cacheEntries.push(entry);
  });
  const recorder = createRecorder();
  useRecorder(recorder);
  const app = createApp(
    h.db,
    { premiumToken: TOKEN, tpa: { enabled: true, privateIngress: true } },
    {
      store: { get, set, bytes: () => 0 },
    },
  );
  for (const [input, auth] of [
    [employee(), `Bearer ${TOKEN}`],
    [employee({ name: "synthetic-census-secret" }), `Bearer ${TOKEN}`],
    [employee(), "wrong"],
  ]) {
    await (await send(app, rows([input]), auth as string)).text();
  }
  const bad: SqlSession = {
    query: async () => {
      throw new Error("synthetic-census-secret 4118923 1985-10-01");
    },
    exec: async () => {},
  };
  const response = await send(
    createApp(bad, {
      premiumToken: TOKEN,
      tpa: { enabled: true, privateIngress: true },
    }),
    rows([employee()]),
  );
  expect(response.status).toBe(503);
  noValues(await response.text());
  noValues(
    JSON.stringify([
      log.mock.calls,
      warn.mock.calls,
      error.mock.calls,
      cacheEntries,
      recorder.aggregate.snapshot(),
    ]),
  );
  expect(get).not.toHaveBeenCalled();
  expect(set).not.toHaveBeenCalled();
});

it("weights admission by employees and releases operator/process slots after errors", async () => {
  const app = appFor();
  expect(
    (await send(app, rows(Array.from({ length: 25 }, () => employee()))))
      .status,
  ).toBe(200);
  const response = await send(
    app,
    rows(Array.from({ length: 6 }, () => employee())),
  );
  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBeTruthy();
  let release = (_value: { rows: Record<string, unknown>[] }) => {};
  const pending = new Promise<{ rows: Record<string, unknown>[] }>(
    (resolve) => {
      release = resolve;
    },
  );
  const stalled: SqlSession = {
    query: <T extends Record<string, unknown>>() =>
      pending as Promise<{ rows: T[] }>,
    exec: async () => {},
  };
  const slow = createApp(stalled, {
    premiumToken: TOKEN,
    tpa: { enabled: true, privateIngress: true },
  });
  const abort = new AbortController();
  const first = send(
    slow,
    rows([employee()]),
    `Bearer ${TOKEN}`,
    path,
    abort.signal,
  );
  const second = send(
    slow,
    rows([employee()]),
    `Bearer ${TOKEN}`,
    path,
    abort.signal,
  );
  await vi.waitFor(async () =>
    expect((await send(slow, rows([employee()]))).status).toBe(429),
  );
  abort.abort();
  expect((await first).status).toBe(504);
  expect((await second).status).toBe(504);
  release({ rows: [] });
  expect((await send(appFor(), rows([employee()]))).status).toBe(200);
});

it("generation control retries the whole batch and refuses a second publication", async () => {
  let generation = 0;
  const db: SqlSession = {
    query: async <T extends Record<string, unknown>>(sql: string) => {
      if (sql.includes("api_data_generation"))
        return {
          rows: [{ generation: String(generation++) }] as unknown as T[],
        };
      return { rows: [] as T[] };
    },
    exec: async () => {},
  };
  // Unconfirmed year needs no catalog; only the generation reads change.
  await expect(
    ichraAffordabilityBatch(
      db,
      censusRows(rows([employee({ plan_start: "2040-01-01" })])),
      new AbortController().signal,
    ),
  ).rejects.toThrow("GENERATION_CHANGED");
  expect(generation).toBe(4);
});

it("snapshot control uses a single read-only repeatable-read session before reading data", async () => {
  const exec = vi.fn(async () => {});
  const query = vi.fn(async () => ({
    rows: [{ generation: "synthetic-generation" }],
  }));
  const db: SqlSession = {
    query: vi.fn(),
    exec: vi.fn(),
    withRequest: async (_signal, run) =>
      run({ query: query as SqlSession["query"], exec }),
  };
  await ichraAffordabilityBatch(
    db,
    censusRows(rows([employee({ plan_start: "2040-01-01" })])),
    new AbortController().signal,
  );
  expect(exec).toHaveBeenCalledExactlyOnceWith(
    "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
  );
  expect(exec.mock.invocationCallOrder[0]).toBeLessThan(
    query.mock.invocationCallOrder[0]!,
  );
  expect(db.query).not.toHaveBeenCalled();
});

it("negative controls: one-cent answer and leaked log sentinel fail their named checks", () => {
  expect(() => exact({ cents: 100 }, { cents: 101 })).toThrow(
    "canonical employee answer bytes",
  );
  expect(() => noValues("event=census income=4118923")).toThrow();
});

it("off-mode legacy response test preserves the existing single-employee bytes", async () => {
  const ordinary = createApp(h.db, { premiumToken: TOKEN });
  const disabled = appFor(h.db, {
    tpa: { enabled: false, privateIngress: false },
  });
  const route = "/v1/ichra/affordability";
  const before = await send(ordinary, employee(), `Bearer ${TOKEN}`, route);
  const after = await send(disabled, employee(), `Bearer ${TOKEN}`, route);
  expect(after.status).toBe(before.status);
  expect(await after.text()).toBe(await before.text());
});

it("deadline control returns no partial census and stops later row reads", async () => {
  const deadline = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  const pending = new Promise<never>(() => {});
  const query = vi.fn(() => {
    deadline.abort();
    return pending;
  });
  const app = createApp(
    { query, exec: async () => {} },
    {
      premiumToken: TOKEN,
      tpa: { enabled: true, privateIngress: true },
    },
  );
  const response = await send(app, rows([employee(), employee()]));
  expect(response.status).toBe(504);
  expect(await response.json()).toEqual({
    error: { code: "REQUEST_DEADLINE" },
  });
  expect(query).toHaveBeenCalledTimes(1);
  expect(response.headers.get("cache-control")).toBe("no-store");
});

it("local-only geography never reserves a live-source budget or makes a network call", async () => {
  vi.stubEnv("CMS_API_KEY", "synthetic-optional-source-key");
  const network = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("live source forbidden"));
  const statements: string[] = [];
  const db: SqlSession = {
    ...h.db,
    query: async (sql, parameters, options) => {
      statements.push(sql);
      if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql))
        throw new Error("write forbidden");
      return h.db.query(sql, parameters, options);
    },
  };
  try {
    const response = await send(
      createApp(db, {
        premiumToken: TOKEN,
        tpa: { enabled: true, privateIngress: true },
      }),
      rows([employee({ residence: { zip: "99999" } })]),
    );
    expect(response.status).toBe(200);
    const batch = (await response.json()) as TestBatch;
    expect(batch.rows[0]?.status).toBe("unknown");
    expect(network).not.toHaveBeenCalled();
    expect(
      statements.some((sql) => /^\s*(INSERT|UPDATE|DELETE)/i.test(sql)),
    ).toBe(false);
  } finally {
    vi.unstubAllEnvs();
  }
});

it("off-mode MCP tool list test preserves every tool definition without census tools", async () => {
  const before = await connect(configDependencies(h.db, loadConfig({}), true));
  const after = await connect(
    configDependencies(h.db, loadConfig({ OPENPLANS_TPA: "off" }), true),
  );
  try {
    const original = await before.client.listTools();
    const disabled = await after.client.listTools();
    expect(JSON.stringify(disabled.tools)).toBe(JSON.stringify(original.tools));
    expect(
      disabled.tools.some((tool) => /census|batch|tpa/.test(tool.name)),
    ).toBe(false);
  } finally {
    await before.close();
    await after.close();
  }
});

it("deadline also bounds a stalled body before JSON validation", async () => {
  const deadline = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"rows":'));
    },
  });
  const query = vi.fn();
  const app = createApp(
    { query, exec: async () => {} },
    { premiumToken: TOKEN, tpa: { enabled: true, privateIngress: true } },
  );
  const pending = app.fetch(
    new Request("http://localhost" + path, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body,
      duplex: "half",
    } as RequestInit),
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  deadline.abort();
  const response = await pending;
  expect(response.status).toBe(504);
  expect(query).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(body.locked).toBe(false));
});

it("body byte cap counts streamed bytes even when a declared length is smaller", async () => {
  const response = await appFor().request(path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      "content-length": "1",
    },
    body: JSON.stringify({
      rows: [{ row: 1, input: employee(), extra: "x".repeat(66000) }],
    }),
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: { code: "REQUEST_TOO_LARGE" },
  });
});

it("cache privacy survives a conflicting public plugin TTL without hashing a census body", async () => {
  const get = vi.fn(async () => null);
  const set = vi.fn(async () => {});
  const cache = createResponseCache(h.db, undefined, {
    store: { get, set, bytes: () => 0 },
    plugins: {
      routes: [
        {
          plugin: "@openplans/plugin-synthetic",
          spec: {
            method: "POST",
            path,
            exposure: "public",
            contentType: "application/json",
            cache: { ttlSeconds: 60 },
            handler: (c) => c.json({ status: "synthetic" }),
          },
        },
      ],
    },
  });
  const app = new Hono();
  app.use("*", cache.middleware);
  app.post(path, (c) => c.json({ status: "synthetic" }));
  const response = await app.request(path, {
    method: "POST",
    body: JSON.stringify(rows([employee()])),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-cache")).toBe("bypass");
  expect(get).not.toHaveBeenCalled();
  expect(set).not.toHaveBeenCalled();
});
