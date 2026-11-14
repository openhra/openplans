import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { nativeRoutes } from "../../src/api/routes.js";
import { compatRoutes } from "../../src/compat/v1/index.js";
import type { SqlSession } from "../../src/db/database.js";
import { callTool } from "../../src/mcp/tools.js";
import { isQueryTimeout, QUERY_TIMEOUT } from "../../src/services/errors.js";
import { importMutant, withMutantFile } from "../mutant-file.js";
import { replaceSyntax } from "../source-mutation.js";

// A read past the 5 s limit answers 504 query_timeout on every surface, never a 500.
// The database here is a stand-in whose every query fails the way pg reports a timeout.
const KEY = "synthetic-timeout-key";
const clientTimeout = () => new Error("Query read timeout");
const serverTimeout = () =>
  Object.assign(new Error("canceling statement due to statement timeout"), {
    code: "57014",
  });
const failing = (error: () => Error): SqlSession => ({
  query: async () => {
    throw error();
  },
  exec: async () => {
    throw error();
  },
});
const src = (path: string) => new URL(`../../src/${path}`, import.meta.url);

type Native = typeof nativeRoutes;
type Compat = typeof compatRoutes;
type Tool = typeof callTool;

async function nativeAnswer(routes: Native, db: SqlSession) {
  const app = new Hono().route("/v1", routes(db, { premiumToken: KEY }));
  return app.request("/v1/providers?zip=78653&radius_miles=25&name=SMITH");
}
async function compatAnswer(routes: Compat, db: SqlSession) {
  return routes(db, { premiumToken: KEY, compatKey: KEY }).request(
    "/compat/v1/providers/search",
    {
      method: "POST",
      headers: { "content-type": "application/json", "X-Api-Key": KEY },
      body: JSON.stringify({ zip_code: "78653", radius: 10, per_page: 25 }),
    },
  );
}
async function mcpAnswer(tool: Tool, db: SqlSession) {
  const result = await tool({ db }, "search_providers", {
    zip: "78653",
    radius_miles: 10,
    year: 2026,
  });
  return result.structuredContent as { error: Record<string, unknown> };
}

async function expectTimeout(response: Response) {
  expect(response.status).toBe(504);
  expect(await response.json()).toEqual({ error: { code: QUERY_TIMEOUT } });
}
function expectMcpTimeout(output: { error: Record<string, unknown> }) {
  expect(output.error).toEqual({
    code: QUERY_TIMEOUT,
    field: null,
    retryable: true,
  });
}

describe("query timeouts", () => {
  it("recognizes the client read timeout and the server statement timeout only", () => {
    expect(isQueryTimeout(clientTimeout())).toBe(true);
    expect(isQueryTimeout(serverTimeout())).toBe(true);
    expect(
      isQueryTimeout(new Error("wrapped", { cause: serverTimeout() })),
    ).toBe(true);
    const cancelled = Object.assign(
      new Error("canceling statement due to user request"),
      { code: "57014" },
    );
    expect(isQueryTimeout(cancelled)).toBe(false);
    expect(isQueryTimeout(new Error("connection refused"))).toBe(false);
    expect(isQueryTimeout("Query read timeout")).toBe(false);
  });

  for (const [label, error] of [
    ["client read timeout", clientTimeout],
    ["server statement timeout", serverTimeout],
  ] as const) {
    it(`answers 504 query_timeout on REST, compat and MCP for a ${label}`, async () => {
      await expectTimeout(await nativeAnswer(nativeRoutes, failing(error)));
      await expectTimeout(await compatAnswer(compatRoutes, failing(error)));
      expectMcpTimeout(await mcpAnswer(callTool, failing(error)));
    });
  }

  it("still answers 500 for an error that is not a timeout", async () => {
    const broken = failing(() => new Error("synthetic failure"));
    const native = await nativeAnswer(nativeRoutes, broken);
    expect(native.status).toBe(500);
    expect(await native.json()).toEqual({ error: { code: "INTERNAL_ERROR" } });
    expect((await mcpAnswer(callTool, broken)).error.code).toBe(
      "DATA_UNAVAILABLE",
    );
  });

  // Planted mutants: each surface without its timeout branch falls back to the generic
  // error, and the same checks must fail on it.
  it("fails when the native route answers a timeout with a 500", async () => {
    const source = replaceSyntax(
      await readFile(src("api/routes.ts"), "utf8"),
      "} else if (isQueryTimeout(error)) {\n      return queryTimeoutResponse(c);\n    } else {",
      "} else {",
    );
    await withMutantFile(src("api/routes.ts"), source, async (file) => {
      const mutant = await importMutant<{ nativeRoutes: Native }>(
        file,
        "nativeRoutes",
      );
      const answer = await nativeAnswer(
        mutant.nativeRoutes,
        failing(clientTimeout),
      );
      expect(answer.status).toBe(500);
      await expect(expectTimeout(answer)).rejects.toThrow();
    });
  });

  it("fails when the compatibility API answers a timeout with a 500", async () => {
    const source = replaceSyntax(
      await readFile(src("compat/v1/index.ts"), "utf8"),
      "if (isQueryTimeout(error)) return queryTimeoutResponse(c);",
      "",
    );
    await withMutantFile(src("compat/v1/index.ts"), source, async (file) => {
      const mutant = await importMutant<{ compatRoutes: Compat }>(
        file,
        "compatRoutes",
      );
      // An identity radius search reads locations in the compatibility route itself.
      const answer = await compatAnswer(
        mutant.compatRoutes,
        failing(serverTimeout),
      );
      expect(answer.status).toBe(500);
      await expect(expectTimeout(answer)).rejects.toThrow();
    });
  });

  it("fails when MCP reports a timeout as unavailable data", async () => {
    const source = replaceSyntax(
      await readFile(src("mcp/tools.ts"), "utf8"),
      "} else if (isQueryTimeout(error)) {\n    code = QUERY_TIMEOUT;\n  } else {",
      "} else {",
    );
    await withMutantFile(src("mcp/tools.ts"), source, async (file) => {
      const mutant = await importMutant<{ callTool: Tool }>(file, "callTool");
      const output = await mcpAnswer(mutant.callTool, failing(clientTimeout));
      expect(output.error.code).toBe("DATA_UNAVAILABLE");
      expect(() => expectMcpTimeout(output)).toThrow();
    });
  });
});
