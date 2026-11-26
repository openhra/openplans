import { buildLowestPremiums } from "../../src/worker/handy-build.js";
import type { SqlSession } from "../../src/db/database.js";
import { createResponseCache } from "../../src/api/cache/index.js";
import { MemoryCache } from "../../src/api/cache/store.js";
import { lowestInput } from "../../src/api/handy.js";
import { handyManifest } from "../../src/db/handy-repository.js";
import { z } from "zod";
import { quotePlans } from "../../src/services/quotes.js";
import { createHash } from "node:crypto";
import type * as Crypto from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/app.js";
import { createMcpHttp } from "../../src/mcp/http.js";
import {
  callLowestTool,
  callMarketSummaryTool,
  callBenchmarkTool,
} from "../../src/mcp/handy.js";
import {
  MAX_OUTPUT_BYTES,
  MAX_TOOL_LIST_BYTES,
  TOOL_LIST_PAGE_SIZE,
} from "../../src/mcp/tools.js";
import {
  lowestPremiums,
  householdHandy,
  enumerateLowest,
  isLowestCell,
} from "../../src/services/handy.js";
import { post } from "../mcp/transport-helpers.js";
import { FIXED_TIME } from "../plugins/fixture.js";
import { loadConfig } from "../../src/config/index.js";
import { loadPlugins } from "../plugins/approval-helpers.js";
import type * as OperatorHost from "../../src/plugins/operator-host.js";
import { createOperatorHost } from "../../src/plugins/operator-host.js";
import { withMutantFile, importMutant } from "../mutant-file.js";
import { replaceSyntax } from "../source-mutation.js";
import { toolPageRefusal } from "../../src/plugins/mcp-tools.js";
import { setup } from "../compat/v1/helpers.js";

// Recorded bodies include the algorithm identity of the captured release, like FIXED_TIME.
// Keep captured bytes stable across release-version changes without recording new digests.
vi.mock("../../src/mcp/version.js", () => ({ applicationVersion: "0.4.11" }));

vi.mock("node:crypto", async (original) => {
  const crypto = await original<typeof Crypto>();
  let sequence = 0;
  return {
    ...crypto,
    randomUUID: () =>
      `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
  };
});
type RpcBody = {
  result: { tools: { name: string }[]; nextCursor?: string };
  error?: { code: number };
};
let h: Awaited<ReturnType<typeof setup>>;
const input = { zip: "77002", county: "48201", year: 2026, age: 40 };
const members = [{ age: 40, relationship: "subscriber", tobacco: false }];
const fixture = new URL(
  "../fixtures/plugins/lowest-public-on.json",
  import.meta.url,
);
beforeAll(async () => {
  vi.stubEnv("OPENPLANS_API_CACHE", "off");
  vi.stubEnv("OPENPLANS_LOWEST_PREMIUMS", "off");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(FIXED_TIME));
  h = await setup({ fixedTime: FIXED_TIME });
  await buildLowestPremiums(h.db, lowestInput(input));
});
afterAll(async () => {
  await h?.close();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it("records the enabled public contracts separately from off-state digests", async () => {
  const app = createApp(h.db, { lowestPremiums: true });
  const deps = {
    db: h.db,
    lowestPremiums: true,
    principal: { id: "personalized" },
    policy: { canEstimate: () => true },
  };
  const actual: Record<string, unknown> = {};
  for (const path of ["lowest-premiums", "market-summary"]) {
    const get = await app.request(
      `/v1/${path}?${new URLSearchParams(Object.entries(input).map(([k, v]) => [k, String(v)]))}`,
    );
    expect(get.status).toBe(200);
    const body = await get.text();
    if (path === "lowest-premiums") {
      expect(JSON.parse(body)).toEqual(
        await lowestPremiums(h.db, input, { slow: true }),
      );
      const answer = JSON.parse(body) as {
        status: string;
        provenance: { snapshots: { retrieved_at: string }[] };
      };
      expect(answer.status).toBe("calculated");
      expect(answer.provenance.snapshots.length).toBeGreaterThan(0);
      expect(
        answer.provenance.snapshots.every(
          (snapshot: { retrieved_at: string }) => snapshot.retrieved_at,
        ),
      ).toBe(true);
    }
    actual[`GET ${path}`] = createHash("sha256").update(body).digest("hex");
    const response = await app.request(`/v1/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        zip: input.zip,
        county: input.county,
        year: input.year,
        members,
      }),
    });
    expect(response.status).toBe(200);
    actual[`POST ${path}`] = createHash("sha256")
      .update(await response.text())
      .digest("hex");
  }
  for (const [name, call, args] of [
    ["lowest", callLowestTool, input],
    ["summary", callMarketSummaryTool, input],
    [
      "household-lowest",
      callLowestTool,
      { zip: input.zip, county: input.county, year: input.year, members },
    ],
    [
      "household-summary",
      callMarketSummaryTool,
      { zip: input.zip, county: input.county, year: input.year, members },
    ],
    [
      "benchmark",
      callBenchmarkTool,
      {
        year: input.year,
        location: { zip: input.zip, county: input.county },
        ages: [40],
      },
    ],
  ] as const) {
    const result = await call(deps, args);
    expect("isError" in result && result.isError, name).not.toBe(true);
    expect(
      Buffer.byteLength(JSON.stringify(result)) + 4096,
    ).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    actual[name] = createHash("sha256")
      .update(JSON.stringify(result))
      .digest("hex");
  }
  if (process.env.OPENPLANS_RECORD_LOWEST_PUBLIC === "1")
    await writeFile(fixture, JSON.stringify(actual, null, 2) + "\n");
  expect(actual).toEqual(JSON.parse(await readFile(fixture, "utf8")));
});

it("fits all eighteen core tools on one public page, and flag-off refuses every addition", async () => {
  const enabled = createMcpHttp(h.db, {
    env: { OPENPLANS_LOWEST_PREMIUMS: "on" },
    log: () => {},
  });
  const response = await enabled.fetch(post("tools/list"));
  const text = await response.text();
  expect(Buffer.byteLength(text) + 512).toBeLessThanOrEqual(
    MAX_TOOL_LIST_BYTES,
  );
  const result = (JSON.parse(text) as RpcBody).result;
  expect(result.tools).toHaveLength(18);
  expect(result.tools.length + 1).toBeLessThanOrEqual(TOOL_LIST_PAGE_SIZE);
  expect(result.nextCursor).toBeUndefined();
  const off = createMcpHttp(h.db, {
    env: { OPENPLANS_LOWEST_PREMIUMS: "off" },
    log: () => {},
  });
  const listed = (
    (await (await off.fetch(post("tools/list"))).json()) as RpcBody
  ).result;
  expect(listed.tools).toHaveLength(15);
  for (const name of [
    "get_lowest_premiums",
    "get_market_summary",
    "get_benchmark",
  ]) {
    expect(result.tools.map((t: { name: string }) => t.name)).toContain(name);
    expect(listed.tools.map((t: { name: string }) => t.name)).not.toContain(
      name,
    );
    expect(
      (
        (await (
          await off.fetch(post("tools/call", { name, arguments: input }))
        ).json()) as RpcBody
      ).error,
    ).toBeDefined();
  }
  const app = createApp(h.db, { lowestPremiums: false });
  for (const path of ["lowest-premiums", "market-summary"]) {
    expect(
      (await app.request(`/v1/${path}?zip=77002&year=2026&age=40`)).status,
    ).toBe(404);
    expect(
      (
        await app.request(`/v1/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...input, members }),
        })
      ).status,
    ).toBe(404);
  }
});

it("refuses a minimum after deleting a potentially cheaper source rate", async () => {
  const winner = (await lowestPremiums(h.db, input)).lowest.plan_id;
  expect(winner).toBeTruthy();
  const rollback = new Error("synthetic rollback");
  await expect(
    h.db.transaction(async (tx) => {
      await tx.query("DELETE FROM rate WHERE base_plan_id=$1", [winner]);
      const result = await lowestPremiums(tx, input);
      expect(result.status).toBe("unknown");
      expect(result.lowest.monthly_cents).toBeNull();
      throw rollback;
    }),
  ).rejects.toBe(rollback);
});

it("refuses an oversized single-age MCP summary without emitting partial evidence", async () => {
  const rollback = new Error("synthetic oversized URL rollback");
  await expect(
    h.db.transaction(async (tx) => {
      await tx.query("UPDATE snapshot SET final_url=$1", [
        "https://example.invalid/synthetic/" + "x".repeat(MAX_OUTPUT_BYTES),
      ]);
      const answer = await callMarketSummaryTool(
        { db: tx, lowestPremiums: true },
        input,
      );
      expect("isError" in answer && answer.isError).toBe(true);
      expect(JSON.stringify(answer)).toContain("result_too_large");
      throw rollback;
    }),
  ).rejects.toBe(rollback);
});

it("fits the proposed public status plugin and eighteen core tools within the discovery guard", async () => {
  vi.stubEnv("OPENPLANS_LOWEST_PREMIUMS", "on");
  try {
    for (const [scope, count] of [
      ["full", 19],
      ["single_age_silver", 18],
    ] as const) {
      vi.stubEnv("OPENPLANS_LOWEST_PREMIUMS_SCOPE", scope);
      const loaded = await loadPlugins(
        loadConfig(
          {},
          {
            version: 1,
            lowestPremiums: true,
            lowestPremiumsScope: scope,
            plugins: { entries: [{ package: "@openplans/plugin-status" }] },
          },
        ),
        "api",
      );
      expect(
        toolPageRefusal([
          [
            "@openplans/plugin-status",
            loaded.registries.mcpTools.map((tool) => tool.spec),
          ],
        ]),
      ).toBeUndefined();
      const app = createMcpHttp(h.db, {
        env: {
          OPENPLANS_LOWEST_PREMIUMS: "on",
          OPENPLANS_LOWEST_PREMIUMS_SCOPE: scope,
        },
        log: () => {},
      });
      const text = await (await app.fetch(post("tools/list"))).text();
      expect(Buffer.byteLength(text) + 512).toBeLessThanOrEqual(
        MAX_TOOL_LIST_BYTES,
      );
      const result = (JSON.parse(text) as RpcBody).result;
      expect(result.tools).toHaveLength(count);
      expect(result.nextCursor).toBeUndefined();
    }
  } finally {
    vi.stubEnv("OPENPLANS_LOWEST_PREMIUMS", "off");
    vi.stubEnv("OPENPLANS_LOWEST_PREMIUMS_SCOPE", "full");
    await loadPlugins(
      loadConfig({}, { version: 1, plugins: { entries: [] } }),
      "api",
    );
  }
});

it("keeps every household candidate reachable through bounded MCP evidence pages", async () => {
  const input = {
    zip: "77002",
    county: "48201",
    year: 2026,
    members: [
      { age: 40, relationship: "subscriber", tobacco: false },
      { age: 40, relationship: "spouse", tobacco: false },
      { age: 10, relationship: "child", tobacco: false },
      { age: 8, relationship: "child", tobacco: false },
    ],
  };
  const deps = {
    db: h.db,
    lowestPremiums: true,
    principal: { id: "personalized" },
    policy: { canEstimate: () => true },
  };
  for (const call of [callLowestTool, callMarketSummaryTool]) {
    const seen = new Set<string>();
    let next: number | null = 1;
    let total = 0;
    while (next !== null) {
      const answer = await call(deps, { ...input, evidence_page: next });
      expect("isError" in answer && answer.isError).not.toBe(true);
      expect(
        Buffer.byteLength(JSON.stringify(answer)) + 4096,
      ).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
      const page = answer.structuredContent as {
        candidates_total: number;
        next_evidence_page: number | null;
        provenance: {
          candidates: { plan_id: string; evidence_ref: number }[];
          evidence: unknown[];
        };
      };
      total = page.candidates_total;
      for (const candidate of page.provenance.candidates) {
        seen.add(candidate.plan_id);
        expect(page.provenance.evidence[candidate.evidence_ref]).toBeDefined();
      }
      if (page.next_evidence_page !== null)
        expect(page.next_evidence_page).toBeGreaterThan(next);
      next = page.next_evidence_page;
    }
    expect(seen.size).toBe(total);
  }
});

it("reconstructs member rate rows exactly from shared evidence and rejects a broken reference", async () => {
  const members = [
    { age: 40, relationship: "subscriber" as const, tobacco: false },
    { age: 40, relationship: "spouse" as const, tobacco: false },
    { age: 10, relationship: "child" as const, tobacco: false },
    { age: 8, relationship: "child" as const, tobacco: false },
  ];
  const result = await householdHandy(h.db, {
    zip: "77002",
    county: "48201",
    year: 2026,
    members,
  });
  const schema = z.object({
    rating: z.object({
      plan_id: z.string(),
      rate_rows_used: z.array(z.unknown()),
      members: z.array(
        z.object({ rate_row_refs: z.array(z.int()) }).passthrough(),
      ),
    }),
  });
  const evidence = result.provenance.evidence
    .map((value) => schema.safeParse(value))
    .find((value) => value.success);
  expect(evidence?.success).toBe(true);
  if (!evidence?.success) throw new Error("Missing shared rate evidence");
  const rating = evidence.data.rating;
  const quotes = await quotePlans(h.db, {
    zip: "77002",
    county: "48201",
    year: 2026,
    members,
    plan_ids: [rating.plan_id],
  });
  const expected = quotes.quotes[0];
  if (!expected || !("members" in expected))
    throw new Error("Missing native member rates");
  const decode = (value: typeof rating) =>
    value.members.map(({ rate_row_refs, ...member }) => ({
      ...member,
      rate_rows: rate_row_refs.map((index) => value.rate_rows_used[index]),
    }));
  expect(decode(rating)).toEqual(expected.members);
  const mutant = structuredClone(rating);
  mutant.members[0]!.rate_row_refs[0] = mutant.rate_rows_used.length;
  expect(() => expect(decode(mutant)).toEqual(expected.members)).toThrow();
});

it("restricts the public ZIP scope in REST, direct MCP calls and discovery", async () => {
  expect(loadConfig({}).lowestPremiums).toBe(false);
  expect(
    loadConfig({ OPENPLANS_LOWEST_PREMIUMS_SCOPE: "single_age_silver" })
      .lowestPremiumsScope,
  ).toBe("single_age_silver");
  expect(() =>
    loadConfig({ OPENPLANS_LOWEST_PREMIUMS_SCOPE: "synthetic-invalid" }),
  ).toThrow();
  const app = createApp(h.db, {
    lowestPremiums: true,
    lowestPremiumsScope: "single_age_silver",
  });
  expect(
    (
      await app.request(
        "/v1/lowest-premiums?zip=77002&county=48201&year=2026&age=40",
      )
    ).status,
  ).toBe(200);
  expect(
    (await app.request("/v1/market-summary?zip=77002&county=48201&year=2026"))
      .status,
  ).toBe(200);
  for (const path of ["/v1/lowest-premiums", "/v1/market-summary"])
    expect((await app.request(path, { method: "POST" })).status).toBe(404);
  for (const query of ["metal=gold", "tobacco=true"])
    expect(
      (
        await app.request(
          `/v1/lowest-premiums?zip=77002&year=2026&age=40&${query}`,
        )
      ).status,
    ).toBe(400);
  expect(
    (await app.request("/v1/lowest-premiums?county=48201&year=2026&age=40"))
      .status,
  ).toBe(400);
  expect(
    (await app.request("/v1/market-summary?zip=77002&year=2026&age=40")).status,
  ).toBe(400);
  const deps = {
    db: h.db,
    lowestPremiums: true,
    lowestPremiumsScope: "single_age_silver" as const,
    principal: { id: "personalized" },
    policy: { canEstimate: () => true },
  };
  for (const [call, args] of [
    [callLowestTool, { ...input, metal: "gold" }],
    [callLowestTool, { zip: input.zip, year: 2026, members }],
    [callMarketSummaryTool, { ...input }],
    [callMarketSummaryTool, { zip: input.zip, year: 2026, members }],
    [
      callBenchmarkTool,
      { year: 2026, location: { zip: input.zip }, ages: [40] },
    ],
  ] as const)
    expect((await call(deps, args)).structuredContent).toHaveProperty("error");
  const http = createMcpHttp(h.db, {
    env: {
      OPENPLANS_LOWEST_PREMIUMS: "on",
      OPENPLANS_LOWEST_PREMIUMS_SCOPE: "single_age_silver",
    },
    log: () => {},
  });
  const result = (
    (await (await http.fetch(post("tools/list"))).json()) as RpcBody
  ).result;
  expect(result.tools).toHaveLength(17);
  expect(result.tools.map((tool) => tool.name)).not.toContain("get_benchmark");
  const definitions = result.tools as {
    name: string;
    inputSchema: { properties: Record<string, unknown> };
  }[];
  expect(
    definitions.find((tool) => tool.name === "get_lowest_premiums")!.inputSchema
      .properties,
  ).not.toHaveProperty("members");
  expect(
    definitions.find((tool) => tool.name === "get_market_summary")!.inputSchema
      .properties,
  ).not.toHaveProperty("age");
});

it("rejects an older minimum cell with missing retrieval dates", async () => {
  const cell = await enumerateLowest(
    h.db,
    lowestInput(input),
    await handyManifest(h.db),
  );
  expect(isLowestCell(cell)).toBe(true);
  const legacy = structuredClone(cell);
  legacy.provenance.snapshots = legacy.provenance.snapshots.map((snapshot) => {
    const { retrieved_at: _date, ...rest } = snapshot as Record<
      string,
      unknown
    >;
    return rest;
  });
  expect(isLowestCell(legacy)).toBe(false);
});

it("uses three fresh metadata reads for policy and a warm minimum and detects a redundant-query mutant", async () => {
  let reads = 0;
  const db: SqlSession = {
    ...h.db,
    async query<Row extends Record<string, unknown>>(
      sql: string,
      args?: unknown[],
    ) {
      reads++;
      return h.db.query<Row>(sql, args);
    },
  };
  const cache = createResponseCache(db, undefined, {
    config: loadConfig({}, { version: 1, cache: { enabled: true } }),
    store: new MemoryCache(8 * 1024 * 1024),
  });
  const expected = await lowestPremiums(db, input, { cache });
  reads = 0;
  expect(await lowestPremiums(db, input, { cache })).toEqual(expected);
  expect(cache.stats().hits).toBeGreaterThan(0);
  expect(reads).toBe(3);
  const mutant: SqlSession = {
    ...db,
    async query<Row extends Record<string, unknown>>(
      sql: string,
      args?: unknown[],
    ) {
      await db.query("SELECT 1");
      return db.query<Row>(sql, args);
    },
  };
  reads = 0;
  expect(await lowestPremiums(mutant, input, { cache })).toEqual(expected);
  expect(() => expect(reads).toBe(3)).toThrow();
});

it("reads status plugin identities without locale setup and rejects a locale-sort mutant", async () => {
  const plugins = ["status", "handy", "compare", "blob-s3"].map((name) => ({
    name: `@openplans/${name}`,
    version: "0.0.0",
    apiVersion: "0.2",
    enabled: true,
    sha256: "synthetic",
  }));
  const config = loadConfig({}, { version: 1, plugins: { entries: [] } });
  const assertPlainRead = async (create: typeof createOperatorHost) => {
    const host = create(config, "api", {}, () => ({
      plugins,
      registries: { cacheStores: {} },
    }));
    const locale = vi
      .spyOn(String.prototype, "localeCompare")
      .mockImplementation(() => {
        throw new Error("Request initialized locale collation");
      });
    try {
      const result = await host.configuration({
        db: h.db,
        signal: new AbortController().signal,
      });
      expect(result.state).toBe("available");
      if (result.state !== "available")
        throw new Error("Status configuration unavailable");
      expect(result.value.plugins.map((plugin) => plugin.name)).toEqual([
        "@openplans/blob-s3",
        "@openplans/compare",
        "@openplans/handy",
        "@openplans/status",
      ]);
      expect(locale).not.toHaveBeenCalled();
    } finally {
      locale.mockRestore();
    }
  };
  await assertPlainRead(createOperatorHost);
  const source = new URL("../../src/plugins/operator-host.ts", import.meta.url);
  await withMutantFile(
    source,
    replaceSyntax(
      await readFile(source, "utf8"),
      "if (left < right) return -1; if (left > right) return 1; return 0;",
      "return left.localeCompare(right);",
    ),
    async (file) => {
      const mutant = await importMutant<typeof OperatorHost>(
        file,
        "createOperatorHost",
      );
      await expect(
        assertPlainRead(mutant.createOperatorHost),
      ).rejects.toThrow();
    },
  );
});
