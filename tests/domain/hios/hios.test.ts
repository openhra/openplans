import { readFileSync } from "node:fs";
import { describe, it, expect, beforeEach } from "vitest";
import {
  build_plan_view,
  classify_index,
  lookup_evidence,
  parse_hios,
} from "../../../src/domain/hios/index.js";

const FIXTURE = JSON.parse(
  readFileSync(
    new URL("../../fixtures/hios/synthetic_fixture.json", import.meta.url),
    "utf8",
  ),
);
const BASE = "12345VA0010001";
describe("ReferenceTests", () => {
  let f: any;
  beforeEach(() => {
    f = structuredClone(FIXTURE);
  });
  const view = (plan = BASE, year: unknown = 2027) =>
    build_plan_view(plan, year, f.plans, f.providers, f.drugs, {
      source_snapshot: f.source_snapshot,
    });

  it("test_base_id", () => expect(parse_hios(BASE).base).toBe(BASE));
  it("test_variant_retained", () =>
    expect(parse_hios(BASE + "-01").full).toBe(BASE + "-01"));
  it("test_malformed_rejected", () => {
    for (const value of [
      BASE + "01",
      BASE.toLowerCase(),
      BASE + " ",
      "garbage",
      123,
    ])
      expect(() => parse_hios(value)).toThrow();
  });
  it("test_year_is_required_integer", () =>
    expect(() => view(BASE, "2027")).toThrow());
  it("test_wrong_year_not_reused", () =>
    expect(() => view(BASE, 2026)).toThrow());
  it("test_duplicate_plan_is_not_silently_merged", () => {
    f.plans.push(structuredClone(f.plans[0]));
    expect(() => view()).toThrow();
  });
  it("test_direct_membership_join", () => {
    const r = view() as any;
    expect(r.providers).toHaveLength(1);
    expect(r.drugs).toHaveLength(1);
    expect(r.drugs[0].status).toBe("listed_covered");
  });
  it("test_variant_membership_does_not_resolve_benefits", () => {
    const r = view(BASE + "-01") as any;
    expect(r.requested_variant_hios_id).toBe(BASE + "-01");
    expect(r.variant_cost_sharing_resolved).toBe(false);
  });
  it("test_stale_edge_excluded", () => {
    f.providers[0].plans[0].years = [2026];
    expect((view() as any).providers).toEqual([]);
  });
  it("test_missing_edge_year_quarantined", () => {
    delete f.drugs[0].plans[0].years;
    const r = view() as any;
    expect(r.drugs).toEqual([]);
    expect(r.issues[0].code).toBe("missing_or_invalid_years");
  });
  it("test_orphan_tier_quarantined", () => {
    f.providers[0].plans[0].network_tier = "UNKNOWN TIER";
    expect((view() as any).issues[0].code).toBe("unresolved_network_tier");
  });
  it("test_null_npi_retained_source_identity", () => {
    f.providers[0].npi = null;
    const r = (view() as any).providers[0];
    expect(r.npi).toBeNull();
    expect(r.source_record_key).toContain(":provider:0");
  });
  it("test_invalid_npi_shape_quarantined", () => {
    f.providers[0].npi = "123";
    expect((view() as any).providers).toEqual([]);
  });
  it("test_addresses_not_cartesian_product", () => {
    const r = (view() as any).providers;
    expect(r).toHaveLength(1);
    expect(r[0].addresses_from_record).toHaveLength(2);
    expect(r[0].location_specific_participation_verified).toBe(false);
  });
  it("test_optional_boolean_remains_unknown", () =>
    expect((view() as any).drugs[0].step_therapy).toBeNull());
  it("test_false_boolean_preserved", () =>
    expect((view() as any).drugs[0].quantity_limit).toBe(false));
  it("test_string_boolean_rejected", () => {
    f.drugs[0].plans[0].prior_authorization = "false";
    expect((view() as any).issues[0].code).toBe("invalid_restriction_boolean");
  });
  it("test_missing_drug_is_unknown_not_denied", () =>
    expect(
      lookup_evidence((view() as any).drugs, "rxcui", "111111111").status,
    ).toBe("unknown"));
  it("test_missing_provider_is_unknown_not_denied", () =>
    expect(lookup_evidence([], "npi", "1234567890").status).toBe("unknown"));
  it("test_index_classification", () => {
    expect(
      classify_index({ plan_urls: [], provider_urls: [], formulary_urls: [] }),
    ).toBe("qhp_index");
    expect(classify_index({ reporting_structure: [] })).toBe(
      "transparency_in_coverage",
    );
    expect(classify_index({ drug_urls: [] })).toBe("unknown");
  });
  it("test_incomplete_crawl_not_promoted", () =>
    expect((view() as any).source_completeness).toBe(
      "not_asserted_by_reference_joiner",
    ));
  it("test_no_patient_price_fabricated", () =>
    expect((view() as any).drugs[0].patient_price).toBeNull());
});
