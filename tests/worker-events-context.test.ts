import { PGlite } from "@electric-sql/pglite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../src/db/database.js";
import { migrate } from "../src/db/migrate.js";
import { loadWorkerPlugins } from "../src/plugins/worker.js";
import type { WorkerPlugins } from "../src/plugins/worker.js";
import { runWorker } from "../src/worker/commands.js";
import type { WorkerHost } from "../src/worker/commands.js";
import { coreMigrations, testDatabase } from "./pglite.js";

// ctx.events, ctx.state and ctx.signal inside plugin worker commands. Synthetic plugins only.
const scratch = await mkdtemp(join(tmpdir(), "openplans-worker-context-"));
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
  await rm(scratch, { recursive: true, force: true });
});
beforeEach(async () => {
  await db.exec("DELETE FROM plugin_event_outbox; DELETE FROM plugin_state;");
  globalThis.syntheticContext = [];
});
declare global {
  var syntheticContext: unknown[];
}

const plugin = async (name: string, writes: string[], body: string) => {
  const directory = join(scratch, name);
  await mkdir(directory, { recursive: true });
  const file = join(directory, "index.mjs");
  await writeFile(
    file,
    `// Synthetic worker plugin fixture.
const record = (entry) => globalThis.syntheticContext.push(entry);
export default {
  manifest: ${JSON.stringify({
    name: `@synthetic/${name}`,
    version: "0.0.1",
    apiVersion: "0.1",
    kinds: ["workerCommands", "events"],
    capabilities: { writes },
  })},
  setup(ctx) {
${body}
  },
};
`,
  );
  return file;
};

const emitter = await plugin(
  "emitter",
  ["events"],
  `    ctx.events.on("cache.flushed", async (event) => record({ heard: event.idempotencyKey }), {
      durable: false,
      subscriber: "synthetic-listener",
    });
    ctx.workerCommands.add({
      argv: ["synthetic", "emit"],
      usage: "Usage: worker synthetic emit",
      async run(args, ctx) {
        await ctx.events.emit({ type: "cache.flushed", idempotencyKey: "from-command", payload: { reason: "operator" } });
        let on = "allowed";
        try {
          ctx.events.on("cache.flushed", async () => {}, { durable: true, subscriber: "late" });
        } catch {
          on = "refused";
        }
        record({ on });
        return 0;
      },
    });
    ctx.workerCommands.add({
      argv: ["synthetic", "state"],
      usage: "Usage: worker synthetic state",
      async run(args, ctx) {
        const before = await ctx.state.get("cursor");
        await ctx.state.set("cursor", { last: 7, at: "2026-11-11T00:00:00.000Z" });
        const after = await ctx.state.get("cursor");
        const refused = [];
        for (const key of ["core:subscriber:x", "", "bad key"]) {
          try {
            await ctx.state.set(key, 1);
          } catch (error) {
            refused.push(error.code);
          }
        }
        try {
          await ctx.state.set("fn", () => 1);
        } catch (error) {
          refused.push(error.code);
        }
        await ctx.state.set("gone", true);
        await ctx.state.delete("gone");
        record({ before: before ?? null, after, refused, gone: (await ctx.state.get("gone")) ?? null });
        return 0;
      },
    });
    ctx.workerCommands.add({
      argv: ["synthetic", "wait"],
      usage: "Usage: worker synthetic wait",
      timeoutMs: 100,
      async run(args, ctx) {
        await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve, { once: true }));
        record({ aborted: ctx.signal.aborted });
        return 0;
      },
    });`,
);
const silent = await plugin(
  "silent",
  [],
  `    ctx.workerCommands.add({
      argv: ["synthetic", "silent"],
      usage: "Usage: worker synthetic silent",
      async run(args, ctx) {
        try {
          await ctx.events.emit({ type: "cache.flushed", idempotencyKey: "silent", payload: { reason: "operator" } });
          record({ emit: "allowed" });
        } catch (error) {
          record({ emit: error.code });
        }
        await ctx.state.set("own", 1);
        return 0;
      },
    });`,
);

const load = async (...files: string[]): Promise<WorkerPlugins> =>
  loadWorkerPlugins({
    env: { OPENPLANS_PLUGINS: files.join(",") },
    exit: (code) => {
      throw new Error(`exit ${code}`);
    },
  });
const run = async (
  args: string[],
  plugins: WorkerPlugins,
  host: WorkerHost = {},
) => {
  const err: string[] = [];
  const code = await runWorker(
    args,
    () => ({ ...db, close: async () => {} }),
    { out: () => {}, error: (line) => err.push(line) },
    undefined,
    plugins.commands,
    { subscriptions: plugins.subscriptions, ...host },
  );
  return { code, err };
};

describe("ctx.events in plugin commands", () => {
  it("emits through the bus: in-process handlers hear it and the outbox gets one row", async () => {
    const plugins = await load(emitter);
    const result = await run(["synthetic", "emit"], plugins);
    expect(result).toEqual({ code: 0, err: [] });
    expect(globalThis.syntheticContext).toEqual([
      { heard: "from-command" },
      { on: "refused" },
    ]);
    const { rows } = await db.query(
      "SELECT idempotency_key, emitted_by, payload FROM plugin_event_outbox",
    );
    expect(rows).toEqual([
      {
        idempotency_key: "from-command",
        emitted_by: "@synthetic/emitter",
        payload: { reason: "operator" },
      },
    ]);
    await plugins.teardown();
  });

  it("refuses emits from a plugin without the events capability", async () => {
    const plugins = await load(silent);
    const result = await run(["synthetic", "silent"], plugins);
    expect(result.code).toBe(0);
    expect(globalThis.syntheticContext).toEqual([
      { emit: "missing_capability" },
    ]);
    const { rows } = await db.query("SELECT 1 FROM plugin_event_outbox");
    expect(rows).toEqual([]);
    await plugins.teardown();
  });
});

describe("ctx.state", () => {
  it("reads and writes the plugin's own rows and refuses core keys and non-JSON values", async () => {
    const plugins = await load(emitter, silent);
    expect((await run(["synthetic", "state"], plugins)).code).toBe(0);
    expect((await run(["synthetic", "silent"], plugins)).code).toBe(0);
    expect(globalThis.syntheticContext[0]).toEqual({
      before: null,
      after: { last: 7, at: "2026-11-11T00:00:00.000Z" },
      refused: ["invalid_key", "invalid_key", "invalid_key", "invalid_value"],
      gone: null,
    });
    const { rows } = await db.query(
      "SELECT plugin, key, value FROM plugin_state ORDER BY plugin, key",
    );
    expect(rows).toEqual([
      {
        plugin: "@synthetic/emitter",
        key: "cursor",
        value: { last: 7, at: "2026-11-11T00:00:00.000Z" },
      },
      { plugin: "@synthetic/silent", key: "own", value: 1 },
    ]);
    await plugins.teardown();
  });
});

describe("ctx.signal", () => {
  it("aborts on the command's time limit and the run exits 1", async () => {
    const plugins = await load(emitter);
    const started = performance.now();
    const result = await run(["synthetic", "wait"], plugins);
    expect(result).toEqual({
      code: 1,
      err: ["worker synthetic wait timed out after 100 ms"],
    });
    expect(performance.now() - started).toBeLessThan(2_000);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(globalThis.syntheticContext).toEqual([{ aborted: true }]);
    await plugins.teardown();
  });

  it("takes the smaller of the command limit and the scheduler's maxRunMs, and the stop signal", async () => {
    const plugins = await load(emitter);
    const shorter = await run(["synthetic", "wait"], plugins, {
      run: { signal: new AbortController().signal, timeoutMs: 20 },
    });
    expect(shorter.err).toEqual([
      "worker synthetic wait timed out after 20 ms",
    ]);
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 10);
    const stopped = await run(["synthetic", "wait"], plugins, {
      run: { signal: stop.signal },
    });
    // The stop signal ends the wait before the 100 ms limit; the command returns 0 itself.
    expect(stopped).toEqual({ code: 0, err: [] });
    await plugins.teardown();
  });
});
