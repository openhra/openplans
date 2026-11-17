import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { pathToFileURL, fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import type { Database } from "../../../src/db/database.js";
import { coreMigrations, migratedTemplate } from "../../pglite.js";
import { loadPluginMigrations, migrate } from "../../../src/db/migrate.js";
import { dataGeneration } from "../../../src/api/cache/generation.js";
import { checkCatalogTriggers } from "../../../src/plugins/testing/checks.js";
import {
  schemaViolations,
  receiptViolations,
} from "../../../src/db/row-provenance-check.js";
import { plantMutant } from "../../../src/plugins/testing/artifacts.js";
import plugin, { applicationState } from "../../../plugins/admin/src/index.js";
import { createRecorder } from "../../../src/telemetry/observer.js";
import { createFlusher } from "../../../src/telemetry/flush.js";
import { currentReader } from "../../../src/telemetry/read.js";
import {
  activeRecorder,
  configureTelemetry,
  startTelemetry,
} from "../../../src/telemetry/index.js";
import { scheduleFlush } from "../../../src/telemetry/schedule.js";
import { trimStorage, writeSnapshot } from "../../../src/telemetry/storage.js";
import {
  HOUR,
  SEVEN_DAYS,
  NINETY_DAYS,
  STORED_ROW_BYTES,
  STORAGE_CAP_BYTES,
} from "../../../src/telemetry/retention.js";
import { responseDigest } from "../../plugins/admin-support/digests.js";
import { createApp } from "../../../src/api/app.js";
import { ingestGeo } from "../../../src/ingest/geo/index.js";
import { fixtureFiles } from "../../ingest/geo/helpers.js";
import {
  applicationStateCatalogImpact,
  pluginManifestSchema,
} from "@openplans/plugin-sdk";
import { MemoryCache } from "../../../src/api/cache/store.js";

// Synthetic operations and disposable offline databases only.
const BOOT = "00000000-0000-4000-8000-000000000001";
const OTHER_BOOT = "00000000-0000-4000-8000-000000000002";
let template: Awaited<ReturnType<typeof migratedTemplate>>;
let core: Awaited<ReturnType<typeof coreMigrations>>;
let migrations: Awaited<ReturnType<typeof loadPluginMigrations>>;
let db: Database;
let now: number;
const source = {
  plugin: plugin.manifest.name,
  tablePrefix: "admin",
  applicationState,
  directory: fileURLToPath(
    new URL("../../../plugins/admin/migrations/", import.meta.url),
  ),
};
beforeAll(async () => {
  core = await coreMigrations();
  template = await migratedTemplate();
  migrations = await loadPluginMigrations([source]);
});
beforeEach(async () => {
  db = await template.fresh();
  now = Date.parse("2026-11-16T12:00:00Z");
  await migrate(db, core.directory, migrations);
});
afterEach(async () => {
  configureTelemetry({ enabled: false });
  vi.useRealTimers();
  await db?.close();
});
afterAll(async () => {
  await template?.close();
  await core?.cleanup();
});
const count = async () =>
  Number(
    (
      await db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM plg_admin_telemetry",
      )
    ).rows[0]!.n,
  );
const assertCap = async (cap: number) =>
  expect((await count()) * STORED_ROW_BYTES).toBeLessThanOrEqual(cap);
const assertAge = async () =>
  expect(
    (
      await db.query(
        `SELECT 1 FROM plg_admin_telemetry WHERE (granularity='5m' AND bucket_start < $1) OR (granularity='1h' AND bucket_start < $2)`,
        [new Date(now - SEVEN_DAYS), new Date(now - NINETY_DAYS)],
      )
    ).rows,
  ).toHaveLength(0);
const assertGeneration = async (before: string) =>
  expect(await dataGeneration(db)).toBe(before);
function recorder() {
  const sink = createRecorder(() => now);
  const labels = sink.register("http", "synthetic.get");
  return {
    sink,
    sample: (duration = 10) =>
      sink.complete(labels, 200, "completed", duration),
  };
}
async function seedOld() {
  const { sink, sample } = recorder();
  sample();
  await db.transaction((tx) =>
    writeSnapshot(tx, BOOT, sink.aggregate.snapshot(), now, false),
  );
  await db.query(
    "UPDATE plg_admin_telemetry SET bucket_start=$1 WHERE granularity='5m'",
    [new Date(now - SEVEN_DAYS - 1)],
  );
  await db.query(
    "UPDATE plg_admin_telemetry SET bucket_start=$1 WHERE granularity='1h'",
    [new Date(now - NINETY_DAYS - 1)],
  );
}

it("installs only with the admin plugin, replays inertly and preserves operational provenance", async () => {
  const fresh = await template.fresh();
  try {
    await migrate(fresh, core.directory);
    expect(
      (
        await fresh.query(
          "SELECT 1 FROM information_schema.tables WHERE table_name='plg_admin_telemetry'",
        )
      ).rows,
    ).toHaveLength(0);
  } finally {
    await fresh.close();
  }
  const before = await dataGeneration(db);
  const { sink, sample } = recorder();
  sample();
  await createFlusher(db, sink.aggregate, {
    now: () => now,
    bootId: BOOT,
  }).flush();
  await assertGeneration(before);
  expect(await migrate(db, core.directory, migrations)).toEqual([]);
  await assertGeneration(before);
  expect(await schemaViolations(db)).toEqual([]);
  expect(await receiptViolations(db)).toEqual([]);
  expect(await checkCatalogTriggers(db)).toEqual([]);
  expect(
    (
      await db.query(
        "SELECT record_policy,sourced_slug FROM plg_admin_telemetry LIMIT 1",
      )
    ).rows[0],
  ).toMatchObject({
    record_policy: "app_state",
    sourced_slug: "app:plugin-admin:plg_admin_telemetry",
  });
  // Core ledger contains no telemetry migration; disabling the plugin neither drops history nor reclassifies it.
  await migrate(db, core.directory);
  expect(await count()).toBe(2);
  await assertGeneration(before);
});

it("preserves rollover, retries and instance sums without adding both granularities", async () => {
  const { sink, sample } = recorder();
  const flusher = createFlusher(db, sink.aggregate, {
    now: () => now,
    bootId: BOOT,
  });
  sample(5);
  sample(15001);
  await flusher.flush();
  await flusher.flush();
  sample(10);
  await flusher.flush();
  now += 5 * 60_000;
  sample(25); // Rotated snapshot is queued before the aggregate clears.
  await flusher.flush();
  const other = recorder();
  other.sample(5);
  await createFlusher(db, other.sink.aggregate, {
    now: () => now,
    bootId: OTHER_BOOT,
  }).flush();
  const scope = { db, signal: new AbortController().signal };
  const reader = currentReader(sink.aggregate, flusher, () => now);
  for (const window of ["7d", "90d"] as const) {
    const result = await reader.read({ window }, scope);
    expect(result.state).toBe("available");
    if (result.state !== "available") throw new Error("No retained data");
    expect(result.value.collection).toBe("partial");
    expect(result.value.series).toHaveLength(1);
    expect(result.value.series[0]!.count).toBe(5);
    expect(result.value.series[0]!.durationBuckets).toEqual([
      2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1,
    ]);
  }
  // A new hour cannot overwrite the preceding hour's rollup.
  now += HOUR;
  sample(50);
  await flusher.flush();
  expect(
    (
      await db.query(
        "SELECT DISTINCT bucket_start FROM plg_admin_telemetry WHERE granularity='1h'",
      )
    ).rows,
  ).toHaveLength(2);
});

it("retries a lost commit acknowledgement idempotently and coalesces overlapping flushes", async () => {
  const { sink, sample } = recorder();
  sample();
  let lose = true;
  const uncertain: Database = {
    ...db,
    transaction: async (run) => {
      const result = await db.transaction(run);
      if (lose) {
        lose = false;
        throw new Error("Synthetic lost acknowledgement");
      }
      return result;
    },
  };
  const flusher = createFlusher(uncertain, sink.aggregate, {
    now: () => now,
    bootId: BOOT,
  });
  await expect(flusher.flush()).rejects.toThrow("Synthetic");
  expect(flusher.health().failed).toBe(true);
  const first = flusher.flush();
  expect(flusher.flush()).toBe(first);
  await first;
  expect(await count()).toBe(2);
  expect(
    (
      await db.query("SELECT sample_count,flush_gap FROM plg_admin_telemetry")
    ).rows.every(
      (row) => Number(row.sample_count) === 1 && row.flush_gap === true,
    ),
  ).toBe(true);
});

it("bounds live rows, buffers and historical label combinations and preserves unrelated audit", async () => {
  await db.exec(
    "CREATE TABLE synthetic_audit(value text); INSERT INTO synthetic_audit VALUES ('synthetic')",
  );
  const { sink } = recorder();
  const flusher = createFlusher(db, sink.aggregate, {
    now: () => now,
    bootId: BOOT,
    capBytes: 8 * STORED_ROW_BYTES,
  });
  for (let bucket = 0; bucket < 10; bucket++) {
    for (let i = 0; i < 140; i++)
      sink.complete(
        sink.register("http", `synthetic.${i}`),
        200,
        "completed",
        5,
      );
    await flusher.flush();
    await assertCap(8 * STORED_ROW_BYTES);
    now += 5 * 60_000;
  }
  expect((await db.query("SELECT * FROM synthetic_audit")).rows).toHaveLength(
    1,
  );
  expect(
    Number(
      (
        await db.query<{ n: string }>(
          "SELECT max(pg_column_size(t))::text AS n FROM plg_admin_telemetry t",
        )
      ).rows[0]!.n,
    ),
  ).toBeLessThan(STORED_ROW_BYTES);
  const broken: Database = {
    ...db,
    transaction: async () => {
      throw new Error("Synthetic outage");
    },
  };
  const pending = createFlusher(broken, sink.aggregate, {
    now: () => now,
    bootId: OTHER_BOOT,
  });
  for (let i = 0; i < 20; i++) {
    sink.complete(
      sink.register("http", "synthetic.pending"),
      200,
      "completed",
      5,
    );
    await expect(pending.flush()).rejects.toThrow();
    now += 5 * 60_000;
  }
  expect(pending.health().pendingBuckets).toBeLessThanOrEqual(2);
  expect(pending.health().droppedBuckets).toBeGreaterThan(0);
  expect(sink.aggregate.snapshot().reservedBytes + 2 * 128 * 2048).toBeLessThan(
    16 * 1024 * 1024,
  );
  const app = createApp(db);
  expect((await app.request("/healthz")).status).toBe(200);
  expect(STORAGE_CAP_BYTES).toBe(256 * 1024 * 1024);
});

it("expires both tiers even on an empty flush and keeps retained windows unavailable when disabled", async () => {
  await seedOld();
  const { sink } = recorder();
  await createFlusher(db, sink.aggregate, {
    now: () => now,
    bootId: BOOT,
  }).flush();
  await assertAge();
  expect(await count()).toBe(0);
  const scope = { db, signal: AbortSignal.abort() };
  expect(
    await currentReader(sink.aggregate).read({ window: "90d" }, scope),
  ).toMatchObject({ state: "unavailable", reason: "deadline" });
});

it("gates startup, schedules and drains shutdown without request SQL or disabled allocation", async () => {
  const open = vi.fn(() => db);
  expect(
    startTelemetry({
      plugins: [],
      openDatabase: open,
      env: { OPENPLANS_METRICS: "on" },
    }),
  ).toBeUndefined();
  expect(
    startTelemetry({
      plugins: [{ name: plugin.manifest.name }],
      openDatabase: open,
      env: {},
    }),
  ).toBeUndefined();
  expect(open).not.toHaveBeenCalled();
  expect(activeRecorder()).toBeUndefined();
  const close = vi.fn(async () => {});
  const lifecycle = startTelemetry({
    plugins: [{ name: plugin.manifest.name }],
    openDatabase: () => ({ ...db, close }),
    env: { OPENPLANS_METRICS: "on" },
  })!;
  const sink = activeRecorder()!;
  sink.complete(sink.register("mcp", "synthetic.tool"), 200, "completed", 25);
  expect(await count()).toBe(0);
  await lifecycle.stop();
  expect(await count()).toBe(2);
  expect(close).toHaveBeenCalledOnce();
  expect(activeRecorder()).toBeUndefined();
  vi.useFakeTimers();
  const flush = vi.fn(async () => {
    throw new Error("Synthetic outage");
  });
  const scheduler = scheduleFlush({ flush }, 5000);
  await vi.advanceTimersByTimeAsync(5000);
  expect(flush).toHaveBeenCalledOnce();
  await scheduler.stop();
  const calls = flush.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10000);
  expect(flush).toHaveBeenCalledTimes(calls);
});

it("negative control: unbounded growth fails the same storage-cap assertion", async () => {
  const { sink } = recorder();
  for (let i = 0; i < 10; i++)
    sink.complete(sink.register("http", `synthetic.${i}`), 200, "completed", 5);
  await createFlusher(db, sink.aggregate, {
    now: () => now,
    bootId: BOOT,
  }).flush();
  const mutant = await plantMutant(
    new URL("../../../src/telemetry/storage.ts", import.meta.url),
    "Math.floor(capBytes/STORED_ROW_BYTES)",
    "Number.MAX_SAFE_INTEGER",
  );
  try {
    const changed = (await import(pathToFileURL(mutant.path).href)) as {
      trimStorage: typeof trimStorage;
    };
    await changed.trimStorage(db, now, 2 * STORED_ROW_BYTES);
    await expect(assertCap(2 * STORED_ROW_BYTES)).rejects.toThrow();
    await trimStorage(db, now, 2 * STORED_ROW_BYTES);
    await assertCap(2 * STORED_ROW_BYTES);
  } finally {
    await mutant.cleanup();
  }
});

it("negative control: omitted retention fails the same age assertion", async () => {
  await seedOld();
  const mutant = await plantMutant(
    new URL("../../../src/telemetry/storage.ts", import.meta.url),
    "new Date(now-SEVEN_DAYS),new Date(now-NINETY_DAYS)",
    "new Date(0),new Date(0)",
  );
  try {
    const changed = (await import(pathToFileURL(mutant.path).href)) as {
      trimStorage: typeof trimStorage;
    };
    await changed.trimStorage(db, now);
    await expect(assertAge()).rejects.toThrow();
    await trimStorage(db, now);
    await assertAge();
  } finally {
    await mutant.cleanup();
  }
});

it("rejects raw labels and malformed snapshots before storage; a persisted raw-label mutant fails privacy", async () => {
  const { sink, sample } = recorder();
  sample();
  const raw = {
    ...sink.aggregate.snapshot(),
    series: [
      {
        ...sink.aggregate.snapshot().series[0]!,
        operation: "/synthetic?private=value",
      },
    ],
  };
  await expect(
    db.transaction((tx) => writeSnapshot(tx, BOOT, raw, now, false)),
  ).rejects.toThrow();
  await expect(
    db.transaction((tx) =>
      writeSnapshot(tx, "", sink.aggregate.snapshot(), now, false),
    ),
  ).rejects.toThrow();
  const malformed = {
    ...sink.aggregate.snapshot(),
    series: [{ ...sink.aggregate.snapshot().series[0]!, durationBuckets: [1] }],
  };
  await expect(
    db.transaction((tx) => writeSnapshot(tx, BOOT, malformed, now, false)),
  ).rejects.toThrow();
  expect(await count()).toBe(0);
  await createFlusher(db, sink.aggregate, {
    now: () => now,
    bootId: BOOT,
  }).flush();
  const privacy = async () =>
    expect(
      JSON.stringify(
        (await db.query("SELECT operation,owner FROM plg_admin_telemetry"))
          .rows,
      ),
    ).not.toContain("/synthetic?");
  await privacy();
  await db.exec(
    "ALTER TABLE plg_admin_telemetry DROP CONSTRAINT plg_admin_telemetry_operation_check; UPDATE plg_admin_telemetry SET operation='/synthetic?private=value'",
  );
  await expect(privacy()).rejects.toThrow();
});

it("negative control: telemetry invalidation fails the generation and warmed-response assertions", async () => {
  await ingestGeo(db, { files: await fixtureFiles() });
  const app = createApp(db, {}, { store: new MemoryCache(1024 * 1024) });
  await (await app.request("/v1/zip-counties?zip=77002")).text();
  const before = await dataGeneration(db);
  const { sink, sample } = recorder();
  sample();
  const flusher = createFlusher(db, sink.aggregate, {
    now: () => now,
    bootId: BOOT,
  });
  const expected = await responseDigest(
    await app.request("/v1/zip-counties?zip=77002"),
  );
  expect(expected.headers["x-cache"]).toBe("hit");
  await flusher.flush();
  await assertGeneration(before);
  expect(
    await responseDigest(await app.request("/v1/zip-counties?zip=77002")),
  ).toEqual(expected);
  await db.exec(
    "DROP TRIGGER api_data_changed ON plg_admin_telemetry; CREATE TRIGGER api_data_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON plg_admin_telemetry FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation()",
  );
  sample();
  await flusher.flush();
  await expect(assertGeneration(before)).rejects.toThrow();
});

it("negative control: one changed response byte while off fails digest identity", async () => {
  configureTelemetry({ enabled: false });
  const app = createApp(db);
  const expected = await responseDigest(await app.request("/healthz"));
  const response = await app.request("/healthz");
  const mutant = new Response((await response.text()) + " ", {
    status: response.status,
    headers: response.headers,
  });
  const changed = await responseDigest(mutant);
  expect(() => expect(changed).toEqual(expected)).toThrow();
  expect(await responseDigest(await app.request("/healthz"))).toEqual(expected);
});

it("wires the production lifecycle before route registration and stops it before database teardown", async () => {
  const source = await readFile(
    new URL("../../../src/api/server.ts", import.meta.url),
    "utf8",
  );
  expect(source.indexOf("const telemetry = startTelemetry")).toBeLessThan(
    source.indexOf("const app = createApp"),
  );
  expect(source).toContain("telemetry?.stop()");
});

it("resets disposable history when allocated table/index pages exceed the physical hard cap", async () => {
  const { sink, sample } = recorder();
  sample();
  const inflated: Database = {
    ...db,
    transaction: (run) =>
      db.transaction((tx) =>
        run({
          ...tx,
          query: async (sql, parameters) =>
            sql.startsWith("SELECT pg_total_relation_size")
              ? ({ rows: [{ bytes: String(STORAGE_CAP_BYTES + 1) }] } as never)
              : tx.query(sql, parameters),
        }),
      ),
  };
  const flusher = createFlusher(inflated, sink.aggregate, {
    now: () => now,
    bootId: BOOT,
  });
  await flusher.flush();
  expect(await count()).toBe(0);
  expect(flusher.health().droppedBuckets).toBe(1);
});

it("contains startup sink failure and does not relax the operational exemption for other tables", () => {
  expect(
    startTelemetry({
      plugins: [{ name: plugin.manifest.name }],
      openDatabase: () => {
        throw new Error("Synthetic unavailable provider");
      },
      env: { OPENPLANS_METRICS: "on" },
    }),
  ).toBeUndefined();
  expect(activeRecorder()).toBeUndefined();
});

it("exposes missing five-minute intervals without fabricating observations", async () => {
  const { sink, sample } = recorder();
  sample();
  const flusher = createFlusher(db, sink.aggregate, {
    now: () => now,
    bootId: BOOT,
  });
  await flusher.flush();
  now += 10 * 60_000;
  sample();
  await flusher.flush();
  const result = await currentReader(sink.aggregate, flusher, () => now).read(
    { window: "7d" },
    { db, signal: new AbortController().signal },
  );
  expect(result).toMatchObject({
    state: "available",
    value: { gaps: true, observedInstances: 1 },
  });
});

it("keeps each retention boundary and expires it immediately afterward", async () => {
  const initial = now;
  now = initial - SEVEN_DAYS;
  const { sink, sample } = recorder();
  sample();
  await createFlusher(db, sink.aggregate, {
    now: () => now,
    bootId: BOOT,
  }).flush();
  now = initial;
  await trimStorage(db, now);
  expect(await count()).toBe(2);
  await trimStorage(db, now + 1);
  expect(
    (await db.query("SELECT 1 FROM plg_admin_telemetry WHERE granularity='5m'"))
      .rows,
  ).toHaveLength(0);
  expect(await count()).toBe(1);
  await db.query("UPDATE plg_admin_telemetry SET bucket_start=$1", [
    new Date(now - NINETY_DAYS),
  ]);
  await trimStorage(db, now);
  expect(await count()).toBe(1);
  await trimStorage(db, now + 1);
  expect(await count()).toBe(0);
});

it("rejects operational exemptions outside the exact admin telemetry table", () => {
  expect(
    applicationStateCatalogImpact(
      plugin.manifest.name,
      "admin",
      "plg_admin_telemetry",
    ),
  ).toBe("operational");
  for (const [name, prefix, table] of [
    [plugin.manifest.name, "admin", "plg_admin_catalog"],
    ["@synthetic/other", "admin", "plg_admin_telemetry"],
    [plugin.manifest.name, "other", "plg_admin_telemetry"],
  ]) {
    expect(applicationStateCatalogImpact(name!, prefix!, table!)).toBe(
      "catalog",
    );
    expect(
      pluginManifestSchema.safeParse({
        ...plugin.manifest,
        name,
        tablePrefix: prefix,
        applicationState: [
          { table, reason: "Synthetic refusal", catalogImpact: "operational" },
        ],
      }).success,
    ).toBe(false);
  }
});
