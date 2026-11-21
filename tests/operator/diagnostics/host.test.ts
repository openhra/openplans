import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import type {
  OperatorHost,
  PluginContext,
  SqlSession,
} from "@openplans/plugin-sdk";
import { loadConfig } from "../../../src/config/index.js";
import {
  createOperatorHost,
  setOperatorTelemetryReader,
} from "../../../src/plugins/operator-host.js";
import { loadPlugins } from "../../plugins/approval-helpers.js";
import {
  emptyRegistries,
  freezeRegistries,
} from "../../../src/plugins/registries.js";
import {
  source,
  input,
  reader,
  scope,
} from "../../../plugins/msot/tests/fixtures.js";
import { compileSource } from "../../../plugins/msot/src/resolver.js";

const now = () => Date.parse("2026-11-15T12:00:00Z");
const state = (owner = "@openplans/plugin-msot", canonical = reader) => {
  const registries = emptyRegistries();
  registries.catalogPolicies.msot = {
    plugin: owner,
    spec: { ...compileSource(source, canonical) },
  };
  return { plugins: [], registries: freezeRegistries(registries) };
};

it("uses the caller's cancellation and a read-only DB for availability, catalog and provider reads", async () => {
  const requestOptions: unknown[] = [];
  const requestSignals: AbortSignal[] = [];
  const query = vi.fn(async (sql: string) => {
    if (sql.includes(" AS generation"))
      return { rows: [{ generation: "synthetic-generation" }] };
    if (sql.includes("AS slot")) return { rows: [{ slot: "a" }] };
    return { rows: [{ current: true }] };
  });
  const db = {
    query: query as unknown as SqlSession["query"],
    exec: vi.fn(),
    async withRequest(signal, run, options) {
      requestSignals.push(signal);
      requestOptions.push(options);
      return run({ query, exec: vi.fn() } as unknown as SqlSession);
    },
  } satisfies SqlSession;
  const controller = new AbortController();
  const request = { db, signal: controller.signal };
  const providerState = state("@openplans/plugin-msot", {
    plans: async (input, request) => {
      await request.db.query("SELECT 1");
      return reader.plans(input, request);
    },
  });
  const host = createOperatorHost(
    loadConfig({}),
    "api",
    {
      dataAvailability: async (db) => {
        await db.query("SELECT 1");
        return [];
      },
    },
    () => providerState,
    now,
  );
  expect(await host.availability(request)).toMatchObject({
    state: "available",
    value: [],
  });
  expect(await host.catalog(request)).toMatchObject({
    state: "available",
    value: { generation: "synthetic-generation", providerSearch: "current" },
  });
  expect(await host.msot.inspect(input, request)).toMatchObject({
    state: "available",
  });
  expect(
    requestOptions.every(
      (options) => JSON.stringify(options) === '{"readOnly":true}',
    ),
  ).toBe(true);
  expect(requestSignals.every((signal) => signal === controller.signal)).toBe(
    true,
  );
  expect(requestOptions.length).toBeGreaterThan(0);
  controller.abort();
  const calls = query.mock.calls.length;
  expect(await host.catalog(request)).toMatchObject({
    state: "unavailable",
    reason: "deadline",
  });
  expect(await host.msot.inspect(input, request)).toMatchObject({
    state: "unavailable",
    reason: "deadline",
  });
  expect(query.mock.calls.length).toBe(calls);
});

it("refuses absent/foreign providers, foreign sources and arbitrary callbacks without running them", async () => {
  const callback = vi.fn();
  const host = createOperatorHost(
    loadConfig({}),
    "api",
    {},
    () => state(),
    now,
  );
  const expected = await compileSource(source, reader).resolve(input, scope);
  expect(await host.msot.inspect(input, scope)).toEqual({
    state: "available",
    value: expected,
    observedAt: new Date(now()).toISOString(),
  });
  const planRead = vi.spyOn(reader, "plans");
  expect(
    await host.msot.inspect({ ...input, source_id: "foreign-source" }, scope),
  ).toMatchObject({ state: "unavailable", reason: "read_failed" });
  expect(planRead).not.toHaveBeenCalled();
  planRead.mockRestore();
  expect(
    await host.msot.inspect({ ...input, callback } as typeof input, scope),
  ).toMatchObject({ state: "unavailable", reason: "not_supported" });
  expect(callback).not.toHaveBeenCalled();
  const foreignState = state("@openplans/foreign-owner");
  const resolve = vi.spyOn(
    foreignState.registries.catalogPolicies.msot!.spec,
    "resolve",
  );
  const foreign = createOperatorHost(
    loadConfig({}),
    "api",
    {},
    () => foreignState,
    now,
  );
  expect(await foreign.msot.inspect(input, scope)).toMatchObject({
    state: "unavailable",
    reason: "not_configured",
  });
  expect(resolve).not.toHaveBeenCalled();
  const absent = createOperatorHost(
    loadConfig({}),
    "api",
    {},
    () => ({ plugins: [], registries: freezeRegistries(emptyRegistries()) }),
    now,
  );
  expect(await absent.msot.inspect(input, scope)).toMatchObject({
    state: "unavailable",
    reason: "not_configured",
  });
  expect(absent.telemetry).toBeUndefined();
  expect(await absent.availability(scope)).toMatchObject({
    state: "unavailable",
    reason: "not_supported",
  });
});

it("keeps read errors safe and approval hashes unverified", async () => {
  const marker = "synthetic-private-error-marker";
  const host = createOperatorHost(
    loadConfig({}),
    "api",
    {
      dataAvailability: async () => {
        throw new Error(marker);
      },
    },
    () => state(),
    now,
  );
  const result = await host.availability(scope);
  expect(result).toMatchObject({ state: "unavailable", reason: "read_failed" });
  expect(JSON.stringify(result).includes(marker)).toBe(false);
  const config = loadConfig(
    {},
    {
      version: 1,
      plugins: {
        entries: [{ package: `/private/${marker}/index.mjs`, enabled: false }],
      },
    },
  );
  const diagnostics = createOperatorHost(
    config,
    "api",
    {},
    () => ({
      plugins: [
        {
          name: "@openplans/plugin-msot",
          enabled: true,
          version: null,
          apiVersion: "0.2",
          sha256: null,
        },
      ],
      registries: freezeRegistries(emptyRegistries()),
    }),
    now,
  );
  const settings = await diagnostics.configuration(scope);
  expect(JSON.stringify(settings).includes(marker)).toBe(false);
  expect(settings).toMatchObject({
    state: "available",
    value: {
      plugins: [
        {
          name: null,
          enabled: false,
          loaded: null,
          approved: { state: "unverified" },
        },
        {
          name: "@openplans/plugin-msot",
          loaded: { version: null, sha256: null },
          approved: { state: "unverified" },
        },
      ],
    },
  });
});

it("finishes an in-flight unavailable read when the request deadline expires", async () => {
  const controller = new AbortController();
  const host = createOperatorHost(
    loadConfig({}),
    "api",
    {
      dataAvailability: () => new Promise(() => {}),
    },
    () => state(),
    now,
  );
  const result = host.availability({ db: scope.db, signal: controller.signal });
  controller.abort();
  expect(await result).toMatchObject({
    state: "unavailable",
    reason: "deadline",
  });
});

it("hands off telemetry after setup without invoking request-supplied callbacks", async () => {
  const host = createOperatorHost(
    loadConfig({}),
    "api",
    {},
    () => state(),
    now,
  );
  const callback = vi.fn();
  const sink = vi.fn(async () => ({
    state: "available" as const,
    observedAt: new Date(now()).toISOString(),
    value: {
      collection: "partial" as const,
      since: null,
      until: new Date(now()).toISOString(),
      drops: 0,
      series: [],
    },
  }));
  setOperatorTelemetryReader({ read: sink });
  try {
    expect(
      await host.telemetry!.read(
        { window: "current_process", callback } as {
          window: "current_process";
        },
        scope,
      ),
    ).toMatchObject({ state: "unavailable", reason: "not_supported" });
    expect(callback).not.toHaveBeenCalled();
    expect(sink).not.toHaveBeenCalled();
    expect(
      await host.telemetry!.read({ window: "current_process" }, scope),
    ).toMatchObject({ state: "available", value: { collection: "partial" } });
    const loading = createOperatorHost(
      loadConfig({}),
      "api",
      {},
      () => undefined,
      now,
    );
    const calls = sink.mock.calls.length;
    expect(
      await loading.telemetry!.read({ window: "current_process" }, scope),
    ).toMatchObject({ state: "unavailable", reason: "not_configured" });
    expect(sink.mock.calls.length).toBe(calls);
    setOperatorTelemetryReader({
      read: async () => {
        throw new Error("synthetic-private-sink-marker");
      },
    });
    expect(
      await host.telemetry!.read({ window: "current_process" }, scope),
    ).toMatchObject({ state: "unavailable", reason: "read_failed" });
  } finally {
    setOperatorTelemetryReader(undefined);
  }
  expect(host.telemetry).toBeUndefined();
});

it("grants diagnostics explicitly, refuses setup reads and resolves after all packages in either order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openplans-operator-host-"));
  const query = vi.fn(async () => ({ rows: [] }));
  try {
    for (const granted of [false, true]) {
      const file = join(directory, `synthetic-${granted}.mjs`);
      await writeFile(
        file,
        `export let context; export let duringSetup;
        export default { manifest: { name: "@openplans/synthetic-diagnostics", version: "0.1.0", apiVersion: "0.2", kinds: [], capabilities: { operatorDiagnostics: ${granted} } },
        async setup(ctx) { context = ctx; duringSetup = await ctx.operatorHost?.catalog({ db: ctx.db.reader, signal: new AbortController().signal }); } };`,
      );
      const module = (await import(pathToFileURL(file).href)) as {
        context: PluginContext;
        duringSetup?: unknown;
      };
      for (const reverse of [false, true]) {
        const plugins = [
          { package: file },
          { package: "@openplans/plugin-msot", options: { source } },
        ];
        if (reverse) plugins.reverse();
        const loaded = await loadPlugins(
          loadConfig({}, { version: 1, plugins: { entries: plugins } }),
          "api",
          {
            env: {},
            now,
            db: { reader: { query, exec: vi.fn() } },
            canonicalReader: reader,
          },
        );
        try {
          expect(query).not.toHaveBeenCalled();
          const host: OperatorHost | undefined = module.context.operatorHost;
          if (!granted) {
            expect(host).toBeUndefined();
            continue;
          }
          expect(module.duringSetup).toMatchObject({
            state: "unavailable",
            reason: "not_configured",
          });
          expect(await host!.msot.inspect(input, scope)).toMatchObject({
            state: "available",
            value: { msot: { source_id: source.source_id } },
          });
          const config = await host!.configuration(scope);
          expect(config.state).toBe("available");
          if (config.state === "available") {
            expect(config.value.plugins.map((plugin) => plugin.name)).toEqual([
              "@openplans/plugin-msot",
              "@openplans/synthetic-diagnostics",
            ]);
            expect(
              config.value.plugins.every(
                (plugin) => plugin.approved.state === "unverified",
              ),
            ).toBe(true);
          }
        } finally {
          await loaded.teardown();
        }
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects disposable setup-query, foreign-owner/source and executed-callback observations", () => {
  function boundary(observed: {
    setupQueries: number;
    owner: string;
    source: string;
    callbackCalls: number;
  }) {
    expect(observed.setupQueries).toBe(0);
    expect(observed.owner).toBe("@openplans/plugin-msot");
    expect(observed.source).toBe(source.source_id);
    expect(observed.callbackCalls).toBe(0);
  }
  const baseline = {
    setupQueries: 0,
    owner: "@openplans/plugin-msot",
    source: source.source_id,
    callbackCalls: 0,
  };
  boundary(baseline);
  for (const mutant of [
    { ...baseline, setupQueries: 1 },
    { ...baseline, owner: "foreign-owner" },
    { ...baseline, source: "foreign-source" },
    { ...baseline, callbackCalls: 1 },
  ])
    expect(() => boundary(mutant)).toThrow();
});
