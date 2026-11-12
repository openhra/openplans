import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Event } from "@openplans/plugin-sdk";
import type { Database } from "../src/db/database.js";
import { migrate } from "../src/db/migrate.js";
import { plantMutant } from "../src/plugins/testing/artifacts.js";
import {
  backoffMs,
  defaultIdempotencyKey,
  deliverEvents,
  installKey,
  MAX_ATTEMPTS,
} from "../src/worker/deliver-events.js";
import type * as DeliverModule from "../src/worker/deliver-events.js";
import type { DurableSubscriber } from "../src/worker/deliver-events.js";
import { runWorker } from "../src/worker/commands.js";
import { coreMigrations, testDatabase } from "./pglite.js";
import { concurrentSessions } from "./worker-events-sessions.js";

// Every event and subscriber in this file is synthetic.
let pg: PGlite;
let db: Database;
let cleanupMigrations: () => Promise<void>;

beforeAll(async () => {
  pg = new PGlite();
  db = testDatabase(pg);
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

const T0 = Date.parse("2026-11-11T12:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms);
const clockAt = (ms: number) => () => at(ms);
const half = () => 0.5;

async function insertEvent(emittedMs: number, key: string = randomUUID()) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO plugin_event_outbox (event_id, event_type, idempotency_key, emitted_by, emitted_at, payload)
     VALUES ($1, 'cache.flushed', $2, 'worker', $3::timestamptz, '{"reason":"operator"}'::jsonb)`,
    [id, key, at(emittedMs).toISOString()],
  );
  return id;
}

interface DeliveryRow extends Record<string, unknown> {
  event_id: string;
  subscriber: string;
  attempts: number;
  next_attempt_at: Date;
  delivered_at: Date | null;
  last_error_code: string | null;
}
async function deliveries(): Promise<DeliveryRow[]> {
  const { rows } = await db.query<DeliveryRow>(
    `SELECT event_id, subscriber, attempts, next_attempt_at, delivered_at, last_error_code
       FROM plugin_event_delivery ORDER BY event_id, subscriber`,
  );
  return rows;
}

const subscriber = (
  name: string,
  handler: (event: Event) => Promise<void>,
): DurableSubscriber => ({
  plugin: "@synthetic/events",
  type: "cache.flushed",
  subscriber: name,
  handler,
});

/** Record installs at T0, so events emitted afterwards are delivered. */
const installAt0 = (subscribers: DurableSubscriber[]) =>
  deliverEvents(db, subscribers, { now: clockAt(0) });

describe("backoff", () => {
  it("is min(2^attempts, 3600) s plus up to a tenth as jitter", () => {
    expect(backoffMs(1, () => 0)).toBe(2_000);
    expect(backoffMs(1, half)).toBe(2_100);
    expect(backoffMs(2, half)).toBe(4_200);
    expect(backoffMs(11, () => 0)).toBe(2_048_000);
    expect(backoffMs(12, () => 0)).toBe(3_600_000);
    expect(backoffMs(19, () => 0.999_999)).toBe(3_959_999);
  });
});

describe("worker deliver-events", () => {
  it("two subscribers: one fails twice then succeeds, attempts and next_attempt_at follow the backoff", async () => {
    const calls: string[] = [];
    let failures = 2;
    const subscribers = [
      subscriber("synthetic-ok", async (event) => {
        calls.push(`ok:${event.idempotencyKey}`);
      }),
      subscriber("synthetic-flaky", async (event) => {
        calls.push(`flaky:${event.idempotencyKey}`);
        if (failures-- > 0) throw new RangeError("synthetic");
      }),
    ];
    await installAt0(subscribers);
    const id = await insertEvent(1_000, "k1");
    const logs: Record<string, unknown>[] = [];
    const run = (ms: number) =>
      deliverEvents(db, subscribers, {
        now: clockAt(ms),
        random: half,
        log: (entry) => logs.push(entry),
      });

    expect(await run(2_000)).toEqual({
      fanned_out: 2,
      delivered: 1,
      retried: 1,
      gave_up: 0,
      deleted: 0,
    });
    let rows = await deliveries();
    const flaky = () => rows.find((r) => r.subscriber === "synthetic-flaky")!;
    const ok = () => rows.find((r) => r.subscriber === "synthetic-ok")!;
    expect(ok()).toMatchObject({
      event_id: id,
      attempts: 1,
      last_error_code: null,
    });
    expect(ok().delivered_at?.toISOString()).toBe(at(2_000).toISOString());
    expect(flaky()).toMatchObject({
      attempts: 1,
      delivered_at: null,
      last_error_code: "handler_failed",
    });
    expect(flaky().next_attempt_at.toISOString()).toBe(
      at(2_000 + 2_100).toISOString(),
    );

    // Not due yet: nothing is called.
    expect((await run(4_000)).retried).toBe(0);
    rows = await deliveries();
    expect(flaky().attempts).toBe(1);

    expect((await run(4_100)).retried).toBe(1);
    rows = await deliveries();
    expect(flaky()).toMatchObject({
      attempts: 2,
      last_error_code: "handler_failed",
    });
    expect(flaky().next_attempt_at.toISOString()).toBe(
      at(4_100 + 4_200).toISOString(),
    );

    expect((await run(8_300)).delivered).toBe(1);
    rows = await deliveries();
    expect(flaky()).toMatchObject({ attempts: 3, last_error_code: null });
    expect(flaky().delivered_at?.toISOString()).toBe(at(8_300).toISOString());

    expect(calls).toEqual(["flaky:k1", "ok:k1", "flaky:k1", "flaky:k1"]);
    expect(logs.map((entry) => entry.event)).toEqual([
      "delivery_failed",
      "delivery_failed",
    ]);
    // Delivery never logs payloads.
    expect(JSON.stringify(logs)).not.toContain("operator");
    expect(logs[0]).toEqual({
      event: "delivery_failed",
      event_type: "cache.flushed",
      subscriber: "synthetic-flaky",
      attempts: 1,
      error_code: "handler_failed",
      error_class: "RangeError",
    });
  });

  it("gives up after 20 attempts and stops selecting the row", async () => {
    let calls = 0;
    const subscribers = [
      subscriber("synthetic-down", async () => {
        calls += 1;
        throw new Error("synthetic");
      }),
    ];
    await installAt0(subscribers);
    await insertEvent(1_000);
    let clock = 2_000;
    let gaveUp = 0;
    for (let i = 0; i < MAX_ATTEMPTS + 3; i += 1) {
      const report = await deliverEvents(db, subscribers, {
        now: () => at(clock),
        random: () => 0,
      });
      gaveUp += report.gave_up;
      clock += 3_600_000 + 1_000;
    }
    expect(calls).toBe(MAX_ATTEMPTS);
    expect(gaveUp).toBe(1);
    expect(await deliveries()).toMatchObject([
      { attempts: 20, delivered_at: null, last_error_code: "gave_up" },
    ]);
  });

  it("a handler past its time limit is retried as handler_timeout", async () => {
    const subscribers = [
      subscriber("synthetic-slow", () => new Promise<void>(() => {})),
    ];
    await installAt0(subscribers);
    await insertEvent(1_000);
    const report = await deliverEvents(db, subscribers, {
      now: clockAt(2_000),
      handlerTimeoutMs: 50,
    });
    expect(report.retried).toBe(1);
    expect(await deliveries()).toMatchObject([
      { attempts: 1, last_error_code: "handler_timeout" },
    ]);
  });

  it("fans out only to subscribers installed when the event was emitted", async () => {
    const seen: string[] = [];
    const early = subscriber("synthetic-early", async (e) => {
      seen.push(`early:${e.idempotencyKey}`);
    });
    const late = subscriber("synthetic-late", async (e) => {
      seen.push(`late:${e.idempotencyKey}`);
    });
    await insertEvent(-1_000, "before-any");
    await deliverEvents(db, [early], { now: clockAt(0) });
    expect(await deliveries()).toEqual([]);
    const { rows: installs } = await db.query(
      "SELECT plugin, key, value FROM plugin_state ORDER BY key",
    );
    expect(installs).toEqual([
      {
        plugin: "@synthetic/events",
        key: installKey(early),
        value: { installedAt: at(0).toISOString() },
      },
    ]);
    expect(installKey(early)).toBe(
      "core:subscriber:synthetic-early:cache.flushed",
    );

    await insertEvent(1_000, "after-early");
    await deliverEvents(db, [early], { now: clockAt(2_000) });
    // The late subscriber installs at 3 s: the 1 s event already has deliveries, so it is skipped.
    await deliverEvents(db, [early, late], { now: clockAt(3_000) });
    await insertEvent(4_000, "after-late");
    await deliverEvents(db, [early, late], { now: clockAt(5_000) });
    // A second run keeps the first installation time.
    await deliverEvents(db, [early, late], { now: clockAt(6_000) });
    expect(seen).toEqual([
      "early:after-early",
      "early:after-late",
      "late:after-late",
    ]);
    const { rows } = await db.query<{ value: unknown }>(
      "SELECT value FROM plugin_state WHERE key = $1",
      [installKey(late)],
    );
    expect(rows).toEqual([{ value: { installedAt: at(3_000).toISOString() } }]);
  });

  it("deletes fully delivered outbox rows older than 30 days, and nothing else", async () => {
    const day = 86_400_000;
    let fail = false;
    const subscribers = [
      subscriber("synthetic-cleanup", async () => {
        if (fail) throw new Error("synthetic");
      }),
    ];
    await installAt0(subscribers);
    const delivered = await insertEvent(1_000, "delivered");
    await deliverEvents(db, subscribers, { now: clockAt(2_000) });
    fail = true;
    const pending = await insertEvent(3_000, "pending");
    await deliverEvents(db, subscribers, { now: clockAt(4_000) });
    const recent = await insertEvent(25 * day, "recent");
    // At 31 days "delivered" is old and done, "pending" is old and still failing, "recent" is new.
    const report = await deliverEvents(db, subscribers, {
      now: clockAt(31 * day),
    });
    expect(report.deleted).toBe(1);
    const { rows } = await db.query<{ event_id: string }>(
      "SELECT event_id FROM plugin_event_outbox ORDER BY emitted_at",
    );
    expect(rows.map((r) => r.event_id)).toEqual([pending, recent]);
    expect(rows.map((r) => r.event_id)).not.toContain(delivered);
  });

  it("deletes old outbox rows that no subscriber ever matched", async () => {
    await insertEvent(-40 * 86_400_000, "unsubscribed");
    const report = await deliverEvents(db, [], { now: clockAt(0) });
    expect(report).toMatchObject({ fanned_out: 0, deleted: 1 });
  });
});

/**
 * Two deliverers over simulated concurrent sessions. Deliverer A holds the first row inside its
 * handler until B has finished. B must deliver the other rows without waiting and must never
 * take the row A holds.
 */
async function parallelDeliverers(
  deliver: typeof DeliverModule.deliverEvents,
): Promise<{ counts: Record<string, number>; bFinishedWhileAHeld: boolean }> {
  const sessions = concurrentSessions(pg);
  const counts: Record<string, number> = {};
  const count = (event: Event) => {
    counts[event.idempotencyKey] = (counts[event.idempotencyKey] ?? 0) + 1;
  };
  let holding!: () => void;
  const aHolds = new Promise<void>((resolve) => (holding = resolve));
  let releaseA!: () => void;
  const gate = new Promise<void>((resolve) => (releaseA = resolve));
  let first = true;
  const a = [
    subscriber("synthetic-shared", async (event) => {
      count(event);
      if (first) {
        first = false;
        holding();
        await gate;
      }
    }),
  ];
  const b = [subscriber("synthetic-shared", async (event) => count(event))];
  await deliver(sessions, a, { now: clockAt(0) });
  for (const key of ["e1", "e2", "e3"]) await insertEvent(1_000, key);
  const runA = deliver(sessions, a, { now: clockAt(2_000) });
  await aHolds;
  const runB = deliver(sessions, b, { now: clockAt(2_000) });
  const winner = await Promise.race([
    runB.then(() => "finished"),
    new Promise((resolve) => setTimeout(() => resolve("waiting"), 1_500)),
  ]);
  releaseA();
  await Promise.all([runA, runB]);
  return { counts, bFinishedWhileAHeld: winner === "finished" };
}

describe("parallel deliverers", () => {
  it("never double-deliver, and the second does not wait for the first", async () => {
    const result = await parallelDeliverers(deliverEvents);
    expect(result).toEqual({
      counts: { e1: 1, e2: 1, e3: 1 },
      bFinishedWhileAHeld: true,
    });
  });

  it.each([
    [
      "without SKIP LOCKED the second deliverer waits on the held row",
      "FOR UPDATE OF d",
    ],
    ["without the lock clause a held row is delivered twice", ""],
  ])("mutant: %s", async (_name, replacement) => {
    const mutant = await plantMutant(
      new URL("../src/worker/deliver-events.ts", import.meta.url),
      '"FOR UPDATE OF d SKIP LOCKED"',
      JSON.stringify(replacement),
    );
    try {
      const loaded = (await import(
        pathToFileURL(mutant.path).href
      )) as typeof DeliverModule;
      const result = await parallelDeliverers(loaded.deliverEvents);
      expect(result).not.toEqual({
        counts: { e1: 1, e2: 1, e3: 1 },
        bFinishedWhileAHeld: true,
      });
      if (replacement === "")
        expect(Math.max(...Object.values(result.counts))).toBe(2);
      else expect(result.bFinishedWhileAHeld).toBe(false);
    } finally {
      await mutant.cleanup();
    }
  });
});

describe("worker commands for events", () => {
  interface Run {
    code: number;
    out: string[];
    err: string[];
    opened: (string | undefined)[];
  }
  const savedUrl = process.env.DATABASE_URL;
  const run = async (
    args: string[],
    host: Parameters<typeof runWorker>[5] = {},
  ): Promise<Run> => {
    const result: Run = { code: 0, out: [], err: [], opened: [] };
    process.env.DATABASE_URL = "postgres://synthetic@localhost:5432/synthetic";
    try {
      result.code = await runWorker(
        args,
        (connection) => {
          result.opened.push(connection);
          return { ...db, close: async () => {} };
        },
        { out: (l) => result.out.push(l), error: (l) => result.err.push(l) },
        undefined,
        [],
        host,
      );
    } finally {
      if (savedUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = savedUrl;
    }
    return result;
  };

  it("deliver-events opens with a 60 s query timeout and reports counts", async () => {
    const result = await run(["deliver-events"]);
    expect(result.code).toBe(0);
    expect(
      result.opened.map((c) => new URL(c!).searchParams.get("query_timeout")),
    ).toEqual(["60000"]);
    expect(JSON.parse(result.out[0]!)).toEqual({
      fanned_out: 0,
      delivered: 0,
      retried: 0,
      gave_up: 0,
      deleted: 0,
    });
    expect((await run(["deliver-events", "extra"])).err).toEqual([
      "Usage: worker deliver-events",
    ]);
  });

  it("deliver-events delivers to durable subscriptions registered by plugins", async () => {
    const seen: string[] = [];
    const spec = {
      type: "cache.flushed" as const,
      durable: true,
      subscriber: "synthetic-cli",
      handler: async (event: Event) => {
        seen.push(event.idempotencyKey);
      },
    };
    const host = { subscriptions: [{ plugin: "@synthetic/cli", spec }] };
    await run(["deliver-events"], host);
    await db.query(
      `INSERT INTO plugin_event_outbox (event_id, event_type, idempotency_key, emitted_by, emitted_at, payload)
       VALUES ($1, 'cache.flushed', 'cli-1', 'worker', now(), '{"reason":"operator"}')`,
      [randomUUID()],
    );
    const result = await run(["deliver-events"], host);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out[0]!)).toMatchObject({
      fanned_out: 1,
      delivered: 1,
    });
    expect(seen).toEqual(["cli-1"]);
  });

  it("emit writes one outbox row as the worker, idempotent on its key", async () => {
    const args = [
      "emit",
      "cache.flushed",
      "--payload",
      '{"reason":"operator"}',
    ];
    const first = await run(args);
    const second = await run(args);
    expect([first.code, second.code]).toEqual([0, 0]);
    const key = defaultIdempotencyKey("cache.flushed", { reason: "operator" });
    expect(JSON.parse(first.out[0]!)).toEqual({
      type: "cache.flushed",
      idempotency_key: key,
    });
    const { rows } = await db.query(
      "SELECT event_type, idempotency_key, emitted_by, payload FROM plugin_event_outbox",
    );
    expect(rows).toEqual([
      {
        event_type: "cache.flushed",
        idempotency_key: key,
        emitted_by: "worker",
        payload: { reason: "operator" },
      },
    ]);
    const keyed = await run([...args, "--idempotency-key", "release-1"]);
    expect(keyed.code).toBe(0);
    expect(JSON.parse(keyed.out[0]!).idempotency_key).toBe("release-1");
  });

  it("emit refuses bad arguments and payloads without printing payload values", async () => {
    for (const args of [
      ["emit"],
      ["emit", "cache.flushed"],
      ["emit", "--payload", "{}"],
      ["emit", "cache.flushed", "--payload", "{}", "--extra", "x"],
    ]) {
      const result = await run(args);
      expect(result.code).toBe(1);
      expect(result.err).toEqual([
        "Usage: worker emit TYPE --payload JSON [--idempotency-key KEY]",
      ]);
    }
    const notJson = await run([
      "emit",
      "cache.flushed",
      "--payload",
      "{secret",
    ]);
    expect(notJson.err).toEqual(["worker emit: --payload is not JSON"]);
    const extra = await run([
      "emit",
      "cache.flushed",
      "--payload",
      '{"reason":"operator","requestBody":"private-value"}',
    ]);
    expect(extra.code).toBe(1);
    expect(extra.err.join("\n")).toMatch(
      /^worker emit refused: invalid_payload/,
    );
    expect(extra.err.join("\n")).not.toContain("private-value");
    const unknown = await run(["emit", "synthetic.unknown", "--payload", "{}"]);
    expect(unknown.err).toEqual([
      "worker emit refused: unknown_event_type: type is not in catalog",
    ]);
    const { rows } = await db.query("SELECT 1 FROM plugin_event_outbox");
    expect(rows).toEqual([]);
  });
});
