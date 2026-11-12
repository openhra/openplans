import { fileURLToPath } from "node:url";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig } from "../../src/config/index.js";
import type { SqlSession } from "../../src/db/database.js";
import { createMcpHttp } from "../../src/mcp/http.js";
import { configDependencies } from "../../src/mcp/policy.js";
import { PERSONALIZED_TOOLS, toolNames } from "../../src/mcp/schemas.js";
import { buildServer } from "../../src/mcp/server.js";
import {
  MAX_TOOL_LIST_BYTES,
  TOOL_LIST_PAGE_SIZE,
} from "../../src/mcp/tools.js";
import {
  assertPluginHonest,
  callPluginTool,
  isToolName,
  loadPlugins,
  toolListBytes,
  toolPageRefusal,
} from "../../src/plugins/index.js";
import type { PluginHost, PluginTool } from "../../src/plugins/index.js";
import type * as McpTools from "../../src/plugins/mcp-tools.js";
import { plantMutant } from "../../src/plugins/testing/index.js";
import { post } from "../mcp/transport-helpers.js";

// Every plugin tool here comes from a synthetic fixture. No source data.
const fixtures = fileURLToPath(
  new URL("../fixtures/plugins/", import.meta.url),
);
const unused: SqlSession = {
  query: async () => {
    throw new Error("Plugin tool tests do not query the database");
  },
  exec: async () => {},
};
class Exit extends Error {
  constructor(readonly code: number) {
    super("exit");
  }
}
const configWith = (options: Record<string, unknown>) =>
  loadConfig(
    {},
    {
      version: 1,
      plugins: [{ package: "./synthetic-mcp-tools/index.mjs", options }],
    },
  );
async function load(
  options: Record<string, unknown>,
  host: PluginHost = "api",
) {
  const lines: string[] = [];
  try {
    const loaded = await loadPlugins(configWith(options), host, {
      env: {},
      baseDirectory: fixtures,
      manifestPaths: [],
      writeLog: (line) => lines.push(line),
      exit: (code) => {
        throw new Exit(code);
      },
    });
    return { tools: loaded.registries.mcpTools, lines };
  } catch (error) {
    if (error instanceof Exit) return { exit: error.code, lines };
    throw error;
  }
}
afterEach(async () => {
  await loadPlugins(loadConfig({}, { version: 1, plugins: [] }), "api");
});

const handlerWith = (pluginTools?: readonly PluginTool[]) =>
  createMcpHandler(
    () =>
      buildServer({
        db: unused,
        cursorSecret: "synthetic-plugin-tools-secret",
        ...(pluginTools ? { pluginTools } : {}),
      }),
    { legacy: "stateless" },
  );
async function call(
  handler: ReturnType<typeof createMcpHandler>,
  name: string,
  args: Record<string, unknown> = {},
) {
  const response = await handler.fetch(
    post("tools/call", { name, arguments: args }),
  );
  return (await response.json()) as {
    result?: {
      isError?: boolean;
      structuredContent: Record<string, unknown>;
      content: { text: string }[];
    };
    error?: { code: number };
  };
}
async function answer(kind: string, args: Record<string, unknown> = {}) {
  const { tools } = await load({ count: 1, answer: kind });
  const handler = handlerWith(tools);
  try {
    return await call(handler, "synthetic_tool_0", args);
  } finally {
    await handler.close();
  }
}

describe("plugin tool calls", () => {
  it("answers through the plugin handler with the core result framing", async () => {
    const { result } = await answer("plain", { label: "alpha" });
    expect(result!.isError).toBeUndefined();
    expect(result!.structuredContent).toEqual({ echo: "alpha" });
    expect(JSON.parse(result!.content[0]!.text)).toEqual({ echo: "alpha" });
  });

  it("passes an honest envelope that reports missing evidence as unknown", async () => {
    const { result } = await answer("unknown");
    expect(result!.isError).toBeUndefined();
    expect(result!.structuredContent.status).toBe("unknown");
  });

  it.each([
    ["not_covered", "INTERNAL_HONESTY_CHECK"],
    ["nested_denial", "INTERNAL_HONESTY_CHECK"],
    ["invalid", "INTERNAL_HONESTY_CHECK"],
    ["oversized", "RESULT_TOO_LARGE"],
  ])("refuses a %s answer with %s", async (kind, code) => {
    const { result } = await answer(kind);
    expect(result!.isError).toBe(true);
    expect(result!.structuredContent).toMatchObject({
      status: "error",
      data: null,
      error: { code },
    });
  });

  it("refuses input outside the plugin's schema", async () => {
    const reply = await answer("plain", { label: 7 });
    // The SDK's schema check refuses before the plugin handler runs.
    expect(reply.result?.isError ?? reply.error !== undefined).toBe(true);
    expect(reply.result?.structuredContent?.echo).toBeUndefined();
    // Called directly, the plugin's own parse refuses too.
    const { tools } = await load({ count: 1 });
    const direct = await callPluginTool(
      { db: unused },
      tools![0]!.spec,
      { label: 7 },
      new AbortController().signal,
    );
    expect(direct.structuredContent).toMatchObject({
      status: "error",
      error: { code: "INVALID_INPUT" },
    });
  });

  it("negative control: without the honesty check a not_covered answer passes", async () => {
    const { tools } = await load({ count: 1, answer: "not_covered" });
    const mutant = await plantMutant(
      new URL("../../src/plugins/mcp-tools.ts", import.meta.url),
      'if ("status" in output) assertPluginHonest(output);',
      "",
    );
    try {
      const module = (await import(
        /* @vite-ignore */ mutant.path
      )) as typeof McpTools;
      const result = await module.callPluginTool(
        { db: unused },
        tools![0]!.spec,
        {},
        new AbortController().signal,
      );
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent.status).toBe("not_covered");
    } finally {
      await mutant.cleanup();
    }
  });
});

describe("assertPluginHonest", () => {
  const envelope = {
    schema_version: "1",
    status: "ok",
    data_generation: "synthetic",
    provenance: [],
    notes: [],
    truncated: false,
    freshness: { checked_at: "2026-11-08T00:00:00.000Z", status: "unknown" },
    page: null,
    error: null,
    data: {},
  };
  it("accepts the core envelope and rejects denials and unsourced claims", () => {
    expect(() => assertPluginHonest(envelope)).not.toThrow();
    for (const bad of [
      { ...envelope, status: "not_covered" },
      { ...envelope, data: null },
      { ...envelope, extra: true },
      { ...envelope, data: { status: "not_in_network" } },
      { ...envelope, data: { rows: [{ status: "listed_covered" }] } },
      {
        ...envelope,
        data: { status: "unknown", evidence_refs: ["absent"], gaps: [] },
      },
    ])
      expect(() => assertPluginHonest(bad)).toThrow(/INTERNAL_HONESTY_CHECK/);
  });
});

describe("tool page bounds at load", () => {
  it("refuses tools whose definitions exceed the tools/list byte cap", async () => {
    const refused = await load({ count: 5, descriptionBytes: 100_000 });
    expect(refused.exit).toBe(1);
    expect(refused.lines.map((line) => JSON.parse(line))).toEqual([
      { plugin: "@synthetic/mcp-tools", code: "mcp_tool_page_overflow" },
    ]);
    // The same tools with short descriptions fit.
    expect((await load({ count: 5 })).exit).toBeUndefined();
  });

  it("negative control: a count-only check lets the oversized list through", async () => {
    const big = z.strictObject({});
    const spec = (index: number) => ({
      name: `synthetic_big_${index}`,
      title: "Synthetic",
      description: "x".repeat(100_000),
      inputSchema: big,
      outputSchema: big,
      readOnly: true as const,
      handler: async () => ({}),
    });
    const plugins = [["@synthetic/big", [0, 1, 2, 3, 4].map(spec)]] as const;
    expect(toolPageRefusal(plugins)).toEqual({
      plugin: "@synthetic/big",
      code: "mcp_tool_page_overflow",
    });
    const mutant = await plantMutant(
      new URL("../../src/plugins/mcp-tools.ts", import.meta.url),
      "|| toolListBytes(tools) > MAX_TOOL_LIST_BYTES",
      "",
    );
    try {
      const module = (await import(
        /* @vite-ignore */ mutant.path
      )) as typeof McpTools;
      expect(module.toolPageRefusal(plugins)).toBeUndefined();
    } finally {
      await mutant.cleanup();
    }
  });

  it("refuses a tool whose schema is not a JSON Schema object", async () => {
    const spec = {
      name: "synthetic_scalar",
      title: "Synthetic",
      description: "Synthetic",
      inputSchema: z.string(),
      outputSchema: z.strictObject({}),
      readOnly: true as const,
      handler: async () => ({}),
    };
    expect(toolPageRefusal([["@synthetic/scalar", [spec]]])).toEqual({
      plugin: "@synthetic/scalar",
      code: "plugin_registration_invalid",
    });
  });

  it("keeps the core list alone within both bounds", () => {
    expect(toolPageRefusal([])).toBeUndefined();
    expect(toolNames.length).toBeLessThanOrEqual(TOOL_LIST_PAGE_SIZE);
    expect(toolListBytes([])).toBeLessThan(MAX_TOOL_LIST_BYTES);
  });

  it("refuses the same configuration on every host", async () => {
    for (const host of ["api", "worker", "stdio"] as const) {
      const refused = await load({ count: 18 }, host);
      expect(refused.exit).toBe(1);
      expect(JSON.parse(refused.lines[0]!).code).toBe("mcp_tool_page_overflow");
    }
  });
});

describe("hosts", () => {
  it("lists the same plugin tools over stdio and HTTP, and none from the worker", async () => {
    const names = async (handler: {
      fetch: (request: Request) => Response | Promise<Response>;
    }) =>
      (
        (await (await handler.fetch(post("tools/list"))).json()).result
          .tools as { name: string }[]
      ).map((tool) => tool.name);
    const expected = [...toolNames, "synthetic_tool_0", "synthetic_tool_1"];

    expect((await load({ count: 2 }, "worker")).tools).toEqual([]);
    await load({ count: 2 }, "stdio");
    // stdio builds its server from configDependencies, as startStdio does.
    const config = loadConfig({});
    const stdio = createMcpHandler(
      () => buildServer(configDependencies(unused, config, true)),
      { legacy: "stateless" },
    );
    try {
      expect(await names(stdio)).toEqual(expected);
    } finally {
      await stdio.close();
    }
    await load({ count: 2 }, "api");
    const logs: Record<string, unknown>[] = [];
    const http = createMcpHttp(unused, {
      env: {
        OPENPLANS_MCP_CURSOR_SECRET: "synthetic-plugin-tools-secret",
        OPENPLANS_PUBLIC_HOUSEHOLD: "on",
      },
      log: (entry) => logs.push({ ...entry }),
    });
    expect(await names(http)).toEqual(expected);
    // tools/call logging names plugin tools through the registry.
    const response = await http.fetch(
      post("tools/call", { name: "synthetic_tool_1", arguments: {} }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).result.structuredContent).toEqual({
      echo: "synthetic",
    });
    expect(logs.at(-1)).toMatchObject({ tool: "synthetic_tool_1" });
    expect(isToolName("synthetic_tool_1")).toBe(true);
    expect(isToolName("synthetic_absent")).toBe(false);
  });

  it("never marks a plugin tool personalized or writable", async () => {
    const { tools } = await load({ count: 3 });
    for (const tool of tools!) {
      expect(PERSONALIZED_TOOLS.has(tool.spec.name as never)).toBe(false);
      expect(tool.spec.readOnly).toBe(true);
    }
  });

  it("keeps the core list unchanged when no plugin is loaded", async () => {
    const plain = handlerWith();
    const empty = handlerWith([]);
    try {
      const listed = async (handler: ReturnType<typeof createMcpHandler>) =>
        (await (await handler.fetch(post("tools/list"))).json()).result;
      const result = await listed(plain);
      expect(result).toEqual(await listed(empty));
      expect(result.nextCursor).toBeUndefined();
      expect(result.tools.map((tool: { name: string }) => tool.name)).toEqual(
        toolNames.filter((name) => !PERSONALIZED_TOOLS.has(name)),
      );
    } finally {
      await plain.close();
      await empty.close();
    }
  });
});
