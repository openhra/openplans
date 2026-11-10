import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ichraRequest } from "../../src/api/validation.js";
import { assertHonest, outputSchemas } from "../../src/mcp/schemas.js";
import { MAX_OUTPUT_BYTES, callTool } from "../../src/mcp/tools.js";
import { ichraAffordability } from "../../src/services/ichra.js";
import { setup } from "../compat/v1/helpers.js";
import { connect } from "./client.js";

// SYNTHETIC employee over the real, unmodified CMS TX PY2026 Harris cut (20 silver plans).
type Json = ReturnType<typeof JSON.parse>;
let h: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => {
  await h?.close();
});
const input = {
  plan_start: "2026-01-01",
  employee: { date_of_birth: "1985-10-01" },
  residence: { zip: "77002" },
  hra: { self_only_annual_cents: 300_000 },
  income: [
    { measure: "household", annual_cents: 4_118_000 },
    { measure: "rate_of_pay_hourly", hourly_cents: 2_000 },
  ],
};
const granted = () => ({
  db: h.db,
  principal: { id: "personalized" },
  policy: { canEstimate: () => true },
});

describe("MCP check_ichra_affordability", () => {
  it("requires a personalized grant", async () => {
    const result = (await callTool(
      { db: h.db },
      "check_ichra_affordability",
      input,
    )) as Json;
    expect(result.structuredContent.error.code).toBe("AUTH_REQUIRED");
    expect(result.structuredContent.data).toBeNull();
    const anonymous = await connect({ db: h.db });
    try {
      const names = (await anonymous.client.listTools()).tools.map(
        (t) => t.name,
      );
      expect(names).not.toContain("check_ichra_affordability");
    } finally {
      await anonymous.close();
    }
  });
  it("returns the service figures with rate evidence and proposed-rule labels", async () => {
    const client = await connect(granted());
    try {
      const output = (await client.call(
        "check_ichra_affordability",
        input,
      )) as Json;
      expect(output.status).toBe("ok");
      const native = (await ichraAffordability(
        h.db,
        ichraRequest(input),
      )) as Json;
      const data = output.data;
      expect(data).toMatchObject({
        status: "calculated",
        applicable_age: 40,
        basis_sensitive: true,
        bindable_quote: false,
        required_contribution_percentage_bp: 996,
      });
      const [ptc, employer] = data.lcsps;
      expect(ptc).toMatchObject({
        use: "premium_tax_credit",
        plan_ids: native.lcsp.plan_ids,
        monthly_cents: native.lcsp.monthly_cents,
        by_basis: {
          gross: { plan_ids: ["87226TX0100011"], monthly_cents: 59_205 },
          ehb_portion: { plan_ids: ["87226TX0140004"], monthly_cents: 59_176 },
        },
        rating_area_id: "Rating Area 10",
      });
      expect(ptc.evidence_refs.length).toBeGreaterThan(0);
      expect(employer).toMatchObject({
        use: "employer",
        identified_at_age: 14,
      });
      expect(data.verdicts).toEqual(native.verdicts);
      expect(output.provenance.length).toBeGreaterThan(0);
      const statuses = Object.fromEntries(
        data.rules.map((r: { id: string; status: string }) => [r.id, r.status]),
      );
      expect(statuses.rate_of_pay_safe_harbor).toBe(
        "proposed_reliance_permitted",
      );
      expect(statuses.affordability).toBe("final");
      expect(output.notes.join(" ")).toContain("Not a bindable quote");
      expect(JSON.stringify(output)).not.toContain("1985-10-01");
    } finally {
      await client.close();
    }
  });
  it("a refusal projects no LCSP and no verdict", async () => {
    const client = await connect(granted());
    try {
      const output = (await client.call("check_ichra_affordability", {
        ...input,
        plan_start: "2027-01-01",
      })) as Json;
      expect(output.status).toBe("unknown");
      expect(output.data).toMatchObject({
        status: "unknown",
        reason: "catalog_not_loaded",
        lcsps: [],
        verdicts: [],
      });
    } finally {
      await client.close();
    }
  });
  it("semantic input errors match the REST route", async () => {
    const result = (await callTool(granted(), "check_ichra_affordability", {
      ...input,
      safe_harbors: { location: true },
    })) as Json;
    expect(result.structuredContent.error.code).toBe(
      "SAFE_HARBOR_INPUT_MISSING",
    );
  });
  it("negative control: a changed LCSP cent or verdict fails the honesty check", async () => {
    const result = (await callTool(
      granted(),
      "check_ichra_affordability",
      input,
    )) as Json;
    const output = result.structuredContent;
    const native = (await ichraAffordability(
      h.db,
      ichraRequest(input),
    )) as Json;
    expect(() =>
      assertHonest("check_ichra_affordability", output, { ichra: native }),
    ).not.toThrow();
    const cent = structuredClone(output);
    cent.data.lcsps[0].monthly_cents += 1;
    expect(() =>
      assertHonest("check_ichra_affordability", cent, { ichra: native }),
    ).toThrow("changed ICHRA LCSP");
    const flipped = structuredClone(output);
    flipped.data.verdicts[0].affordable = !flipped.data.verdicts[0].affordable;
    expect(() =>
      assertHonest("check_ichra_affordability", flipped, { ichra: native }),
    ).toThrow("changed ICHRA verdict");
    expect(
      outputSchemas.check_ichra_affordability.safeParse(output).success,
    ).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(
      MAX_OUTPUT_BYTES,
    );
  });
});
