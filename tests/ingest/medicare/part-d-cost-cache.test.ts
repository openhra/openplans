// Decodes every core row of the cached 2026 quarterly and 2027 monthly Part D archives and checks
// the totals against counts taken from the raw text with a separate script. Runs only when
// OPENPLANS_DATA_DIR holds those exact archives; nothing is downloaded.
import { describe, expect, it } from "vitest";
import {
  decodeInsulin,
  decodePlanRows,
  decodeTierCosts,
  yearRules,
} from "../../../src/domain/medicare/part-d-cost/repository.js";
import type { StoredRow } from "../../../src/domain/medicare/part-d-cost/repository.js";
import {
  cachedSpuf,
  spufTableRows,
} from "../../../src/ingest/medicare/spuf.js";
import type { SpufKind, SpufTable } from "../../../src/ingest/medicare/spuf.js";

interface Expected {
  kind: SpufKind;
  year: number;
  sha256: string;
  plan: {
    rows: number;
    plans: number;
    suppressed: number;
    zeroDeductible: number;
  };
  cost: {
    rows: number;
    staleCatastrophic: number;
    boundedCopayCells: number;
    coinsuranceCells: number;
    notOfferedCells: number;
  };
  insulin: {
    rows: number;
    blankTier: number;
    blankCells: number;
    notOfferedCells: number;
    filedCells: number;
  };
  formularyRows: number;
}
// Counts read from the raw member text (pipe-split, windows-1252) by a separate script.
const archives: Expected[] = [
  {
    kind: "quarterly",
    year: 2026,
    sha256: "16315ea97f043eea8f8539dc2ac2d8343b8054890e12615953767a8b6688d82b",
    plan: { rows: 112294, plans: 5518, suppressed: 22, zeroDeductible: 749 },
    cost: {
      rows: 172549,
      staleCatastrophic: 6,
      boundedCopayCells: 2903,
      coinsuranceCells: 100097,
      notOfferedCells: 104750,
    },
    insulin: {
      rows: 43045,
      blankTier: 767,
      blankCells: 50038,
      notOfferedCells: 48356,
      filedCells: 122142,
    },
    formularyRows: 1129364,
  },
  {
    kind: "monthly",
    year: 2027,
    sha256: "5f3bbe4e9ca29bce965403f3780d66452ec446cef5bf01fa050d3c6a990f053c",
    plan: { rows: 108263, plans: 5495, suppressed: 3, zeroDeductible: 453 },
    cost: {
      rows: 173613,
      staleCatastrophic: 6,
      boundedCopayCells: 1914,
      coinsuranceCells: 109941,
      notOfferedCells: 115421,
    },
    insulin: {
      rows: 44855,
      blankTier: 526,
      blankCells: 57888,
      notOfferedCells: 56722,
      filedCells: 121532,
    },
    formularyRows: 963666,
  },
];

const dataDir = process.env.OPENPLANS_DATA_DIR;
async function find(expected: Expected) {
  if (!dataDir) return null;
  const cached = await cachedSpuf(expected.kind, dataDir);
  return (
    cached.find(
      (entry) =>
        entry.metadata.sha256 === expected.sha256 &&
        entry.archive.year === expected.year,
    ) ?? null
  );
}
const located = await Promise.all(archives.map(find));

async function byPlan(path: string, table: SpufTable) {
  const plans = new Map<string, StoredRow[]>();
  let rows = 0;
  for await (const row of spufTableRows(path, table)) {
    rows++;
    const key = `${row.values.CONTRACT_ID}-${row.values.PLAN_ID}-${row.values.SEGMENT_ID}`;
    const list = plans.get(key) ?? [];
    list.push({ cells: row.values, source_row: row.rowNumber });
    plans.set(key, list);
  }
  return { plans, rows };
}

describe.each(
  archives.map((expected, i) => [expected.year, expected, i] as const),
)("cached %i Part D archive", (_year, expected, index) => {
  const cached = located[index];
  const rules = yearRules(expected.year);

  it.skipIf(!cached)(
    "decodes plan rows: suppression, deductibles and county agreement",
    async () => {
      const { plans, rows } = await byPlan(cached!.path, "plan");
      expect(rows).toBe(expected.plan.rows);
      expect(plans.size).toBe(expected.plan.plans);
      let suppressed = 0,
        zero = 0;
      for (const [key, list] of plans) {
        const decoded = decodePlanRows(
          "cache",
          list.map((row) => ({
            ...row,
            formulary_id: row.cells.FORMULARY_ID!,
            suppressed: row.cells.PLAN_SUPPRESSED_YN === "Y",
          })),
          rules,
        );
        expect(decoded.conflicts, key).toEqual([]);
        expect(decoded.formularies, key).toHaveLength(1);
        expect(decoded.deductible.status, key).toBe("value");
        if (decoded.suppressed) suppressed++;
        if (
          decoded.deductible.status === "value" &&
          decoded.deductible.cents === 0
        )
          zero++;
      }
      expect(suppressed).toBe(expected.plan.suppressed);
      expect(zero).toBe(expected.plan.zeroDeductible);
    },
    300_000,
  );

  it.skipIf(!cached)(
    "decodes cost and insulin rows: codes, sentinels, blank tiers and duplicates",
    async () => {
      const costs = await byPlan(cached!.path, "beneficiary_cost");
      const insulin = await byPlan(cached!.path, "insulin_cost");
      expect(costs.rows).toBe(expected.cost.rows);
      expect(insulin.rows).toBe(expected.insulin.rows);
      const conflicts: Record<string, number> = {};
      const cells: Record<string, number> = {};
      const count = (bucket: Record<string, number>, key: string) =>
        (bucket[key] = (bucket[key] ?? 0) + 1);
      let tierRows = 0,
        blankTier = 0;
      for (const [key, rows] of costs.plans) {
        const decoded = decodeTierCosts("cache", rows, rules);
        for (const conflict of decoded.conflicts)
          count(conflicts, conflict.code);
        for (const tier of decoded.tiers) {
          tierRows += tier.evidence.length;
          for (const channel of tier.channels) {
            const bounded = [channel.minimum, channel.maximum].some(
              (bound) => bound.status === "value" && bound.cents > 0,
            );
            // A bounded copay keeps its filed amount; bounds.ts decides what the bounds mean.
            if (
              channel.status === "copay" &&
              bounded &&
              channel.amount?.status === "value"
            )
              count(cells, "copay_bounded");
            if (channel.amount?.status === "unknown")
              count(cells, `unknown_${channel.status}`);
            else count(cells, channel.status);
          }
        }
        const fromInsulin = decodeInsulin(
          "cache",
          insulin.plans.get(key) ?? [],
          rows,
        );
        for (const conflict of fromInsulin.conflicts)
          count(conflicts, conflict.code);
        for (const item of fromInsulin.insulin) {
          if (item.tier === null) blankTier++;
          for (const channel of item.channels)
            count(cells, `insulin_${channel.reason ?? channel.status}`);
        }
      }
      // Every insulin row belongs to a plan with cost rows.
      for (const key of insulin.plans.keys())
        expect(costs.plans.has(key), key).toBe(true);
      expect(conflicts).toEqual({
        catastrophic_cost_sharing_conflicts_with_rules:
          expected.cost.staleCatastrophic,
      });
      expect(tierRows).toBe(
        expected.cost.rows - expected.cost.staleCatastrophic,
      );
      expect(cells.copay_bounded).toBe(expected.cost.boundedCopayCells);
      expect(cells.unknown_copay).toBeUndefined();
      expect(cells.coinsurance).toBe(expected.cost.coinsuranceCells);
      expect(cells.not_offered).toBe(expected.cost.notOfferedCells);
      expect(cells.unknown_coinsurance).toBeUndefined();
      expect(blankTier).toBe(expected.insulin.blankTier);
      expect(cells.insulin_filed).toBe(expected.insulin.filedCells);
      expect(cells.insulin_not_offered).toBe(expected.insulin.notOfferedCells);
      expect(cells.insulin_blank_insulin_cost).toBe(
        expected.insulin.blankCells - expected.insulin.notOfferedCells,
      );
      expect(cells.insulin_incomplete_insulin_cost).toBeUndefined();
    },
    300_000,
  );

  it.skipIf(!cached)(
    "has one formulary row per RxCUI, all for the archive's contract year",
    async () => {
      const seen = new Set<string>();
      let rows = 0,
        duplicates = 0,
        wrongYear = 0;
      for await (const row of spufTableRows(cached!.path, "formulary")) {
        rows++;
        const key = `${row.values.FORMULARY_ID}|${row.values.RXCUI}`;
        if (seen.has(key)) duplicates++;
        seen.add(key);
        if (row.values.CONTRACT_YEAR !== String(expected.year)) wrongYear++;
      }
      expect(rows).toBe(expected.formularyRows);
      expect(duplicates).toBe(0);
      expect(wrongYear).toBe(0);
    },
    300_000,
  );
});
