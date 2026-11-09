import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  communityRulesFile,
  parseCommunityRules,
  parseStateArtifact,
  communityRate,
} from "../../../src/ingest/state/index.js";
import type {
  CommunityPremium,
  HouseholdMember,
} from "../../../src/domain/rating/index.js";

export const communityRules = parseCommunityRules(
  readFileSync(communityRulesFile, "utf8"),
);
export function publishedRate(state: "NY" | "VT", key: string) {
  const artifact = parseStateArtifact(
    readFileSync(
      new URL(
        `../../fixtures/state/${state.toLowerCase()}-2026.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const source = artifact.sources[0]!;
  const record = source.records.find(
    (r) => r.plan_id === key || r.plan_name === key,
  )!;
  return communityRate(artifact, source, record);
}
export const nyRule = communityRules.find((rule) => rule.state === "NY")!;
export const vtRule = communityRules.find((rule) => rule.state === "VT")!;
export const nyRate = publishedRate("NY", "11177NY0220001");
export const vtRate = publishedRate("VT", "Gold Plan");
// SYNTHETIC households. Prices are from the public state publications.
type AgedMember = Extract<HouseholdMember, { age: number }>;
export const single: AgedMember[] = [
  { id: "s", relationship: "subscriber", age: 40, tobaccoUse: false },
];
export const couple: AgedMember[] = [
  ...single,
  { id: "p", relationship: "spouse", age: 45, tobaccoUse: false },
];
export const parent: AgedMember[] = [
  ...single,
  { id: "c", relationship: "child", age: 10, tobaccoUse: false },
];
export const family: AgedMember[] = [
  ...couple,
  { id: "c1", relationship: "child", age: 10, tobaccoUse: false },
  { id: "c2", relationship: "child", age: 17, tobaccoUse: false },
];
export function assertNyParent(result: CommunityPremium): void {
  assert.equal(result.status, "rated");
  // $1,270.98 x 1.70 = $2,160.666, rounded half up to $2,160.67.
  assert.equal(result.totalCents, 216_067);
}
export function assertNyUnsupported(result: {
  status: string;
  totalCents: number | null;
}): void {
  assert.equal(result.status, "unsupported_rating_method");
  assert.equal(result.totalCents, null);
}
