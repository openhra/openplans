import { describe, expect, it } from "vitest";
import {
  allowanceInput,
  presetInput,
  privateInput,
} from "../src/allowance/contract.js";
import type { AllowancePrivateInput } from "../src/allowance/contract.js";
import { allowanceScenario } from "../src/allowance/service.js";
import {
  allowanceSourceManifest,
  printAllowanceSheet,
} from "../src/allowance/sheet.js";
import { loadForTest } from "../../../src/plugins/testing/index.js";
import plugin from "../src/index.js";
import type { McpToolSpec } from "@openplans/plugin-sdk";

const members = [
  { age: 40, relationship: "subscriber", tobacco: false },
  { age: 40, relationship: "spouse", tobacco: false },
  { age: 10, relationship: "child", tobacco: false },
  { age: 8, relationship: "child", tobacco: false },
] as const;
const distribution = {
  status: "partial",
  data_generation: "generation-a",
  provenance: { manifest: "manifest-a" },
  location: { zip: "00501" },
  benchmarks: [
    "employee_only",
    "employee_spouse",
    "employee_spouse_child",
    "employee_spouse_children",
  ].map((profile_id) => ({
    profile_id,
    result: {
      status: "calculated",
      data_generation: "generation-a",
      slcsp_monthly_cents: 8000,
    },
  })),
  profiles: [
    "employee_only",
    "employee_spouse",
    "employee_spouse_child",
    "employee_spouse_children",
  ].map((id, index) => ({
    id,
    members: members.slice(0, index + 1),
    lowest_silver: { monthly_cents: index === 2 ? null : 10000 + index * 100 },
  })),
};

describe("allowance adapters", () => {
  it("registers a public preset route, an operator-only explicit route and a preset-only MCP tool", async () => {
    const loaded = await loadForTest(plugin);
    try {
      expect(loaded.registrations.routes).toMatchObject([
        { method: "GET", path: "/handy/allowance/print", exposure: "public" },
        {
          method: "GET",
          path: "/handy/allowance/manifest",
          exposure: "public",
        },
        { method: "POST", path: "/handy/allowance", exposure: "public" },
        {
          method: "POST",
          path: "/handy/allowance/scenario",
          exposure: "operator",
        },
      ]);
      const tool = loaded.registrations.mcpTools[0] as McpToolSpec<
        unknown,
        unknown
      >;
      expect(
        loaded.registrations.mcpTools.map(
          (entry) => (entry as McpToolSpec<unknown, unknown>).name,
        ),
      ).toEqual(["get_allowance_range"]);
      expect(
        tool.inputSchema.safeParse({
          zip: "00501",
          year: 2026,
          preset: "family-40-40-10-8-v1",
        }).success,
      ).toBe(true);
      expect(
        tool.inputSchema.safeParse({
          zip: "00501",
          year: 2026,
          preset: "family-40-40-10-8-v1",
          members,
        }).success,
      ).toBe(false);
    } finally {
      await loaded.close();
    }
  });

  it("rejects explicit household and allowance fields on the public input", () => {
    expect(
      presetInput.safeParse({ zip: "00501", year: 2026, members }).success,
    ).toBe(false);
    expect(
      presetInput.safeParse({
        zip: "00501",
        year: 2026,
        allowance_cents: 10000,
      }).success,
    ).toBe(false);
    expect(presetInput.safeParse({ zip: "00501", year: 2026 }).success).toBe(
      false,
    );
    expect(
      presetInput.safeParse({
        zip: "00501",
        year: 2026,
        preset: "family-40-40-10-8-v1",
      }).success,
    ).toBe(true);
  });

  it("requires four ordered explicit members and a whole-cent allowance privately", () => {
    expect(
      privateInput.safeParse({
        zip: "00501",
        year: 2026,
        members,
        allowance_cents: 10000,
      }).success,
    ).toBe(true);
    expect(
      privateInput.safeParse({
        zip: "00501",
        year: 2026,
        members: members.slice(1),
        allowance_cents: 10000,
      }).success,
    ).toBe(false);
    expect(
      privateInput.safeParse({
        zip: "00501",
        year: 2026,
        members,
        allowance_cents: 10000.5,
      }).success,
    ).toBe(false);
    expect(
      allowanceInput.safeParse({
        zip: "00501",
        year: 2026,
        members,
        allowance_cents: 10000,
      }).success,
    ).toBe(true);
  });

  it("keeps unknown profiles in the denominator and keeps adjusted SLCSP separate", async () => {
    const host = {
      householdDistributions: async () => distribution,
    } as never;
    const result = await allowanceScenario(
      host,
      { db: {} as never, signal: new AbortController().signal },
      { zip: "00501", year: 2026, preset: "family-40-40-10-8-v1" },
    );
    expect(result.profiles).toHaveLength(4);
    expect(result.target).toEqual({
      basis: "full_gross_lowest_silver_premium",
      profile_count: 4,
      denominator: 4,
      monthly_cents: null,
      status: "unknown",
    });
    expect(result.slcsp).toHaveLength(4);
    const slcsp = result.slcsp as {
      result: { slcsp_monthly_cents: number };
    }[];
    expect(slcsp[0]?.result.slcsp_monthly_cents).toBe(8000);
    expect(
      (result.target as { monthly_cents: number | null }).monthly_cents,
    ).not.toBe(8000);
  });

  it("rejects a one-cent target mutant and never substitutes an employer age", async () => {
    const inputs: unknown[] = [];
    const host = {
      householdDistributions: async (input: unknown) => {
        inputs.push(input);
        return {
          ...distribution,
          profiles: distribution.profiles.map((p) => ({
            ...p,
            lowest_silver: { monthly_cents: 5000 },
          })),
        };
      },
    } as never;
    const result = await allowanceScenario(
      host,
      { db: {} as never, signal: new AbortController().signal },
      { zip: "00501", year: 2026, preset: "family-40-40-10-8-v1" },
    );
    expect((result.target as { monthly_cents: number }).monthly_cents).toBe(
      5000,
    );
    expect(inputs[0]).toMatchObject({ preset: "family-40-40-10-8-v1" });
    expect(inputs).toHaveLength(1);
  });

  it("funds the exact all-profile target and rejects an allowance one cent short", async () => {
    const supplied: unknown[] = [];
    const host = {
      householdDistributions: async (input: unknown) => {
        supplied.push(input);
        return {
          ...distribution,
          profiles: distribution.profiles.map((profile, index) => ({
            ...profile,
            lowest_silver: { monthly_cents: 10000 + index * 100 },
          })),
        };
      },
    } as never;
    const explicit: AllowancePrivateInput = {
      zip: "00501",
      year: 2026,
      members: [...members],
      allowance_cents: 10300,
    };
    const funded = await allowanceScenario(
      host,
      { db: {} as never, signal: new AbortController().signal },
      explicit,
    );
    const short = await allowanceScenario(
      host,
      { db: {} as never, signal: new AbortController().signal },
      { ...explicit, allowance_cents: 10299 },
    );
    expect(funded.target).toMatchObject({
      monthly_cents: 10300,
      profile_count: 4,
      denominator: 4,
    });
    expect(funded.funding).toEqual({
      allowance_cents: 10300,
      status: "funded",
    });
    expect(short.funding).toEqual({
      allowance_cents: 10299,
      status: "unfunded",
    });
    expect(supplied[0]).toMatchObject({ members });
    expect(supplied[0]).not.toHaveProperty("preset");
  });
});

describe("allowance printable sheet", () => {
  const testMinimumCents = (metal: string, index: number) => {
    if (metal === "silver" && index === 0) return 12345;
    if (metal === "silver" && index === 2) return null;
    return 10000 + index * 100;
  };
  const sheetDto = {
    year: 2026,
    location: { zip: "00501", county: "36103" },
    preset: "family-40-40-10-8-v1",
    preset_origin: "product_preset",
    data_generation: "generation-sheet-a",
    provenance: {
      input_manifest: "sha256:manifest-a",
      snapshots: [
        {
          publisher: "CMS",
          snapshot_id: "rates-2026-abcdef123456",
          sha256: "feed-sha-1234567890",
        },
      ],
    },
    profiles: distribution.profiles.map((profile, index) => ({
      ...profile,
      status: index === 2 ? "unknown" : "calculated",
      metals: ["bronze", "silver", "gold", "expanded bronze"].map((metal) => ({
        metal,
        points: {
          minimum: { monthly_cents: testMinimumCents(metal, index) },
          median: { monthly_cents: 25000 + index },
        },
        counts: {
          eligible: index === 2 ? null : 12,
          excluded: 2,
          unknown: index === 2 ? null : 1,
        },
        evidence:
          index === 2
            ? [
                {
                  status: "unknown",
                  reason: "source_missing",
                  source_file: "missing-file",
                },
              ]
            : [{ source_file: "rates-2026.csv" }],
      })),
    })),
    slcsp: distribution.profiles.map((profile) => ({
      profile_id: profile.id,
      result: { status: "unknown", slcsp_monthly_cents: null },
    })),
    target: {
      monthly_cents: null,
      status: "unknown",
      profile_count: 4,
      denominator: 4,
    },
  };

  it("prints exact DTO values, visible ages, provenance, unknowns and source download", () => {
    const html = printAllowanceSheet(
      sheetDto,
      "/handy/allowance/manifest?zip=00501",
    );
    expect(html).toContain("$123.45");
    expect(html).toContain("subscriber 40, non-tobacco");
    expect(html).toContain("spouse 40, non-tobacco");
    expect(html).toContain("child 10, non-tobacco");
    expect(html).toContain("child 8, non-tobacco");
    expect(html).toContain("generation-sheet-a");
    expect(html).toContain("sha256:manifest-a");
    expect(html).toContain("CMS:rates-2026-");
    expect(html).toContain("Expanded bronze minimum");
    expect(html).toContain("$100.00");
    expect(html).toContain("missing-file");
    expect(html).toContain(
      "Unknown evidence is present. No missing amount has been estimated.",
    );
    expect(html).toContain("Download source manifest (JSON)");
    expect(html).toContain(
      "Premium funding only. Affordability and benefits are separate checks.",
    );
    expect(html).not.toContain("4 of 4 employees");
    expect(html).toContain("@page");
    expect(html).toContain("letter");
    expect(html).toContain("break-inside:avoid;page-break-inside:avoid");
    expect(printAllowanceSheet(sheetDto, "/manifest", "A4")).toContain(
      "@page{size:A4;",
    );
  });

  it("keeps null prices unknown and exports source provenance without inventing amounts", () => {
    const html = printAllowanceSheet(sheetDto, "/manifest");
    expect(html).toContain("<td>Unknown</td>");
    const checkPrices = (rendered: string) => {
      expect(rendered).not.toMatch(/<(?:td|li)>[^<]*\$0(?:\.00)?(?:<| )/);
      expect(rendered).toContain("targets:</strong> Unknown");
    };
    checkPrices(html);
    expect(() =>
      checkPrices(html.replace("<td>Unknown</td>", "<td>$0.00</td>")),
    ).toThrow();
    expect(() =>
      checkPrices(
        html.replace("targets:</strong> Unknown", "targets:</strong> $0"),
      ),
    ).toThrow();
    const zero = structuredClone(sheetDto);
    zero.profiles[0]!.metals[0]!.points.minimum.monthly_cents = 0;
    expect(printAllowanceSheet(zero, "/manifest")).toContain("<td>$0.00</td>");
    expect(html).toContain("Gross premiums are not the subsidy benchmark.");
    expect(html).toContain(
      "Restart the sheet to use current prices and sources together.",
    );
    const manifest = allowanceSourceManifest(sheetDto);
    expect(manifest.data_generation).toBe("generation-sheet-a");
    expect(manifest.provenance).toEqual(sheetDto.provenance);
    expect(manifest.profile_evidence).toHaveLength(4);
    expect(JSON.stringify(manifest)).toContain("missing-file");
    expect(manifest.benchmarks).toEqual(sheetDto.slcsp);
  });

  it("rejects printable-sheet mutants for amounts, denominators, evidence and clipping", () => {
    const original = printAllowanceSheet(sheetDto, "/manifest", "letter");
    const required = [
      "$123.45",
      "subscriber 40, non-tobacco",
      "generation-sheet-a",
      "Unknown evidence is present. No missing amount has been estimated.",
      "4 profiles, denominator 4",
      "Unknown",
      "break-inside:avoid;page-break-inside:avoid",
    ];
    const accepts = (html: string) => {
      for (const fragment of required) expect(html).toContain(fragment);
      expect(html).not.toContain("100% of employees");
    };
    accepts(original);
    const mutants = [
      original.replace("$123.45", "$123.44"),
      original.replaceAll(
        "subscriber 40, non-tobacco",
        "subscriber, non-tobacco",
      ),
      original.replace("generation-sheet-a", "Unknown"),
      original.replace(
        "Unknown evidence is present. No missing amount has been estimated.",
        "",
      ),
      original.replace("4 profiles, denominator 4", "100% of employees"),
      original.replaceAll("Unknown", "$0.00"),
      original.replace(
        "break-inside:avoid;page-break-inside:avoid",
        "overflow:hidden",
      ),
    ];
    for (const [index, mutant] of mutants.entries())
      expect(() => accepts(mutant), `mutant ${index + 1}`).toThrow();
  });
});
