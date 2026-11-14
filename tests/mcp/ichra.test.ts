import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ichraRequest } from "../../src/api/validation.js";
import { assertHonest, outputSchemas } from "../../src/mcp/schemas.js";
import { MAX_OUTPUT_BYTES, callTool } from "../../src/mcp/tools.js";
import { ichraAffordability } from "../../src/services/ichra.js";
import { setup } from "../compat/v1/helpers.js";
import { connect } from "./client.js";

// SYNTHETIC employee over the real, unmodified CMS TX PY2026 Harris cut (20 silver plans).
interface Lcsp {
  monthly_cents: number;
  evidence_refs: string[];
}
interface Verdict {
  measure: string;
  status: string;
  affordable: boolean | null;
  reason?: string;
}
interface IchraOutput {
  status: string;
  data: {
    applicable_age: number;
    lcsps: Lcsp[];
    verdicts: Verdict[];
    rules: { id: string; status: string }[];
  };
  provenance: unknown[];
  notes: string[];
  error: { code: string };
}
interface ToolResult {
  structuredContent: IchraOutput;
}
interface NativeIchra extends Record<string, unknown> {
  lcsp: { plan_ids: readonly string[]; monthly_cents: number | null };
  verdicts: readonly unknown[];
}
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
    )) as ToolResult;
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
      )) as IchraOutput;
      expect(output.status).toBe("ok");
      const native = (await ichraAffordability(
        h.db,
        ichraRequest(input),
      )) as NativeIchra;
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
      expect(ptc!.evidence_refs.length).toBeGreaterThan(0);
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
      })) as IchraOutput;
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
    })) as ToolResult;
    expect(result.structuredContent.error.code).toBe(
      "SAFE_HARBOR_INPUT_MISSING",
    );
  });
  it("takes the partial-year, lowest-rate and salary-reduction fields like the route", async () => {
    // SYNTHETIC inputs; the arithmetic is worked in tests/api/ichra.test.ts.
    const extended = {
      ...input,
      months_available: 6,
      hra: { self_only_annual_cents: 175_950 },
      income: [
        {
          measure: "w2",
          annual_cents: 3_000_000,
          w2_months_offered: 6,
          w2_months_employed: 10,
        },
        {
          measure: "rate_of_pay_hourly",
          hourly_cents: 2_000,
          lowest_hourly_cents: 1_800,
        },
        {
          measure: "rate_of_pay_salary",
          monthly_cents: 400_000,
          salary_reduced: true,
        },
      ],
    };
    const result = (await callTool(
      granted(),
      "check_ichra_affordability",
      extended,
    )) as ToolResult;
    const output = result.structuredContent;
    expect(output.status).toBe("ok");
    const native = (await ichraAffordability(
      h.db,
      ichraRequest(extended),
    )) as NativeIchra;
    expect(output.data.verdicts).toEqual(native.verdicts);
    expect(
      output.data.verdicts.map((v: Verdict) => [
        v.measure,
        v.status,
        v.affordable,
      ]),
    ).toEqual([
      ["w2", "calculated", true],
      ["rate_of_pay_hourly", "calculated", false],
      ["rate_of_pay_salary", "unknown", null],
    ]);
    expect(output.data.verdicts[2]!.reason).toBe("rate_of_pay_salary_reduced");
    const cited = output.data.rules.map((r: { id: string }) => r.id);
    expect(cited).toContain("w2_safe_harbor");
    expect(cited).toContain("rate_of_pay_safe_harbor");
    expect(
      outputSchemas.check_ichra_affordability.safeParse(output).success,
    ).toBe(true);
  });
  it("refuses month counts and rates outside their range, and never answers", async () => {
    const w2 = (months: Record<string, unknown>) => ({
      ...input,
      income: [{ measure: "w2", annual_cents: 3_000_000, ...months }],
    });
    const cases: [unknown, string | null][] = [
      [
        w2({ w2_months_offered: 7, w2_months_employed: 6 }),
        "W2_MONTHS_OFFERED_EXCEED_EMPLOYED",
      ],
      [w2({ w2_months_offered: 6 }), "W2_MONTHS_INCOMPLETE"],
      [w2({ w2_months_offered: 0, w2_months_employed: 6 }), null],
      [w2({ w2_months_offered: 6, w2_months_employed: 13 }), null],
      [
        {
          ...input,
          income: [
            {
              measure: "rate_of_pay_hourly",
              hourly_cents: 2_000,
              lowest_hourly_cents: 0,
            },
          ],
        },
        null,
      ],
    ];
    for (const [arguments_, code] of cases) {
      const result = (await callTool(
        granted(),
        "check_ichra_affordability",
        arguments_,
      )) as ToolResult;
      expect(result.structuredContent.data).toBeNull();
      expect(result.structuredContent.error.code).toEqual(
        code ?? expect.any(String),
      );
    }
  });
  it("negative control: a changed LCSP cent or verdict fails the honesty check", async () => {
    const result = (await callTool(
      granted(),
      "check_ichra_affordability",
      input,
    )) as ToolResult;
    const output = result.structuredContent;
    const native = (await ichraAffordability(
      h.db,
      ichraRequest(input),
    )) as NativeIchra;
    expect(() =>
      assertHonest("check_ichra_affordability", output, { ichra: native }),
    ).not.toThrow();
    const cent = structuredClone(output);
    cent.data.lcsps[0]!.monthly_cents += 1;
    expect(() =>
      assertHonest("check_ichra_affordability", cent, { ichra: native }),
    ).toThrow("changed ICHRA LCSP");
    const flipped = structuredClone(output);
    flipped.data.verdicts[0]!.affordable =
      !flipped.data.verdicts[0]!.affordable;
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

it("MCP non-calendar look-back preserves entrant age, figures and cited rules", async () => {
  const extended = {
    ...input,
    plan_start: "2026-07-01",
    employee: { date_of_birth: "1985-08-15", eligible_from: "2026-08-15" },
    months_available: 11,
    hra: { self_only_annual_cents: 330_000 },
    safe_harbors: { look_back: true },
    income: [{ measure: "rate_of_pay_hourly", hourly_cents: 2_300 }],
  };
  const client = await connect(granted());
  try {
    const output = (await client.call(
      "check_ichra_affordability",
      extended,
    )) as IchraOutput;
    expect(output.status).toBe("ok");
    expect(output.data.applicable_age).toBe(41);
    expect(output.data.lcsps[0]).toMatchObject({
      use: "employer",
      coverage_month: "2026-01-01",
      priced_at_age: 41,
      monthly_cents: 60_316,
    });
    const native = (await ichraAffordability(
      h.db,
      ichraRequest(extended),
    )) as NativeIchra;
    expect(output.data.verdicts).toEqual(native.verdicts);
    expect(output.data.rules).toContainEqual(
      expect.objectContaining({
        id: "look_back_current_circumstances",
        status: "proposed_reliance_permitted",
        citations: [expect.stringContaining("2019-20034")],
      }),
    );
    expect(
      outputSchemas.check_ichra_affordability.safeParse(output).success,
    ).toBe(true);
  } finally {
    await client.close();
  }
});
