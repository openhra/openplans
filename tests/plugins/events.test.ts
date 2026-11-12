import { PGlite } from "@electric-sql/pglite";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eventPayloadSchemas } from "@openplans/plugin-sdk";
import type { Event, EventRegistry } from "@openplans/plugin-sdk";
import type { Database } from "../../src/db/database.js";
import { migrate } from "../../src/db/migrate.js";
import { EventRefusedError } from "../../src/plugins/events.js";
import type * as EventsModule from "../../src/plugins/events.js";
import { plantMutant } from "../../src/plugins/testing/artifacts.js";
import {
  checkEventPayloads,
  readOutbox,
  testEventBus,
} from "../../src/plugins/testing/events.js";
import { coreMigrations, testDatabase } from "../pglite.js";

// Every event in this file is synthetic.
const flushed = (key: string) =>
  ({
    type: "cache.flushed",
    idempotencyKey: key,
    payload: { reason: "operator" },
  }) as const;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

let db: Database;
let cleanupMigrations: () => Promise<void>;

beforeAll(async () => {
  db = testDatabase(new PGlite());
  const core = await coreMigrations();
  cleanupMigrations = core.cleanup;
  await migrate(db, core.directory);
});

afterAll(async () => {
  await db.close();
  await cleanupMigrations();
});

beforeEach(async () => {
  await db.exec("DELETE FROM plugin_event_outbox; DELETE FROM plugin_state;");
});

const core = (bus: ReturnType<typeof testEventBus>["bus"]): EventRegistry =>
  bus.registry({ kind: "core", name: "worker" });

/** The acceptance check for a 5 s handler, shared by the real bus and its mutant. */
async function slowHandlerEmit(
  createEventBus: typeof EventsModule.createEventBus,
  release: Promise<void>,
): Promise<{ elapsed: number; logs: Record<string, unknown>[] }> {
  const logs: Record<string, unknown>[] = [];
  const bus = createEventBus({ db, log: (entry) => logs.push(entry) });
  const events = bus.registry({ kind: "core", name: "api" });
  events.on("cache.flushed", () => release, {
    durable: false,
    subscriber: "synthetic-slow",
  });
  const started = performance.now();
  await events.emit(flushed("slow"));
  return { elapsed: performance.now() - started, logs };
}

describe("event bus fan-out", () => {
  it("a throwing handler is logged and skipped; the emitter and other handlers continue", async () => {
    const { bus, logs } = testEventBus(db);
    const events = core(bus);
    const seen: string[] = [];
    events.on(
      "cache.flushed",
      async () => {
        throw new TypeError("synthetic failure");
      },
      { durable: false, subscriber: "synthetic-throws" },
    );
    events.on(
      "cache.flushed",
      async (event) => {
        seen.push(event.payload.reason);
      },
      { durable: false, subscriber: "synthetic-ok" },
    );
    await expect(events.emit(flushed("throws"))).resolves.toBeUndefined();
    expect(seen).toEqual(["operator"]);
    expect(logs).toEqual([
      {
        event: "handler_failed",
        event_type: "cache.flushed",
        subscriber: "synthetic-throws",
        error_class: "TypeError",
      },
    ]);
    expect(await readOutbox(db)).toHaveLength(1);
  });

  it("a handler sleeping 5 s holds the emitter about 2 s and logs handler_timeout", async () => {
    const { createEventBus } = await import("../../src/plugins/events.js");
    const { elapsed, logs } = await slowHandlerEmit(
      createEventBus,
      sleep(5_000),
    );
    expect(elapsed).toBeGreaterThanOrEqual(1_900);
    expect(elapsed).toBeLessThan(2_600);
    expect(logs).toEqual([
      {
        event: "handler_timeout",
        event_type: "cache.flushed",
        subscriber: "synthetic-slow",
        timeout_ms: 2_000,
      },
    ]);
    expect(await readOutbox(db)).toHaveLength(1);
  });

  it("mutant: without the per-handler bound the slow handler blocks the emitter", async () => {
    const mutant = await plantMutant(
      new URL("../../src/plugins/events.ts", import.meta.url),
      "bounded(entry, event, timeoutMs)",
      'entry.handler(structuredClone(event)).then((): Outcome => "ok")',
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    try {
      const loaded = (await import(
        pathToFileURL(mutant.path).href
      )) as typeof EventsModule;
      const run = slowHandlerEmit(loaded.createEventBus, gate);
      // The real bus returns at 2 s; the mutant is still waiting at 3 s.
      const winner = await Promise.race([
        run.then(() => "returned"),
        sleep(3_000).then(() => "blocked"),
      ]);
      expect(winner).toBe("blocked");
      release();
      const { elapsed, logs } = await run;
      expect(elapsed).toBeGreaterThanOrEqual(3_000);
      expect(logs).toEqual([]);
    } finally {
      release();
      await mutant.cleanup();
    }
  });

  it("handlers get a copy with the assigned id, time and emitter", async () => {
    const { bus } = testEventBus(db, {
      now: () => new Date("2026-11-11T00:00:00Z"),
      newId: () => "00000000-0000-4000-8000-000000000001",
    });
    const seen: Event<"cache.flushed">[] = [];
    const events = core(bus);
    events.on(
      "cache.flushed",
      async (event) => {
        seen.push(event);
        (event.payload as { reason: string }).reason = "changed";
      },
      { durable: false, subscriber: "synthetic-a" },
    );
    events.on(
      "cache.flushed",
      async (event) => {
        seen.push(event);
      },
      { durable: false, subscriber: "synthetic-b" },
    );
    events.on("cache.flushed", async () => {}, {
      durable: true,
      subscriber: "synthetic-durable",
    });
    await events.emit(flushed("copy"));
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual({
      id: "00000000-0000-4000-8000-000000000001",
      type: "cache.flushed",
      emittedAt: "2026-11-11T00:00:00.000Z",
      emittedBy: "worker",
      idempotencyKey: "copy",
      payload: { reason: "operator" },
    });
    expect(bus.durableSubscribers().map((entry) => entry.subscriber)).toEqual([
      "synthetic-durable",
    ]);
  });
});

describe("event bus outbox", () => {
  it("emit outside a transaction writes one row in its own transaction", async () => {
    const { bus, logs } = testEventBus(db);
    await core(bus).emit({
      type: "snapshot.activated",
      idempotencyKey: "synthetic:activated",
      payload: { sourceId: "synthetic", snapshotId: "synthetic-1", rows: null },
    });
    const rows = await readOutbox(db);
    expect(rows).toEqual([
      {
        event_id: expect.stringMatching(/^[0-9a-f-]{36}$/) as string,
        event_type: "snapshot.activated",
        idempotency_key: "synthetic:activated",
        emitted_by: "worker",
        payload: {
          sourceId: "synthetic",
          snapshotId: "synthetic-1",
          rows: null,
        },
      },
    ]);
    expect(logs).toEqual([]);
  });

  it("a repeated idempotency key keeps one row", async () => {
    const { bus } = testEventBus(db);
    await core(bus).emit(flushed("same"));
    await core(bus).emit(flushed("same"));
    expect(await readOutbox(db)).toHaveLength(1);
  });

  it("emit inside a transaction that rolls back leaves no outbox row", async () => {
    const { bus, logs } = testEventBus(db);
    await expect(
      bus.transaction(async (session) => {
        await session.query(
          "INSERT INTO plugin_state (plugin, key, value) VALUES ('synthetic', 'k', '1')",
        );
        await core(bus).emit(flushed("rolled-back"));
        // Visible inside the caller's transaction before it ends.
        expect(await readOutbox(session)).toHaveLength(1);
        throw new Error("synthetic rollback");
      }),
    ).rejects.toThrow("synthetic rollback");
    expect(await readOutbox(db)).toEqual([]);
    expect((await db.query("SELECT 1 FROM plugin_state")).rows).toEqual([]);
    expect(logs).toEqual([]);
  });

  it("an explicit session joins the caller's transaction too", async () => {
    const { bus } = testEventBus(db);
    await expect(
      db.transaction(async (session) => {
        await core(bus).emit(flushed("explicit"), { session });
        throw new Error("synthetic rollback");
      }),
    ).rejects.toThrow("synthetic rollback");
    expect(await readOutbox(db)).toEqual([]);
    await db.transaction(async (session) => {
      await core(bus).emit(flushed("explicit"), { session });
    });
    expect(await readOutbox(db)).toHaveLength(1);
  });

  it("a committed transaction keeps its outbox row", async () => {
    const { bus } = testEventBus(db);
    await bus.transaction(async () => {
      await core(bus).emit(flushed("committed"));
    });
    expect((await readOutbox(db)).map((row) => row.idempotency_key)).toEqual([
      "committed",
    ]);
  });

  it("a failing outbox insert inside a transaction is logged; the caller's work still commits", async () => {
    const { bus, logs } = testEventBus(db);
    await db.exec(
      "ALTER TABLE plugin_event_outbox ADD CONSTRAINT synthetic_refuse CHECK (idempotency_key <> 'refused')",
    );
    try {
      await bus.transaction(async (session) => {
        await expect(
          core(bus).emit(flushed("refused")),
        ).resolves.toBeUndefined();
        await session.query(
          "INSERT INTO plugin_state (plugin, key, value) VALUES ('synthetic', 'k', '1')",
        );
      });
    } finally {
      await db.exec(
        "ALTER TABLE plugin_event_outbox DROP CONSTRAINT synthetic_refuse",
      );
    }
    expect(await readOutbox(db)).toEqual([]);
    expect((await db.query("SELECT key FROM plugin_state")).rows).toEqual([
      { key: "k" },
    ]);
    expect(logs).toEqual([
      {
        event: "outbox_insert_failed",
        event_type: "cache.flushed",
        in_transaction: true,
        error_class: expect.any(String) as string,
      },
    ]);
  });

  it("a failing outbox insert in its own transaction is logged and does not throw", async () => {
    const logs: Record<string, unknown>[] = [];
    const { createEventBus } = await import("../../src/plugins/events.js");
    const bus = createEventBus({
      db: {
        ...db,
        transaction: async () => {
          throw new Error("synthetic connection failure");
        },
      },
      log: (entry) => logs.push(entry),
    });
    await expect(core(bus).emit(flushed("lost"))).resolves.toBeUndefined();
    expect(logs).toEqual([
      {
        event: "outbox_insert_failed",
        event_type: "cache.flushed",
        in_transaction: false,
        error_class: "Error",
      },
    ]);
  });
});

describe("event bus refusals", () => {
  it("an unknown payload key is refused before any handler or outbox write", async () => {
    const { bus } = testEventBus(db);
    const events = core(bus);
    let called = 0;
    events.on(
      "cache.flushed",
      async () => {
        called += 1;
      },
      { durable: false, subscriber: "synthetic" },
    );
    const emitted = events.emit({
      ...flushed("unknown-key"),
      payload: { reason: "operator", requestBody: "synthetic" },
    } as never);
    await expect(emitted).rejects.toBeInstanceOf(EventRefusedError);
    await expect(emitted).rejects.toThrow(
      "invalid_payload: cache.flushed unrecognized_keys requestBody",
    );
    expect(called).toBe(0);
    expect(await readOutbox(db)).toEqual([]);
  });

  it("mutant: skipping payload validation lets the unknown key through", async () => {
    const mutant = await plantMutant(
      new URL("../../src/plugins/events.ts", import.meta.url),
      "schema.safeParse(envelope.payload)",
      "({ success: true, data: envelope.payload })",
    );
    try {
      const loaded = (await import(
        pathToFileURL(mutant.path).href
      )) as typeof EventsModule;
      const bus = loaded.createEventBus({ db, log: () => {} });
      await expect(
        bus.registry({ kind: "core", name: "api" }).emit({
          ...flushed("mutant-unknown-key"),
          payload: { reason: "operator", requestBody: "synthetic" },
        } as never),
      ).resolves.toBeUndefined();
      expect(await readOutbox(db)).toHaveLength(1);
    } finally {
      await mutant.cleanup();
    }
  });

  it("refuses unknown types, extra envelope keys, empty keys and bad counts", async () => {
    const events = core(testEventBus(db).bus);
    const refused = async (input: unknown, code: string) => {
      const error: unknown = await events.emit(input as never).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(EventRefusedError);
      expect((error as EventRefusedError).code).toBe(code);
    };
    await refused(
      { type: "passthrough.called", idempotencyKey: "x", payload: {} },
      "unknown_event_type",
    );
    await refused({ ...flushed("x"), id: "chosen" }, "invalid_envelope");
    await refused({ ...flushed(" "), idempotencyKey: " " }, "invalid_envelope");
    await refused(
      {
        type: "snapshot.activated",
        idempotencyKey: "x",
        payload: { sourceId: "s", snapshotId: "s", rows: -1 },
      },
      "invalid_payload",
    );
    await refused(
      {
        type: "snapshot.activated",
        idempotencyKey: "x",
        payload: { sourceId: "s", snapshotId: "s" },
      },
      "invalid_payload",
    );
    expect(await readOutbox(db)).toEqual([]);
  });

  it('plugins emit only with writes: ["events"]; the core emits freely', async () => {
    const { bus } = testEventBus(db);
    const without = bus.registry({
      kind: "plugin",
      manifest: {
        name: "synthetic-plugin",
        capabilities: { writes: ["cache"] },
      },
    });
    await expect(without.emit(flushed("plugin-denied"))).rejects.toThrow(
      "missing_capability",
    );
    const allowed = bus.registry({
      kind: "plugin",
      manifest: {
        name: "synthetic-plugin",
        capabilities: { writes: ["events"] },
      },
    });
    await allowed.emit(flushed("plugin-allowed"));
    await bus.registry({ kind: "core", name: "api" }).emit(flushed("core"));
    expect(
      (await readOutbox(db)).map((row) => [
        row.idempotency_key,
        row.emitted_by,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ["plugin-allowed", "synthetic-plugin"],
        ["core", "api"],
      ]),
    );
    expect(await readOutbox(db)).toHaveLength(2);
  });

  it("refuses unknown subscription types and duplicate subscribers", () => {
    const events = core(testEventBus(db).bus);
    expect(() =>
      events.on("passthrough.called" as never, async () => {}, {
        durable: false,
        subscriber: "synthetic",
      }),
    ).toThrow("unknown_event_type");
    events.on("cache.flushed", async () => {}, {
      durable: false,
      subscriber: "synthetic",
    });
    expect(() =>
      events.on("cache.flushed", async () => {}, {
        durable: true,
        subscriber: "synthetic",
      }),
    ).toThrow("invalid_subscription");
  });
});

describe("event bus wiring", () => {
  it("takes subscriptions staged by the loader and refuses duplicates among them", async () => {
    const seen: string[] = [];
    const staged = {
      type: "cache.flushed" as const,
      durable: false,
      subscriber: "synthetic-staged",
      handler: async (event: Event) => {
        seen.push(event.idempotencyKey);
      },
    };
    const { bus } = testEventBus(db, { subscriptions: [staged] });
    await core(bus).emit(flushed("staged"));
    expect(seen).toEqual(["staged"]);
    expect(() => testEventBus(db, { subscriptions: [staged, staged] })).toThrow(
      "invalid_subscription",
    );
  });
});

describe("event catalog", () => {
  it("types an unknown snapshot row count as null, never 0", () => {
    const schema = eventPayloadSchemas["snapshot.activated"];
    const payload = { sourceId: "synthetic", snapshotId: "synthetic-1" };
    expect(schema.parse({ ...payload, rows: null }).rows).toBeNull();
    expect(schema.parse({ ...payload, rows: 3 }).rows).toBe(3);
    expect(schema.safeParse(payload).success).toBe(false);
  });

  it("the kit's payload scanner passes the shipped catalog", () => {
    expect(checkEventPayloads()).toEqual([]);
  });
});
