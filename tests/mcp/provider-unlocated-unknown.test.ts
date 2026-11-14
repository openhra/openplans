import { describe, expect, it, vi } from "vitest";
import type { SqlSession } from "../../src/db/database.js";

// A native identity radius search whose unlocated count did not finish answers
// `meta.unlocated: null` with `meta.unlocated_status: "unknown"`. The MCP tool also answers a
// null count where no count applies (an NPI lookup), so its `unlocated_status` tells an MCP
// client "unknown, addresses may be missing" apart from "not applicable". The native answer is
// synthetic.
vi.mock("../../src/services/providers.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  findProviders: async () => ({
    status: "available",
    providers: [],
    total: 0,
    page: 1,
    page_size: 50,
    next_page: null,
    meta: {
      unlocated: null,
      unlocated_status: "unknown",
      unlocated_scope: "candidate_addresses",
      origin: null,
      radius_miles: 5,
    },
  }),
}));

const { callTool } = await import("../../src/mcp/tools.js");

const db: SqlSession = {
  query: async (sql: string) =>
    (sql.includes("api_data_generation")
      ? { rows: [{ generation: "synthetic" }] }
      : { rows: [] }) as never,
  exec: async () => {},
};

describe("MCP search_providers and an unknown unlocated count", () => {
  it("tells an unknown count apart from a count that does not apply", async () => {
    const result = (await callTool(
      { db, pluginTools: [] },
      "search_providers",
      { zip: "77030", radius_miles: 5 },
    )) as { structuredContent?: { data?: Record<string, unknown> } };
    const data = result.structuredContent?.data ?? {};
    expect(data.unlocated).toBeNull();
    expect(data.unlocated_status).toBe("unknown");
  });
});
