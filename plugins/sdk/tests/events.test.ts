import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { eventPayloadSchemas } from "../src/index.js";
import type { EventPayloads } from "../src/index.js";
import { checkEventPayloads } from "../../../src/plugins/testing/checks.js";
import { plantMutant } from "../../../src/plugins/testing/artifacts.js";

// All event inputs in this file are synthetic.
const examples = {
  "release.deployed": {
    version: "1.0.0",
    imageId: "synthetic-image",
    previousVersion: null,
  },
  "release.rolled_back": {
    version: "1.0.0",
    imageId: "synthetic-image",
    fromVersion: "1.1.0",
  },
  "snapshot.activated": {
    sourceId: "synthetic",
    snapshotId: "synthetic-receipt",
    rows: 1,
  },
  "snapshot.quarantined": {
    sourceId: "synthetic",
    snapshotId: "synthetic-receipt",
    reasonCode: "invalid_rows",
  },
  "ingest.started": {
    sourceId: "synthetic",
    command: ["ingest", "synthetic"],
    scope: { state: "TX", year: 2026 },
  },
  "ingest.completed": {
    sourceId: "synthetic",
    command: ["ingest", "synthetic"],
    durationMs: 2,
    snapshotIds: ["synthetic-receipt"],
  },
  "ingest.failed": {
    sourceId: "synthetic",
    command: ["ingest", "synthetic"],
    reasonCode: "invalid_rows",
  },
  "readiness.failed": { check: "synthetic", reasonCode: "missing" },
  "audit.failed": { step: "synthetic", reasonCode: "missing" },
  "passthrough.budget_exhausted": { sourceId: "synthetic", dailyMax: 1 },
  "passthrough.breaker_open": {
    sourceId: "synthetic",
    untilAt: "2026-11-11T00:00:00Z",
  },
  "cache.flushed": { reason: "generation" },
  "health.changed": { component: "api", from: "ok", to: "down" },
  "record_policy.changed": {
    policy: "synthetic",
    ttl: null,
    staleWindow: "1 day",
  },
  "plugin.loaded": { plugins: [{ name: "synthetic", version: "1.0.0" }] },
} satisfies EventPayloads;

describe("event catalog", () => {
  it("has all 15 payload schemas and permits only inspectable, safe property names", () => {
    expect(Object.keys(eventPayloadSchemas).sort()).toEqual(
      Object.keys(examples).sort(),
    );
    expect(Object.keys(eventPayloadSchemas)).toHaveLength(15);
    expect(checkEventPayloads(eventPayloadSchemas)).toEqual([]);
    for (const [type, schema] of Object.entries(eventPayloadSchemas)) {
      const payload = examples[type as keyof EventPayloads];
      expect(schema.safeParse(payload).success, type).toBe(true);
      expect(
        schema.safeParse({ ...payload, requestBody: "synthetic" }).success,
        type,
      ).toBe(false);
    }
  });

  it("mutant: adding requestBody to one catalog schema fails the scanner", async () => {
    const mutant = await plantMutant(
      new URL("../src/events.ts", import.meta.url),
      "rows: count",
      "rows: count, requestBody: z.string()",
    );
    try {
      const loaded = (await import(pathToFileURL(mutant.path).href)) as {
        eventPayloadSchemas: typeof eventPayloadSchemas;
      };
      expect(checkEventPayloads(loaded.eventPayloadSchemas)).toEqual([
        "snapshot.activated/requestBody: forbidden payload property",
      ]);
      expect(checkEventPayloads(eventPayloadSchemas)).toEqual([]);
    } finally {
      await mutant.cleanup();
    }
  });

  it.each([
    "zip",
    "age",
    "income",
    "tobacco",
    "household",
    "members",
    "body",
    "url",
    "path",
    "host",
    "key",
    "token",
    "secret",
    "password",
    "connection",
  ])("rejects nested %s fields inside wrapped unions and arrays", (name) => {
    const schema = z.strictObject({
      nested: z
        .array(
          z.union([
            z.strictObject({ safe: z.string() }),
            z.strictObject({ [name.toUpperCase()]: z.string() }).nullable(),
          ]),
        )
        .optional(),
    });
    expect(
      checkEventPayloads({ synthetic: schema }).some((problem) =>
        problem.includes(`${name.toUpperCase()}: forbidden`),
      ),
    ).toBe(true);
  });

  it("allows only exact exceptions; rejects uninspectable or open schemas", () => {
    expect(
      checkEventPayloads({
        synthetic: z.strictObject({ imageId: z.string(), untilAt: z.string() }),
      }),
    ).toEqual([]);
    expect(
      checkEventPayloads({
        synthetic: z.strictObject({ imageIdToken: z.string() }),
      }),
    ).toHaveLength(1);
    for (const schema of [
      z.unknown(),
      z.record(z.string(), z.string()),
      z.looseObject({}),
      z.string().transform((s) => s),
    ])
      expect(checkEventPayloads({ synthetic: schema }).length).toBeGreaterThan(
        0,
      );
  });

  it("rejects invalid enums, timestamps, negative counts and missing fields", () => {
    expect(
      eventPayloadSchemas["snapshot.activated"].safeParse({
        ...examples["snapshot.activated"],
        rows: -1,
      }).success,
    ).toBe(false);
    expect(
      eventPayloadSchemas["passthrough.breaker_open"].safeParse({
        sourceId: "synthetic",
        untilAt: "tomorrow",
      }).success,
    ).toBe(false);
    expect(
      eventPayloadSchemas["health.changed"].safeParse({
        component: "api",
        from: "ok",
        to: "healthy",
      }).success,
    ).toBe(false);
    for (const schema of Object.values(eventPayloadSchemas))
      expect(schema.safeParse({}).success).toBe(false);
  });
});
