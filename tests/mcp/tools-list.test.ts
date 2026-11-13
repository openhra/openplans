import { randomUUID } from "node:crypto";
import { readFile, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { afterEach, expect, it } from "vitest";
import { loadConfig } from "../../src/config/index.js";
import type { SqlSession } from "../../src/db/database.js";
import { loadPlugins } from "../../src/plugins/index.js";
import type { PluginTool } from "../../src/plugins/index.js";
import { createMcpHttp } from "../../src/mcp/http.js";
import type { buildServer } from "../../src/mcp/server.js";
import { toolNames } from "../../src/mcp/schemas.js";
import { cursorCodec } from "../../src/mcp/cursor.js";
import {
  MAX_OUTPUT_BYTES,
  MAX_TOOL_LIST_BYTES,
  TOOL_LIST_PAGE_SIZE,
} from "../../src/mcp/tools.js";
import { replaceSyntax } from "../source-mutation.js";
import { post } from "./transport-helpers.js";

const unused: SqlSession = {
  query: async () => {
    throw new Error("Discovery must not query the database");
  },
  exec: async () => {},
};
const cursorSecret = "synthetic-tools-list-secret";
const granted = {
  db: unused,
  cursorSecret,
  principal: { id: "personalized" },
  policy: { canEstimate: () => true },
};
const binding = {
  tool: "tools/list",
  filters: toolNames,
  generation: "mcp-definitions-v1",
  scope: "personalized",
};
function expectCompleteList(
  result: {
    tools: { name: string }[];
    nextCursor?: string;
  },
  names: readonly string[] = toolNames,
) {
  expect(names.length).toBeLessThanOrEqual(TOOL_LIST_PAGE_SIZE);
  expect(result.tools.map((tool) => tool.name)).toEqual(names);
  expect(result.nextCursor).toBeUndefined();
}

// Plugin tools come from the synthetic fixture; nothing here reads source data.
const fixtures = fileURLToPath(
  new URL("../fixtures/plugins/", import.meta.url),
);
class Exit extends Error {
  constructor(readonly code: number) {
    super("exit");
  }
}
async function loadTools(options: Record<string, unknown>) {
  const lines: string[] = [];
  const config = loadConfig(
    {},
    {
      version: 1,
      plugins: [{ package: "./synthetic-mcp-tools/index.mjs", options }],
    },
  );
  try {
    const loaded = await loadPlugins(config, "api", {
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
// Loading replaces the process registry; put the empty one back after each test.
afterEach(async () => {
  await loadPlugins(loadConfig({}, { version: 1, plugins: [] }), "api");
});
const handlerWith = (
  pluginTools: readonly PluginTool[],
  server: typeof buildServer,
) =>
  createMcpHandler(() => server({ ...granted, pluginTools }), {
    legacy: "stateless",
  });
const app = () =>
  createMcpHttp(unused, {
    env: { OPENPLANS_MCP_CURSOR_SECRET: cursorSecret },
    log: () => {},
  });

it.each(["2026-07-28", "2025-11-25", "2025-06-18"])(
  "%s returns all fifteen tools in one raw HTTP response",
  async (version) => {
    const request = post("tools/list", {}, { "MCP-Protocol-Version": version });
    const body = JSON.parse(await request.text());
    if (version !== "2026-07-28") delete body.params._meta;
    const response = await app().fetch(
      new Request(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(body),
      }),
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_TOOL_LIST_BYTES);
    const payload = text.startsWith("{")
      ? text
      : text
          .split("\n")
          .find((line) => line.startsWith("data: "))!
          .slice(6);
    expectCompleteList(JSON.parse(payload).result);
  },
);

it("resumes signed cursors from earlier pages and handles the end of the list", async () => {
  const server = app();
  for (const offset of [9, toolNames.length]) {
    const cursor = cursorCodec(cursorSecret).issue(binding, offset);
    const response = await server.fetch(post("tools/list", { cursor }));
    expect(response.status).toBe(200);
    const result = (await response.json()).result;
    expect(result.tools.map((tool: { name: string }) => tool.name)).toEqual(
      toolNames.slice(offset),
    );
    expect(result.nextCursor).toBeUndefined();
  }
});

it("rejects tampered, expired, out-of-range and differently scoped list cursors", async () => {
  const codec = cursorCodec(cursorSecret);
  const token = codec.issue(binding, 9);
  const cursors = [
    token + "x",
    cursorCodec(cursorSecret, () => Date.now() - 16 * 60_000).issue(binding, 9),
    codec.issue(binding, toolNames.length + 1),
    codec.issue({ ...binding, scope: "anonymous" }, 9),
  ];
  for (const cursor of cursors) {
    const response = await app().fetch(post("tools/list", { cursor }));
    expect((await response.json()).error.code).toBe(-32602);
  }
});

it("refuses eighteen plugin tools at load because they need a second page", async () => {
  const refused = await loadTools({ count: 18 });
  expect(refused.exit).toBe(1);
  expect(refused.lines.map((line) => JSON.parse(line))).toEqual([
    { plugin: "@synthetic/mcp-tools", code: "mcp_tool_page_overflow" },
  ]);
  // The bound is the page size: seventeen plugin tools still fit with the fifteen core tools.
  const fits = await loadTools({
    count: TOOL_LIST_PAGE_SIZE - toolNames.length,
  });
  expect(fits.exit).toBeUndefined();
  expect(fits.tools).toHaveLength(17);
});

it("lists three plugin tools after the core tools, in registration order", async () => {
  const { tools } = await loadTools({ count: 3 });
  const names = [
    ...toolNames,
    "synthetic_tool_0",
    "synthetic_tool_1",
    "synthetic_tool_2",
  ];
  // Through the HTTP transport, which reads the loaded registry itself.
  const response = await app().fetch(post("tools/list"));
  const text = await response.text();
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_TOOL_LIST_BYTES);
  const result = JSON.parse(text).result;
  expectCompleteList(result, names);
  expect(result.tools.slice(0, toolNames.length)).toEqual(
    (await (await app().fetch(post("tools/list"))).json()).result.tools.slice(
      0,
      toolNames.length,
    ),
  );
  expect(result.tools[toolNames.length]).toMatchObject({
    name: "synthetic_tool_0",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
  });
  expect(result.tools[toolNames.length].description).toMatch(
    /^Synthetic tool for the registry tests\. Uses imported public evidence\./,
  );
  // The same tools when the registry is passed in explicitly.
  const { buildServer: real } = await import("../../src/mcp/server.js");
  const handler = handlerWith(tools!, real);
  try {
    const direct = (await (await handler.fetch(post("tools/list"))).json())
      .result;
    expect(direct).toEqual(result);
  } finally {
    await handler.close();
  }
});

it("rejects a list cursor issued before a plugin was enabled", async () => {
  const before = cursorCodec(cursorSecret).issue(binding, 9);
  // Accepted while no plugin is loaded.
  const accepted = await app().fetch(post("tools/list", { cursor: before }));
  expect((await accepted.json()).result.tools).toHaveLength(
    toolNames.length - 9,
  );
  await loadTools({ count: 3 });
  const response = await app().fetch(post("tools/list", { cursor: before }));
  expect((await response.json()).error.code).toBe(-32602);
  // A cursor bound to the new list still resumes it.
  const after = cursorCodec(cursorSecret).issue(
    {
      ...binding,
      filters: [
        ...toolNames,
        "synthetic_tool_0",
        "synthetic_tool_1",
        "synthetic_tool_2",
      ],
    },
    toolNames.length,
  );
  const resumed = await app().fetch(post("tools/list", { cursor: after }));
  expect(
    (await resumed.json()).result.tools.map(
      (tool: { name: string }) => tool.name,
    ),
  ).toEqual(["synthetic_tool_0", "synthetic_tool_1", "synthetic_tool_2"]);
});

it.each([
  [
    "nine-tool page",
    "definitions.slice(offset, offset + TOOL_LIST_PAGE_SIZE)",
    "definitions.slice(offset, offset + 9)",
  ],
  [
    "tool-result byte budget",
    "512 <= MAX_TOOL_LIST_BYTES",
    "512 <= MAX_OUTPUT_BYTES",
  ],
  [
    "unreviewed sixteenth tool",
    'server.server.setRequestHandler("tools/list", (request, ctx) => {',
    'definitions.push({ ...definitions[0]!, name: "synthetic_sixteenth" }); server.server.setRequestHandler("tools/list", (request, ctx) => {',
  ],
  [
    "page size back to fifteen with sixteen tools",
    "definitions.slice(offset, offset + TOOL_LIST_PAGE_SIZE)",
    "definitions.slice(offset, offset + 15)",
  ],
] as const)("negative control: rejects %s", async (name, before, after) => {
  const source = new URL("../../src/mcp/server.ts", import.meta.url);
  // The mutant sits next to server.ts so its relative imports resolve. The pid and
  // a random suffix keep two test runs in the same checkout from writing, reading
  // and deleting each other's copy.
  const temporary = new URL(
    `../../src/mcp/.server-list-mutant-${name.replaceAll(" ", "-")}-${process.pid}-${randomUUID()}.ts`,
    import.meta.url,
  );
  await writeFile(
    temporary,
    replaceSyntax(await readFile(source, "utf8"), before, after),
  );
  let handler: ReturnType<typeof createMcpHandler> | undefined;
  try {
    const module = (await import(/* @vite-ignore */ temporary.href)) as {
      buildServer: typeof buildServer;
    };
    expect(module.buildServer).toBeTypeOf("function");
    const plugin = name === "page size back to fifteen with sixteen tools";
    const pluginTools = plugin ? (await loadTools({ count: 1 })).tools! : [];
    const names =
      {
        "unreviewed sixteenth tool": [...toolNames, "synthetic_sixteenth"],
        "page size back to fifteen with sixteen tools": [
          ...toolNames,
          "synthetic_tool_0",
        ],
      }[name as string] ?? toolNames;
    // The unmutated server lists every tool on one page.
    const { buildServer: real } = await import("../../src/mcp/server.js");
    const control = handlerWith(pluginTools, real);
    try {
      expectCompleteList(
        (await (await control.fetch(post("tools/list"))).json()).result,
        plugin ? names : toolNames,
      );
    } finally {
      await control.close();
    }
    handler = handlerWith(pluginTools, module.buildServer);
    const response = await handler.fetch(post("tools/list"));
    const result = (await response.json()).result;
    expect(result.tools.length).toBeGreaterThan(0);
    expect(() => expectCompleteList(result)).toThrow();
    // A sixteenth tool fits the larger page, so the list changes without a cursor.
    if (name === "unreviewed sixteenth tool") {
      expect(result.nextCursor).toBeUndefined();
      expect(result.tools.map((tool: { name: string }) => tool.name)).toEqual(
        names,
      );
      return;
    }
    expect(() => expectCompleteList(result, names)).toThrow();
    expect(result.nextCursor).toBeTypeOf("string");
    const resumed = await handler.fetch(
      post("tools/list", { cursor: result.nextCursor }),
    );
    const tail = (await resumed.json()).result;
    expect(
      [...result.tools, ...tail.tools].map(
        (tool: { name: string }) => tool.name,
      ),
    ).toEqual(names);
    expect(tail.nextCursor).toBeUndefined();
    if (name === "tool-result byte budget") {
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(
        MAX_OUTPUT_BYTES,
      );
    }
  } finally {
    await handler?.close();
    await rm(temporary, { force: true });
  }
});
