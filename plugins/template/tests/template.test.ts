import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import {
  PLUGIN_API_VERSION,
  pluginManifestSchema,
} from "@openplans/plugin-sdk";
import type {
  Event,
  McpToolSpec,
  OpenPlansPlugin,
} from "@openplans/plugin-sdk";
import { migrate } from "../../../src/db/migrate.js";
import {
  callPluginTool,
  pluginToolDefinition,
} from "../../../src/plugins/mcp-tools.js";
import {
  loadForTest,
  plantMutant,
} from "../../../src/plugins/testing/index.js";
import { loadWorkerPlugins } from "../../../src/plugins/worker.js";
import { runWorker } from "../../../src/worker/commands.js";
import { coreMigrations, testDatabase } from "../../../tests/pglite.js";
import plugin, {
  HELLO_ARGV,
  HELLO_PATH,
  HELLO_TOOL,
  PLUGIN_NAME,
  RUNS_KEY,
  SUBSCRIBER,
} from "../src/index.js";

const indexFile = fileURLToPath(new URL("../src/index.ts", import.meta.url));

/** What the public route must do. An empty list means it works. */
async function routeProblems(candidate: OpenPlansPlugin): Promise<string[]> {
  const loaded = await loadForTest(candidate, { options: { greeting: "hi" } });
  try {
    const problems: string[] = [];
    const ok = await loaded.app.request(`${HELLO_PATH}?name=Ada`);
    if (ok.status !== 200) problems.push(`status ${ok.status}`);
    else if (JSON.stringify(await ok.json()) !== '{"greeting":"hi, Ada"}')
      problems.push("wrong greeting");
    const bad = await loaded.app.request(`${HELLO_PATH}?name=%3Cb%3E`);
    if (bad.status !== 400) problems.push(`bad name answered ${bad.status}`);
    return problems;
  } finally {
    await loaded.close();
  }
}

describe("template plugin", () => {
  it("declares a valid manifest for the current API version", () => {
    const manifest = pluginManifestSchema.parse(plugin.manifest);
    expect(manifest.name).toBe(PLUGIN_NAME);
    expect(manifest.apiVersion).toBe(PLUGIN_API_VERSION);
    expect(manifest.kinds).toEqual([
      "routes",
      "mcpTools",
      "workerCommands",
      "events",
    ]);
  });

  it("registers one route, one tool, one command and one non-durable handler", async () => {
    const loaded = await loadForTest(plugin);
    try {
      const { registrations } = loaded;
      expect(registrations.routes).toMatchObject([
        { method: "GET", path: HELLO_PATH, exposure: "public" },
      ]);
      expect(registrations.mcpTools).toMatchObject([
        { name: HELLO_TOOL, readOnly: true },
      ]);
      expect(registrations.workerCommands).toMatchObject([
        { argv: HELLO_ARGV },
      ]);
      expect(registrations.subscriptions).toMatchObject([
        {
          type: "snapshot.activated",
          options: { durable: false, subscriber: SUBSCRIBER },
        },
      ]);
      expect(registrations.schedules).toEqual([]);
    } finally {
      await loaded.close();
    }
  });

  it("serves the greeting on its public route and refuses a bad name", async () => {
    expect(await routeProblems(plugin)).toEqual([]);
  });

  it("uses the default greeting when no options are given", async () => {
    const loaded = await loadForTest(plugin);
    try {
      const response = await loaded.app.request(HELLO_PATH);
      expect(await response.json()).toEqual({ greeting: "hello, world" });
    } finally {
      await loaded.close();
    }
  });

  it("answers the MCP tool through the core's tool runner", async () => {
    const loaded = await loadForTest(plugin);
    try {
      const tool = loaded.registrations.mcpTools[0] as McpToolSpec<
        unknown,
        unknown
      >;
      expect(pluginToolDefinition(tool).inputSchema.type).toBe("object");
      const result = await callPluginTool(
        { db: loaded.db },
        tool,
        { name: "Ada" },
        new AbortController().signal,
      );
      expect(result.structuredContent).toEqual({ greeting: "hello, Ada" });
      const refused = await callPluginTool(
        { db: loaded.db },
        tool,
        { name: "<b>" },
        new AbortController().signal,
      );
      expect(refused.isError).toBe(true);
    } finally {
      await loaded.close();
    }
  });

  it("logs each activated snapshot from its event handler", async () => {
    const loaded = await loadForTest(plugin);
    try {
      const [subscription] = loaded.registrations.subscriptions;
      const handler = subscription!.handler as (
        event: Event<"snapshot.activated">,
      ) => Promise<void>;
      await handler({
        id: "00000000-0000-4000-8000-000000000001",
        type: "snapshot.activated",
        emittedAt: "2026-01-01T00:00:00.000Z",
        emittedBy: "openplans",
        idempotencyKey: "synthetic-key",
        payload: { sourceId: "synthetic", snapshotId: "snap-1", rows: 3 },
      });
      expect(loaded.logs).toEqual([
        { code: "template_snapshot_seen", source: "synthetic" },
      ]);
    } finally {
      await loaded.close();
    }
  });

  it("loads through the worker and counts runs in plugin state", async () => {
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
      const run = (args: string[]) =>
        runWorker(
          args,
          () => ({ ...target, close: async () => {} }),
          { out: () => {}, error: () => {} },
          undefined,
          plugins.commands,
          { subscriptions: plugins.subscriptions },
        );
      expect(await run([...HELLO_ARGV])).toBe(0);
      expect(await run([...HELLO_ARGV])).toBe(0);
      expect(await run([...HELLO_ARGV, "extra"])).toBe(1);
      const { rows } = await target.query<{ value: unknown }>(
        "SELECT value FROM plugin_state WHERE plugin = $1 AND key = $2",
        [PLUGIN_NAME, RUNS_KEY],
      );
      expect(rows).toEqual([{ value: 2 }]);
    } finally {
      await target.close();
      await core.cleanup();
    }
  });

  it("planted mutant: a broken route path fails the route check", async () => {
    const mutant = await plantMutant(
      indexFile,
      "path: HELLO_PATH,",
      'path: "/template/helo",',
    );
    try {
      const broken = (await import(mutant.path)) as {
        default: OpenPlansPlugin;
      };
      expect(await routeProblems(broken.default)).toEqual([
        "status 404",
        "bad name answered 404",
      ]);
    } finally {
      await mutant.cleanup();
    }
  });
});
