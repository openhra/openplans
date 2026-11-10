import { readFile, writeFile, rm } from "node:fs/promises";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { expect, it } from "vitest";
import type { SqlSession } from "../../src/db/database.js";
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
function expectCompleteList(result: {
  tools: { name: string }[];
  nextCursor?: string;
}) {
  expect(toolNames.length).toBeLessThanOrEqual(TOOL_LIST_PAGE_SIZE);
  expect(result.tools.map((tool) => tool.name)).toEqual(toolNames);
  expect(result.nextCursor).toBeUndefined();
}
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
] as const)("negative control: rejects %s", async (name, before, after) => {
  const source = new URL("../../src/mcp/server.ts", import.meta.url);
  const temporary = new URL(
    `../../src/mcp/.server-list-mutant-${name.replaceAll(" ", "-")}.ts`,
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
    handler = createMcpHandler(() => module.buildServer(granted), {
      legacy: "stateless",
    });
    const response = await handler.fetch(post("tools/list"));
    const result = (await response.json()).result;
    expect(result.tools.length).toBeGreaterThan(0);
    expect(result.nextCursor).toBeTypeOf("string");
    expect(() => expectCompleteList(result)).toThrow();
    const resumed = await handler.fetch(
      post("tools/list", { cursor: result.nextCursor }),
    );
    const tail = (await resumed.json()).result;
    expect(
      [...result.tools, ...tail.tools].map(
        (tool: { name: string }) => tool.name,
      ),
    ).toEqual(
      name === "unreviewed sixteenth tool"
        ? [...toolNames, "synthetic_sixteenth"]
        : toolNames,
    );
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
