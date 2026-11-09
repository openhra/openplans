import { describe, expect, it } from "vitest";
import {
  classifyProviderEvidence,
  providerSpecialties,
} from "../../../src/domain/providers/index.js";
import type { ProviderEvidence } from "../../../src/domain/providers/index.js";
const positive = {
  tier_status: "resolved",
  evidence_status: "listed_participating",
} as ProviderEvidence;
const negative = {
  ...positive,
  evidence_status: "explicitly_not_participating",
} as ProviderEvidence;
describe("provider evidence boundary", () => {
  it("distinguishes all five states using only applicable evidence and manifest completeness", () => {
    expect(classifyProviderEvidence([], false)).toBe("unknown");
    expect(classifyProviderEvidence([], true)).toBe("not_listed");
    expect(classifyProviderEvidence([positive], false)).toBe(
      "listed_participating",
    );
    expect(classifyProviderEvidence([negative], true)).toBe(
      "explicitly_not_participating",
    );
    expect(classifyProviderEvidence([positive, negative], true)).toBe(
      "conflicting",
    );
    expect(
      classifyProviderEvidence(
        [{ ...positive, tier_status: "unresolved" }],
        true,
      ),
    ).toBe("listed_participating");
    expect(
      classifyProviderEvidence(
        [
          { ...positive, network_tier: "A" },
          { ...positive, network_tier: "B" },
        ],
        true,
      ),
    ).toBe("listed_participating");
  });
  it("maps published speciality at the boundary, supporting the observed Cigna specialty spelling", () => {
    expect(
      providerSpecialties({ speciality: ["Cardiology"], specialty: ["Other"] }),
    ).toEqual(["Cardiology"]);
    expect(providerSpecialties({ specialty: ["Cardiology"] })).toEqual([
      "Cardiology",
    ]);
    expect(providerSpecialties({})).toEqual([]);
  });
});
