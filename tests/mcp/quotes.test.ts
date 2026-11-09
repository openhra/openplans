import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMcpHttp } from "../../src/mcp/http.js";
import { assertHonest, toolNames } from "../../src/mcp/schemas.js";
import { callTool } from "../../src/mcp/tools.js";
import { estimatePremiums } from "../../src/services/catalog.js";
import { quotePlans } from "../../src/services/quotes.js";
import { quoteFixture } from "../api/quote-fixture.js";
import { connect } from "./client.js";
import { post } from "./transport-helpers.js";

/** Mutated outputs are asserted structurally. */
type Json = ReturnType<typeof JSON.parse>;
const PLAN = "87226TX0100013";
const publicInput = {
  year: 2026,
  location: { zip: "77002", county: "48201" },
  members: [{ age: 35 }],
  plan_refs: [PLAN],
  npis: ["1234567893"],
  rxcuis: ["860975"],
};
let fixture: Awaited<ReturnType<typeof quoteFixture>>;
beforeAll(async () => {
  fixture = await quoteFixture();
});
afterAll(async () => fixture?.close());

const personalized = ["quote_premiums"];
/** Removed name of quote_premiums; it must behave like any tool that never existed. */
const REMOVED_TOOL = "estimate_premiums";

describe("MCP quote_plans public tier", () => {
  it("quotes anonymously at the README premium with unknown coverage evidence per plan", async () => {
    const h = await connect({ db: fixture.db });
    try {
      const output = await h.call("quote_plans", publicInput);
      expect(output.data).toMatchObject({
        bindable_quote: false,
        tier: "public_quote",
        tobacco_rating: "requested_flags",
        subsidy_status: "not_evaluated",
        data_availability: { providers: "unknown", drugs: "unknown" },
      });
      const quote = output.data!.quotes[0]!;
      expect(quote).toMatchObject({
        kind: "quote",
        plan_ref: PLAN,
        gross_status: "rated",
        gross_monthly_cents: 52928,
      });
      expect(quote.providers.map((p) => [p.npi, p.status])).toEqual([
        ["1234567893", "unknown"],
      ]);
      expect(quote.drugs.map((d) => [d.rxcui, d.status])).toEqual([
        ["860975", "unknown"],
      ]);
      const native = await quotePlans(fixture.db, {
        year: 2026,
        zip: "77002",
        county: "48201",
        members: [{ age: 35 }],
        plan_ids: [PLAN],
        npis: publicInput.npis,
        rxcuis: publicInput.rxcuis,
      });
      assertHonest("quote_plans", output, { estimates: native.quotes });
      const status = await h.call("get_data_status", {});
      expect(status.data).toMatchObject({
        public_quoting: "enabled",
        personalized_access: "authentication_required",
      });
    } finally {
      await h.close();
    }
  });

  it("negative control 6: a quote that turns missing evidence into out_of_network or a changed premium fails assertHonest", async () => {
    const h = await connect({ db: fixture.db });
    try {
      const output = await h.call("quote_plans", publicInput);
      const native = await quotePlans(fixture.db, {
        year: 2026,
        county: "48201",
        members: [{ age: 35 }],
        plan_ids: [PLAN],
        npis: publicInput.npis,
        rxcuis: publicInput.rxcuis,
      });
      const context = { estimates: native.quotes };
      expect(() => assertHonest("quote_plans", output, context)).not.toThrow();
      const network = structuredClone(output) as Json;
      network.data.quotes[0].providers[0].status = "out_of_network";
      expect(() => assertHonest("quote_plans", network, context)).toThrow();
      const drug = structuredClone(output) as Json;
      drug.data.quotes[0].drugs[0].status = "not_covered";
      expect(() => assertHonest("quote_plans", drug, context)).toThrow();
      const listed = structuredClone(output) as Json;
      listed.data.quotes[0].drugs[0].status = "listed_covered";
      expect(() => assertHonest("quote_plans", listed, context)).toThrow(
        "unsourced factual record",
      );
      const cents = structuredClone(output) as Json;
      cents.data.quotes[0].gross_monthly_cents++;
      expect(() => assertHonest("quote_plans", cents, context)).toThrow(
        "fabricated cents",
      );
      const income = structuredClone(output) as Json;
      income.data.quotes[0].household_income_annual = 40000;
      expect(() => assertHonest("quote_plans", income, context)).toThrow();
    } finally {
      await h.close();
    }
  });

  it("refuses income, dates of birth and names with INVALID_INPUT", async () => {
    const h = await connect({ db: fixture.db });
    try {
      for (const input of [
        { ...publicInput, household: { income_annual: 40000, size: 1 } },
        { ...publicInput, members: [{ age: 35, dob: "1990-01-02" }] },
        { ...publicInput, members: [{ age: 35, name: "x" }] },
      ]) {
        const result = await callTool({ db: fixture.db }, "quote_plans", input);
        expect(result.isError).toBe(true);
        expect(result.structuredContent.error?.code).toBe("INVALID_INPUT");
      }
    } finally {
      await h.close();
    }
  });

  it("pages the location catalog with a cursor and never caches quotes", async () => {
    let outcomes: string[] = [];
    const deps = {
      db: fixture.db,
      onCache: (outcome: string) => outcomes.push(outcome),
    };
    const input = {
      year: 2026,
      location: { zip: "77002" },
      members: [{ age: 35 }],
    };
    const first = await callTool(deps, "quote_plans", input);
    expect(first.isError).toBeFalsy();
    const data = first.structuredContent.data as { quotes: unknown[] };
    expect(data.quotes.length).toBeGreaterThan(0);
    expect(first.structuredContent.page).toMatchObject({
      returned: data.quotes.length,
      next_cursor: null,
    });
    outcomes = [];
    await callTool(deps, "quote_plans", input);
    expect(outcomes.every((o) => o === "bypass")).toBe(true);
  });
});

describe("MCP tool listing and grants (negative control 7)", () => {
  it("lists 12 tools anonymously, 13 with a grant, 11 with quoting off", async () => {
    const anonymous = await connect({ db: fixture.db });
    const granted = await connect({
      db: fixture.db,
      principal: { id: "personalized" },
      policy: { canEstimate: () => true },
    });
    const off = await connect({ db: fixture.db, publicQuoting: false });
    try {
      const names = async (h: typeof anonymous) =>
        (await h.client.listTools()).tools.map((t) => t.name);
      const open = await names(anonymous);
      expect(open).toHaveLength(12);
      expect(open).toContain("quote_plans");
      for (const name of personalized) expect(open).not.toContain(name);
      expect(await names(granted)).toEqual(toolNames);
      expect(toolNames).toHaveLength(13);
      const closed = await names(off);
      expect(closed).toHaveLength(11);
      expect(closed).not.toContain("quote_plans");
      const disabled = await off.call("quote_plans", publicInput, true);
      expect(disabled.error?.code).toBe("QUOTING_DISABLED");
      expect((await off.call("get_data_status", {})).data?.public_quoting).toBe(
        "disabled",
      );
    } finally {
      await anonymous.close();
      await granted.close();
      await off.close();
    }
  });

  it("quote_premiums returns the canonical premium under quotes", async () => {
    const h = await connect({
      db: fixture.db,
      principal: { id: "personalized" },
      policy: { canEstimate: () => true },
    });
    try {
      const input = {
        plan_refs: [PLAN],
        location: { county: "48201" },
        coverage_start: "2026-01-01",
        members: [{ age: 35, tobacco: false, relationship: "subscriber" }],
      };
      const current = await h.call("quote_premiums", input);
      expect(current.data?.quotes[0]?.gross_monthly_cents).toBe(52928);
      expect(current.data).not.toHaveProperty("estimates");
      const native = await estimatePremiums(fixture.db, {
        plan_ids: input.plan_refs,
        ...input.location,
        coverage_start: input.coverage_start,
        members: input.members,
      });
      assertHonest("quote_premiums", current, native);
    } finally {
      await h.close();
    }
  });

  it("estimate_premiums is gone: unlisted even with a grant, and a call gets the SDK unknown-tool error", async () => {
    expect(toolNames).not.toContain(REMOVED_TOOL);
    const granted = await connect({
      db: fixture.db,
      principal: { id: "personalized" },
      policy: { canEstimate: () => true },
    });
    try {
      const listed = (await granted.client.listTools()).tools.map(
        (t) => t.name,
      );
      expect(listed).toContain("quote_premiums");
      expect(listed).not.toContain(REMOVED_TOOL);
      const unknownError = async (name: string) => {
        try {
          const result = await granted.client.callTool({ name, arguments: {} });
          return { isError: result.isError, content: result.content };
        } catch (error) {
          return { thrown: String(error) };
        }
      };
      const removed = await unknownError(REMOVED_TOOL);
      const never = await unknownError("synthetic_never_a_tool");
      expect(JSON.stringify(removed)).toContain(REMOVED_TOOL);
      expect(JSON.stringify(removed)).toMatch(/not found|unknown tool/i);
      expect(JSON.stringify(removed).replaceAll(REMOVED_TOOL, "NAME")).toBe(
        JSON.stringify(never).replaceAll("synthetic_never_a_tool", "NAME"),
      );
    } finally {
      await granted.close();
    }
  });

  it("over HTTP with the MCP token, estimate_premiums answers like a tool that never existed", async () => {
    const quiet = () => {};
    const app = createMcpHttp(fixture.db, {
      env: { OPENPLANS_MCP_TOKEN: "synthetic-mcp-token" },
      log: quiet,
    });
    const auth = { authorization: "Bearer synthetic-mcp-token" };
    const list = await app.fetch(post("tools/list", {}, auth));
    const listed = JSON.stringify(await list.json());
    expect(listed).toContain('"quote_premiums"');
    expect(listed).not.toContain(REMOVED_TOOL);
    const answer = async (name: string) => {
      const response = await app.fetch(
        post("tools/call", { name, arguments: {} }, auth),
      );
      return { status: response.status, text: await response.text() };
    };
    const removed = await answer(REMOVED_TOOL);
    const never = await answer("synthetic_never_a_tool");
    expect(removed.status).toBe(never.status);
    expect(removed.status).not.toBe(401);
    expect(removed.text).toContain(REMOVED_TOOL);
    expect(JSON.parse(removed.text).error.code).toBe(-32602);
    expect(removed.text.replaceAll(REMOVED_TOOL, "NAME")).toBe(
      never.text.replaceAll("synthetic_never_a_tool", "NAME"),
    );
  });

  it("over HTTP: public quote_plans answers, personalized names return 401, OPENPLANS_PUBLIC_QUOTING=off hides quote_plans", async () => {
    const quiet = () => {};
    const app = createMcpHttp(fixture.db, { env: {}, log: quiet });
    const list = await app.fetch(post("tools/list"));
    const listed = JSON.stringify(await list.json());
    expect(listed).toContain('"quote_plans"');
    for (const name of personalized) {
      expect(listed).not.toContain(`"${name}"`);
      const denied = await app.fetch(
        post("tools/call", { name, arguments: {} }),
      );
      await denied.text();
      expect(denied.status).toBe(401);
    }
    const call = await app.fetch(
      post("tools/call", { name: "quote_plans", arguments: publicInput }),
    );
    expect(call.status).toBe(200);
    expect(await call.text()).toContain("52928");
    const off = createMcpHttp(fixture.db, {
      env: { OPENPLANS_PUBLIC_QUOTING: "off" },
      log: quiet,
    });
    const hidden = await off.fetch(post("tools/list"));
    expect(JSON.stringify(await hidden.json())).not.toContain('"quote_plans"');
    const refused = await off.fetch(
      post("tools/call", { name: "quote_plans", arguments: publicInput }),
    );
    expect(await refused.text()).toContain("QUOTING_DISABLED");
  });
});
