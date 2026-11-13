import { importMutant, withMutantFile } from "../mutant-file.js";
import { replaceSyntax } from "../source-mutation.js";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import type { createMcpHttp as Factory } from "../../src/mcp/http.js";
import { post, runStdio } from "./transport-helpers.js";
import {
  allowedOrigin,
  corsRequest,
  expectCorsHeaders,
} from "./cors-helpers.js";

// Mutate disposable copies, never the real sources. The same assertions must reject each copy.
it.each([
  ["origin", "origin !== undefined && !origins.includes(origin)", "false", 403],
  [
    "auth",
    "PERSONALIZED_TOOLS.has(params?.name as ToolName) && !granted",
    "PERSONALIZED_TOOLS.has(params?.name as ToolName) && false",
    401,
  ],
  [
    "size",
    "readRequestBody(c.req.raw, limits.input_bytes)",
    "readRequestBody(c.req.raw, 128 * 1024)",
    413,
  ],
] as const)(
  "negative control: omitted %s protection fails its assertion",
  async (kind, before, after, expected) => {
    const source = new URL("../../src/mcp/http.ts", import.meta.url);
    const original = await readFile(source, "utf8");
    await withMutantFile(
      source,
      replaceSyntax(original, before, after),
      async (temporary) => {
        const module = await importMutant<{
          createMcpHttp: typeof Factory;
        }>(temporary, "createMcpHttp");
        const app = module.createMcpHttp(
          {
            query: async () => {
              throw new Error("Unexpected SQL");
            },
            exec: async () => {},
          },
          {
            env: { OPENPLANS_MCP_ALLOWED_ORIGINS: "https://allowed.example" },
            log: () => {},
          },
        );
        let request;
        if (kind === "origin") {
          request = post(
            "server/discover",
            {},
            { origin: "https://attacker.example" },
          );
        } else if (kind === "auth") {
          request = post("tools/call", {
            name: "quote_premiums",
            arguments: {},
          });
        } else {
          request = post("server/discover", { padding: "x".repeat(64 * 1024) });
        }
        const response = await app.fetch(request);
        await response.text();
        await expect(async () => {
          expect(response.status).toBe(expected);
        }).rejects.toThrow();
      },
    );
  },
);
it.each(["JSON", "SSE", "error"] as const)(
  "negative control: removing CORS headers fails the %s regression assertion",
  async (kind) => {
    const source = new URL("../../src/mcp/http.ts", import.meta.url);
    const original = await readFile(source, "utf8");
    const block = `if (origin) {
    c.header('Access-Control-Allow-Origin', origin);
    c.header('Vary', 'Origin', { append: true });
    c.header('Access-Control-Expose-Headers', 'Mcp-Session-Id, MCP-Protocol-Version, WWW-Authenticate, Retry-After');
  }`;
    await withMutantFile(
      source,
      replaceSyntax(original, block, ""),
      async (temporary) => {
        const module = await importMutant<{
          createMcpHttp: typeof Factory;
        }>(temporary, "createMcpHttp");
        const app = module.createMcpHttp(
          {
            query: async () => {
              throw new Error("Unexpected SQL");
            },
            exec: async () => {},
          },
          {
            env: { OPENPLANS_MCP_ALLOWED_ORIGINS: allowedOrigin },
            log: () => {},
          },
        );
        const response = await app.fetch(await corsRequest(kind));
        expect(response.status).toBe(kind === "error" ? 415 : 200);
        expect(response.headers.get("content-type")).toContain(
          kind === "SSE" ? "text/event-stream" : "application/json",
        );
        await response.text();
        expect(() => expectCorsHeaders(response)).toThrow();
      },
    );
  },
);
it("negative control: a stdout banner fails the protocol-only assertion", async () => {
  const source = new URL("../../dist/mcp/stdio.js", import.meta.url);
  const original = await readFile(source, "utf8");
  await withMutantFile(
    source,
    replaceSyntax(
      original,
      "export function startStdio() {",
      'export function startStdio() { console.log("synthetic banner");',
    ),
    async (temporary) => {
      const { output, code } = await runStdio(fileURLToPath(temporary));
      expect(code).toBe(0);
      // The mutant ran: its banner reached stdout.
      expect(output).toContain("synthetic banner");
      expect(() =>
        output
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toThrow();
    },
  );
});
