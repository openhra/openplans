import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { lowestAgeBandLcsp } from "../../src/domain/ichra/index.ts";
import {
  householdPremium,
  parseRateRow,
} from "../../src/domain/rating/index.ts";
import {
  allocatePremium,
  lowestCostSilver,
  slcsp,
} from "../../src/domain/subsidy/index.ts";
import { compareLcsp } from "../../scripts/oracle/ichra-logic.mjs";

// SYNTHETIC catalog. Plan IDs, prices and EHB fractions are invented for this test and are not
// source evidence; only the column names follow the CMS Exchange PUF layout.
const STATE = "TX",
  YEAR = 2026,
  COUNTY = "48201",
  OTHER_COUNTY = "48113",
  AREA = "Rating Area 10",
  MONTH = "2026-01-01";
const A = "20069TX0100006",
  B = "29418TX0140049",
  OFF = "87226TX0100013",
  GOLD = "11718TX0140016",
  CHILD = "33602TX0460001",
  ELSEWHERE = "45786TX0010001";
const BOTH = "Allows Adult and Child-Only";
// [plan, variant suffixes, metal, exchange, family offer, EHB fraction, service area, prices by band]
const PLANS = [
  [
    A,
    ["01", "04"],
    "Silver",
    "On the Exchange",
    BOTH,
    "0.9000",
    "TXS001",
    [200, 300, 400, 900],
  ],
  [B, ["01"], "Silver", "Both", BOTH, "1.0000", "TXS002", [210, 310, 390, 890]],
  [
    OFF,
    ["00"],
    "Silver",
    "Off the Exchange",
    BOTH,
    "1.0000",
    "TXS002",
    [50, 100, 100, 100],
  ],
  [
    GOLD,
    ["01"],
    "Gold",
    "On the Exchange",
    BOTH,
    "1.0000",
    "TXS002",
    [50, 100, 100, 100],
  ],
  [
    CHILD,
    ["01"],
    "Silver",
    "On the Exchange",
    "Allows Child-Only",
    "1.0000",
    "TXS002",
    [150, 150, 150, 150],
  ],
  [
    ELSEWHERE,
    ["01"],
    "Silver",
    "On the Exchange",
    BOTH,
    "1.0000",
    "TXS003",
    [60, 120, 120, 120],
  ],
];
const BANDS = ["0-14", "21", "40", "64 and over"];
const RATE_HEADER =
  "BusinessYear,StateCode,IssuerId,SourceName,ImportDate,RateEffectiveDate,RateExpirationDate,PlanId,RatingAreaId,Tobacco,Age,IndividualRate,IndividualTobaccoRate,Couple,PrimarySubscriberAndOneDependent,PrimarySubscriberAndTwoDependents,PrimarySubscriberAndThreeOrMoreDependents,CoupleAndOneDependent,CoupleAndTwoDependents,CoupleAndThreeOrMoreDependents".split(
    ",",
  );

function rateRow(plan, band, dollars, overrides = {}) {
  return {
    ...Object.fromEntries(RATE_HEADER.map((name) => [name, ""])),
    BusinessYear: String(YEAR),
    StateCode: STATE,
    IssuerId: plan.slice(0, 5),
    SourceName: "SYNTHETIC",
    ImportDate: "2025-10-15",
    RateEffectiveDate: MONTH,
    RateExpirationDate: "2026-12-31",
    PlanId: plan,
    RatingAreaId: AREA,
    Tobacco: "No Preference",
    Age: band,
    IndividualRate: dollars.toFixed(2),
    ...overrides,
  };
}
function syntheticRates() {
  const rates = PLANS.flatMap(([plan, , , , , , , prices]) =>
    BANDS.map((band, index) => rateRow(plan, band, prices[index])),
  );
  // Rows the January reading in this rating area must ignore.
  rates.push(rateRow(B, "40", 1, { RatingAreaId: "Rating Area 8" }));
  return rates;
}
function csv(header, records) {
  return [
    header.join(","),
    ...records.map((r) => header.map((name) => r[name]).join(",")),
  ].join("\n");
}
const ATTRIBUTE_HEADER = [
  "BusinessYear",
  "StateCode",
  "IssuerId",
  "MarketCoverage",
  "DentalOnlyPlan",
  "StandardComponentId",
  "ServiceAreaId",
  "MetalLevel",
  "QHPNonQHPTypeId",
  "ChildOnlyOffering",
  "EHBPercentTotalPremium",
  "PlanId",
];
const attributes = PLANS.flatMap(
  ([plan, variants, metal, exchange, offer, fraction, area]) =>
    variants.map((variant) => ({
      BusinessYear: String(YEAR),
      StateCode: STATE,
      IssuerId: plan.slice(0, 5),
      MarketCoverage: "Individual",
      DentalOnlyPlan: "No",
      StandardComponentId: plan,
      ServiceAreaId: area,
      MetalLevel: metal,
      QHPNonQHPTypeId: exchange,
      ChildOnlyOffering: offer,
      EHBPercentTotalPremium: fraction,
      PlanId: `${plan}-${variant}`,
    })),
);
const AREA_HEADER = [
  "BusinessYear",
  "StateCode",
  "IssuerId",
  "ServiceAreaId",
  "CoverEntireState",
  "County",
  "PartialCounty",
  "MarketCoverage",
  "DentalOnlyPlan",
];
const AREA_COUNTY = { TXS001: COUNTY, TXS002: "", TXS003: OTHER_COUNTY };
const serviceAreas = PLANS.map(([plan, , , , , , area]) => ({
  BusinessYear: String(YEAR),
  StateCode: STATE,
  IssuerId: plan.slice(0, 5),
  ServiceAreaId: area,
  CoverEntireState: area === "TXS002" ? "Yes" : "No",
  County: AREA_COUNTY[area],
  PartialCounty: area === "TXS002" ? "" : "No",
  MarketCoverage: "Individual",
  DentalOnlyPlan: "No",
}));

const CASES = [
  { county: COUNTY, rating_area: AREA, month: MONTH, age: 40 },
  {
    county: COUNTY,
    rating_area: AREA,
    month: MONTH,
    age: 40,
    identification_age: 21,
  },
  { county: COUNTY, rating_area: AREA, month: MONTH, age: 64 },
  { county: COUNTY, rating_area: AREA, month: MONTH, age: 10 },
];
// Hand-listed from the SYNTHETIC catalog above: the silver Exchange plans offered in COUNTY.
const OFFERED = { adult: [A, B], child: [A, B, CHILD] };

let directory;
/** `ehb` replaces EHBPercentTotalPremium for some plans; `script` runs another copy of the reading. */
async function reference(
  rates,
  cases = CASES,
  { ehb = {}, script = "scripts/oracle/ichra-reference.py" } = {},
) {
  const path = (name) => join(directory, name);
  await writeFile(
    path("plan-attributes.csv"),
    csv(
      ATTRIBUTE_HEADER,
      attributes.map((row) =>
        row.StandardComponentId in ehb
          ? { ...row, EHBPercentTotalPremium: ehb[row.StandardComponentId] }
          : row,
      ),
    ),
  );
  await writeFile(path("service-area.csv"), csv(AREA_HEADER, serviceAreas));
  await writeFile(path("rate.csv"), csv(RATE_HEADER, rates));
  await writeFile(
    path("cases.json"),
    JSON.stringify({ state: STATE, year: YEAR, cases }),
  );
  const result = spawnSync(
    "python3",
    [
      "-B",
      script,
      ...["plan-attributes", "service-area", "rate"].flatMap((kind) => [
        `--${kind}`,
        path(`${kind}.csv`),
      ]),
      "--cases",
      path("cases.json"),
      "--output",
      path("out.json"),
    ],
    { encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(await readFile(path("out.json"), "utf8")).cases;
}

function employee(age) {
  return {
    coverageStartDate: MONTH,
    ratingMethod: "per_member",
    benchmarkScope: "single_location_single_policy",
    members: [{ id: "0", age, relationship: "subscriber", tobaccoUse: false }],
  };
}
/** The application's ranking over the same rows; `rank` lets a control swap the pick. */
function application(
  rates,
  { rank = lowestCostSilver, swapBases = false, ehb = {} } = {},
) {
  const parsed = rates.map((raw, index) =>
    parseRateRow(raw, {
      snapshotId: "synthetic-ichra-oracle-test",
      sourceFile: "synthetic.csv",
      sourceRowNumber: index + 2,
    }),
  );
  const fractions = new Map(
    PLANS.map(([plan, , , , , fraction]) => [plan, ehb[plan] ?? fraction]),
  );
  const candidates = (plans, age, basis) =>
    plans.map((planId) => {
      const premium = householdPremium(parsed, planId, AREA, employee(age));
      const totalCents =
        basis === "gross"
          ? premium.totalCents
          : allocatePremium(premium.totalCents, fractions.get(planId));
      return {
        planId,
        metalLevel: "Silver",
        onExchange: true,
        availableToHousehold: true,
        benchmarkBasis: "lcsp_self_only_premium",
        premium: { ...premium, totalCents },
      };
    });
  return CASES.map((item) => {
    const plans = item.age >= 21 ? OFFERED.adult : OFFERED.child;
    const identification = item.identification_age ?? item.age;
    const answer = (basis) => {
      // As the ICHRA service does: one unreadable EHB fraction leaves the EHB basis unknown.
      if (
        basis === "ehb_portion" &&
        plans.some((plan) => allocatePremium(100, fractions.get(plan)) === null)
      )
        return {
          status: "requires_premium_adjustments",
          plan_ids: [],
          monthly_cents: null,
          prices_at_age: [],
        };
      const atAge = candidates(plans, item.age, basis);
      if (identification === item.age) {
        const result = rank(atAge, employee(item.age));
        const cents = result.lcspMonthlyCents ?? result.slcspMonthlyCents;
        return {
          status: result.status,
          plan_ids: result.planIds,
          monthly_cents: cents,
          prices_at_age: [cents],
        };
      }
      const result = lowestAgeBandLcsp(
        candidates(plans, identification, basis),
        employee(identification),
        atAge,
        employee(item.age),
      );
      return {
        status: result.status,
        plan_ids: result.planIds,
        monthly_cents: result.lcspMonthlyCents,
        prices_at_age: result.pricesAtAge,
      };
    };
    const bases = {
      gross: answer("gross"),
      ehb_portion: answer("ehb_portion"),
    };
    return {
      ...item,
      bases: swapBases
        ? { gross: bases.ehb_portion, ehb_portion: bases.gross }
        : bases,
    };
  });
}

describe("lowest cost silver plan from raw files (SYNTHETIC catalog)", () => {
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "ichra-oracle-"));
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("reads the hand-worked answers from the raw rows", async () => {
    const [direct, lowestBand, oldest, child] =
      await reference(syntheticRates());
    // Age 40: B files 390.00, A files 400.00 with 90% EHB (360.00).
    expect(direct.bases.gross).toMatchObject({
      plan_ids: [B],
      monthly_cents: 39000,
    });
    expect(direct.bases.ehb_portion).toMatchObject({
      plan_ids: [A],
      monthly_cents: 36000,
    });
    expect(direct.silver_plan_count).toBe(2);
    // Identified at 21 (A 300.00 against B 310.00), priced at 40.
    expect(lowestBand.bases.gross).toMatchObject({
      plan_ids: [A],
      monthly_cents: 40000,
    });
    expect(oldest.bases.gross).toMatchObject({
      plan_ids: [B],
      monthly_cents: 89000,
    });
    // A child may take the child-only plan; adults above never see it.
    expect(child.bases.gross).toMatchObject({
      plan_ids: [CHILD],
      monthly_cents: 15000,
    });
    expect(child.silver_plan_count).toBe(3);
  });

  it("agrees with the application ranking on both bases", async () => {
    const rates = syntheticRates();
    expect(compareLcsp(await reference(rates), application(rates))).toEqual([]);
  });

  it("refuses instead of guessing", async () => {
    const rates = syntheticRates();
    const [empty] = await reference(rates, [
      { county: "48999", rating_area: AREA, month: MONTH, age: 70 },
    ]);
    // Only the statewide plans reach this county; both admit adults.
    expect(empty.bases.gross.plan_ids).toEqual([B]);
    const missing = rates.filter((r) => !(r.PlanId === A && r.Age === "40"));
    const [incomplete] = await reference(missing, [CASES[0]]);
    expect(incomplete.bases.gross).toMatchObject({
      status: "incomplete_lcsp",
      monthly_cents: null,
    });
    const [none] = await reference(rates, [
      { county: COUNTY, rating_area: "Rating Area 99", month: MONTH, age: 40 },
    ]);
    expect(none.bases.gross.status).toBe("incomplete_lcsp");
  });

  it("leaves the EHB portion unknown past 15 places or outside 0 through 1", async () => {
    const rates = syntheticRates();
    for (const fraction of [
      "0.9000000000000001",
      "1.0000000000000000",
      "1.01",
      "-0.9",
      "90%",
    ]) {
      const ehb = { [A]: fraction };
      const answers = await reference(rates, CASES, { ehb });
      for (const answer of answers) {
        expect(answer.bases.ehb_portion, fraction).toMatchObject({
          status: "requires_premium_adjustments",
          reason: `${A}: ehb_allocation_unknown`,
          monthly_cents: null,
        });
        expect(answer.bases.gross.status).toBe("calculated");
      }
      expect(compareLcsp(answers, application(rates, { ehb }))).toEqual([]);
    }
    // Fifteen places is still a filed fraction: A files 400.00 at 90%.
    const ehb = { [A]: "0.900000000000001" };
    const [direct] = await reference(rates, [CASES[0]], { ehb });
    expect(direct.bases.ehb_portion).toMatchObject({
      status: "calculated",
      plan_ids: [A],
      monthly_cents: 36000,
    });
    expect(
      compareLcsp(
        await reference(rates, CASES, { ehb }),
        application(rates, { ehb }),
      ),
    ).toEqual([]);
  });

  describe("planted defects must be caught", () => {
    it("a reading that accepts a 16-place EHB fraction", async () => {
      const source = await readFile(
        "scripts/oracle/ichra-reference.py",
        "utf8",
      );
      const strict = String.raw`0(?:\.\d{1,15})?|1(?:\.0{1,15})?`;
      expect(source).toContain(strict);
      const script = join(directory, "ichra-reference-16.py");
      await writeFile(
        script,
        source.replace(strict, String.raw`0(?:\.\d{1,16})?|1(?:\.0{1,16})?`),
      );
      const rates = syntheticRates();
      const ehb = { [A]: "0.9000000000000001" };
      const mutant = await reference(rates, CASES, { ehb, script });
      expect(mutant[0].bases.ehb_portion.status).toBe("calculated");
      const differences = compareLcsp(mutant, application(rates, { ehb }));
      expect(differences.join("\n")).toContain(
        "ehb_portion: status requires_premium_adjustments, raw files give calculated",
      );
    });
    it("one cent on one rate row", async () => {
      const rates = syntheticRates();
      const expected = await reference(rates);
      const mutant = rates.map((r) =>
        r.PlanId === B && r.Age === "40" && r.RatingAreaId === AREA
          ? { ...r, IndividualRate: "390.01" }
          : r,
      );
      expect(compareLcsp(expected, application(mutant))).not.toEqual([]);
    });
    it("the second lowest silver plan in place of the lowest", async () => {
      const rates = syntheticRates();
      const differences = compareLcsp(
        await reference(rates),
        application(rates, { rank: slcsp }),
      );
      expect(differences.join("\n")).toContain("raw files give 39000");
    });
    it("the two premium bases swapped", async () => {
      const rates = syntheticRates();
      const differences = compareLcsp(
        await reference(rates),
        application(rates, { swapBases: true }),
      );
      expect(differences.some((line) => line.includes("gross"))).toBe(true);
      expect(differences.some((line) => line.includes("ehb_portion"))).toBe(
        true,
      );
    });
    it("a case answered by only one side", async () => {
      const rates = syntheticRates();
      const expected = await reference(rates);
      expect(compareLcsp(expected, application(rates).slice(1))).not.toEqual(
        [],
      );
      expect(compareLcsp(expected.slice(1), application(rates))).not.toEqual(
        [],
      );
    });
  });
});
