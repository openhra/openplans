import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const modulePath = fileURLToPath(
  new URL(
    "../../../src/ingest/state/offexchange-inventory.py",
    import.meta.url,
  ),
);
const fixture = JSON.parse(
  await readFile(
    new URL("./fixtures/vt-hios-2026.json", import.meta.url),
    "utf8",
  ),
);
const fields = {
  StandardComponentId: "STANDARD COMPONENT ID",
  MarketCoverage: "MARKET COVERAGE",
  DentalOnlyPlan: "DENTAL ONLY PLAN",
  QHPNonQHPTypeId: "QHP NONQHP TYPE ID",
  MetalLevel: "METAL LEVEL",
  PlanMarketingName: "PLAN MARKETING NAME",
};
const rows = fixture.rows.map(
  (r: { source_row: number; values: Record<string, string> }) => [
    r.source_row,
    Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [value, r.values[key]]),
    ),
  ],
);

function check(zeroMutant = false) {
  // SYNTHETIC missing-rate envelope around real public identity facts. The real
  // cached bundle has rates for every base ID; never label this a real data gap.
  // Mutation runs only in an in-memory copy of the inventory implementation.
  return spawnSync(
    "python3",
    [
      "-c",
      `
import json, sys
from pathlib import Path
code = Path(sys.argv[1]).read_text()
if sys.argv[2] == 'mutant':
    original = "'puf_rate_rows': prices}"
    assert code.count(original) == 1
    code = code.replace(original, "'puf_rate_rows': prices, 'total_cents': 0}")
namespace = {'__name__': 'synthetic_inventory_check'}
exec(compile(code, sys.argv[1], 'exec'), namespace)
result = namespace['inventory'](json.load(sys.stdin), [], [])
assert len(result) == 55
assert all(p['puf_rate_status'] == 'unknown' for p in result)
assert all(p['puf_rate_reason'] == 'NO_PUBLIC_RATE_IN_REVIEWED_SOURCES' for p in result)
assert all('total_cents' not in p for p in result), 'missing premiums must never become zero'
assert all(p['puf_rate_rows'] == [] for p in result)
medical = [p for p in result if p['market'] == ['Individual'] and p['dental_only'] == ['No']]
assert len(medical) == 28
assert all(p['exchange'] == ['Both'] for p in medical)
assert len([p for p in medical if p['metal'] == ['Silver']]) == 8
assert all(p['hios_id'] for p in medical)
print('PASS: real identity inventory; synthetic missing rates remain unknown')
`,
      modulePath,
      zeroMutant ? "mutant" : "original",
    ],
    { input: JSON.stringify(rows), encoding: "utf8" },
  );
}

it("inventories all real VT base identities without treating eight Both-market Silver designs as new off-exchange-only IDs", () => {
  const result = check();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("PASS");
});

it("negative control: an implementation copy that emits zero for missing premiums fails the inventory contract", () => {
  const result = check(true);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("missing premiums must never become zero");
});
