import { expect, expectTypeOf, it } from "vitest";
import type {
  Database as CoreDatabase,
  SqlSession as CoreSession,
} from "../../../src/db/database.js";
import type { CacheStore as CoreCache } from "../../../src/api/cache/store.js";
import type { SnapshotMetadata as CoreMetadata } from "../../../src/fetch/cache.js";
import { CACHE_LEVEL_ORDER } from "../src/index.js";
import type {
  CacheStore,
  Database,
  Event,
  EventInput,
  EventRegistry,
  PluginContext,
  PluginDatabase,
  RouteSpec,
  SnapshotMetadata,
  SqlSession,
  WorkerContext,
} from "../src/index.js";

it("structurally matches the host database, cache and acquisition metadata", () => {
  expectTypeOf<CoreDatabase>().toExtend<Database>();
  expectTypeOf<Database>().toExtend<CoreDatabase>();
  expectTypeOf<CoreSession>().toExtend<SqlSession>();
  expectTypeOf<SqlSession>().toExtend<CoreSession>();
  expectTypeOf<CoreCache>().toEqualTypeOf<CacheStore>();
  expectTypeOf<CoreMetadata>().toExtend<SnapshotMetadata>();
  expect(CACHE_LEVEL_ORDER).toEqual(["none", "request", "memory", "stored"]);
  expect(Object.isFrozen(CACHE_LEVEL_ORDER)).toBe(true);
});

// Compiled under the root strict config; never run these calls.
function eventTypeChecks(registry: EventRegistry, event: Event) {
  if (event.type === "snapshot.activated") {
    expectTypeOf(event.payload.rows).toEqualTypeOf<number | null>();
    // @ts-expect-error Payload narrows with its event discriminator.
    void event.payload.version;
  }
  registry.emit({
    type: "cache.flushed",
    idempotencyKey: "synthetic",
    payload: { reason: "operator" },
  });
  const wrongPayload = {
    type: "cache.flushed",
    idempotencyKey: "synthetic",
    payload: { rows: 1 },
  } as const;
  // @ts-expect-error The payload must match the event type.
  registry.emit(wrongPayload);
  const mismatched = {
    type: "cache.flushed",
    idempotencyKey: "synthetic",
    payload: { sourceId: "synthetic", snapshotId: "synthetic", rows: 1 },
  } as const;
  // @ts-expect-error Input events cannot pair an unrelated payload with a type.
  const invalid: EventInput = mismatched;
  return invalid;
}
void eventTypeChecks;

it("types the database plugins receive in setup, worker commands and routes", () => {
  expectTypeOf<WorkerContext["db"]>().toEqualTypeOf<PluginDatabase>();
  expectTypeOf<PluginContext["db"]>().toEqualTypeOf<PluginDatabase>();
  expectTypeOf<PluginDatabase["reader"]>().toEqualTypeOf<SqlSession>();
  expectTypeOf<PluginDatabase["writer"]>().toEqualTypeOf<
    Database | undefined
  >();
});

// Compiled under the root strict config; never run these handlers.
const routeTypeChecks: RouteSpec["handler"][] = [
  async (c) => {
    expectTypeOf(c.get("pluginDb")).toEqualTypeOf<SqlSession>();
    expectTypeOf(c.get("pluginSignal")).toEqualTypeOf<AbortSignal>();
    const { rows } = await c.get("pluginDb").query("SELECT 1 AS one");
    return c.json({ rows });
  },
];
void routeTypeChecks;
