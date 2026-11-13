import { describe, expect, it } from "vitest";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import {
  assertHonest,
  inputJsonSchemas,
  outputJsonSchemas,
  outputSchemas,
  parseToolInput,
  toolNames,
} from "../../src/mcp/schemas.js";
import type { ToolName } from "../../src/mcp/schemas.js";

import { evidence, envelope, shellPlan } from "./helpers.js";
const payloads: Record<ToolName, unknown> = {
  search: { results: [], scope_gaps: [] },
  fetch: {
    id: "plan:2026:87226TX0100013",
    title: "Synthetic contract shell",
    url: "openplans://plan/2026/87226TX0100013",
    text: "",
    entity: "plan",
    section: "summary",
    records: [shellPlan],
  },
  search_plans: {
    plans: [shellPlan],
    location_status: "available",
    location_issues: [],
    counties: [],
  },
  get_plan: { plan: shellPlan, section: "summary", records: [] },
  quote_premiums: { quotes: [], bindable_quote: false },
  check_ichra_affordability: {
    status: "unknown",
    reason: "catalog_not_loaded",
    plan_start: "2027-01-01",
    applicable_age: 40,
    basis_sensitive: null,
    lcsps: [],
    monthly_hra_cents: null,
    required_contribution_percentage_bp: null,
    verdicts: [],
    safe_harbors_applied: [],
    rules: [],
    bindable_quote: false,
  },
  quote_plans: {
    quotes: [],
    bindable_quote: false,
    tier: "public_quote",
    location_status: "unknown",
    location_issues: [],
    tobacco_rating: "requested_flags",
    subsidy_status: "not_evaluated",
    data_availability: {
      catalog: "unknown",
      providers: "unknown",
      drugs: "unknown",
    },
  },
  search_providers: { providers: [], unlocated: null },
  search_drugs: {
    candidates: [],
    exact_concept_required: true,
    terminology_status: "unknown",
  },
  check_drug_coverage: { results: [] },
  check_provider_network: { results: [] },
  lookup_geography: { zip: "77001", resolution: "unknown", counties: [] },
  get_data_status: {
    datasets: [],
    personalized_access: "authentication_required",
    public_quoting: "enabled",
    loaded: false,
  },
  list_carriers_networks: { rows: [] },
  search_medicare_plans: {
    location_status: "unknown",
    county_fips: null,
    contract_year: 2026,
    as_of: null,
    plans: [],
    part_d_drug_data: "pending_terms_review",
  },
};
const validInputs: Record<ToolName, unknown> = {
  search: { query: "77002" },
  fetch: { id: "plan:2026:87226TX0100013" },
  search_plans: { location: { zip: "77002" }, year: 2026 },
  get_plan: { plan_ref: "BCBSVT:Gold Plan", year: 2026 },
  quote_premiums: {
    plan_refs: ["87226TX0100013"],
    location: { county: "48201" },
    coverage_start: "2026-01-01",
    members: [{ age: 35, tobacco: false, relationship: "subscriber" }],
  },
  check_ichra_affordability: {
    plan_start: "2026-01-01",
    employee: { date_of_birth: "1985-10-01" },
    residence: { zip: "77002" },
    hra: { self_only_annual_cents: 300_000 },
    income: [
      { measure: "household", annual_cents: 4_118_000 },
      { measure: "fpl" },
    ],
  },
  quote_plans: {
    year: 2026,
    location: { zip: "77002" },
    members: [{ age: 35 }, { age: 8, tobacco: false }],
    npis: ["1234567890"],
    rxcuis: ["860975"],
  },
  search_providers: { npi: "1234567890", year: 2026 },
  search_drugs: { query: "metformin" },
  check_drug_coverage: {
    plan_ids: ["87226TX0100013"],
    rxcuis: ["860975"],
    year: 2026,
  },
  check_provider_network: {
    plan_ids: ["87226TX0100013"],
    npis: ["1234567890"],
    year: 2026,
  },
  lookup_geography: { zip: "75034" },
  get_data_status: {},
  list_carriers_networks: { state: "TX" },
  search_medicare_plans: { location: { county: "48201" }, year: 2026 },
};
const validator = new AjvJsonSchemaValidator();
describe("fifteen closed MCP tool contracts (no transport)", () => {
  it("compiles all input/output schemas with the pinned SDK validator and round-trips JSON", () => {
    expect(toolNames).toHaveLength(15);
    expect(toolNames).not.toContain("estimate_premiums");
    expect(toolNames).toEqual([...toolNames].sort());
    expect(toolNames).not.toContain("benchmark_silver");
    for (const tool of toolNames) {
      const input = JSON.parse(JSON.stringify(validInputs[tool]));
      const inputCheck = validator.getValidator(inputJsonSchemas[tool])(input);
      expect(inputCheck.valid, `${tool}: ${JSON.stringify(inputCheck)}`).toBe(
        true,
      );
      parseToolInput(tool, input);
      const output = JSON.parse(JSON.stringify(envelope(payloads[tool])));
      const outputCheck = validator.getValidator(outputJsonSchemas[tool])(
        output,
      );
      expect(outputCheck.valid, `${tool}: ${JSON.stringify(outputCheck)}`).toBe(
        true,
      );
      expect(outputSchemas[tool].parse(output)).toEqual(output);
      assertHonest(tool, output);
      expect(
        validator.getValidator(inputJsonSchemas[tool])({
          ...input,
          unlisted: true,
        }).valid,
      ).toBe(false);
      expect(
        validator.getValidator(outputJsonSchemas[tool])({
          ...output,
          unlisted: true,
        }).valid,
      ).toBe(false);
    }
  });
  it("rejects invalid cross-field inputs in both JSON Schema and semantic parsing", () => {
    const mutants: [ToolName, unknown][] = [
      ["search_plans", { year: 2026, location: {} }],
      ["search_drugs", {}],
      ["search_drugs", { query: "a", ndc: "00071015523" }],
      ["search_providers", {}],
      ["search_providers", { plan_id: "87226TX0100013" }],
      ["search_providers", { name: "Smith", radius_miles: 5 }],
      ["search_providers", { taxonomy: "207Q00000X", specialty: "Family" }],
      ["search_providers", { npi: "1234567890", name: "Smith" }],
      [
        "check_drug_coverage",
        {
          plan_ids: ["87226TX0100013", "87226TX0100013"],
          rxcuis: ["860975"],
          year: 2026,
        },
      ],
      [
        "quote_premiums",
        {
          ...(validInputs.quote_premiums as object),
          members: [{ age: 35, relationship: "subscriber" }],
        },
      ],
      // The public quote tool refuses household, income and identity inputs.
      [
        "quote_plans",
        {
          ...(validInputs.quote_plans as object),
          household: { income_annual: 40000, size: 1, tax_filing: "single" },
        },
      ],
      [
        "quote_plans",
        {
          ...(validInputs.quote_plans as object),
          members: [{ age: 35, dob: "1990-01-02" }],
        },
      ],
      [
        "quote_plans",
        {
          ...(validInputs.quote_plans as object),
          members: [{ age: 35, household_income_annual: 40000 }],
        },
      ],
      [
        "quote_plans",
        {
          ...(validInputs.quote_plans as object),
          members: Array.from({ length: 11 }, () => ({ age: 30 })),
        },
      ],
      [
        "quote_plans",
        {
          ...(validInputs.quote_plans as object),
          npis: [
            "1234567890",
            "1234567891",
            "1234567892",
            "1234567893",
            "1234567894",
            "1234567895",
          ],
        },
      ],
    ];
    for (const [tool, mutant] of mutants) {
      expect(
        validator.getValidator(inputJsonSchemas[tool])(mutant).valid,
        tool,
      ).toBe(false);
      expect(() => parseToolInput(tool, mutant), tool).toThrow();
    }
    for (const [tool, mutant] of [
      ["search_drugs", { query: " " }],
      ["search_drugs", { ndc: "000000000000" }],
      ["get_data_status", { state: "XX" }],
      [
        "get_plan",
        { plan_ref: "87226TX0100013-04", year: 2026, csr_variant: "05" },
      ],
    ] as [ToolName, unknown][])
      expect(() => parseToolInput(tool, mutant)).toThrow();
  });
  it("rejects unknown output fields all the way down, missing and nonexistent provenance", () => {
    const record = { ...shellPlan, invented: "fact" };
    expect(() =>
      outputSchemas.get_plan.parse(
        envelope({ plan: record, section: "summary", records: [] }),
      ),
    ).toThrow();
    const missing = envelope(payloads.search_plans);
    delete (missing as Partial<typeof missing>).provenance;
    expect(() => assertHonest("search_plans", missing)).toThrow(
      "invalid output contract",
    );
    const dangling = envelope({
      plans: [{ ...shellPlan, evidence_refs: ["no-such-source"] }],
      location_status: "available",
      location_issues: [],
      counties: [],
    });
    expect(() => assertHonest("search_plans", dangling)).toThrow(
      "unresolvable provenance",
    );
    expect(() =>
      assertHonest("search_plans", envelope(payloads.search_plans), {
        snapshotIds: new Set(),
      }),
    ).toThrow("nonexistent snapshot");
  });
  it("rejects unknown-to-negative mutations and incomplete not_listed results", () => {
    const drug = {
      kind: "drug_coverage",
      plan_id: "87226TX0100013",
      rxcui: "860975",
      year: 2026,
      status: "unknown",
      tier: null,
      tier_status: null,
      prior_authorization: null,
      step_therapy: null,
      quantity_limit: null,
      patient_price: null,
      source_completeness: "partial",
      evidence: [],
      ...evidence,
    };
    assertHonest("check_drug_coverage", envelope({ results: [drug] }));
    for (const status of [
      "not covered",
      "not_covered",
      "denied",
      "explicitly_not_covered",
      "not_listed",
    ]) {
      expect(() =>
        assertHonest(
          "check_drug_coverage",
          envelope({ results: [{ ...drug, status }] }),
        ),
      ).toThrow();
    }
    const participation = {
      kind: "participation",
      plan_id: drug.plan_id,
      npi: "1234567890",
      year: 2026,
      status: "unknown",
      scope: "provider_record",
      address_participation: "not_evaluated",
      source_completeness: "failed",
      evidence: [],
      ...evidence,
    };
    assertHonest(
      "check_provider_network",
      envelope({ results: [participation] }),
    );
    expect(() =>
      assertHonest(
        "check_provider_network",
        envelope({
          results: [
            { ...participation, status: "explicitly_not_participating" },
          ],
        }),
      ),
    ).toThrow("claim without explicit source record");
    assertHonest(
      "check_drug_coverage",
      envelope({
        results: [
          { ...drug, status: "not_listed", source_completeness: "complete" },
        ],
      }),
    );
  });
});
