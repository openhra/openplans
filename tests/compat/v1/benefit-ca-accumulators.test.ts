import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { stateDetailColumns } from "../../../src/ingest/state/catalog.js";
import { attributeCostSharing } from "../../../src/domain/csr/index.js";
import { mapVariantAccumulators } from "../../../src/compat/v1/mapping.js";

const source = JSON.parse(
  await readFile(
    new URL("./benefit-ca-accumulator-public.json", import.meta.url),
    "utf8",
  ),
) as {
  rows: { source_row: number; values: Record<string, string> }[];
};
const raw = source.rows[0]!.values;
function caContract(values: Record<string, string>) {
  const columns = stateDetailColumns(values);
  const sharing = {
    status: "available",
    ...attributeCostSharing(columns),
  } as Parameters<typeof mapVariantAccumulators>[0];
  const mapped = mapVariantAccumulators(sharing);
  assert.equal(
    mapped.individual_medical_deductible,
    "In-Network Tier 1: $0 / Out-of-Network: $5,500 / Combined in/out of network: Not Applicable",
  );
  assert.equal(
    mapped.individual_drug_deductible,
    "In-Network Tier 1: $0 / Out-of-Network: Not Applicable / Combined in/out of network: Not Applicable",
  );
  assert.equal(mapped.individual_medical_moop, mapped.individual_drug_moop);
  assert.match(
    String(mapped.individual_medical_moop),
    /^Medical and drug combined \| In-Network Tier 1: \$9,200/,
  );
  assert.match(
    String(mapped.family_medical_moop),
    /\$9200 per person \| \$18400 per group/,
  );
  return columns;
}
it("normalizes the public CA accumulator headers while preserving raw source cells and payment scopes", () => {
  const columns = caContract(raw);
  for (const [key, value] of Object.entries(raw))
    expect(columns[key]).toBe(value);
  expect(columns.MEHBDedInnTier1Coinsurance).toBe("20.00%");
  expect(columns.DEHBDedInnTier1Coinsurance).toBe("20.00%");
  expect(
    attributeCostSharing(columns).coinsurance_raw.MEHBDedInnTier1Coinsurance,
  ).toBe("20.00%");
  expect(columns.MedicalDrugDeductiblesIntegrated).toBe("No");
  expect(columns.MedicalDrugMaximumOutofPocketIntegrated).toBe("Yes");
  expect(columns.MEHBDedOutOfNetIndividual?.trim()).toBe("$5,500");
  expect(source.rows[0]!.source_row).toBe(377);
});
it("rejects conflicting CA aliases and leaves missing accumulator values unknown", () => {
  expect(() =>
    stateDetailColumns({ ...raw, MEHBDedInnTier1Individual: "$999" }),
  ).toThrow("Conflicting supplemental detail columns");
  const sharing = {
    status: "available",
    ...attributeCostSharing(stateDetailColumns({})),
  } as Parameters<typeof mapVariantAccumulators>[0];
  expect(
    Object.values(mapVariantAccumulators(sharing)).every(
      (value) => value === null,
    ),
  ).toBe(true);
});
it("negative controls reject a dropped CA header and crossed medical/drug cells", () => {
  const missing = { ...raw };
  delete missing["MEHB DED OUT OF NET INDIVIDUAL"];
  expect(() => caContract(missing)).toThrow();
  const swapped = {
    ...raw,
    "MEHB DED OUT OF NET INDIVIDUAL": raw["DEHB DED OUT OF NET INDIVIDUAL"]!,
  };
  expect(() => caContract(swapped)).toThrow();
});
