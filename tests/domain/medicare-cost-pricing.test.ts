// Plan average unit costs and dispensing-fee ranges read from a pinned Part D release. Every
// identifier, price and fee below is synthetic. Expected answers are written out by hand from the
// synthetic rows, not computed by the reader, and two planted mutants of the row choice must fail.
import { PGlite } from "@electric-sql/pglite";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/db/database.js";
import { migrate } from "../../src/db/migrate.js";
import {
  pickUnitCost,
  readDispensingFeeRanges,
  readUnitCost,
} from "../../src/domain/medicare/part-d-cost/repository.js";
import type {
  UnitCost,
  UnitCostRequest,
  UnitCostRow,
} from "../../src/domain/medicare/part-d-cost/repository.js";
import {
  acquireSpuf,
  cachedSpuf,
  importSpuf,
  parseSpufUrl,
} from "../../src/ingest/medicare/spuf.js";
import type { SpufTable } from "../../src/ingest/medicare/spuf.js";
import { lookup, spufUrl, zip } from "../ingest/medicare/helpers.js";
import { coreMigrations, testDatabase } from "../pglite.js";

const networkHeader =
  "CONTRACT_ID|PLAN_ID|SEGMENT_ID|PHARMACY_NUMBER|PHARMACY_ZIPCODE|PREFERRED_STATUS_RETAIL|PREFERRED_STATUS_MAIL|PHARMACY_RETAIL|PHARMACY_MAIL|IN_AREA_FLAG|FLOOR_PRICE|BRAND_DISPENSING_FEE_30|BRAND_DISPENSING_FEE_60|BRAND_DISPENSING_FEE_90|GENERIC_DISPENSING_FEE_30|GENERIC_DISPENSING_FEE_60|GENERIC_DISPENSING_FEE_90|SELECTED_DISPENSING_FEE_30|SELECTED_DISPENSING_FEE_60|SELECTED_DISPENSING_FEE_90";
/** Synthetic pricing rows; row numbers count the header as row 1. */
const pricingRows = [
  "H9000|001|000|99990000001|30|1.23", // row 2
  "H9000|001|000|99990000001|90|1.2", // row 3; no 60-day row
  "H9000|001|000|99990000002|30|0", // row 4: zero cost
  "H9000|001|001|99990000001|30|9.9999", // row 5: another segment
  "H9000|002|000|99990000001|60|2.3456", // row 6: 60 days only
];

function archive(options: { pricing?: boolean; pricingRows?: string[] } = {}) {
  const table = (header: string, rows: string[]) =>
    zip({ "synthetic.txt": Buffer.from([header, ...rows, ""].join("\r\n")) });
  return zip({
    "plan information synthetic.zip": table(
      "CONTRACT_ID|PLAN_ID|SEGMENT_ID|FORMULARY_ID|PREMIUM|DEDUCTIBLE|PLAN_SUPPRESSED_YN",
      [
        "H9000|001|000|99990000|0|0|N",
        "H9000|001|001|99990000|0|0|N",
        "H9000|002|000|99990000|0|0|N",
      ],
    ),
    "pharmacy networks file synthetic part 1.zip": table(networkHeader, [
      "H9000|001|000|101000000001|90001|Y|N|Y|N|1|0|0.3|0.3|0|0.5|0.5|0|.|.|.",
      "H9000|001|000|101000000002|90002|Y|N|Y|N|1|1.5|2.75|2.75|0|.|.|.|1|1|1",
      "H9000|001|000|101000000003|90003|N|N|Y|N|1|0|10.1234|10|10|1|1|1|.|.|.",
      "H9000|001|000|101000000004|90004|Y|N|Y|N|0|0|99|99|99|99|99|99|.|.|.",
    ]),
    ...(options.pricing === false
      ? {}
      : {
          "pricing file synthetic.zip": table(
            "CONTRACT_ID|PLAN_ID|SEGMENT_ID|NDC|DAYS_SUPPLY|UNIT_COST",
            options.pricingRows ?? pricingRows,
          ),
        }),
  });
}

let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "medicare-pricing-"));
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function loaded(
  bytes: Buffer,
  tables: SpufTable[],
  url = spufUrl,
): Promise<{ db: Database; snapshotId: string; close(): Promise<void> }> {
  const migrations = await coreMigrations();
  const db = testDatabase(new PGlite());
  await migrate(db, migrations.directory);
  const imported = await importInto(db, bytes, tables, url);
  return {
    db,
    snapshotId: imported.snapshot_id,
    close: async () => {
      await db.close();
      await migrations.cleanup();
    },
  };
}

/** Caches `bytes` as the archive at `url` and imports it into `db`. */
async function importInto(
  db: Database,
  bytes: Buffer,
  tables: SpufTable[],
  url = spufUrl,
) {
  const dataDir = await mkdtemp(join(directory, "cache-"));
  const parsed = parseSpufUrl(url)!;
  await acquireSpuf(parsed, {
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
  const cached = (await cachedSpuf(parsed.kind, dataDir))[0]!;
  return importSpuf(db, cached, tables);
}

const plan = (planId: string, segmentId = "0") => ({
  contractId: "H9000",
  planId,
  segmentId,
});
type Case = [
  name: string,
  request: Partial<UnitCostRequest>,
  expected:
    | { unit_cost: string; ten_thousandths: number; source_row: number }
    | { reason: string },
];
/** Hand-written answers for the synthetic rows above. */
const cases: Case[] = [
  [
    "30-day row",
    {},
    { unit_cost: "1.2300", ten_thousandths: 12_300, source_row: 2 },
  ],
  [
    "90-day row",
    { daysSupply: 90 },
    { unit_cost: "1.2000", ten_thousandths: 12_000, source_row: 3 },
  ],
  [
    "standard retail reads the same plan average",
    { channel: "standard_retail" },
    { unit_cost: "1.2300", ten_thousandths: 12_300, source_row: 2 },
  ],
  [
    "60 days where only 30 and 90 exist",
    { daysSupply: 60 },
    { reason: "unit_cost_not_published" },
  ],
  [
    "60 days on the plan that has only 60",
    { plan: plan("002"), daysSupply: 60 },
    { unit_cost: "2.3456", ten_thousandths: 23_456, source_row: 6 },
  ],
  [
    "30 days on the plan that has only 60",
    { plan: plan("002") },
    { reason: "unit_cost_not_published" },
  ],
  [
    "segment 1 reads its own row",
    { plan: plan("001", "1") },
    { unit_cost: "9.9999", ten_thousandths: 99_999, source_row: 5 },
  ],
  [
    "segment 1 has no 90-day row of segment 0",
    { plan: plan("001", "1"), daysSupply: 90 },
    { reason: "unit_cost_not_published" },
  ],
  ["zero cost", { ndc: "99990000002" }, { reason: "unit_cost_unreadable" }],
  [
    "NDC without a row",
    { ndc: "99990000003" },
    { reason: "unit_cost_not_published" },
  ],
  [
    "plan without rows",
    { plan: plan("003") },
    { reason: "unit_cost_not_published" },
  ],
  [
    "28-day fill",
    { daysSupply: 28 },
    { reason: "price_days_supply_not_published" },
  ],
  [
    "45-day fill",
    { daysSupply: 45 },
    { reason: "price_days_supply_not_published" },
  ],
  [
    "preferred mail",
    { channel: "preferred_mail" },
    { reason: "unit_cost_retail_only" },
  ],
  [
    "standard mail",
    { channel: "standard_mail" },
    { reason: "unit_cost_retail_only" },
  ],
  [
    "quantity in millilitres",
    { quantityUnit: "mL" },
    { reason: "quantity_unit_not_ndc_unit" },
  ],
  [
    "quantity in packages",
    { quantityUnit: "package" },
    { reason: "quantity_unit_not_ndc_unit" },
  ],
  ["short NDC", { ndc: "9999000001" }, { reason: "invalid_ndc" }],
  [
    "another contract year on the same release",
    { year: 2027 },
    { reason: "pricing_release_mismatch" },
  ],
  [
    "unknown release",
    { snapshotId: "synthetic-missing" },
    { reason: "release_not_active" },
  ],
];

type Pick = typeof pickUnitCost;
/** Named failures of `pick` over every case; a correct reader returns none. */
async function problems(
  db: Database,
  snapshotId: string,
  pick: Pick = pickUnitCost,
  read: typeof readUnitCost = readUnitCost,
): Promise<string[]> {
  const out: string[] = [];
  for (const [name, partial, expected] of cases) {
    const request: UnitCostRequest = {
      snapshotId,
      year: 2026,
      plan: plan("001"),
      ndc: "99990000001",
      daysSupply: 30,
      channel: "preferred_retail",
      quantityUnit: "ndc_unit",
      ...partial,
    };
    const answer: UnitCost = await read(db, request, pick);
    if (answer.status === "value" && answer.ten_thousandths === 0)
      out.push(`${name}: a zero price`);
    if ("reason" in expected) {
      if (answer.status !== "unknown" || answer.reason !== expected.reason)
        out.push(
          `${name}: expected unknown ${expected.reason}, got ${JSON.stringify(answer)}`,
        );
      continue;
    }
    if (
      answer.status !== "value" ||
      answer.unit_cost !== expected.unit_cost ||
      answer.ten_thousandths !== expected.ten_thousandths ||
      answer.days_supply !== request.daysSupply ||
      answer.evidence.source_row !== expected.source_row ||
      answer.evidence.snapshot_id !== snapshotId ||
      answer.evidence.table !== "pricing"
    )
      out.push(`${name}: got ${JSON.stringify(answer)}`);
  }
  return out;
}

describe("plan average unit cost reader", () => {
  let state: Awaited<ReturnType<typeof loaded>>;
  beforeAll(async () => {
    state = await loaded(archive(), ["plan", "pricing", "dispensing_fee"]);
  }, 120_000);
  afterAll(async () => {
    await state.close();
  });

  it("answers only exact rows and names every unknown", async () => {
    expect(await problems(state.db, state.snapshotId)).toEqual([]);
  });

  it("labels a value as the plan's retail average with a caller-asserted quantity", async () => {
    const answer = await readUnitCost(state.db, {
      snapshotId: state.snapshotId,
      year: 2026,
      plan: plan("001"),
      ndc: "99990000001",
      daysSupply: 30,
      channel: "preferred_retail",
      quantityUnit: "ndc_unit",
    });
    expect(answer).toMatchObject({
      status: "value",
      basis: "cms_plan_average",
      quantity_basis: "caller_asserted_ndc_units",
      evidence: { fields: ["UNIT_COST"] },
    });
    if (answer.status === "value")
      expect(answer.caveat).toMatch(/in-area retail.*not the price at any/);
  });

  it("cites the zero row it refused to read", async () => {
    const answer = await readUnitCost(state.db, {
      snapshotId: state.snapshotId,
      year: 2026,
      plan: plan("001"),
      ndc: "99990000002",
      daysSupply: 30,
      channel: "preferred_retail",
      quantityUnit: "ndc_unit",
    });
    expect(answer).toEqual({
      status: "unknown",
      reason: "unit_cost_unreadable",
      evidence: [
        {
          snapshot_id: state.snapshotId,
          table: "pricing",
          source_row: 4,
          fields: ["UNIT_COST"],
        },
      ],
    });
  });

  it("treats a blank or malformed stored cost as unreadable, never 0", () => {
    for (const unit_cost of [null, "", "-1.0000", "abc"])
      expect(
        pickUnitCost("s", 30, [{ days_supply: 30, unit_cost, source_row: 9 }]),
      ).toMatchObject({ status: "unknown", reason: "unit_cost_unreadable" });
  });

  describe("planted mutants (each must fail a named case)", () => {
    const missingAsZero: Pick = (snapshotId, daysSupply, rows) => {
      const answer = pickUnitCost(snapshotId, daysSupply, rows);
      if (
        answer.status === "unknown" &&
        answer.reason === "unit_cost_not_published"
      )
        return {
          status: "value",
          basis: "cms_plan_average",
          unit_cost: "0.0000",
          ten_thousandths: 0,
          days_supply: daysSupply as 30,
          quantity_basis: "caller_asserted_ndc_units",
          caveat: "",
          evidence: {
            snapshot_id: snapshotId,
            table: "pricing",
            source_row: 0,
            fields: ["UNIT_COST"],
          },
        };
      return answer;
    };
    const nearestDaysSupply: Pick = (snapshotId, daysSupply, rows) => {
      const nearest = [...rows].sort(
        (a, b) =>
          Math.abs(a.days_supply - daysSupply) -
          Math.abs(b.days_supply - daysSupply),
      )[0];
      if (!nearest) return pickUnitCost(snapshotId, daysSupply, rows);
      const answer = pickUnitCost(snapshotId, nearest.days_supply, rows);
      return answer.status === "value"
        ? { ...answer, days_supply: daysSupply as 30 }
        : answer;
    };

    it("a missing price returned as 0 fails", async () => {
      const found = await problems(state.db, state.snapshotId, missingAsZero);
      expect(
        found.some((p) => p.startsWith("60 days where only 30 and 90 exist")),
      ).toBe(true);
      expect(found.some((p) => p.startsWith("NDC without a row"))).toBe(true);
    });
    // The rest of the design's planted mutants for the price reader. Each changes one rule.
    const thirtyDayRow: Pick = (snapshotId, daysSupply, rows) => {
      const answer = pickUnitCost(snapshotId, 30, rows);
      return answer.status === "value"
        ? { ...answer, days_supply: daysSupply as 30 }
        : answer;
    };
    const zeroAsValue: Pick = (snapshotId, daysSupply, rows) => {
      const answer = pickUnitCost(snapshotId, daysSupply, rows);
      const row = rows.find((item) => item.days_supply === daysSupply);
      if (
        answer.status === "value" ||
        row?.unit_cost == null ||
        Number(row.unit_cost) !== 0
      )
        return answer;
      return {
        status: "value",
        basis: "cms_plan_average",
        unit_cost: row.unit_cost!,
        ten_thousandths: 0,
        days_supply: daysSupply as 30,
        quantity_basis: "caller_asserted_ndc_units",
        caveat: "",
        evidence: answer.evidence[0]!,
      };
    };
    const mailFromRetail: typeof readUnitCost = (db, request, ...rest) =>
      readUnitCost(
        db,
        {
          ...request,
          channel: request.channel.endsWith("_mail")
            ? "preferred_retail"
            : request.channel,
        },
        ...rest,
      );
    const anyUnit: typeof readUnitCost = (db, request, ...rest) =>
      readUnitCost(db, { ...request, quantityUnit: "ndc_unit" }, ...rest);
    const releaseYear: typeof readUnitCost = (db, request, ...rest) =>
      readUnitCost(db, { ...request, year: 2026 }, ...rest);
    const anySegment: typeof readUnitCost = (db, request, pick) =>
      readUnitCost(
        db,
        request,
        pick,
        async (session, wanted) =>
          (
            await session.query<UnitCostRow>(
              `SELECT c.days_supply,c.unit_cost::text AS unit_cost,c.source_row
             FROM partd_pricing_release k JOIN partd_plan_unit_cost c ON c.release_key=k.release_key
             WHERE k.snapshot_id=$1 AND c.contract_id=$2 AND c.plan_id=$3 AND c.ndc=$4
             ORDER BY c.days_supply`,
              [
                wanted.snapshotId,
                wanted.plan.contractId,
                wanted.plan.planId,
                wanted.ndc,
              ],
            )
          ).rows,
      );
    const caught = async (
      read: typeof readUnitCost,
      pick: Pick,
      names: string[],
    ) => {
      const found = await problems(state.db, state.snapshotId, pick, read);
      for (const name of names)
        expect(
          found.some((p) => p.startsWith(`${name}:`)),
          name,
        ).toBe(true);
    };

    it("the 30-day unit cost used for a 90-day fill fails", async () => {
      await caught(readUnitCost, thirtyDayRow, [
        "90-day row",
        "60 days on the plan that has only 60",
      ]);
    });
    it("a zero unit cost read as a value fails", async () => {
      await caught(readUnitCost, zeroAsValue, ["zero cost"]);
    });
    it("a mail fill priced from the retail unit cost fails", async () => {
      await caught(mailFromRetail, pickUnitCost, [
        "preferred mail",
        "standard mail",
      ]);
    });
    it("a quantity in another unit multiplied by the unit cost fails", async () => {
      await caught(anyUnit, pickUnitCost, [
        "quantity in millilitres",
        "quantity in packages",
      ]);
    });
    it("2026 pricing answered for a 2027 request fails", async () => {
      await caught(releaseYear, pickUnitCost, [
        "another contract year on the same release",
      ]);
    });
    it("pricing joined across segments fails", async () => {
      await caught(anySegment, pickUnitCost, [
        "30-day row",
        "segment 1 reads its own row",
      ]);
    });
    it("the nearest days supply in place of the exact one fails", async () => {
      const found = await problems(
        state.db,
        state.snapshotId,
        nearestDaysSupply,
      );
      expect(
        found.some((p) => p.startsWith("60 days where only 30 and 90 exist")),
      ).toBe(true);
      expect(
        found.some((p) => p.startsWith("30 days on the plan that has only 60")),
      ).toBe(true);
    });
  });
});

describe("unit cost release checks", () => {
  it("reports a quarterly release imported without pricing as not loaded", async () => {
    const state = await loaded(archive({ pricing: false }), ["plan"]);
    try {
      expect(
        await readUnitCost(state.db, {
          snapshotId: state.snapshotId,
          year: 2026,
          plan: plan("001"),
          ndc: "99990000001",
          daysSupply: 30,
          channel: "preferred_retail",
          quantityUnit: "ndc_unit",
        }),
      ).toEqual({
        status: "unknown",
        reason: "pricing_not_loaded",
        evidence: [],
      });
      expect(
        await readDispensingFeeRanges(state.db, {
          snapshotId: state.snapshotId,
          year: 2026,
          plan: plan("001"),
          daysSupply: 30,
          channel: "preferred_retail",
        }),
      ).toEqual({ status: "unknown", reason: "dispensing_fees_not_loaded" });
    } finally {
      await state.close();
    }
  }, 120_000);

  it("reports a monthly release as having no published pricing for its year", async () => {
    const state = await loaded(
      archive({ pricing: false }),
      ["plan"],
      spufUrl.replace("SPUF_2026_", "2026_"),
    );
    try {
      expect(
        await readUnitCost(state.db, {
          snapshotId: state.snapshotId,
          year: 2026,
          plan: plan("001"),
          ndc: "99990000001",
          daysSupply: 30,
          channel: "preferred_retail",
          quantityUnit: "ndc_unit",
        }),
      ).toMatchObject({ reason: "pricing_not_published_for_year" });
    } finally {
      await state.close();
    }
  }, 120_000);
});

describe("dispensing-fee ranges", () => {
  let state: Awaited<ReturnType<typeof loaded>>;
  beforeAll(async () => {
    state = await loaded(archive(), ["plan", "pricing", "dispensing_fee"]);
  }, 120_000);
  afterAll(async () => {
    await state.close();
  });
  const read = (channel: UnitCostRequest["channel"], daysSupply = 30) =>
    readDispensingFeeRanges(state.db, {
      snapshotId: state.snapshotId,
      year: 2026,
      plan: plan("001"),
      daysSupply,
      channel,
    });

  it("gives in-area lowest and highest fees per type, with `.` counted as missing", async () => {
    const answer = await read("preferred_retail");
    if (answer.status !== "value") throw new Error(JSON.stringify(answer));
    const sha = createHash("sha256")
      .update(
        zip({
          "synthetic.txt": Buffer.from(
            [
              networkHeader,
              "H9000|001|000|101000000001|90001|Y|N|Y|N|1|0|0.3|0.3|0|0.5|0.5|0|.|.|.",
              "H9000|001|000|101000000002|90002|Y|N|Y|N|1|1.5|2.75|2.75|0|.|.|.|1|1|1",
              "H9000|001|000|101000000003|90003|N|N|Y|N|1|0|10.1234|10|10|1|1|1|.|.|.",
              "H9000|001|000|101000000004|90004|Y|N|Y|N|0|0|99|99|99|99|99|99|.|.|.",
              "",
            ].join("\r\n"),
          ),
        }),
      )
      .digest("hex");
    const evidence = {
      snapshot_id: state.snapshotId,
      table: "dispensing_fee",
      source_files: ["pharmacy networks file synthetic part 1.zip"],
      source_sha256: [sha],
      first_source_row: 2,
    };
    // Pharmacy 4 is out of area (fee 99) and pharmacy 3 is standard retail: neither counts here.
    expect(answer.ranges).toEqual([
      {
        fee_type: "brand",
        pharmacies: 2,
        fees_readable: 2,
        fees_missing: 0,
        min_fee: "0.3000",
        max_fee: "2.7500",
        max_floor_price: "1.5000",
        floors_missing: 0,
        evidence,
      },
      {
        fee_type: "generic",
        pharmacies: 2,
        fees_readable: 1,
        fees_missing: 1,
        min_fee: "0.5000",
        max_fee: "0.5000",
        max_floor_price: "1.5000",
        floors_missing: 0,
        evidence,
      },
      {
        fee_type: "selected",
        pharmacies: 2,
        fees_readable: 1,
        fees_missing: 1,
        min_fee: "1.0000",
        max_fee: "1.0000",
        max_floor_price: "1.5000",
        floors_missing: 0,
        evidence,
      },
    ]);
    const standard = await read("standard_retail", 90);
    expect(standard).toMatchObject({
      status: "value",
      ranges: [
        { fee_type: "brand", min_fee: "10.0000", max_fee: "10.0000" },
        { fee_type: "generic", min_fee: "1.0000", max_fee: "1.0000" },
        {
          fee_type: "selected",
          fees_readable: 0,
          min_fee: null,
          max_fee: null,
        },
      ],
    });
  });

  it("is unknown for a channel without in-area pharmacies and for other days supplies", async () => {
    expect(await read("preferred_mail")).toEqual({
      status: "unknown",
      reason: "no_in_area_network_pharmacy",
    });
    expect(await read("preferred_retail", 34)).toEqual({
      status: "unknown",
      reason: "price_days_supply_not_published",
    });
  });
});

describe("unit costs of two releases in one database", () => {
  // A second synthetic quarterly release of the same year: the same plan and NDC at other prices.
  const laterUrl = spufUrl.replace("SPUF_2026_20261007", "SPUF_2026_20270107");
  const laterRows = [
    "H9000|001|000|99990000001|30|7.77", // row 2
    "H9000|001|000|99990000001|90|8.8", // row 3
  ];
  let state: Awaited<ReturnType<typeof loaded>>;
  let laterId: string;
  beforeAll(async () => {
    state = await loaded(archive(), ["plan", "pricing"]);
    laterId = (
      await importInto(
        state.db,
        archive({ pricingRows: laterRows }),
        ["plan", "pricing"],
        laterUrl,
      )
    ).snapshot_id;
  }, 120_000);
  afterAll(async () => {
    await state.close();
  });
  const request = (snapshotId: string, daysSupply = 30): UnitCostRequest => ({
    snapshotId,
    year: 2026,
    plan: plan("001"),
    ndc: "99990000001",
    daysSupply,
    channel: "preferred_retail",
    quantityUnit: "ndc_unit",
  });
  type ReadRows = Parameters<typeof readUnitCost>[3];
  /** Hand-written answers per release; a correct reader returns no problems. */
  async function releaseProblems(readRows?: ReadRows): Promise<string[]> {
    const expected: [string, () => string, number, string, number][] = [
      ["first release, 30 days", () => state.snapshotId, 30, "1.2300", 2],
      ["first release, 90 days", () => state.snapshotId, 90, "1.2000", 3],
      ["later release, 30 days", () => laterId, 30, "7.7700", 2],
      ["later release, 90 days", () => laterId, 90, "8.8000", 3],
    ];
    const out: string[] = [];
    for (const [name, id, days, cost, row] of expected) {
      const answer = await readUnitCost(
        state.db,
        request(id(), days),
        pickUnitCost,
        readRows,
      );
      if (
        answer.status !== "value" ||
        answer.unit_cost !== cost ||
        answer.evidence.snapshot_id !== id() ||
        answer.evidence.source_row !== row
      )
        out.push(`${name}: got ${JSON.stringify(answer)}`);
    }
    return out;
  }

  it("gives each release its own rows", async () => {
    expect(laterId).not.toBe(state.snapshotId);
    expect(await releaseProblems()).toEqual([]);
    const keys = await state.db.query<{ snapshot_id: string; rows: number }>(
      `SELECT k.snapshot_id,count(c.*)::int AS rows FROM partd_pricing_release k
       LEFT JOIN partd_plan_unit_cost c USING(release_key) GROUP BY k.snapshot_id ORDER BY 1`,
    );
    expect(keys.rows).toEqual(
      [
        { snapshot_id: state.snapshotId, rows: pricingRows.length },
        { snapshot_id: laterId, rows: laterRows.length },
      ].sort((a, b) => a.snapshot_id.localeCompare(b.snapshot_id)),
    );
  });

  it("stores each price once, keyed by release, with the quarterly file as its source", async () => {
    const { rows } = await state.db.query<Record<string, unknown>>(
      `SELECT c.sourced_by,c.sourced_slug,c.sourced_at,c.record_policy,s.sha256,s.source_id
       FROM partd_plan_unit_cost c JOIN partd_pricing_release k USING(release_key)
       JOIN snapshot s USING(snapshot_id) WHERE k.snapshot_id=$1 LIMIT 1`,
      [laterId],
    );
    expect(rows[0]).toMatchObject({
      sourced_by: "cms-partd-spuf-quarterly",
      sourced_slug: "partd_pricing_release",
      sourced_at: null,
      record_policy: "source_snapshot",
      source_id: "cms-partd-spuf-quarterly",
    });
    expect(laterId.endsWith(String(rows[0]!.sha256))).toBe(true);
  });

  it("planted mutant: a row query that joins the other release fails", async () => {
    const otherRelease: ReadRows = async (db, wanted) =>
      (
        await db.query<UnitCostRow>(
          `SELECT c.days_supply,c.unit_cost::text AS unit_cost,c.source_row
           FROM partd_pricing_release k JOIN partd_plan_unit_cost c ON c.release_key<>k.release_key
           WHERE k.snapshot_id=$1 AND c.contract_id=$2 AND c.plan_id=$3 AND c.segment_id=$4 AND c.ndc=$5
           ORDER BY c.days_supply`,
          [
            wanted.snapshotId,
            wanted.plan.contractId,
            wanted.plan.planId,
            wanted.plan.segmentId,
            wanted.ndc,
          ],
        )
      ).rows;
    const found = await releaseProblems(otherRelease);
    expect(found.some((p) => p.startsWith("first release, 30 days"))).toBe(
      true,
    );
    expect(found.some((p) => p.startsWith("later release, 90 days"))).toBe(
      true,
    );
  });

  it("reads pricing without a key row as not loaded until it is imported again", async () => {
    const migrations = await coreMigrations();
    const db = testDatabase(new PGlite());
    try {
      await migrate(db, migrations.directory);
      const first = await importInto(db, archive(), ["plan", "pricing"]);
      // A release whose pricing went into the table that migration 1004 replaced.
      await db.exec(
        "DELETE FROM partd_plan_unit_cost; DELETE FROM partd_pricing_release;",
      );
      expect(await readUnitCost(db, request(first.snapshot_id))).toEqual({
        status: "unknown",
        reason: "pricing_not_loaded",
        evidence: [],
      });
      const again = await importInto(db, archive(), ["pricing"]);
      expect(again).toMatchObject({
        snapshot_id: first.snapshot_id,
        outcome: "extended",
      });
      expect(
        (
          await db.query<{ tables: string[] }>(
            "SELECT tables FROM partd_release",
          )
        ).rows[0]!.tables,
      ).toEqual(["plan", "pricing"]);
      expect(await readUnitCost(db, request(first.snapshot_id))).toMatchObject({
        status: "value",
        unit_cost: "1.2300",
      });
    } finally {
      await db.close();
      await migrations.cleanup();
    }
  }, 120_000);
});
