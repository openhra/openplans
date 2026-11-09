import { symlink, rm } from "node:fs/promises";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createApp } from "../../src/api/app.js";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { createMcpHttp } from "../../src/mcp/http.js";
import { migrate } from "../../src/db/migrate.js";
import { testDatabase, coreMigrations } from "../pglite.js";
import type { SqlSession } from "../../src/db/database.js";

import { post, runStdio } from "./transport-helpers.js";
import {
  allowedOrigin,
  corsRequest,
  expectCorsHeaders,
} from "./cors-helpers.js";
const quiet = () => {};

describe("HTTP transport official clients", () => {
  const db = testDatabase(new PGlite());
  let core: Awaited<ReturnType<typeof coreMigrations>>;
  beforeAll(async () => {
    core = await coreMigrations();
    await migrate(db, core.directory);
  });
  afterAll(async () => {
    await db.close();
    await core?.cleanup();
  });
  for (const legacy of [false, true])
    it(`reads catalog with ${legacy ? "2025-11-25" : "2026-07-28"} client`, async () => {
      const app = createMcpHttp(db, { env: {}, log: quiet });
      const client = new Client(
        { name: "synthetic-transport-client", version: "1" },
        {
          versionNegotiation: legacy
            ? { mode: "legacy" }
            : { mode: { pin: "2026-07-28" } },
        },
      );
      const transport = new StreamableHTTPClientTransport(
        new URL("http://127.0.0.1/mcp"),
        {
          fetch: async (input, init) => app.fetch(new Request(input, init)),
        },
      );
      try {
        await client.connect(transport);
        expect(client.getProtocolEra()).toBe(legacy ? "legacy" : "modern");
        const tools = await client.listTools();
        expect(tools.tools.some((t) => t.name === "search_plans")).toBe(true);
        expect(tools.tools.some((t) => t.name === "quote_premiums")).toBe(
          false,
        );
        const result = await client.callTool({
          name: "lookup_geography",
          arguments: { zip: "00000" },
        });
        expect(result.isError).not.toBe(true);
        const limits = await client.readResource({ uri: "openplans://limits" });
        expect(limits.contents[0]?.mimeType).toBe("application/json");
      } finally {
        await client.close();
      }
    });
  it("acknowledges notifications without session headers", async () => {
    const app = createMcpHttp(db, { env: {}, log: quiet });
    const request = post("notifications/initialized");
    const message = JSON.parse(await request.text());
    delete message.id;
    const response = await app.fetch(
      new Request(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(message),
      }),
    );
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
    expect(response.headers.has("Mcp-Session-Id")).toBe(false);
  });
  it.each([false, true])(
    "delivers progress while SQL is still blocked (legacy=%s)",
    async (legacy) => {
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const gated: SqlSession = {
        exec: db.exec,
        query: async (sql, parameters) => {
          await blocked;
          return db.query(sql, parameters);
        },
      };
      const app = createMcpHttp(gated, { env: {}, log: quiet });
      const request = post("tools/call", {
        name: "get_data_status",
        arguments: {},
      });
      const body = JSON.parse(await request.text());
      body.params._meta = {
        ...(legacy ? {} : body.params._meta),
        progressToken: "synthetic-blocked-progress",
      };
      if (legacy) request.headers.set("MCP-Protocol-Version", "2025-11-25");
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // The result cannot exist until release(). A buffering regression times out.
        const early = (async () => {
          const response = await app.fetch(
            new Request(request.url, {
              method: "POST",
              headers: request.headers,
              body: JSON.stringify(body),
            }),
          );
          expect(response.status).toBe(200);
          expect(response.headers.get("content-type")).toContain(
            "text/event-stream",
          );
          expect(response.headers.get("x-accel-buffering")).toBe("no");
          reader = response.body!.getReader();
          let text = "";
          while (!text.includes("notifications/progress")) {
            const part = await reader.read();
            expect(part.done).toBe(false);
            text += new TextDecoder().decode(part.value);
          }
          const messages = text
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => JSON.parse(line.slice(6)));
          expect(messages.some((message) => "id" in message)).toBe(false);
          expect(
            messages.find(
              (message) => message.method === "notifications/progress",
            ).params,
          ).toMatchObject({
            progressToken: "synthetic-blocked-progress",
            progress: 0,
          });
        })();
        await Promise.race([
          early,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Progress was buffered behind SQL")),
              1000,
            );
          }),
        ]);
        clearTimeout(timer);
        release();
        let final = "";
        for (;;) {
          const part = await reader!.read();
          if (part.done) break;
          final += new TextDecoder().decode(part.value);
        }
        const result = final
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => JSON.parse(line.slice(6)))
          .find((message) => message.id === 1)?.result;
        expect(result).toBeDefined();
        expect(result.isError).not.toBe(true);
      } finally {
        clearTimeout(timer);
        release();
        await reader?.cancel();
      }
    },
  );
  it("returns CORS headers on a successful request-scoped SSE exchange", async () => {
    const app = createMcpHttp(db, {
      env: { OPENPLANS_MCP_ALLOWED_ORIGINS: allowedOrigin },
      log: quiet,
    });
    const response = await app.fetch(await corsRequest("SSE"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expectCorsHeaders(response);
    const messages = (await response.text())
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)));
    expect(
      messages.some((message) => message.method === "notifications/progress"),
    ).toBe(true);
    const result = messages.find((message) => message.id === 1)?.result;
    expect(result).toBeDefined();
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.data.loaded).toBe(false);
  });
});

it.each([undefined, "SIGTERM", "SIGINT"] as const)(
  "stdio stdout is protocol only and exits on %s",
  async (signal) => {
    const { output, code } = await runStdio(undefined, false, signal);
    const messages = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(messages.every((m) => m.jsonrpc === "2.0")).toBe(true);
    expect(
      messages
        .find((m) => m.id === 2)
        .result.tools.some(
          (t: { name: string }) => t.name === "quote_premiums",
        ),
    ).toBe(false);
    expect(code).toBe(0);
  },
);
it("stdio personalized grant is explicit", async () => {
  const { output } = await runStdio(undefined, true);
  const messages = output
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(
    messages
      .find((m) => m.id === 2)
      .result.tools.some((t: { name: string }) => t.name === "quote_premiums"),
  ).toBe(true);
});

it("mounts MCP without applying its Host/Origin checks to REST health", async () => {
  const app = createApp({
    query: async () => ({ rows: [] }),
    exec: async () => {},
  });
  const response = await app.fetch(
    new Request("http://rest.example/healthz", {
      headers: { host: "rest.example", origin: "https://rest.example" },
    }),
  );
  expect(response.status).toBe(200);
  expect((await response.json()).status).toBe("ok");
  expect((await app.fetch(post())).status).toBe(200);
  expect(
    (
      await app.fetch(
        post("server/discover", {}, { origin: "https://attacker.example" }),
      )
    ).status,
  ).toBe(403);
});
it("modern official stdio client reads resources through the executable symlink", async () => {
  const temporary = new URL("../../dist/mcp/.stdio-entry", import.meta.url);
  await symlink("stdio.js", temporary);
  const client = new Client(
    { name: "synthetic-stdio-modern-client", version: "1" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [temporary.pathname],
    env: { DATABASE_URL: "postgresql://synthetic@127.0.0.1:1/synthetic" },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    expect(client.getProtocolEra()).toBe("modern");
    expect(
      (await client.listTools()).tools.some((tool) => tool.name === "search"),
    ).toBe(true);
    expect(
      (await client.readResource({ uri: "openplans://limits" })).contents[0]
        ?.mimeType,
    ).toBe("application/json");
  } finally {
    await client.close();
    await rm(temporary, { force: true });
  }
});
