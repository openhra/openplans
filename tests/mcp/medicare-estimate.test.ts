import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { McpServer } from "@modelcontextprotocol/server";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createApp } from "../../src/api/app.js";
import { MemoryCache } from "../../src/api/cache/store.js";
import { loadConfig } from "../../src/config/index.js";
import type { Transport } from "../../src/fetch/index.js";
import {
  acquireSpuf,
  cachedSpuf,
  importSpuf,
  parseSpufUrl,
} from "../../src/ingest/medicare/spuf.js";
import { createMcpHttp } from "../../src/mcp/http.js";
import type { HttpOptions } from "../../src/mcp/http.js";
import {
  assertEstimateHonest,
  callEstimateTool,
  estimateOutputSchema,
  estimateToolHooks,
  MEDICARE_ESTIMATE_TOOL,
  registerEstimateTool,
} from "../../src/mcp/medicare-estimate.js";
import type { EstimateToolHooks } from "../../src/mcp/medicare-estimate.js";
import { drugCostDeps } from "../../src/services/medicare-drug-cost.js";
import type { DrugCostEstimate } from "../../src/services/medicare-drug-cost.js";
import type * as EstimateModule from "../../src/mcp/medicare-estimate.js";
import { configDependencies } from "../../src/mcp/policy.js";
import { buildServer } from "../../src/mcp/server.js";
import type { McpDependencies } from "../../src/mcp/server.js";
import { toolNames } from "../../src/mcp/schemas.js";
import {
  MAX_TOOL_LIST_BYTES,
  TOOL_LIST_PAGE_SIZE,
} from "../../src/mcp/tools.js";
import { runWithScope } from "../../src/plugins/request-scope.js";
import { toolPageRefusal } from "../../src/plugins/mcp-tools.js";
import type * as McpToolsModule from "../../src/plugins/mcp-tools.js";
import type { PluginTool } from "../../src/plugins/mcp-tools.js";
import type * as ServerModule from "../../src/mcp/server.js";
import { z } from "zod";
import { estimateMedicareDrugCost } from "../../src/services/medicare.js";
import {
  loadedDatabase,
  lookup,
  spufArchive,
  spufUrl,
} from "../ingest/medicare/helpers.js";
import type { Loaded } from "../ingest/medicare/helpers.js";
import type { SqlSession } from "../../src/db/database.js";
import { replaceSyntax } from "../source-mutation.js";
import { post } from "./transport-helpers.js";
import { importMutant, plantMutantFile } from "../mutant-file.js";

// Synthetic credentials and schedules over the fixture cut of the 2026 Q3 Part D files.
/** The parts of the JSON-RPC messages and estimate answers these tests read. */
interface ListedTool {
  name: string;
  description: string;
  inputSchema: {
    additionalProperties?: boolean;
    properties: Record<string, unknown>;
  };
}
interface ToolsListMessage {
  result: { tools: ListedTool[]; nextCursor?: string };
}
interface Figure {
  status: string;
  cents: number | null;
  reason?: string | null;
  evidence_refs: string[];
}
interface EvidenceItem {
  kind: string;
  snapshot_id: string;
  source_rows?: number[];
}
interface EstimateAnswer {
  benefit_type: unknown;
  snapshot_ids: string[];
  evidence: EvidenceItem[];
  fills: { figures: { patient_pay: Figure } }[];
  plan_figures: { standard_deductible: Figure };
}
interface Provenance {
  snapshot_id: string;
}
interface ToolOutput {
  status: string;
  error: unknown;
  data: EstimateAnswer | null;
  provenance: Provenance[];
}
interface CallMessage {
  error?: unknown;
  result: {
    structuredContent: ToolOutput;
    content: { text: string }[];
    isError?: boolean;
  };
}
const MCP_TOKEN = "synthetic-mcp-estimate-grant";
const API_TOKEN = "synthetic-api-estimate-grant";
const PLAN = "H0028-042-0";
const FILL_ID = "synthetic-fill-5521";
const schedule = (overrides: Record<string, unknown> = {}) => ({
  scenario: "non_lis_no_other_payer",
  channel: "preferred_retail",
  opening_state: { kind: "new_calendar_year" },
  fills: [
    {
      fill_id: FILL_ID,
      date: "2026-02-03",
      rxcui: "860975",
      quantity: "30",
      unit: "tablet",
      days_supply: 30,
    },
  ],
  ...overrides,
});
const args = (overrides: Record<string, unknown> = {}) => ({
  plan_key: PLAN,
  year: 2026,
  ...schedule(overrides),
});

function switches(partD: boolean, estimator: boolean) {
  vi.stubEnv("OPENPLANS_MEDICARE_PART_D", partD ? "on" : "");
  vi.stubEnv("OPENPLANS_MEDICARE_DRUG_COST", estimator ? "on" : "");
}

/** The JSON-RPC message from a JSON or single-event SSE response. */
async function rpc<T = unknown>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.headers.get("content-type")?.includes("text/event-stream"))
    return JSON.parse(text);
  const line = text
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .find((l) => l.includes('"jsonrpc"'));
  return JSON.parse(line!);
}

class SpyStore extends MemoryCache {
  sets = 0;
  constructor() {
    super(1 << 20);
  }
  override async set(key: string, value: string, ttl: number) {
    this.sets++;
    return super.set(key, value, ttl);
  }
}

const unusedDb: SqlSession = {
  query: async () => {
    throw new Error("Discovery must not query the database");
  },
  exec: async () => {},
};
const grantedDeps = (db: SqlSession = unusedDb): McpDependencies => ({
  db,
  cursorSecret: "synthetic-estimate-cursor-secret",
  principal: { id: "personalized" },
  policy: { canEstimate: () => true },
  medicareEstimateGrant: true,
  pluginTools: [],
});

async function listed(deps: McpDependencies) {
  const app = createMcpHttpFromServer(deps);
  return rpc<ToolsListMessage>(await app(post("tools/list")));
}
/** A bare stateless handler over buildServer, so discovery is tested apart from HTTP policy. */
function createMcpHttpFromServer(deps: McpDependencies) {
  return async (request: Request) => {
    const { createMcpHandler } = await import("@modelcontextprotocol/server");
    const handler = createMcpHandler(() => buildServer(deps), {
      legacy: "stateless",
    });
    try {
      return await handler.fetch(request);
    } finally {
      await handler.close();
    }
  };
}

/** Synthetic plugin tool specs with tiny schemas. */
function nearFull(count: number) {
  const empty = z.strictObject({});
  return Array.from({ length: count }, (_, index) => ({
    name: `synthetic_fill_${index}`,
    title: "Synthetic",
    description: "Synthetic page filler.",
    inputSchema: empty,
    outputSchema: empty,
    readOnly: true as const,
    handler: async () => ({}),
  }));
}
function pluginTools(count: number): PluginTool[] {
  return nearFull(count).map(
    (spec) =>
      ({ plugin: "@synthetic/near-full", spec }) as unknown as PluginTool,
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("estimate_medicare_drug_costs discovery", () => {
  it("is not listed unless both switches are on, and the list bytes stay the same", async () => {
    switches(false, false);
    const baseline = JSON.stringify((await listed(grantedDeps())).result);
    for (const [partD, estimator] of [
      [false, true],
      [true, false],
    ] as const) {
      switches(partD, estimator);
      const body = await listed(grantedDeps());
      expect(body.result.tools.map((t: { name: string }) => t.name)).toEqual(
        toolNames,
      );
      expect(JSON.stringify(body.result)).toBe(baseline);
    }
  });

  it("follows the core tools on one page when both switches are on", async () => {
    switches(true, true);
    const body = await listed(grantedDeps());
    const names = body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual([...toolNames, MEDICARE_ESTIMATE_TOOL]);
    expect(names.length).toBeLessThanOrEqual(TOOL_LIST_PAGE_SIZE);
    expect(body.result.nextCursor).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(body)) + 512).toBeLessThanOrEqual(
      MAX_TOOL_LIST_BYTES,
    );
    const tool = body.result.tools.at(-1)!;
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(Object.keys(tool.inputSchema.properties)).not.toContain(
      "benefit_type",
    );
    expect(tool.description).not.toMatch(/not[ _-]?covered/i);
  });

  it("is not listed without the estimate grant, even when personalized tools are open", async () => {
    switches(true, true);
    const body = await listed({
      ...grantedDeps(),
      medicareEstimateGrant: undefined,
    });
    expect(body.result.tools.map((t: { name: string }) => t.name)).toEqual(
      toolNames,
    );
  });

  it("counts in the plugin page budget, so a near-full plugin list is refused, never hidden", () => {
    const room = TOOL_LIST_PAGE_SIZE - toolNames.length;
    const plugins = [["@synthetic/near-full", nearFull(room)]] as const;
    switches(false, false);
    expect(toolPageRefusal(plugins)).toBeUndefined();
    switches(true, true);
    expect(toolPageRefusal(plugins)).toEqual({
      plugin: "@synthetic/near-full",
      code: "mcp_tool_page_overflow",
    });
    // One plugin tool fewer leaves room: the estimate is listed with every plugin tool on one page.
    const fewer = [["@synthetic/near-full", nearFull(room - 1)]] as const;
    expect(toolPageRefusal(fewer)).toBeUndefined();
  });

  it("is listed with a near-full plugin list that the loader accepted", async () => {
    switches(true, true);
    const room = TOOL_LIST_PAGE_SIZE - toolNames.length;
    const body = await listed({
      ...grantedDeps(),
      pluginTools: pluginTools(room - 1),
    });
    const names = body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toHaveLength(TOOL_LIST_PAGE_SIZE);
    expect(names[toolNames.length]).toBe(MEDICARE_ESTIMATE_TOOL);
    expect(body.result.nextCursor).toBeUndefined();
  });
});

describe("estimate_medicare_drug_costs over the fixture Part D files", () => {
  let loaded: Loaded;
  beforeAll(async () => {
    loaded = await loadedDatabase();
    const transport: Transport = async () => ({
      status: 200,
      headers: { "content-type": "application/zip" },
      body: Readable.from([await spufArchive()]),
    });
    const archive = parseSpufUrl(spufUrl)!;
    await acquireSpuf(archive, {
      dataDir: loaded.dataDir,
      dependencies: { lookup, transport },
    });
    await importSpuf(
      loaded.db,
      (await cachedSpuf(archive.kind, loaded.dataDir))[0]!,
    );
  }, 300_000);
  afterAll(async () => {
    await loaded?.cleanup();
  });

  function mcpApp(env: Record<string, string>, options: HttpOptions = {}) {
    return createMcpHttp(loaded.db, { env, log: () => {}, ...options });
  }
  const call = (extra: Record<string, string> = {}, input: unknown = args()) =>
    post(
      "tools/call",
      { name: MEDICARE_ESTIMATE_TOOL, arguments: input },
      extra,
    );
  const bearer = { authorization: `Bearer ${MCP_TOKEN}` };

  it("gives the same answer as the HTTP route, with evidence and provenance", async () => {
    switches(true, true);
    const http = createApp(
      loaded.db,
      { premiumToken: API_TOKEN },
      { store: new SpyStore(), config: loadConfig({}) },
    );
    const route = await http.request(
      `/v1/medicare/plans/${PLAN}/drug-cost-estimates?year=2026`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${API_TOKEN}`,
        },
        body: JSON.stringify(schedule()),
      },
    );
    expect(route.status).toBe(200);
    const routeBody = await route.json();

    const response = await mcpApp({ OPENPLANS_MCP_TOKEN: MCP_TOKEN }).fetch(
      call(bearer),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const result = (await rpc<CallMessage>(response)).result;
    const output = result.structuredContent;
    expect(estimateOutputSchema.safeParse(output).success).toBe(true);
    expect(output.error, JSON.stringify(output.error)).toBeNull();
    expect(output.data).toEqual(routeBody);
    expect(JSON.parse(result.content[0]!.text)).toEqual(output);

    // Benefit evidence cites CMS rows; the envelope names each cited snapshot.
    expect(output.data!.benefit_type).toMatchObject({ origin: "pbp_filing" });
    const sources = new Map(
      output.provenance.map((s): [string, Provenance] => [s.snapshot_id, s]),
    );
    expect(sources.size).toBeGreaterThan(0);
    for (const id of output.data!.snapshot_ids)
      expect(sources.get(id)).toMatchObject({ status: "available" });
    const rows = output.data!.evidence.filter((e) =>
      ["source_row", "pbp_row"].includes(e.kind),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const item of rows)
      expect(sources.get(item.snapshot_id)).toMatchObject({
        status: "available",
      });
    // No prices are loaded: the fill amount is unknown with a reason, and so is the envelope.
    const fill = output.data!.fills[0]!;
    expect(fill.figures.patient_pay).toMatchObject({
      status: "unknown",
      cents: null,
    });
    expect(fill.figures.patient_pay.reason).toBeTruthy();
    expect(output.status).toBe("unknown");
    expect(JSON.stringify(output)).not.toMatch(/not[ _-]?covered/i);
    expect(() => assertEstimateHonest(output, routeBody)).not.toThrow();
  });

  it("matches the service called directly, unsupported scenarios included", async () => {
    switches(true, true);
    for (const overrides of [
      {},
      { price_basis: "cms_plan_average" },
      {
        opening_state: {
          kind: "provided",
          as_of: "2026-01-15",
          gross_covered_drug_cost_cents: 900_000,
          troop_cents: 210_000,
          plan_deductible_met_cents: 0,
        },
      },
    ]) {
      const direct = await estimateMedicareDrugCost(
        loaded.db,
        PLAN,
        { year: "2026" },
        schedule(overrides),
      );
      const result = await callEstimateTool(
        grantedDeps(loaded.db),
        args(overrides),
      );
      expect(result.structuredContent.data).toEqual(direct);
      if (overrides.price_basis)
        expect(result.structuredContent.status).toBe("unsupported");
    }
  });

  it("needs a verified Bearer token and never opens to anonymous callers", async () => {
    switches(true, true);
    // No MCP token, household tools open to anonymous callers: the estimate stays closed.
    const open = mcpApp({});
    const listedOpen = await rpc<ToolsListMessage>(
      await open.fetch(post("tools/list")),
    );
    expect(
      listedOpen.result.tools.map((t: { name: string }) => t.name),
    ).toContain("quote_premiums");
    expect(
      listedOpen.result.tools.map((t: { name: string }) => t.name),
    ).not.toContain(MEDICARE_ESTIMATE_TOOL);
    const notConfigured = await open.fetch(call());
    expect(notConfigured.status).toBe(503);
    expect((await notConfigured.json()).error.message).toBe(
      "AUTH_NOT_CONFIGURED",
    );

    const app = mcpApp({ OPENPLANS_MCP_TOKEN: MCP_TOKEN });
    for (const extra of [
      {} as Record<string, string>,
      { authorization: "Bearer not-the-token" },
    ]) {
      const denied = await app.fetch(call(extra));
      expect(denied.status).toBe(401);
      expect(denied.headers.get("www-authenticate")).toContain("Bearer");
    }
    const allowed = await app.fetch(call(bearer));
    expect(allowed.status).toBe(200);
    expect(
      (await rpc<CallMessage>(allowed)).result.structuredContent.status,
    ).not.toBe("error");
    // Direct calls without the grant are refused before any read.
    const direct = await callEstimateTool(
      { ...grantedDeps(unusedDb), medicareEstimateGrant: false },
      args(),
    );
    expect(direct.structuredContent.error?.code).toBe("AUTH_REQUIRED");
  });

  it("with the switches off the name is unknown and answers as before", async () => {
    switches(false, false);
    const app = mcpApp({ OPENPLANS_MCP_TOKEN: MCP_TOKEN });
    const before = await app.fetch(
      post(
        "tools/call",
        { name: "synthetic_absent_tool", arguments: {} },
        bearer,
      ),
    );
    const estimate = await app.fetch(call(bearer));
    expect(estimate.status).toBe(before.status);
    const [a, b] = [await rpc(before), await rpc(estimate)];
    expect(JSON.stringify(b).replaceAll(MEDICARE_ESTIMATE_TOOL, "X")).toBe(
      JSON.stringify(a).replaceAll("synthetic_absent_tool", "X"),
    );
  });

  it("never caches, stores or logs the schedule", async () => {
    switches(true, true);
    const store = new SpyStore();
    const logs: unknown[] = [];
    const levels: unknown[] = [];
    const spies = (["log", "error", "warn", "info", "debug"] as const).map(
      (name) => vi.spyOn(console, name),
    );
    const app = mcpApp(
      { OPENPLANS_MCP_TOKEN: MCP_TOKEN },
      {
        log: (entry) => logs.push(entry),
        onCacheLevel: (level) => levels.push(level),
      },
    );
    for (let i = 0; i < 2; i++) {
      const response = await app.fetch(call(bearer));
      expect(response.status).toBe(200);
      await response.text();
    }
    expect(levels).toEqual(["none", "none"]);
    expect(logs).toHaveLength(2);
    for (const entry of logs)
      expect(entry).toMatchObject({
        tool: MEDICARE_ESTIMATE_TOOL,
        cache: "bypass",
      });
    const written = JSON.stringify([
      logs,
      ...spies.map((spy) => spy.mock.calls),
    ]);
    for (const secret of [FILL_ID, "860975", "2026-02-03"])
      expect(written).not.toContain(secret);
    // The direct call never touches a response cache either.
    let level: unknown;
    await runWithScope(async (scope) => {
      await callEstimateTool(
        { ...grantedDeps(loaded.db), cache: undefined },
        args(),
      );
      level = scope.level();
    });
    expect(level).toBe("none");
    expect(store.sets).toBe(0);
  });

  it("refuses a caller's benefit type or drug class", async () => {
    switches(true, true);
    const deps = grantedDeps(loaded.db);
    const asserted = [
      { ...args(), benefit_type: "ds" },
      {
        ...args(),
        fills: [{ ...schedule().fills[0], insulin: "yes" }],
      },
      {
        ...args(),
        fills: [{ ...schedule().fills[0], program: "selected" }],
      },
    ];
    for (const input of asserted) {
      const result = await callEstimateTool(deps, input);
      expect(result.structuredContent.status).toBe("error");
      expect(result.structuredContent.error?.code).toBe("UNSUPPORTED_FIELD");
      expect(JSON.stringify(result)).not.toMatch(/"(ds|yes|selected)"/);
    }
    // Over the transport the SDK schema or the tool refuses it; no estimate comes back.
    const app = mcpApp({ OPENPLANS_MCP_TOKEN: MCP_TOKEN });
    const response = await app.fetch(call(bearer, asserted[0]));
    const body = await rpc<CallMessage>(response);
    expect(
      body.error !== undefined ||
        body.result.structuredContent?.status === "error" ||
        body.result.isError === true,
    ).toBe(true);
  });

  /** The tool's data has the HTTP route's bytes, grouped county rows included. */
  async function sameAsHttp(hooks: EstimateToolHooks): Promise<boolean> {
    const http = createApp(
      loaded.db,
      { premiumToken: API_TOKEN },
      { store: new SpyStore(), config: loadConfig({}) },
    );
    const route = await http.request(
      `/v1/medicare/plans/${PLAN}/drug-cost-estimates?year=2026`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${API_TOKEN}`,
        },
        body: JSON.stringify(schedule()),
      },
    );
    const text = await route.text();
    const result = await callEstimateTool(
      grantedDeps(loaded.db),
      args(),
      0,
      hooks,
    );
    const output = result.structuredContent as ToolOutput;
    if (output.error) return false;
    try {
      assertEstimateHonest(output, JSON.parse(text));
    } catch {
      return false;
    }
    return JSON.stringify(output.data) === text;
  }

  it("shares the grouped evidence shape with HTTP; a diverging MCP shape is caught", async () => {
    switches(true, true);
    expect(await sameAsHttp(estimateToolHooks)).toBe(true);
    const result = await callEstimateTool(grantedDeps(loaded.db), args());
    const data = (result.structuredContent as ToolOutput).data!;
    expect(
      data.evidence.filter((item) => item.kind === "source_rows").length,
    ).toBeGreaterThan(0);
    // Planted mutant: the tool lists county rows one by one while HTTP groups them.
    const diverged: EstimateToolHooks = {
      ...estimateToolHooks,
      service: {
        ...drugCostDeps,
        readBundle: async (...input) => {
          const bundle = await drugCostDeps.readBundle(...input);
          return bundle.status === "available"
            ? { ...bundle, row_groups: [] }
            : bundle;
        },
      },
    };
    expect(await sameAsHttp(diverged)).toBe(false);
  });

  it("the honesty check refuses changed figures, lost sources and denial words", async () => {
    switches(true, true);
    const result = await callEstimateTool(grantedDeps(loaded.db), args());
    const output = result.structuredContent as ToolOutput;
    const canonical = structuredClone(output.data);
    expect(() =>
      assertEstimateHonest(output, canonical as DrugCostEstimate),
    ).not.toThrow();
    const tamper = (edit: (copy: ToolOutput) => void, against = canonical) => {
      const copy = structuredClone(output);
      edit(copy);
      return () => assertEstimateHonest(copy, against as DrugCostEstimate);
    };
    // A plausible invented cent.
    expect(
      tamper((c) => {
        c.data!.plan_figures.standard_deductible.cents! += 1;
      }),
    ).toThrow(/INTERNAL_HONESTY_CHECK/);
    // A cited snapshot missing from provenance.
    expect(tamper((c) => c.provenance.pop())).toThrow(/INTERNAL_HONESTY_CHECK/);
    // An unknown relabelled as a coverage denial, even if the service said it.
    const denied = structuredClone(canonical);
    denied!.fills[0]!.figures.patient_pay.reason = "not_covered";
    expect(
      tamper((c) => {
        c.data!.fills[0]!.figures.patient_pay.reason = "not_covered";
      }, denied),
    ).toThrow(/INTERNAL_HONESTY_CHECK/);
    // A value figure without evidence.
    const bare = structuredClone(canonical);
    bare!.plan_figures.standard_deductible.evidence_refs = [];
    expect(
      tamper((c) => {
        c.data!.plan_figures.standard_deductible.evidence_refs = [];
      }, bare),
    ).toThrow(/INTERNAL_HONESTY_CHECK/);
    // A grouped county row lost from its group.
    expect(
      tamper((c) => {
        const group = c.data!.evidence.find(
          (item) => item.kind === "source_rows",
        );
        group!.source_rows!.pop();
      }),
    ).toThrow(/INTERNAL_HONESTY_CHECK/);
    // Envelope status must follow the answer: partial or unknown is never ok.
    expect(tamper((c) => (c.status = "ok"))).toThrow(/INTERNAL_HONESTY_CHECK/);
  });
});

describe("stdio follows the personalized-tool rules", () => {
  function stdioList(env: Record<string, string>) {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ["dist/mcp/stdio.js"], {
        env: {
          PATH: process.env.PATH,
          DATABASE_URL:
            "postgresql://synthetic:synthetic@127.0.0.1:1/synthetic",
          ...env,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("stdio did not exit"));
      }, 10_000);
      child.stdout.on("data", (data) => {
        output += String(data);
        if (output.includes('"id":2')) child.stdin.end();
      });
      child.on("error", reject);
      child.on("exit", () => {
        clearTimeout(timer);
        resolve(output);
      });
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            clientInfo: { name: "synthetic-stdio-client", version: "1" },
            capabilities: {},
          },
        }) + "\n",
      );
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n",
      );
    });
  }
  const on = {
    OPENPLANS_MEDICARE_PART_D: "on",
    OPENPLANS_MEDICARE_DRUG_COST: "on",
  };
  it("lists the estimate only with the switches on and the stdio grant", async () => {
    expect(
      await stdioList({ ...on, OPENPLANS_MCP_ALLOW_PERSONALIZED: "1" }),
    ).toContain(`"name":"${MEDICARE_ESTIMATE_TOOL}"`);
    expect(
      await stdioList({ ...on, OPENPLANS_MCP_ALLOW_PERSONALIZED: "0" }),
    ).not.toContain(MEDICARE_ESTIMATE_TOOL);
    expect(
      await stdioList({ OPENPLANS_MCP_ALLOW_PERSONALIZED: "1" }),
    ).not.toContain(MEDICARE_ESTIMATE_TOOL);
  }, 30_000);
});

// Planted mutants in disposable copies. Each must make the matching assertion above fail.
describe("negative controls", () => {
  async function mutant<T>(
    file: string,
    _kind: string,
    edits: [string, string][],
  ): Promise<{ module: T; cleanup: () => Promise<void> }> {
    // `file` is relative to src/mcp.
    const source = new URL(`../../src/mcp/${file}.ts`, import.meta.url);
    let text = await readFile(source, "utf8");
    for (const [before, after] of edits)
      text = replaceSyntax(text, before, after);
    const planted = await plantMutantFile(source, text);
    try {
      // The copy must load every function the real module exports.
      const real = (await import(/* @vite-ignore */ source.href)) as object;
      const functions = Object.entries(real)
        .filter(([, value]) => typeof value === "function")
        .map(([name]) => name);
      return {
        module: await importMutant<T & object>(
          planted.url,
          ...(functions as (keyof T & string)[]),
        ),
        cleanup: planted.cleanup,
      };
    } catch (error) {
      await planted.cleanup();
      throw error;
    }
  }

  it("a tool listed with the switch off is caught", async () => {
    switches(false, false);
    const { module, cleanup } = await mutant<typeof EstimateModule>(
      "medicare-estimate",
      "switch",
      [
        [
          "if (!hooks.enabled() || !hooks.granted(deps)) return undefined;",
          "if (!hooks.granted(deps)) return undefined;",
        ],
      ],
    );
    try {
      const assertion = (mod: typeof EstimateModule) => () =>
        expect(
          mod.registerEstimateTool(
            new McpServer({ name: "synthetic", version: "1" }),
            grantedDeps(),
          ),
        ).toBeUndefined();
      expect(
        assertion({ registerEstimateTool } as typeof EstimateModule),
      ).not.toThrow();
      expect(assertion(module)).toThrow();
    } finally {
      await cleanup();
    }
  });

  it("the estimate tool silently omitted is caught", async () => {
    switches(true, true);
    const server = await mutant<typeof ServerModule>("server", "omitted", [
      [
        "const estimate = registerEstimateTool(server, deps);",
        "const estimate = undefined;",
      ],
    ]);
    const pages = await mutant<typeof McpToolsModule>(
      "../plugins/mcp-tools",
      "uncounted",
      [["...switchedCoreTools()", ""]],
    );
    try {
      const listedBy = (build: typeof buildServer) => async () => {
        const { createMcpHandler } =
          await import("@modelcontextprotocol/server");
        const handler = createMcpHandler(() => build(grantedDeps()), {
          legacy: "stateless",
        });
        const body = await rpc<ToolsListMessage>(
          await handler.fetch(post("tools/list")),
        );
        await handler.close();
        expect(
          body.result.tools.map((t: { name: string }) => t.name),
        ).toContain(MEDICARE_ESTIMATE_TOOL);
      };
      await expect(listedBy(buildServer)()).resolves.toBeUndefined();
      await expect(listedBy(server.module.buildServer)()).rejects.toThrow();
      const room = TOOL_LIST_PAGE_SIZE - toolNames.length;
      const plugins = [["@synthetic/near-full", nearFull(room)]] as const;
      const refuses = (check: typeof toolPageRefusal) => () =>
        expect(check(plugins)?.code).toBe("mcp_tool_page_overflow");
      expect(refuses(toolPageRefusal)).not.toThrow();
      expect(refuses(pages.module.toolPageRefusal)).toThrow();
    } finally {
      await server.cleanup();
      await pages.cleanup();
    }
  });

  it("anonymous access accepted is caught", async () => {
    switches(true, true);
    const { module, cleanup } = await mutant<{
      createMcpHttp: typeof createMcpHttp;
    }>("http", "estimate-auth", [
      [
        "const needsEstimateGrant = estimateCall && !granted;",
        "const needsEstimateGrant = estimateCall && !granted && !open;",
      ],
      ["granted || open, granted )", "granted || open, granted || open )"],
    ]);
    try {
      const assertion = (factory: typeof createMcpHttp) => async () => {
        const app = factory(unusedDb, { env: {}, log: () => {} });
        const response = await app.fetch(
          post("tools/call", {
            name: MEDICARE_ESTIMATE_TOOL,
            arguments: args(),
          }),
        );
        await response.text();
        expect(response.status).toBe(503);
      };
      await expect(assertion(createMcpHttp)()).resolves.toBeUndefined();
      await expect(assertion(module.createMcpHttp)()).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });

  it("a cached schedule is caught", async () => {
    switches(true, true);
    const { module, cleanup } = await mutant<typeof EstimateModule>(
      "medicare-estimate",
      "cache",
      [['restrict: () => restrictCacheLevel("none"),', "restrict: () => {},"]],
    );
    try {
      const assertion = (mod: typeof EstimateModule) => async () => {
        let level: unknown;
        await runWithScope(async (scope) => {
          await mod.callEstimateTool(
            { ...grantedDeps(unusedDb), medicareEstimateGrant: false },
            args(),
          );
          level = scope.level();
        });
        expect(level).toBe("none");
      };
      await expect(
        assertion({ callEstimateTool } as typeof EstimateModule)(),
      ).resolves.toBeUndefined();
      await expect(assertion(module)()).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });

  it("policy never turns household openness into the estimate grant", () => {
    const config = loadConfig({});
    expect(
      configDependencies(unusedDb, config, true).medicareEstimateGrant,
    ).toBe(undefined);
    expect(
      configDependencies(unusedDb, config, true, true).medicareEstimateGrant,
    ).toBe(true);
  });
});
