import { replaceSyntax } from "../source-mutation.js";
import { readFile, writeFile, rm } from "node:fs/promises";
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
    "params?.name === 'estimate_premiums' && !granted",
    "params?.name === 'estimate_premiums' && false",
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
    const temporary = new URL(
      `../../src/mcp/.http-mutant-${kind}.ts`,
      import.meta.url,
    );
    const original = await readFile(source, "utf8");
    await writeFile(temporary, replaceSyntax(original, before, after));
    try {
      const module = (await import(/* @vite-ignore */ temporary.href)) as {
        createMcpHttp: typeof Factory;
      };
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
          name: "estimate_premiums",
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
    } finally {
      await rm(temporary, { force: true });
    }
  },
);
it.each(["JSON", "SSE", "error"] as const)(
  "negative control: removing CORS headers fails the %s regression assertion",
  async (kind) => {
    const source = new URL("../../src/mcp/http.ts", import.meta.url);
    const temporary = new URL(
      `../../src/mcp/.http-mutant-cors-${kind}.ts`,
      import.meta.url,
    );
    const original = await readFile(source, "utf8");
    const block = `if (origin) {
    c.header('Access-Control-Allow-Origin', origin);
    c.header('Vary', 'Origin', { append: true });
    c.header('Access-Control-Expose-Headers', 'Mcp-Session-Id, MCP-Protocol-Version, WWW-Authenticate, Retry-After');
  }`;
    await writeFile(temporary, replaceSyntax(original, block, ""));
    try {
      const module = (await import(/* @vite-ignore */ temporary.href)) as {
        createMcpHttp: typeof Factory;
      };
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
    } finally {
      await rm(temporary, { force: true });
    }
  },
);
it("negative control: a stdout banner fails the protocol-only assertion", async () => {
  const temporary = new URL("../../dist/mcp/.stdio-mutant.js", import.meta.url);
  const original = await readFile(
    new URL("../../dist/mcp/stdio.js", import.meta.url),
    "utf8",
  );
  await writeFile(
    temporary,
    replaceSyntax(
      original,
      "export function startStdio() {",
      'export function startStdio() { console.log("synthetic banner");',
    ),
  );
  try {
    const { output, code } = await runStdio(temporary.pathname);
    expect(code).toBe(0);
    expect(() =>
      output
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toThrow();
  } finally {
    await rm(temporary, { force: true });
  }
});
