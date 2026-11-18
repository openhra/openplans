import { buildLowestPremiums } from "../../src/worker/handy-build.js";
import { lowestInput } from "../../src/api/handy.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { importMedicare } from "../../src/ingest/medicare/command.js";
import {
  acquireSpuf,
  cachedSpuf,
  importSpuf,
  parseSpufUrl,
} from "../../src/ingest/medicare/spuf.js";
import {
  seedCache,
  lookup,
  spufArchive,
  spufUrl,
} from "../ingest/medicare/helpers.js";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { z } from "zod";
import { MAX_OUTPUT_BYTES } from "../../src/mcp/tools.js";
import { inputJsonSchemas } from "../../src/mcp/schemas.js";
import type { ToolName } from "../../src/mcp/schemas.js";
import { messageBytes } from "../../src/mcp/tools.js";
import {
  estimateToolHooks,
  MEDICARE_ESTIMATE_TOOL,
} from "../../src/mcp/medicare-estimate.js";
import type { PluginTool } from "../../src/plugins/mcp-tools.js";
import {
  digestFixture,
  CURSOR_SECRET,
  FIXED_TIME,
} from "../plugins/fixture.js";
import { connect } from "./client.js";

type FixtureCall = { name: string; arguments: Record<string, unknown> };
const corpus = JSON.parse(
  await readFile(
    new URL("../fixtures/plugins/corpus.json", import.meta.url),
    "utf8",
  ),
) as { mcp: { method: string; params: FixtureCall }[] };
const scope = { zip: "77002", county: "48201", year: 2026 };
// Anonymous synthetic inputs over the existing public-data cuts. No new source data.
const extras: FixtureCall[] = [
  {
    name: "get_lowest_premiums",
    arguments: { ...scope, age: 35, metal: "silver" },
  },
  {
    name: "get_lowest_premiums",
    arguments: {
      ...scope,
      metal: "silver",
      members: [{ age: 35, relationship: "subscriber", tobacco: false }],
    },
  },
  { name: "get_market_summary", arguments: scope },
  {
    name: "get_market_summary",
    arguments: {
      ...scope,
      members: [{ age: 35, relationship: "subscriber", tobacco: false }],
    },
  },
  {
    name: "get_benchmark",
    arguments: {
      year: 2026,
      location: { zip: "77002", county: "48201" },
      ages: [35],
    },
  },
  {
    name: MEDICARE_ESTIMATE_TOOL,
    arguments: {
      plan_key: "H0028-042-0",
      year: 2026,
      scenario: "non_lis_no_other_payer",
      channel: "preferred_retail",
      opening_state: { kind: "new_calendar_year" },
      fills: [
        {
          fill_id: "synthetic-fill",
          date: "2026-02-03",
          rxcui: "860975",
          quantity: "30",
          unit: "tablet",
          days_supply: 30,
        },
      ],
    },
  },
  { name: "synthetic_budget_tool", arguments: {} },
];
const plugin: PluginTool = {
  plugin: "@synthetic/budget",
  spec: {
    name: "synthetic_budget_tool",
    title: "Synthetic budget tool",
    description: "Synthetic structural output for byte checks.",
    readOnly: true,
    inputSchema: z.strictObject({}),
    outputSchema: z.strictObject({ text: z.string() }),
    handler: async () => ({ text: "x".repeat(30_000) }),
  },
};
let fixture: Awaited<ReturnType<typeof digestFixture>>;
let client: Awaited<ReturnType<typeof connect>>;
let dataDir: string;
beforeAll(async () => {
  vi.spyOn(estimateToolHooks, "enabled").mockReturnValue(true);
  fixture = await digestFixture();
  dataDir = await mkdtemp(join(tmpdir(), "openplans-mcp-budgets-"));
  await seedCache(dataDir);
  await importMedicare(fixture.db, { year: 2026 }, dataDir);
  const archive = parseSpufUrl(spufUrl)!;
  await acquireSpuf(archive, {
    dataDir,
    dependencies: {
      lookup,
      transport: async () => ({
        status: 200,
        headers: { "content-type": "application/zip" },
        body: Readable.from([await spufArchive()]),
      }),
    },
  });
  await importSpuf(fixture.db, (await cachedSpuf(archive.kind, dataDir))[0]!);
  vi.stubEnv("OPENPLANS_MEDICARE_PART_D", "on");
  vi.stubEnv("OPENPLANS_MEDICARE_DRUG_COST", "on");
  await buildLowestPremiums(fixture.db, lowestInput({ ...scope, age: 35 }));
  client = await connect({
    db: fixture.db,
    cursorSecret: CURSOR_SECRET,
    now: () => Date.parse(FIXED_TIME),
    principal: { id: "synthetic-budgets" },
    policy: { canEstimate: () => true },
    lowestPremiums: true,
    lowestPremiumsScope: "full",
    medicareEstimateGrant: true,
    pluginTools: [plugin],
  });
});
afterAll(async () => {
  await client?.close();
  await fixture?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("every registered tool's largest fixture answer fits its explicit transport budget", async () => {
  const tools = (await client.client.listTools()).tools.map(({ name }) => name);
  const calls = corpus.mcp
    .filter(({ method }) => method === "tools/call")
    .map(({ params }) => params);
  // Exercise the largest declared page as well as each recorded request.
  for (const call of [...calls]) {
    const schema = inputJsonSchemas[call.name as ToolName];
    if (schema && "limit" in (schema.properties ?? {}))
      calls.push({ ...call, arguments: { ...call.arguments, limit: 25 } });
  }
  for (const section of ["benefits", "documents", "provenance"])
    calls.push({
      name: "get_plan",
      arguments: {
        plan_ref: "87226TX0100013-00",
        year: 2026,
        section,
        limit: 25,
      },
    });
  calls.push(...extras);
  const largest = new Map<string, { bytes: number; output: unknown }>();
  for (const call of calls) {
    const result = await client.client.callTool(call);
    expect(
      result.isError,
      `${call.name}: ${JSON.stringify(result.structuredContent)}`,
    ).not.toBe(true);
    // The measure includes both copies, metadata and the request-ID reserve.
    const bytes = messageBytes(
      result.structuredContent as Parameters<typeof messageBytes>[0],
    );
    if (bytes > (largest.get(call.name)?.bytes ?? 0))
      largest.set(call.name, { bytes, output: result.structuredContent });
  }
  expect([...largest.keys()].sort()).toEqual([...tools].sort());
  const check = (answers: typeof largest) => {
    for (const name of tools)
      expect(answers.get(name)!.bytes, name).toBeLessThanOrEqual(
        MAX_OUTPUT_BYTES,
      );
  };
  check(largest);
  // Negative control: the same all-tool check rejects a planted oversize fixture answer.
  const planted = new Map(largest);
  const name = tools[0]!;
  const output = {
    ...(largest.get(name)!.output as object),
    notes: ["x".repeat(MAX_OUTPUT_BYTES)],
  };
  planted.set(name, {
    output,
    bytes: messageBytes(output as Parameters<typeof messageBytes>[0]),
  });
  expect(() => check(planted)).toThrow();
});
