import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import type { OpenPlansPlugin } from "../src/index.js";
import {
  checkCatalogTriggers,
  checkRouteResponses,
  checkRowProvenance,
  loadForTest,
  plantMutant,
  responseDigests,
} from "../../../src/plugins/testing/index.js";

// All plugin inputs, identifiers and records below are synthetic.
let fixture: Awaited<ReturnType<typeof loadForTest>>;
let teardowns = 0;
const plugin: OpenPlansPlugin = {
  manifest: {
    name: "@openplans/plugin-synthetic",
    version: "0.1.0",
    apiVersion: "0.1",
    kinds: ["routes", "events", "workerCommands", "schedules"],
    capabilities: {
      writes: ["staging", "events"],
      secrets: ["SYNTHETIC_SECRET"],
    },
    options: z.strictObject({ message: z.string() }),
  },
  setup: async (ctx) => {
    const options = ctx.options as { message: string };
    ctx.routes.add({
      method: "GET",
      path: "/synthetic",
      exposure: "public",
      contentType: "application/json",
      handler: (c) => c.json({ message: options.message }),
    });
    ctx.routes.add({
      method: "GET",
      path: "/synthetic-leak",
      exposure: "public",
      contentType: "application/json",
      handler: (c) => c.json({ nested: [{ sourced_slug: "synthetic" }] }),
    });
    ctx.workerCommands.add({
      argv: ["ingest", "synthetic"],
      usage: "ingest synthetic",
      run: async () => 0,
    });
    ctx.schedules.add({
      name: "synthetic",
      cron: "* * * * *",
      command: ["ingest", "synthetic"],
      maxRunMs: 100,
    });
    ctx.events.on("cache.flushed", async () => {}, {
      durable: false,
      subscriber: "synthetic",
    });
    await ctx.events.emit({
      type: "cache.flushed",
      idempotencyKey: "synthetic",
      payload: { reason: "operator" },
    });
    ctx.log({ code: "synthetic_setup" });
  },
  teardown: async () => {
    teardowns++;
  },
};
beforeAll(async () => {
  fixture = await loadForTest(plugin, {
    options: { message: "synthetic" },
    secrets: { SYNTHETIC_SECRET: "synthetic", UNDECLARED: "synthetic" },
  });
});
afterAll(async () => {
  await fixture?.close();
});

it("runs isolated setup and records registrations without delivering events", async () => {
  expect(await (await fixture.app.request("/synthetic")).json()).toEqual({
    message: "synthetic",
  });
  expect(fixture.registrations.routes).toHaveLength(2);
  expect(fixture.registrations.workerCommands[0]?.argv).toEqual([
    "ingest",
    "synthetic",
  ]);
  expect(fixture.registrations.schedules).toHaveLength(1);
  expect(fixture.registrations.subscriptions).toHaveLength(1);
  expect(fixture.events).toEqual([
    {
      type: "cache.flushed",
      idempotencyKey: "synthetic",
      payload: { reason: "operator" },
    },
  ]);
  expect(fixture.logs).toEqual([{ code: "synthetic_setup" }]);
  expect(fixture.context.db.writer).toBe(fixture.db);
  expect(fixture.context.secrets.get("SYNTHETIC_SECRET")).toBe("synthetic");
  expect(fixture.context.secrets.get("UNDECLARED")).toBeUndefined();
  await expect(
    fixture.context.fetch("https://synthetic.invalid/", {
      expectedContent: "json",
      maxBytes: 10,
    }),
  ).rejects.toThrow("Test fetch must be injected");
  await expect(fixture.app.request("/synthetic-leak")).rejects.toThrow(
    "nested/*/sourced_slug",
  );
});

it("checks migrated provenance and catalog triggers; planted missing and disabled triggers fail", async () => {
  expect(await checkRowProvenance(fixture.db)).toEqual([]);
  expect(await checkCatalogTriggers(fixture.db)).toEqual([]);
  await fixture.db.exec("CREATE TABLE synthetic_public(id integer)");
  try {
    expect(await checkCatalogTriggers(fixture.db)).toEqual([
      "synthetic_public: no api_data_changed trigger",
    ]);
    expect(await checkRowProvenance(fixture.db)).toContain(
      "synthetic_public: missing sourced_at",
    );
    await fixture.db
      .exec(`CREATE TRIGGER api_data_changed AFTER INSERT ON synthetic_public
      FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation()`);
    expect(await checkCatalogTriggers(fixture.db)).toEqual([
      "synthetic_public: no api_data_changed trigger",
    ]);
    await fixture.db.exec(`DROP TRIGGER api_data_changed ON synthetic_public;
      CREATE TRIGGER api_data_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE
      ON synthetic_public FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation()`);
    expect(await checkCatalogTriggers(fixture.db)).toEqual([]);
    await fixture.db.exec(
      "ALTER TABLE synthetic_public DISABLE TRIGGER api_data_changed",
    );
    expect(await checkCatalogTriggers(fixture.db)).toEqual([
      "synthetic_public: no api_data_changed trigger",
    ]);
    expect(
      await checkCatalogTriggers(fixture.db, { synthetic_public: " " }),
    ).toContain("synthetic_public: no api_data_changed trigger");
  } finally {
    await fixture.db.exec("DROP TABLE synthetic_public");
  }
});

it("hashes raw bytes and all five pinned headers; changed response bytes fail comparison", async () => {
  const app = new Hono();
  app.get("/synthetic", (c) => {
    c.header("cache-control", "public, max-age=5");
    c.header("x-cache", "miss");
    return c.text("synthetic\n");
  });
  const corpus = [{ id: "synthetic", path: "/synthetic" }];
  const original = await responseDigests(app, corpus);
  expect(original.synthetic).toEqual({
    status: 200,
    body_sha256: createHash("sha256").update("synthetic\n").digest("hex"),
    headers: {
      "content-type": "text/plain; charset=UTF-8",
      "cache-control": "public, max-age=5",
      "x-cache": "miss",
      "x-openplans-gaps": null,
      "x-quote-tier": null,
    },
  });
  const mutant = new Hono().get("/synthetic", (c) => c.text("synthetic"));
  expect(await responseDigests(mutant, corpus)).not.toEqual(original);
  await expect(responseDigests(app, [...corpus, ...corpus])).rejects.toThrow(
    "Duplicate corpus id",
  );
});

it("guards only JSON responses and preserves the request receiver", async () => {
  const app = checkRouteResponses({
    message: "synthetic",
    request() {
      return new Response(JSON.stringify({ message: this.message }), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  expect(await (await app.request()).json()).toEqual({ message: "synthetic" });
  const html = checkRouteResponses(
    new Hono().get("/", (c) => c.html("created_at")),
  );
  expect((await html.request("/")).status).toBe(200);
});

it("plants a syntax mutant in a disposable copy and leaves its original unchanged", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "openplans-synthetic-source-"),
  );
  const file = join(directory, "source.ts");
  await writeFile(file, "export const safe = true;\n");
  let mutant: Awaited<ReturnType<typeof plantMutant>> | undefined;
  try {
    mutant = await plantMutant(file, "safe = true", "safe = false");
    expect(await readFile(file, "utf8")).toContain("safe = true");
    expect(await readFile(mutant.path, "utf8")).toContain("safe = false");
    await expect(
      plantMutant(file, "absent = true", "absent = false"),
    ).rejects.toThrow("exactly once");
  } finally {
    await mutant?.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
  await expect(readFile(mutant!.path)).rejects.toThrow();
});

it("rejects invalid options before setup; cleanup is idempotent and injected databases stay open", async () => {
  await expect(
    loadForTest(plugin, { options: { message: 42 } }),
  ).rejects.toThrow();
  let calls = 0;
  const test = await loadForTest(
    {
      ...plugin,
      manifest: {
        ...plugin.manifest,
        options: undefined,
        capabilities: undefined,
      },
      setup: (ctx) => {
        calls++;
        expect(ctx.db.writer).toBeUndefined();
      },
      teardown: async () => {
        calls++;
      },
    },
    { db: fixture.db },
  );
  await test.close();
  await test.close();
  expect(calls).toBe(2);
  expect((await fixture.db.query("SELECT 1 AS value")).rows).toEqual([
    { value: 1 },
  ]);
  expect(teardowns).toBe(0);
});
