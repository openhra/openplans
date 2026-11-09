import { describe, expect, it } from "vitest";
import { classifyDrugEvidence } from "../../../src/domain/drugs/index.js";
import type { DrugEvidence } from "../../../src/domain/drugs/index.js";
const evidence = (overrides: Partial<DrugEvidence> = {}): DrugEvidence => ({
  drug_tier: "GENERIC",
  tier_status: "resolved",
  cost_sharing: null,
  prior_authorization: null,
  step_therapy: false,
  quantity_limit: null,
  evidence_status: "listed_covered",
  snapshot_id: "synthetic-shard",
  source_id: "synthetic",
  source_record: 0,
  source_plan_index: 0,
  source_set_id: "synthetic-set",
  raw_snapshot_id: "synthetic-raw",
  source_url: null,
  source_updated_at: null,
  ...overrides,
});
describe("drug evidence states", () => {
  it("absence requires a complete manifest; it never supplies explicit exclusion", () => {
    expect(classifyDrugEvidence([], true)).toBe("not_listed");
    expect(classifyDrugEvidence([], false)).toBe("unknown");
  });
  it("preserves explicit publisher exclusion independently of absence and resolves agreement", () => {
    expect(classifyDrugEvidence([evidence()], true)).toBe("listed_covered");
    expect(
      classifyDrugEvidence(
        [evidence({ evidence_status: "explicitly_not_covered" })],
        true,
      ),
    ).toBe("explicitly_not_covered");
    expect(classifyDrugEvidence([evidence(), evidence()], true)).toBe(
      "listed_covered",
    );
  });
  it("conflicting shards cannot be resolved by input order or converted to coverage", () => {
    const rows = [
      evidence(),
      evidence({ evidence_status: "explicitly_not_covered" }),
    ];
    expect(classifyDrugEvidence(rows, true)).toBe("conflicting");
    expect(classifyDrugEvidence([...rows].reverse(), true)).toBe("conflicting");
    expect(
      classifyDrugEvidence(
        [evidence(), evidence({ drug_tier: "SPECIALTY" })],
        true,
      ),
    ).toBe("conflicting");
    expect(
      classifyDrugEvidence(
        [evidence({ step_therapy: true }), evidence()],
        true,
      ),
    ).toBe("conflicting");
  });
  it("unknown restriction is compatible with a known flag, never evidence of false", () => {
    expect(
      classifyDrugEvidence(
        [evidence(), evidence({ prior_authorization: true })],
        true,
      ),
    ).toBe("listed_covered");
    expect(
      classifyDrugEvidence(
        [
          evidence({ prior_authorization: false }),
          evidence({ prior_authorization: true }),
        ],
        true,
      ),
    ).toBe("conflicting");
  });
});
