import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeSbeRow } from "../../../src/ingest/sbe/normalize.js";
import {
  householdPremium,
  parseRateRow,
} from "../../../src/domain/rating/index.js";
import type {
  CmsRateRow,
  Household,
  HouseholdPremium,
} from "../../../src/domain/rating/index.js";
import { CA_INDIVIDUAL_TOBACCO_POLICY } from "../../../src/domain/rating/medical-policy.js";

export const caFixture = JSON.parse(
  readFileSync(
    new URL("../../fixtures/rating/ca-2026/rates.json", import.meta.url),
    "utf8",
  ),
) as {
  sourceSha256: string;
  sourceFile: string;
  rows: { sourceRowNumber: number; raw: Record<string, string> }[];
};
export const caRows = caFixture.rows.map(({ sourceRowNumber, raw }) =>
  parseRateRow(
    normalizeSbeRow("rate", {
      rowNumber: sourceRowNumber,
      recordNumber: sourceRowNumber - 1,
      fields: Object.values(raw),
      values: raw,
    }).values as unknown as CmsRateRow,
    {
      snapshotId: `sha256:${caFixture.sourceSha256}`,
      sourceFile: caFixture.sourceFile,
      sourceRowNumber,
    },
  ),
);
export const caExamples = [
  {
    plan: "18126CA0010001",
    area: "Rating Area 16",
    county: "06037",
    zip: "90001",
    cents: 59396,
    row: 130,
    cell: 11305,
    geo: 1881,
  },
  {
    plan: "18126CA0010001",
    area: "Rating Area 19",
    county: "06073",
    zip: "92101",
    cents: 63319,
    row: 283,
    cell: 16915,
    geo: 2624,
  },
  {
    plan: "27603CA1500005",
    area: "Rating Area 7",
    county: "06085",
    zip: "95101",
    cents: 107090,
    row: 4567,
    cell: 24361,
    geo: 956,
  },
];
export const caHousehold = (tobaccoUse = false): Household => ({
  coverageStartDate: "2026-01-01",
  ratingMethod: "per_member",
  members: [
    { id: "subscriber", age: 40, relationship: "subscriber", tobaccoUse },
  ],
});
export const caFamily: Household = {
  ...caHousehold(),
  members: [
    {
      id: "subscriber",
      age: 35,
      relationship: "subscriber",
      tobaccoUse: false,
    },
    { id: "spouse", age: 33, relationship: "spouse", tobaccoUse: false },
    { id: "child", age: 5, relationship: "child", tobaccoUse: false },
  ],
};
export function caFamilyPremium(household = caFamily, rows = caRows) {
  return householdPremium(
    rows,
    "70285CA1250001",
    "Rating Area 7",
    household,
    CA_INDIVIDUAL_TOBACCO_POLICY.policy,
  );
}
export function assertCaFamily(result: HouseholdPremium) {
  assert.equal(result.status, "rated", "filed family gross");
  assert.equal(result.totalCents, 449675, "filed family gross");
  assert.deepEqual(
    result.members.map((member) => member.premiumCents),
    [172528, 169140, 108007],
    "filed family members",
  );
}
