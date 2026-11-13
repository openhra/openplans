// Dispensing-fee range import from the pharmacy networks file. Every identifier and fee below is
// synthetic; the header is the one the published 2026 data files use.
import { PGlite } from "@electric-sql/pglite";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../../src/db/migrate.js";
import {
  feeColumnAliases,
  formatFeeAmount,
  parseFeeAmount,
  PlanFeeRanges,
  resolveFeeColumns,
} from "../../../src/ingest/medicare/dispensing-fee.js";
import type { FeeRange } from "../../../src/ingest/medicare/dispensing-fee.js";
import {
  acquireSpuf,
  cachedSpuf,
  importSpuf,
  parseSpufUrl,
} from "../../../src/ingest/medicare/spuf.js";
import { coreMigrations, testDatabase } from "../../pglite.js";
import { lookup, spufUrl, zip } from "./helpers.js";

const dataHeader =
  "CONTRACT_ID|PLAN_ID|SEGMENT_ID|PHARMACY_NUMBER|PHARMACY_ZIPCODE|PREFERRED_STATUS_RETAIL|PREFERRED_STATUS_MAIL|PHARMACY_RETAIL|PHARMACY_MAIL|IN_AREA_FLAG|FLOOR_PRICE|BRAND_DISPENSING_FEE_30|BRAND_DISPENSING_FEE_60|BRAND_DISPENSING_FEE_90|GENERIC_DISPENSING_FEE_30|GENERIC_DISPENSING_FEE_60|GENERIC_DISPENSING_FEE_90|SELECTED_DISPENSING_FEE_30|SELECTED_DISPENSING_FEE_60|SELECTED_DISPENSING_FEE_90";
const layoutHeader = dataHeader.replaceAll(
  "SELECTED_DISPENSING_FEE_",
  "SELECTED_DRUG_DISPENSING_FEE_",
);
const member = (header: string, rows: string[]) =>
  zip({ "synthetic.txt": Buffer.from([header, ...rows, ""].join("\r\n")) });
/** Plan 001 runs across the two members; plan 002 follows it in part 2. */
const part1 = [
  "H9000|001|000|101000000001|90001|Y|Y|Y|Y|1|0|1|1|1|2|2|2|.|.|.",
];
const part2 = [
  "H9000|001|000|101000000002|90002|Y|N|Y|N|1|0.25|3|3|3|.|.|.|4|4|4",
  "H9000|002|000|101000000001|90001|N|N|Y|N|1|0|5|5|5|6|6|6|.|.|.",
];
const planFile = member(
  "CONTRACT_ID|PLAN_ID|SEGMENT_ID|FORMULARY_ID|PREMIUM|DEDUCTIBLE|PLAN_SUPPRESSED_YN",
  ["H9000|001|000|99990000|0|0|N", "H9000|002|000|99990000|0|0|N"],
);

function archive(
  first: string[] = part1,
  second: string[] = part2,
  header = dataHeader,
) {
  return zip({
    "plan information synthetic.zip": planFile,
    "pharmacy networks file synthetic part 1.zip": member(header, first),
    "pharmacy networks file synthetic part 2.zip": member(header, second),
  });
}

let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "partd-fee-"));
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function cached(bytes: Buffer) {
  const dataDir = await mkdtemp(join(directory, "cache-"));
  await acquireSpuf(parseSpufUrl(spufUrl)!, {
    dataDir,
    dependencies: {
      lookup,
      transport: async () => ({
        status: 200,
        headers: { "content-type": "application/zip" },
        body: Readable.from([bytes]),
      }),
    },
  });
  return (await cachedSpuf("quarterly", dataDir))[0]!;
}
async function database() {
  const migrations = await coreMigrations();
  const db = testDatabase(new PGlite());
  await migrate(db, migrations.directory);
  return {
    db,
    close: async () => {
      await db.close();
      await migrations.cleanup();
    },
  };
}

describe("dispensing-fee cells", () => {
  it("reads 9(8.4) amounts exactly and keeps `.` and blank missing", () => {
    expect(parseFeeAmount(".", "fee")).toBeNull();
    expect(parseFeeAmount("", "fee")).toBeNull();
    expect(parseFeeAmount("0", "fee")).toBe(0);
    expect(parseFeeAmount("0.1", "fee")).toBe(1000);
    expect(parseFeeAmount(".5", "fee")).toBe(5000);
    expect(parseFeeAmount("27.1234", "fee")).toBe(271_234);
    expect(parseFeeAmount("12345678.9999", "fee")).toBe(123_456_789_999);
    for (const bad of ["1.23456", "-1", "1e3", "abc", "1,5", " "])
      expect(() => parseFeeAmount(bad, "fee")).toThrow("9(8.4)");
    expect(formatFeeAmount(271_234)).toBe("27.1234");
    expect(formatFeeAmount(5)).toBe("0.0005");
  });

  it("accepts the data-file and the record-layout spelling of the selected-drug fee", () => {
    expect(resolveFeeColumns(dataHeader.split("|")).selected[60]).toBe(
      "SELECTED_DISPENSING_FEE_60",
    );
    expect(resolveFeeColumns(layoutHeader.split("|")).selected[60]).toBe(
      "SELECTED_DRUG_DISPENSING_FEE_60",
    );
    const neither = dataHeader
      .split("|")
      .filter((c) => !c.startsWith("SELECTED_"));
    expect(() => resolveFeeColumns(neither)).toThrow("selected fee column");
    const both = [...dataHeader.split("|"), "SELECTED_DRUG_DISPENSING_FEE_30"];
    expect(() => resolveFeeColumns(both)).toThrow("selected fee column");
  });
});

describe("dispensing-fee import", () => {
  it("stores ranges per plan with each member's name and hash, never pharmacy rows", async () => {
    const state = await database();
    try {
      const input = await cached(archive());
      const imported = await importSpuf(state.db, input, [
        "plan",
        "dispensing_fee",
      ]);
      expect(imported.counts).toMatchObject({
        dispensing_fee_rows: 3,
        dispensing_fee_plans: 2,
      });
      const { rows } = await state.db.query<Record<string, unknown>>(
        `SELECT plan_id,channel,fee_type,pharmacies,fees_readable,fees_missing,min_fee::text,max_fee::text,
           max_floor_price::text,source_files,source_sha256,first_source_row::int
         FROM partd_dispensing_fee_range WHERE days_supply=30 AND in_area ORDER BY plan_id,channel,fee_type`,
      );
      const sha = (rows: string[]) =>
        createHash("sha256").update(member(dataHeader, rows)).digest("hex");
      const both = {
        source_files: [
          "pharmacy networks file synthetic part 1.zip",
          "pharmacy networks file synthetic part 2.zip",
        ],
        source_sha256: [sha(part1), sha(part2)],
        first_source_row: 2,
      };
      const one = {
        source_files: ["pharmacy networks file synthetic part 2.zip"],
        source_sha256: [sha(part2)],
        first_source_row: 3,
      };
      const range = (
        plan: string,
        channel: string,
        fee_type: string,
        readable: number,
        missing: number,
        min: string | null,
        max: string | null,
        floor: string,
        source: typeof both,
      ) => ({
        plan_id: plan,
        channel,
        fee_type,
        pharmacies: readable + missing,
        fees_readable: readable,
        fees_missing: missing,
        min_fee: min,
        max_fee: max,
        max_floor_price: floor,
        ...source,
      });
      expect(rows).toEqual([
        range(
          "001",
          "preferred_mail",
          "brand",
          1,
          0,
          "1.0000",
          "1.0000",
          "0.0000",
          both,
        ),
        range(
          "001",
          "preferred_mail",
          "generic",
          1,
          0,
          "2.0000",
          "2.0000",
          "0.0000",
          both,
        ),
        range(
          "001",
          "preferred_mail",
          "selected",
          0,
          1,
          null,
          null,
          "0.0000",
          both,
        ),
        range(
          "001",
          "preferred_retail",
          "brand",
          2,
          0,
          "1.0000",
          "3.0000",
          "0.2500",
          both,
        ),
        range(
          "001",
          "preferred_retail",
          "generic",
          1,
          1,
          "2.0000",
          "2.0000",
          "0.2500",
          both,
        ),
        range(
          "001",
          "preferred_retail",
          "selected",
          1,
          1,
          "4.0000",
          "4.0000",
          "0.2500",
          both,
        ),
        range(
          "002",
          "standard_retail",
          "brand",
          1,
          0,
          "5.0000",
          "5.0000",
          "0.0000",
          one,
        ),
        range(
          "002",
          "standard_retail",
          "generic",
          1,
          0,
          "6.0000",
          "6.0000",
          "0.0000",
          one,
        ),
        range(
          "002",
          "standard_retail",
          "selected",
          0,
          1,
          null,
          null,
          "0.0000",
          one,
        ),
      ]);
      const pharmacyRows = await state.db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM partd_network_pharmacy",
      );
      expect(pharmacyRows.rows[0]!.n).toBe(0);
    } finally {
      await state.close();
    }
  }, 120_000);

  it("adds fee ranges to a release already imported from the same bytes", async () => {
    const state = await database();
    try {
      const input = await cached(archive());
      expect((await importSpuf(state.db, input, ["plan"])).outcome).toBe(
        "imported",
      );
      const extended = await importSpuf(state.db, input, [
        "plan",
        "dispensing_fee",
      ]);
      expect(extended.outcome).toBe("extended");
      expect(extended.counts.dispensing_fee_plans).toBe(2);
      const release = await state.db.query<{ tables: string[] }>(
        "SELECT tables FROM partd_release",
      );
      expect(release.rows[0]!.tables).toEqual(["plan", "dispensing_fee"]);
      expect(
        (await importSpuf(state.db, input, ["plan", "dispensing_fee"])).outcome,
      ).toBe("noop");
    } finally {
      await state.close();
    }
  }, 120_000);

  it.each([
    [
      "rows not grouped by plan",
      archive(part1, [part2[1]!, part2[0]!]),
      /not grouped by plan/,
    ],
    [
      "a fee that is not an amount",
      archive([part1[0]!.replace("|1|1|1|2|", "|1|x|1|2|")]),
      /BRAND_DISPENSING_FEE_60 is not a 9\(8\.4\) amount/,
    ],
    [
      "a channel flag that is not Y/N",
      archive([part1[0]!.replace("|Y|Y|Y|Y|1|", "|Y|Y||Y|1|")]),
      /PHARMACY_RETAIL is not Y\/N/,
    ],
    [
      "an area flag that is not 0/1",
      archive([part1[0]!.replace("|Y|Y|Y|Y|1|", "|Y|Y|Y|Y|Y|")]),
      /IN_AREA_FLAG/,
    ],
    [
      "a header without the selected-drug fee",
      archive(
        part1.map((r) => r.split("|").slice(0, -3).join("|")),
        part2.map((r) => r.split("|").slice(0, -3).join("|")),
        dataHeader.split("|").slice(0, -3).join("|"),
      ),
      /selected fee column/,
    ],
  ])(
    "rejects %s and leaves the release without fee ranges",
    async (_name, bytes, message) => {
      const state = await database();
      try {
        const input = await cached(bytes);
        await importSpuf(state.db, input, ["plan"]);
        await expect(
          importSpuf(state.db, input, ["plan", "dispensing_fee"]),
        ).rejects.toThrow(message);
        const after = await state.db.query<{ tables: string[]; n: number }>(
          "SELECT tables,(SELECT count(*)::int FROM partd_dispensing_fee_range) AS n FROM partd_release",
        );
        expect(after.rows).toEqual([{ tables: ["plan"], n: 0 }]);
      } finally {
        await state.close();
      }
    },
    120_000,
  );
});

describe("planted fee-import mutants (each must fail a named check)", () => {
  /** Ranges for one plan's rows, the way the import builds them. */
  type Build = (header: string, rows: string[]) => FeeRange[];
  const build: Build = (header, rows) => {
    const names = header.split("|");
    const columns = resolveFeeColumns(names);
    const ranges = new PlanFeeRanges();
    for (const row of rows) {
      const cells = row.split("|");
      ranges.add(
        Object.fromEntries(names.map((name, i) => [name, cells[i]!])),
        columns,
      );
    }
    return ranges.ranges();
  };
  const group = (ranges: FeeRange[], channel: string, type: string) =>
    ranges.find(
      (range) =>
        range.channel === channel &&
        range.fee_type === type &&
        range.days_supply === 30 &&
        range.in_area,
    );
  /** Plan 001's rows across both members; expected ranges written out by hand. */
  const plan001 = [...part1, part2[0]!];
  function failing(make: Build): string[] {
    const checks: [string, () => boolean][] = [
      [
        "the data-file header is read",
        () =>
          group(make(dataHeader, plan001), "preferred_retail", "selected")
            ?.max_fee === 40_000,
      ],
      [
        "a `.` selected fee is missing, not $0",
        () => {
          const selected = group(
            make(dataHeader, plan001),
            "preferred_retail",
            "selected",
          );
          return (
            selected?.fees_missing === 1 &&
            selected.fees_readable === 1 &&
            selected.min_fee === 40_000
          );
        },
      ],
      [
        "a mail group whose only fee is `.` has no fee",
        () => {
          const mail = group(
            make(dataHeader, plan001),
            "preferred_mail",
            "selected",
          );
          return mail?.min_fee === null && mail.fees_missing === 1;
        },
      ],
    ];
    const passes = (ok: () => boolean) => {
      try {
        return ok();
      } catch {
        return false;
      }
    };
    return checks.filter(([, ok]) => !passes(ok)).map(([name]) => name);
  }

  it("passes every check with the production import", () => {
    expect(failing(build)).toEqual([]);
  });

  it("catches `.` read as $0", () => {
    const dotAsZero: Build = (header, rows) =>
      build(
        header,
        rows.map((row) =>
          row
            .split("|")
            .map((cell) => (cell === "." ? "0" : cell))
            .join("|"),
        ),
      );
    expect(failing(dotAsZero)).toEqual([
      "a `.` selected fee is missing, not $0",
      "a mail group whose only fee is `.` has no fee",
    ]);
  });

  it("catches a reader that knows only the record-layout spelling SELECTED_DRUG_DISPENSING_FEE_*", async () => {
    const real = feeColumnAliases.selected;
    feeColumnAliases.selected = (days) => [
      `SELECTED_DRUG_DISPENSING_FEE_${days}`,
    ];
    try {
      expect(failing(build)).toContain("the data-file header is read");
      // The whole import of the published spelling fails too, and stores no ranges.
      const state = await database();
      try {
        const input = await cached(archive());
        await expect(
          importSpuf(state.db, input, ["plan", "dispensing_fee"]),
        ).rejects.toThrow("selected fee column");
      } finally {
        await state.close();
      }
    } finally {
      feeColumnAliases.selected = real;
    }
    expect(failing(build)).toEqual([]);
  }, 120_000);
});
