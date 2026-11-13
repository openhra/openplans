import { sharedResponseCache } from "../../src/api/cache/index.js";
import { PGlite } from "@electric-sql/pglite";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrate } from "../../src/db/migrate.js";
import { ingestGeo } from "../../src/ingest/geo/index.js";
import { importPufs } from "../../src/ingest/puf/import.js";
import { ingestRatingRules } from "../../src/ingest/rating-rules/index.js";
import { importFormulary } from "../../src/ingest/qhp/formulary.js";
import { importProviders } from "../../src/ingest/qhp/provider.js";
import { getPlan, estimatePremiums } from "../../src/services/catalog.js";
import { checkDrugCoverages, getDrug } from "../../src/services/drugs.js";
import { checkProviderNetworks } from "../../src/services/providers.js";
import {
  discoverPlans,
  parseEntityId,
  nativeWindow,
} from "../../src/services/discovery.js";
import {
  assertHonest,
  evidenceCaution,
  outputSchemas,
  toolAnnotations,
  toolNames,
} from "../../src/mcp/schemas.js";
import { buildServer } from "../../src/mcp/server.js";
import {
  callTool,
  MAX_OUTPUT_BYTES,
  MAX_TOOL_LIST_BYTES,
} from "../../src/mcp/tools.js";
import { projector, row } from "../../src/mcp/projection.js";
import { cursorCodec } from "../../src/mcp/cursor.js";
import { testDatabase, coreMigrations } from "../pglite.js";
import { fixtureFiles } from "../api/helpers.js";
import { fixtureFiles as geoFiles } from "../ingest/geo/helpers.js";
import * as drugFixture from "../ingest/qhp/formulary-helpers.js";
import * as providerFixture from "../ingest/qhp/provider-helpers.js";
import { connect } from "./client.js";

const authorized = {
  principal: { id: "synthetic-mcp-principal" },
  policy: { canEstimate: () => true },
};
// Real CMS/Census cuts; household, credentials and each explicitly marked mutation are synthetic.
describe("in-process MCP public catalog and estimates", () => {
  const db = testDatabase(new PGlite());
  let dir: string,
    core: Awaited<ReturnType<typeof coreMigrations>>,
    h: Awaited<ReturnType<typeof connect>>;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "openplans-mcp-tools-"));
    core = await coreMigrations();
    await migrate(db, core.directory);
    await ingestGeo(db, { files: await geoFiles() });
    expect(
      (
        await importPufs(db, {
          year: 2026,
          state: "TX",
          files: await fixtureFiles(dir),
          dataDir: dir,
        })
      ).status,
    ).toBe("ACTIVE");
    await ingestRatingRules(db);
    h = await connect({ db, ...authorized });
  });
  afterAll(async () => {
    await h?.close();
    await db.close();
    await core?.cleanup();
    await rm(dir, { recursive: true, force: true });
  });

  it("discovers all fifteen tools in fixed order when granted, closed contracts, annotations and instructions", async () => {
    const list = await h.client.listTools();
    expect(list.tools.map((t) => t.name)).toEqual(toolNames);
    for (const tool of list.tools) {
      expect(tool.title).toBeTruthy();
      expect(tool.description?.endsWith(evidenceCaution)).toBe(true);
      expect(tool.annotations).toEqual(toolAnnotations);
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.outputSchema?.additionalProperties).toBe(false);
    }
    expect(list.cacheScope).toBe("private");
    expect(list.ttlMs).toBe(0);
    const discovery = await h.client.discover();
    expect(discovery.instructions).toContain("get_data_status");
    expect(discovery.instructions).toContain("not bindable");
    expect(discovery.instructions).toContain("quote_plans");
    expect(discovery.cacheScope).toBe("public");
    expect(discovery.ttlMs).toBe(3_600_000);
    expect(discovery.capabilities.tools?.listChanged).toBe(false);
    expect(discovery.capabilities.resources?.listChanged).toBe(false);
  });
  it("calls scoped catalog tools with independent source evidence and typed fetch IDs", async () => {
    const plans = await h.call("search_plans", {
      location: { county: "48201" },
      year: 2026,
      limit: 2,
    });
    expect(plans.data?.plans).toHaveLength(2);
    expect(plans.provenance.length).toBeGreaterThan(0);
    const detail = await h.call("get_plan", {
      plan_ref: "87226TX0100013",
      year: 2026,
    });
    expect(detail.data?.plan).toMatchObject({
      plan_ref: "87226TX0100013",
      hios_id: "87226TX0100013",
      plan_key: null,
    });
    const benefits = await h.call("get_plan", {
      plan_ref: "87226TX0100013-00",
      year: 2026,
      section: "benefits",
    });
    expect(benefits.data?.records.length).toBeGreaterThan(0);
    const docs = await h.call("get_plan", {
      plan_ref: "87226TX0100013",
      year: 2026,
      section: "documents",
    });
    expect(docs.notes).toContain("DOCUMENT_EVIDENCE_UNAVAILABLE");
    expect(docs.data?.records).toEqual([]);
    const geography = await h.call("lookup_geography", { zip: "75034" });
    expect(geography.status).toBe("ambiguous");
    expect(geography.data?.counties.length).toBeGreaterThan(1);
    const status = await h.call("get_data_status", { state: "TX", year: 2026 });
    expect(status.data?.loaded).toBe(true);
    expect(status.data?.personalized_access).toBe("authorized");
    for (const kind of ["carriers", "networks"])
      expect(
        (
          await h.call("list_carriers_networks", {
            state: "TX",
            year: 2026,
            kind,
          })
        ).data?.rows.length,
      ).toBeGreaterThan(0);
    const search = await h.call("search", {
      query: "87226TX0100013",
      entity: "plan",
      location: { county: "48201" },
      year: 2026,
    });
    expect(search.data?.results).toHaveLength(1);
    const id = search.data!.results[0]!.id;
    expect(parseEntityId(id)).toEqual({
      kind: "plan",
      parts: ["2026", "87226TX0100013"],
    });
    const fetched = await h.call("fetch", { id });
    expect(fetched.data?.records[0]).toEqual(detail.data?.plan);
    const noScope = await h.call("search", { query: "health", entity: "plan" });
    expect(noScope.data?.scope_gaps).toContain(
      "PLAN_SEARCH_REQUIRES_YEAR_AND_LOCATION",
    );
    for (const id of [
      "https://example.com/",
      "file:///etc/passwd",
      "../local",
      "snapshot:https%3A%2F%2Fexample.com",
      "plan:2026:..%2Fsecret",
    ]) {
      expect((await h.call("fetch", { id }, true)).error?.code).toBe(
        "INVALID_FETCH_ID",
      );
    }
  });
  it("keeps exact premium cents and complete native rate traces, and rejects amount/provenance mutants", async () => {
    const input = {
      plan_refs: ["87226TX0100013"],
      location: { county: "48201" },
      coverage_start: "2026-01-01",
      members: [{ age: 35, tobacco: false, relationship: "subscriber" }],
    };
    const output = await h.call("quote_premiums", input);
    expect(output.data?.quotes[0]?.gross_monthly_cents).toBe(52928);
    const native = await estimatePremiums(db, {
      plan_ids: input.plan_refs,
      ...input.location,
      coverage_start: input.coverage_start,
      members: input.members,
    });
    assertHonest("quote_premiums", output, native);
    const amount = structuredClone(output);
    amount.data!.quotes[0]!.gross_monthly_cents!++;
    expect(() => outputSchemas.quote_premiums.parse(amount)).not.toThrow();
    expect(() => assertHonest("quote_premiums", amount, native)).toThrow(
      "fabricated cents",
    );
    const dropped = structuredClone(output);
    dropped.provenance = [];
    expect(() => assertHonest("quote_premiums", dropped, native)).toThrow(
      "unresolvable provenance",
    );
    const status = structuredClone(output);
    status.data!.quotes[0]!.gross_status = "unknown";
    expect(() => assertHonest("quote_premiums", status, native)).toThrow(
      "unrated numeric premium",
    );
  });
  it("preserves every native-page remainder and rejects filter/scope/generation/expiry/tamper cursors", async () => {
    const expected = await discoverPlans(
      db,
      { county: "48201", year: "2026" },
      "",
    );
    const found: string[] = [];
    let cursor: string | undefined;
    do {
      const output = await h.call("search_plans", {
        location: { county: "48201" },
        year: 2026,
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      found.push(...output.data!.plans.map((p) => p.plan_ref));
      cursor = output.page?.next_cursor ?? undefined;
      expect(output.page?.returned).toBeLessThanOrEqual(17);
    } while (cursor);
    expect(found).toEqual(expected.map((r) => String(r.base_plan_id)));
    expect(new Set(found).size).toBe(found.length);
    expect(found.length).toBeGreaterThan(1);
    // Synthetic ordinal fixture crosses 50-row native pages at offset 34, 51 and 102.
    const ordinals = Array.from({ length: 123 }, (_, i) => i),
      read = async (page: number) => ({
        items: ordinals.slice((page - 1) * 50, page * 50),
        total: ordinals.length,
      });
    const actual: number[] = [];
    for (let at = 0; at < ordinals.length; at += 17)
      actual.push(...(await nativeWindow(at, 17, read)).items);
    expect(actual).toEqual(ordinals);
    const skippedRemainder = actual.filter((n) => n !== 49);
    expect(() => expect(skippedRemainder).toEqual(ordinals)).toThrow();
    const first = await h.call("search_plans", {
      location: { county: "48201" },
      year: 2026,
      limit: 1,
    });
    const token = first.page!.next_cursor!;
    expect(
      (
        await h.call(
          "search_plans",
          {
            location: { county: "48201" },
            year: 2026,
            limit: 1,
            cursor: `${token.slice(0, -8)}AAAAAAAA`,
          },
          true,
        )
      ).error?.code,
    ).toBe("INVALID_CURSOR");
    expect(
      (
        await h.call(
          "search_plans",
          {
            location: { county: "48201" },
            year: 2026,
            limit: 2,
            cursor: token,
          },
          true,
        )
      ).error?.code,
    ).toBe("INVALID_CURSOR");
    const other = await connect({ db });
    try {
      expect(
        (
          await other.call(
            "search_plans",
            {
              location: { county: "48201" },
              year: 2026,
              limit: 1,
              cursor: token,
            },
            true,
          )
        ).error?.code,
      ).toBe("INVALID_CURSOR");
    } finally {
      await other.close();
    }
    await db.query(
      "UPDATE snapshot SET publisher_updated_at=clock_timestamp() WHERE snapshot_id=(SELECT snapshot_id FROM puf_import_file WHERE kind='rate' LIMIT 1)",
    );
    expect(
      (
        await h.call(
          "search_plans",
          {
            location: { county: "48201" },
            year: 2026,
            limit: 1,
            cursor: token,
          },
          true,
        )
      ).error?.code,
    ).toBe("CURSOR_EXPIRED");
    let time = 1000;
    const codec = cursorCodec("synthetic-cursor-key", () => time),
      binding = {
        tool: "search",
        filters: { a: 1 },
        generation: "g",
        scope: "anon",
      };
    const old = codec.issue(binding, 7);
    time += 900_001;
    expect(() => codec.read(old, binding)).toThrow("CURSOR_EXPIRED");
    const mutant = cursorCodec("different-synthetic-key");
    expect(() => mutant.read(old, binding)).toThrow("INVALID_CURSOR");
  });
  it("omits estimates anonymously and rechecks a policy revoked after registration", async () => {
    let allowed = true;
    const restricted = await connect(
      {
        db,
        principal: authorized.principal,
        policy: { canEstimate: () => allowed },
      },
      true,
    );
    const anonymous = await connect({ db });
    try {
      expect(
        (await anonymous.client.listTools()).tools.map((t) => t.name),
      ).not.toContain("quote_premiums");
      expect(
        (await anonymous.call("get_data_status", {})).data?.personalized_access,
      ).toBe("authentication_required");
      allowed = false;
      expect(
        (
          await restricted.call(
            "quote_premiums",
            {
              plan_refs: ["87226TX0100013"],
              location: { county: "48201" },
              coverage_start: "2026-01-01",
              members: [
                { age: 35, tobacco: false, relationship: "subscriber" },
              ],
            },
            true,
          )
        ).error?.code,
      ).toBe("AUTH_REQUIRED");
    } finally {
      await restricted.close();
      await anonymous.close();
    }
  });
  it("reads only bounded public resources and templates, with real cache hint fields", async () => {
    const list = await h.client.listResources();
    expect(list.resources.map((r) => r.uri)).toEqual([
      "openplans://availability",
      "openplans://sources",
      "openplans://limits",
    ]);
    const templates = await h.client.listResourceTemplates();
    expect(templates.resourceTemplates.map((t) => t.uriTemplate)).toEqual([
      "openplans://provenance/{snapshot_id}",
      "openplans://plan/{year}/{plan_id}",
    ]);
    for (const uri of [
      "openplans://availability",
      "openplans://sources",
      "openplans://limits",
      "openplans://plan/2026/87226TX0100013",
    ]) {
      const resource = await h.client.readResource({ uri });
      const content = resource.contents[0]!;
      expect("text" in content).toBe(true);
      if (!("text" in content)) throw new Error("Missing resource text");
      const value = JSON.parse(content.text);
      expect(value.status).not.toBe("error");
      expect(Buffer.byteLength(JSON.stringify(resource))).toBeLessThan(
        MAX_OUTPUT_BYTES,
      );
      expect(content.text).not.toContain("raw_path");
      if (uri !== "openplans://limits") {
        expect(resource.ttlMs).toBe(0);
        expect(resource.cacheScope).toBe("private");
      } else
        expect(JSON.parse(value.data.text)).toMatchObject({
          max_page: 25,
          output_bytes: MAX_OUTPUT_BYTES,
        });
    }
    const plan = await getPlan(db, "87226TX0100013", { year: "2026" });
    const snapshot = String(
      row(plan.provenance.snapshot_ids)["plan-attributes"],
    );
    const provenance = await h.client.readResource({
      uri: `openplans://provenance/${encodeURIComponent(snapshot)}`,
    });
    expect(provenance.ttlMs).toBe(3_600_000);
    expect(provenance.cacheScope).toBe("public");
    await expect(
      h.client.readResource({ uri: "https://example.com/" }),
    ).rejects.toThrow();
  });
  it("caps the full duplicated-content message and refuses an oversized singleton without stripping evidence", async () => {
    // Synthetic mutation in an isolated DB transaction: 50 raw benefit fields + 100 unparsed accumulators.
    const sentinel = new Error("rollback synthetic oversized fixture");
    await expect(
      db.transaction(async (tx) => {
        const raw = Object.fromEntries(
          Array.from({ length: 100 }, (_, i) => [
            `MEHBDedSynthetic${i}`,
            "x".repeat(1000),
          ]),
        );
        await tx.query(
          "UPDATE plan_variant SET raw=$1 WHERE variant_plan_id=$2",
          [JSON.stringify(raw), "87226TX0100013-00"],
        );
        const sharing = Object.fromEntries(
          Array.from({ length: 50 }, (_, i) => [
            `Synthetic${i}`,
            "x".repeat(1000),
          ]),
        );
        await tx.query(
          "UPDATE plan_benefit SET cost_sharing_raw=$1,cost_sharing_parsed=$2 WHERE published_plan_id=$3",
          [JSON.stringify(sharing), "{}", "87226TX0100013-00"],
        );
        const result = await callTool({ db: tx }, "get_plan", {
          plan_ref: "87226TX0100013-00",
          year: 2026,
          section: "benefits",
        });
        expect(result.structuredContent.error?.code).toBe("RESULT_TOO_LARGE");
        expect(result.isError).toBe(true);
        throw sentinel;
      }),
    ).rejects.toBe(sentinel);
    expect(
      h.messages
        .filter((s) => s.includes("structuredContent"))
        .every((s) => Buffer.byteLength(s) <= MAX_OUTPUT_BYTES),
    ).toBe(true);
  });
  it("fits large pages by returning complete rows with a cursor pointing to the first omitted row", async () => {
    const sentinel = new Error("rollback synthetic wide fixture");
    await expect(
      db.transaction(async (tx) => {
        const sharing = Object.fromEntries(
          Array.from({ length: 50 }, (_, i) => [
            `Synthetic${i}`,
            "x".repeat(300),
          ]),
        );
        await tx.query(
          "UPDATE plan_benefit SET cost_sharing_raw=$1,cost_sharing_parsed=$2 WHERE published_plan_id=$3",
          [JSON.stringify(sharing), "{}", "87226TX0100013-00"],
        );
        const expected = (
          await getPlan(tx, "87226TX0100013-00", { year: "2026" })
        ).benefits.map((b) => b.benefit_name);
        const client = await connect({ db: tx });
        try {
          const found: string[] = [];
          let cursor: string | undefined;
          do {
            const output = await client.call("get_plan", {
              plan_ref: "87226TX0100013-00",
              year: 2026,
              section: "benefits",
              limit: 10,
              ...(cursor ? { cursor } : {}),
            });
            expect(output.page!.returned).toBeGreaterThan(0);
            expect(output.page!.returned).toBeLessThan(10);
            for (const record of output.data!.records) {
              expect(record.evidence_refs.length).toBeGreaterThan(0);
              if (record.kind === "benefit") {
                expect(record.cost_sharing_text).toHaveLength(50);
                found.push(record.name);
              }
            }
            cursor = output.page?.next_cursor ?? undefined;
          } while (cursor);
          expect(found).toEqual(expected);
          expect(
            client.messages
              .filter((s) => s.includes("structuredContent"))
              .every((s) => Buffer.byteLength(s) <= MAX_OUTPUT_BYTES),
          ).toBe(true);
        } finally {
          await client.close();
        }
        throw sentinel;
      }),
    ).rejects.toBe(sentinel);
  });
  it("enforces the SDK input-element ceiling before schema dispatch", async () => {
    const result = await h.client.callTool({
      name: "get_data_status",
      arguments: { synthetic: Array.from({ length: 600 }, () => 1) },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("512 elements"),
    });
  });
  it("fits schema discovery under its budget even with a large caller-issued RPC ID", async () => {
    // Each stateless factory must return a fresh instance; reuse dependencies, not the server object.
    const fresh = createMcpHandler(() => buildServer({ db, ...authorized }), {
      legacy: "stateless",
    });
    try {
      const id = "synthetic-rpc-id:".padEnd(64_000, "x"),
        names: string[] = [];
      let cursor: string | undefined;
      do {
        const response = await fresh.fetch(
          new Request("http://127.0.0.1/mcp", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id,
              method: "tools/list",
              params: cursor ? { cursor } : {},
            }),
          }),
        );
        const text = await response.text();
        expect(response.status).toBe(200);
        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(
          MAX_TOOL_LIST_BYTES,
        );
        const payload = text.startsWith("{")
          ? text
          : text
              .split("\n")
              .find((line) => line.startsWith("data:"))!
              .slice(5);
        const result = JSON.parse(payload).result;
        expect(result.tools.map((t: { name: string }) => t.name)).toEqual(
          toolNames,
        );
        expect(result.nextCursor).toBeUndefined();
        names.push(...result.tools.map((t: { name: string }) => t.name));
        cursor = result.nextCursor;
      } while (cursor);
      expect(names).toEqual(toolNames);
    } finally {
      await fresh.close();
    }
  });
  it("supports a legacy in-process client with identical structured/text content", async () => {
    const legacy = await connect({ db }, true);
    try {
      expect(
        (await legacy.call("lookup_geography", { zip: "75034" })).status,
      ).toBe("ambiguous");
    } finally {
      await legacy.close();
    }
  });
});

describe("in-process MCP RxNorm/formulary evidence", () => {
  let fixture: Awaited<ReturnType<typeof drugFixture.setup>>,
    h: Awaited<ReturnType<typeof connect>>,
    plan: string,
    rxcui: string;
  beforeAll(async () => {
    fixture = await drugFixture.setup();
    const records = await drugFixture.fixture("drugs");
    plan = fixture.catalog.plans[0].base_plan_id;
    rxcui = records[0].rxnorm_id;
    await fixture.replace(records);
    expect((await importFormulary(fixture.db, drugFixture.scope)).status).toBe(
      "ACTIVE",
    );
    h = await connect({ db: fixture.db });
  });
  afterAll(async () => {
    await h?.close();
    await fixture?.close();
  });
  it("serves cached terminology and coverage with the original canonical concept checks", async () => {
    const deps = { db: fixture.db, now: () => 1_800_000_000_000 };
    const cache = sharedResponseCache(fixture.db),
      before = cache.stats().hits;
    for (const [tool, input] of [
      ["search_drugs", { query: "metformin", limit: 1 }],
      ["search", { query: "metformin", entity: "drug", limit: 1 }],
      ["fetch", { id: `drug:${rxcui}` }],
      [
        "check_drug_coverage",
        { plan_ids: [plan], rxcuis: [rxcui], year: 2026 },
      ],
    ] as const) {
      const hits = cache.stats().hits;
      const cold = await callTool(deps, tool, input),
        warm = await callTool(deps, tool, input);
      expect(cold.isError, tool).toBeUndefined();
      expect(warm).toEqual(cold);
      expect(cache.stats().hits - hits, tool).toBe(1);
    }
    expect(cache.stats().hits - before).toBe(4);
  });
  it("searches canonical unique concepts and refuses a schema-valid fabricated RxCUI", async () => {
    const output = await h.call("search_drugs", {
      query: "metformin",
      limit: 1,
    });
    expect(output.data?.candidates).toHaveLength(1);
    const candidate = output.data!.candidates[0]!;
    const canonical = await getDrug(fixture.db, candidate.rxcui),
      p = await projector(fixture.db, canonical);
    const context = { ...p.context, drugs: canonical.concepts };
    assertHonest("search_drugs", output, context);
    const mutant = structuredClone(output);
    mutant.data!.candidates[0]!.rxcui = "99999999999999999999";
    expect(() => outputSchemas.search_drugs.parse(mutant)).not.toThrow();
    expect(() => assertHonest("search_drugs", mutant, context)).toThrow(
      "fabricated drug concept",
    );
    const search = await h.call("search", {
      query: "metformin",
      entity: "drug",
      limit: 1,
    });
    expect(
      (await h.call("fetch", { id: search.data!.results[0]!.id })).data?.entity,
    ).toBe("drug");
  });
  it("retains issuer evidence, unresolved flags, completeness and unknown semantics", async () => {
    const output = await h.call("check_drug_coverage", {
      plan_ids: [plan],
      rxcuis: [rxcui],
      year: 2026,
    });
    expect(output.data?.results[0]).toMatchObject({
      status: "listed_covered",
      patient_price: null,
      source_completeness: "complete",
    });
    const unknown = await h.call("check_drug_coverage", {
      plan_ids: [plan],
      rxcuis: ["99999999999999999999"],
      year: 2026,
    });
    expect(unknown.data?.results[0]?.status).toBe("unknown");
    // The native reason travels with the unknown answer, as it does for CMS fallback answers.
    const native = await checkDrugCoverages(fixture.db, {
      plan_ids: [plan],
      rxcuis: ["99999999999999999999"],
      year: 2026,
    });
    const reason = (native.results[0] as { reason?: string }).reason;
    expect(reason).toEqual(expect.any(String));
    expect(unknown.data?.results[0]?.gaps).toContain(reason);
    const mutant = structuredClone(unknown) as unknown as {
      data: { results: { status: string }[] };
    };
    mutant.data.results[0]!.status = "not covered";
    expect(() => assertHonest("check_drug_coverage", mutant)).toThrow();
    const before = await h.call("search_drugs", { query: "metformin" });
    await fixture.db.query(
      "UPDATE snapshot SET validation_state='QUARANTINED' WHERE snapshot_id='rx'",
    );
    expect(before.data?.terminology_status).toBe("available");
    const absent = await h.call("search_drugs", { query: "metformin" });
    expect(absent.status).toBe("unknown");
    expect(absent.data?.terminology_status).toBe("unknown");
    expect(absent.data?.candidates).toEqual([]);
  });
});

describe("in-process MCP issuer provider evidence", () => {
  let fixture: Awaited<ReturnType<typeof providerFixture.setup>>,
    h: Awaited<ReturnType<typeof connect>>,
    plan: string,
    npi: string;
  beforeAll(async () => {
    fixture = await providerFixture.setup();
    const records = await providerFixture.fixture("records");
    plan = records[0].plans.find((p: { plan_id: string }) =>
      fixture.catalog.plans.some(
        (c: { base_plan_id: string }) => c.base_plan_id === p.plan_id,
      ),
    ).plan_id;
    npi = records[0].npi;
    await fixture.replace(records);
    expect(
      (await importProviders(fixture.db, providerFixture.scope)).status,
    ).toBe("ACTIVE");
    h = await connect({ db: fixture.db });
  });
  afterAll(async () => {
    await h?.close();
    await fixture?.close();
  });
  it("serves cached identities and participation without changing issuer evidence", async () => {
    const deps = { db: fixture.db, now: () => 1_800_000_000_000 };
    const cache = sharedResponseCache(fixture.db),
      before = cache.stats().hits;
    for (const [tool, input] of [
      ["search_providers", { npi, year: 2026 }],
      ["check_provider_network", { plan_ids: [plan], npis: [npi], year: 2026 }],
    ] as const) {
      const hits = cache.stats().hits;
      const cold = await callTool(deps, tool, input),
        warm = await callTool(deps, tool, input);
      expect(cold.isError, tool).toBeUndefined();
      expect(warm).toEqual(cold);
      expect(cache.stats().hits - hits, tool).toBe(1);
    }
    expect(cache.stats().hits - before).toBe(2);
  });
  it("calls provider tools without deriving address membership and refuses exact-NPI filter intersections", async () => {
    const found = await h.call("search_providers", { npi, year: 2026 });
    expect(found.data?.providers.length).toBeGreaterThan(0);
    expect(found.data?.providers[0]).toMatchObject({
      participation: "not_evaluated",
      participation_scope: "identity",
    });
    const planFound = await h.call("search_providers", {
      plan_id: plan,
      year: 2026,
    });
    expect(planFound.data?.providers.length).toBeGreaterThan(0);
    const membership = await h.call("check_provider_network", {
      plan_ids: [plan],
      npis: [npi],
      year: 2026,
    });
    expect(membership.data?.results[0]).toMatchObject({
      status: "listed_participating",
      scope: "provider_record",
      address_participation: "not_evaluated",
      source_completeness: "complete",
    });
    const search = await h.call("search", {
      query: npi,
      entity: "provider",
      year: 2026,
    });
    const fetch = await h.call("fetch", {
      id: search.data!.results[0]!.id,
      section: "addresses",
    });
    expect(fetch.data?.records.every((r) => r.kind === "address")).toBe(true);
    expect(
      (
        await h.client.callTool({
          name: "search_providers",
          arguments: { npi, name: "Smith" },
        })
      ).isError,
    ).toBe(true);
  });
  it("keeps the native reason on an unknown participation answer", async () => {
    // Without an ACTIVE directory set the answer is unknown, and its reason must survive.
    await fixture.db.query("DELETE FROM provider_active_set");
    const absent = { plan_ids: [plan], npis: [npi], year: 2026 };
    const unlisted = await h.call("check_provider_network", absent);
    const native = await checkProviderNetworks(fixture.db, absent);
    const reason = (native.results[0] as { reason?: string }).reason;
    expect(unlisted.data?.results[0]?.status).toBe("unknown");
    expect(reason).toEqual(expect.any(String));
    expect(unlisted.data?.results[0]?.gaps).toContain(reason);
    // No NPPES release here: an empty identity search says why, like GET /v1/providers.
    const empty = await h.call("search_providers", { name: "Nobody" });
    expect(empty.status).toBe("unknown");
    expect(empty.data).toMatchObject({
      providers: [],
      reason: "provider_registry_not_loaded",
    });
  });
});
