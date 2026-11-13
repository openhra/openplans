import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { zip } from "../ingest/medicare/helpers.ts";
import {
  compareApplicationAnswers,
  comparePriceAnswers,
  countApplicationAnswers,
  countPriceAnswers,
} from "../../scripts/oracle/medicare-part-d-price-logic.mjs";

// SYNTHETIC mini-archive. Contract IDs, NDCs, unit costs, fees and cost sharing are invented for
// this test and are not source evidence; only the member names and column headers follow the CMS
// Part D SPUF record layout.
const SCRIPT = "scripts/oracle/medicare-part-d-price-reference.py";
const P1 = "S9001-001-0",
  P2 = "S9002-001-0",
  P3 = "S9003-001-0";
const [A, B, C, D, E, F, G] = [1, 2, 3, 4, 5, 6, 7].map(
  (n) => `9000000000${n}`,
);

const table = (head, rows) =>
  Buffer.from([head, ...rows].map((r) => r.join("|")).join("\r\n") + "\r\n");
const PLAN = [
  ["CONTRACT_ID", "PLAN_ID", "SEGMENT_ID", "CONTRACT_NAME", "PLAN_NAME"],
  ["FORMULARY_ID", "PREMIUM", "DEDUCTIBLE", "MA_REGION_CODE"],
  ["PDP_REGION_CODE", "STATE", "COUNTY_CODE", "SNP", "PLAN_SUPPRESSED_YN"],
].flat();
const plan = (contract, suppressed) => [
  ...[contract, "001", "000", "Synthetic", "Synthetic plan", "F0000001"],
  ...["10.00", "0", " ", "01", "TX", "48201", "0", suppressed],
];
const FORMULARY = [
  ["FORMULARY_ID", "FORMULARY_VERSION", "CONTRACT_YEAR", "RXCUI", "NDC"],
  ["TIER_LEVEL_VALUE", "QUANTITY_LIMIT_YN", "QUANTITY_LIMIT_AMOUNT"],
  ["QUANTITY_LIMIT_DAYS", "PRIOR_AUTHORIZATION_YN", "STEP_THERAPY_YN"],
  ["SELECTED_DRUG_YN"],
].flat();
const drug = (ndc, tier, selected = "N") => [
  ...["F0000001", "1", "2026", `1${ndc.slice(-3)}`, ndc, tier],
  ...["N", " ", " ", "N", "N", selected],
];
const CHANNEL_SUFFIXES = ["PREF", "NONPREF", "MAIL_PREF", "MAIL_NONPREF"];
const COST = [
  ...["CONTRACT_ID", "PLAN_ID", "SEGMENT_ID", "COVERAGE_LEVEL", "TIER"],
  "DAYS_SUPPLY",
  ...CHANNEL_SUFFIXES.flatMap((s) =>
    ["COST_TYPE", "COST_AMT", "COST_MIN_AMT", "COST_MAX_AMT"].map(
      (f) => `${f}_${s}`,
    ),
  ),
  "TIER_SPECIALTY_YN",
  "DED_APPLIES_YN",
];
// Each channel is [type, amount]; bounds are 0 (none).
const cost = (contract, level, tier, supply, channels) => [
  ...[contract, "001", "000", level, tier, supply],
  ...channels.flatMap(([type, amount]) => [type, amount, "0", "0"]),
  "N",
  "N",
];
const copays = (pref, nonpref) => [
  ["1", pref],
  ["1", nonpref],
  ["1", "0"],
  ["0", "0"],
];
const coins = (rate) => [
  ["2", rate],
  ["2", rate],
  ["2", rate],
  ["0", "0"],
];
const costRows = (contract) => [
  cost(contract, "1", "1", "1", copays("5.00", "10.00")),
  cost(contract, "1", "1", "2", copays("15.00", "30.00")),
  cost(contract, "1", "1", "4", copays("10.00", "20.00")),
  // The deductible phase must not be read for initial coverage.
  cost(contract, "0", "1", "1", copays("99.00", "99.00")),
  cost(contract, "1", "2", "1", copays("2.00", "2.00")),
  cost(contract, "1", "3", "1", coins(".25")),
  cost(contract, "1", "3", "2", coins(".25")),
  cost(contract, "1", "4", "1", copays("47.00", "47.00")),
];
const PRICING = [
  "CONTRACT_ID",
  "PLAN_ID",
  "SEGMENT_ID",
  "NDC",
  "DAYS_SUPPLY",
].concat("UNIT_COST");
const price = (contract, ndc, days, unit) => [
  ...[contract, "001", "000", ndc, days, unit],
];
const NETWORK = [
  ...["CONTRACT_ID", "PLAN_ID", "SEGMENT_ID", "PHARMACY_NUMBER"],
  ...["PHARMACY_ZIPCODE", "PREFERRED_STATUS_RETAIL", "PREFERRED_STATUS_MAIL"],
  ...["PHARMACY_RETAIL", "PHARMACY_MAIL", "IN_AREA_FLAG", "FLOOR_PRICE"],
  ...["BRAND", "GENERIC", "SELECTED"].flatMap((t) =>
    [30, 60, 90].map((d) => `${t}_DISPENSING_FEE_${d}`),
  ),
];
// fees: [brand 30/60/90, generic 30/60/90, selected 30/60/90]
const pharmacy = (contract, n, preferred, retail, inArea, floor, fees) => [
  ...[contract, "001", "000", `10100000000${n}`, "77001", preferred, "N"],
  ...[retail, retail === "Y" ? "N" : "Y", inArea, floor, ...fees],
];
const NONE = [".", ".", "."];

function archiveBytes() {
  const inner = (name, bytes) => zip({ [`${name}.txt`]: bytes });
  const members = {
    "plan information  PPUF_2026Q3": table(PLAN, [
      plan("S9001", "N"),
      plan("S9001", "N"),
      plan("S9002", "Y"),
      plan("S9003", "N"),
    ]),
    "basic drugs formulary file  PPUF_2026Q3": table(FORMULARY, [
      drug(A, "1"),
      drug(B, "3"),
      drug(C, "4", "Y"),
      drug(D, "2"),
      drug(E, "1"),
      drug(F, "1"),
      drug(G, "1", "Y"),
    ]),
    "beneficiary cost file  PPUF_2026Q3": table(COST, [
      ...costRows("S9001"),
      ...costRows("S9003"),
    ]),
    "pricing file PPUF_2026Q3": table(PRICING, [
      price("S9001", A, "30", "0.5000"),
      price("S9001", A, "90", "0.4500"),
      price("S9001", B, "30", "12.3456"),
      price("S9001", B, "60", "12.0000"),
      price("S9001", B, "90", "11.5000"),
      price("S9001", C, "30", "100.0000"),
      price("S9001", E, "30", "0"),
      price("S9001", F, "30", "0.1000"),
      price("S9001", G, "30", "1.0000"),
      price("S9002", A, "30", "0.5000"),
      price("S9003", A, "30", "0.5000"),
    ]),
    "pharmacy networks file  PPUF_2026Q3 part 1": table(NETWORK, [
      pharmacy("S9001", 1, "Y", "Y", "1", "0", [
        ...["2.00", "2.00", "3.00"],
        ...["1.00", "1.00", "1.50"],
        ...NONE,
      ]),
      pharmacy("S9001", 2, "Y", "Y", "1", "0", [
        ...["2.50", "2.50", "3.50"],
        ...["0.50", "0.50", "1.00"],
        ...["4.00", ".", "."],
      ]),
      pharmacy("S9001", 3, "N", "Y", "1", "0", [...NONE, ...NONE, ...NONE]),
    ]),
    "pharmacy networks file  PPUF_2026Q3 part 2": table(NETWORK, [
      // Out of the service area, and mail only: neither counts for the retail fee range.
      pharmacy("S9001", 4, "Y", "Y", "0", "0", Array(9).fill("99.00")),
      pharmacy("S9001", 5, "Y", "N", "1", "0", Array(9).fill("99.00")),
      pharmacy("S9003", 6, "Y", "Y", "1", "20.00", Array(9).fill("1.00")),
    ]),
  };
  return zip(
    Object.fromEntries(
      Object.entries(members).map(([name, bytes]) => [
        `${name}.zip`,
        inner(name, bytes),
      ]),
    ),
  );
}

// SYNTHETIC maximum fair price file in the CMS column layout. C has a 2026 price (79.995 per unit
// rounds to $80.00 for one unit) and a 2027 one; A, which the formulary does not flag as selected,
// has a price too; G's only row is a deselection (it ends before it starts) and never applies.
const MFP_HEADER = [
  ...[
    "IPAY",
    "Selected Drug Name",
    "Active Ingredient Name or Active Moiety Name",
  ],
  ...["NDC-9", "NDC-11", "XREF NDC-11", "HCPCS Code", "MFP Effective Date"],
  ...["MFP End Date", "Single MFP per 30 DES", "NDC-9 MFP per Unit Price"],
  ...["HCPCS Code Dosage Price", "As of Date", "Type of Update", "Remarks"],
];
const mfpRow = (ndc, from, to, unit) => [
  ...[
    "2026",
    "SYNTHETIC",
    "SYNTHETIC",
    `${ndc.slice(0, 5)}-${ndc.slice(5, 9)}`,
  ],
  ...[
    `${ndc.slice(0, 5)}-${ndc.slice(5, 9)}-${ndc.slice(9)}`,
    "",
    "",
    from,
    to,
  ],
  ...["$1.00", unit, "", "01/01/2026", "Synthetic", "Synthetic"],
];
const mfpBytes = () =>
  zip({
    "synthetic_mfp.csv": Buffer.from(
      [
        MFP_HEADER,
        mfpRow(C, "01/01/2026", "12/31/2026", "$79.995000"),
        mfpRow(C, "01/01/2027", "", "$1,000.000000"),
        mfpRow(A, "01/01/2026", "", "$0.400000"),
        mfpRow(G, "01/01/2027", "12/31/2026", "$2.000000"),
      ]
        .map((r) => r.join(","))
        .join("\r\n") + "\r\n",
    ),
  });

const fill = (id, planKey, ndc, days, channel, extra = {}) => ({
  case_id: id,
  contract_year: 2026,
  plan_key: planKey,
  ndc,
  days_supply: days,
  quantity: String(days),
  unit: "ndc_unit",
  channel,
  phase: "initial_coverage",
  classification: { insulin: false, acip_vaccine: false },
  ...extra,
});
const CASES = [
  fill("copay", P1, A, 30, "preferred_retail"),
  fill("no-fee", P1, A, 90, "standard_retail"),
  fill("no-60", P1, A, 60, "preferred_retail"),
  fill("coinsurance", P1, B, 30, "preferred_retail", { quantity: "10" }),
  fill("selected", P1, C, 30, "preferred_retail", { quantity: "1" }),
  fill("unpriced", P1, D, 30, "preferred_retail"),
  fill("zero-cost", P1, E, 30, "preferred_retail"),
  fill("mail", P1, A, 30, "preferred_mail"),
  fill("suppressed", P2, A, 30, "preferred_retail"),
  fill("45-days", P1, A, 45, "preferred_retail"),
  fill("millilitres", P1, A, 30, "preferred_retail", { unit: "mL" }),
  fill("catastrophic", P1, A, 30, "preferred_retail", {
    phase: "catastrophic",
  }),
  fill("off-formulary", P1, "90000000099", 30, "preferred_retail"),
  fill("cap", P1, F, 30, "preferred_retail"),
  fill("threshold", P1, B, 90, "preferred_retail", { quantity: "1000" }),
  fill("floor", P3, A, 30, "preferred_retail"),
  fill("selected-no-mfp", P1, G, 30, "preferred_retail"),
];

const v = (cents) => ({ status: "value", cents });
const u = (reason) => ({ status: "unknown", reason });
const all = (reason) => ({
  unit_cost_total: u(reason),
  total_lowest_fee: u(reason),
  total_highest_fee: u(reason),
  gross: u(reason),
  member_cost: u(reason),
  maximum_fair_price_total: u(reason),
});
const NOT_SELECTED = { maximum_fair_price_total: u("drug_not_selected") };
const NO_MFP = u("maximum_fair_price_not_in_effect");
const FEE = u("dispensing_fee_unknown");
// Worked by hand from the synthetic rows above, independently of the script.
const EXPECTED = [
  // 0.5 x 30 = 15.00; brand or generic 30-day fees at preferred pharmacies 1 and 2: 0.50 to 2.50.
  ["copay", { ...prices(1500, 1550, 1750), member_cost: v(500) }],
  // 0.45 x 90 = 40.50; no readable standard fee, but $30 is under 90% of any gross above R0.
  ["no-fee", { ...prices(4050, FEE, FEE), member_cost: v(3000) }],
  ["no-60", all("price_days_supply_not_published")],
  // 12.3456 x 10 = 123.456; 25% of 123.46, 123.96 and 125.96 differ.
  ["coinsurance", { ...prices(12346, 12396, 12596), member_cost: FEE }],
  // Selected drug: the $80.00 maximum fair price replaces the $100.00 unit cost; selected fee
  // 4.00, or the brand fee 2.00 where the selected fee is missing. The $47 copay holds.
  [
    "selected",
    {
      ...prices(10000, 8200, 8400),
      member_cost: v(4700),
      maximum_fair_price_total: v(8000),
    },
  ],
  ["unpriced", all("price_days_supply_not_published")],
  ["zero-cost", all("unit_cost_unreadable")],
  ["mail", all("unit_cost_retail_only")],
  ["suppressed", all("plan_suppressed_by_cms")],
  ["45-days", all("price_days_supply_not_published")],
  ["millilitres", all("quantity_unit_not_ndc_unit")],
  [
    "catastrophic",
    { ...prices(1500, 1550, 1750), member_cost: u("phase_not_supported") },
  ],
  ["off-formulary", all("proxy_ndc_not_on_formulary")],
  // Flagged selected with no maximum fair price in effect: only the unit cost total is known.
  [
    "selected-no-mfp",
    {
      unit_cost_total: v(3000),
      total_lowest_fee: NO_MFP,
      total_highest_fee: NO_MFP,
      gross: NO_MFP,
      member_cost: NO_MFP,
      maximum_fair_price_total: NO_MFP,
    },
  ],
  // 0.1 x 30 = 3.00 is below the $5 copay, so the enrollee pays more than 90% of the price.
  ["cap", { ...prices(300, 350, 550), member_cost: u("subsidy_cap_may_bind") }],
  // 11.5 x 1000 = 11,500.00; 25% is more than the $2,100 threshold.
  [
    "threshold",
    {
      ...prices(1150000, 1150100, 1150350),
      member_cost: u("crosses_out_of_pocket_threshold"),
    },
  ],
  // A $20 floor above the $15 price: the gross is open, the $5 copay holds.
  [
    "floor",
    {
      ...prices(1500, 1600, 1600),
      gross: u("floor_price_may_apply"),
      member_cost: v(500),
    },
  ],
].map(([case_id, figures]) => ({ case_id, figures }));

function prices(r0, low, high) {
  const figure = (x) => (typeof x === "number" ? v(x) : x);
  return {
    unit_cost_total: v(r0),
    total_lowest_fee: figure(low),
    total_highest_fee: figure(high),
    gross: FEE,
    ...NOT_SELECTED,
  };
}

let directory, archive, mfpFile;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "partd-price-oracle-"));
  archive = join(directory, "SPUF_synthetic.zip");
  await writeFile(archive, archiveBytes());
  mfpFile = join(directory, "mfp_synthetic.zip");
  await writeFile(mfpFile, mfpBytes());
  await writeFile(
    join(directory, "cases.json"),
    JSON.stringify({ cases: CASES }),
  );
});
afterAll(() => rm(directory, { recursive: true, force: true }));

async function reference(script = SCRIPT) {
  const output = join(directory, "out.json");
  const result = spawnSync(
    "python3",
    [
      "-I",
      script,
      archive,
      "--cases",
      join(directory, "cases.json"),
      "--output",
      output,
      "--mfp-file",
      mfpFile,
    ],
    { encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(await readFile(output, "utf8"));
}

async function mutant(name, replacements) {
  let source = await readFile(SCRIPT, "utf8");
  for (const [from, to] of replacements) {
    expect(source.split(from).length, `${name}: ${from}`).toBe(2);
    source = source.replace(from, to);
  }
  const script = join(directory, `${name}.py`);
  await writeFile(script, source);
  return (await reference(script)).answers;
}

describe("Part D plan-average price reference (synthetic archive)", () => {
  it("matches the hand-worked answers", async () => {
    const { answers, counts } = await reference();
    expect(comparePriceAnswers(EXPECTED, answers)).toEqual([]);
    expect(counts).toEqual(countPriceAnswers(EXPECTED));
  });

  it("cites the pricing row and the fee range it used", async () => {
    const { answers } = await reference();
    const copay = answers.find((a) => a.case_id === "copay");
    expect(copay.evidence.pricing).toEqual([
      { member: "pricing file PPUF_2026Q3.txt", row: 1, unit_cost: "0.5000" },
    ]);
    expect(copay.evidence.fees).toMatchObject({
      pharmacies: 2,
      readable: 4,
      min: "0.50",
      max: "2.50",
    });
    expect(copay.readings).toEqual({
      r0: "15.0000",
      low: "15.5000",
      high: "17.5000",
    });
  });

  it("a comparison catches a wrong cent, a wrong reason and a missing case", () => {
    const wrong = structuredClone(EXPECTED);
    wrong[0].figures.member_cost = v(501);
    wrong[2].figures.gross = u("pricing_not_loaded");
    wrong.pop();
    expect(comparePriceAnswers(EXPECTED, wrong)).toEqual([
      "copay member_cost: application gives value 501, raw files give value 500",
      "no-60 gross: application gives unknown pricing_not_loaded, raw files give unknown price_days_supply_not_published",
      "floor: the application gave no answer",
    ]);
  });

  it("matches bounded application answers only at the reference's own ends", async () => {
    const { answers } = await reference();
    const coinsurance = answers.find((a) => a.case_id === "coinsurance");
    expect(coinsurance.evidence.member_charges).toEqual({
      r0: 3087,
      low: 3099,
      high: 3149,
    });
    const bounded = (low, high) => ({
      status: "bounded",
      minimum_cents: low,
      maximum_cents: high,
      reason: "dispensing_fee_unknown",
    });
    const application = structuredClone(EXPECTED).map((item) =>
      item.case_id === "coinsurance"
        ? {
            ...item,
            figures: {
              ...item.figures,
              gross: bounded(12396, 12596),
              member_cost: bounded(3099, 3149),
            },
          }
        : item,
    );
    const ok = compareApplicationAnswers(answers, application);
    expect(ok.differences).toEqual([]);
    expect(ok.notCompared).toEqual([
      "catastrophic member_cost: reference phase_not_supported, application unknown phase_not_supported",
      "cap member_cost: reference subsidy_cap_may_bind, application unknown subsidy_cap_may_bind",
      "threshold member_cost: reference crosses_out_of_pocket_threshold, application unknown crosses_out_of_pocket_threshold",
    ]);
    expect(countApplicationAnswers(application).gross.bounded).toBe(1);

    const wrong = structuredClone(application);
    const at = wrong.find((item) => item.case_id === "coinsurance").figures;
    at.gross = bounded(12346, 12596); // the unit cost alone as the lower end
    at.member_cost = bounded(3149, 3099); // swapped
    const copay = wrong.find((item) => item.case_id === "copay").figures;
    copay.member_cost = bounded(500, 500); // the reference settles a value
    expect(compareApplicationAnswers(answers, wrong).differences).toEqual([
      "copay member_cost: application gives bounded 500..500, raw files give value 500",
      "coinsurance gross: application gives bounded 12346..12596, raw files give unknown dispensing_fee_unknown",
      "coinsurance member_cost: application gives bounded 3149..3099, raw files give unknown dispensing_fee_unknown",
    ]);
  });

  it("leaves a member cost uncompared only when the reference lost the price", async () => {
    const LOGIC = "scripts/oracle/medicare-part-d-price-logic.mjs";
    const answer = (figures, id) =>
      figures.find((item) => item.case_id === id).figures;
    const application = structuredClone(EXPECTED);
    // No unit cost, and a selected drug with no maximum fair price in effect. The application
    // names its cost-sharing reason instead.
    answer(application, "unpriced").member_cost = u("cost_row_missing");
    answer(application, "selected-no-mfp").member_cost = u(
      "channel_not_offered",
    );
    const ok = compareApplicationAnswers(EXPECTED, application);
    expect(ok.differences).toEqual([]);
    expect(ok.notCompared.filter((line) => line.includes("no price"))).toEqual([
      "unpriced member_cost: no price (price_days_supply_not_published), application cost_row_missing",
      "selected-no-mfp member_cost: no price (maximum_fair_price_not_in_effect), application channel_not_offered",
    ]);

    // Member-cost differences the price does not explain still fail.
    const wrong = structuredClone(application);
    answer(wrong, "selected-no-mfp").member_cost = v(4700);
    answer(wrong, "coinsurance").member_cost = u("channel_not_offered");
    answer(wrong, "copay").member_cost = u("cost_row_missing");
    const reference = structuredClone(EXPECTED);
    answer(reference, "selected").member_cost = u("cost_sharing_row_missing");
    answer(wrong, "selected").member_cost = u("channel_not_offered");
    const caught = [
      "copay member_cost: application gives unknown cost_row_missing, raw files give value 500",
      "coinsurance member_cost: application gives unknown channel_not_offered, raw files give unknown dispensing_fee_unknown",
      "selected member_cost: application gives unknown channel_not_offered, raw files give unknown cost_sharing_row_missing",
      "selected-no-mfp member_cost: application gives value 4700, raw files give unknown maximum_fair_price_not_in_effect",
    ];
    expect(compareApplicationAnswers(reference, wrong).differences).toEqual(
      caught,
    );

    // A planted mutant that takes any unknown gross as a lost price hides the fee-caused difference.
    const source = await readFile(LOGIC, "utf8");
    const from = "priceLostAt(want) === b.reason";
    expect(source.split(from).length).toBe(2);
    const loose = join(directory, "price-logic-any-gross.mjs");
    await writeFile(
      loose,
      source.replace(from, 'want.figures.gross?.status === "unknown"'),
    );
    const mutantCompare = (await import(loose)).compareApplicationAnswers;
    expect(mutantCompare(reference, wrong).differences).not.toEqual(caught);
  });

  describe("planted mutants must be caught", () => {
    it("a missing price treated as $0", async () => {
      const answers = await mutant("missing-price-zero", [
        [
          'if price is None:\n        return None, "price_days_supply_not_published"',
          'if price is None:\n        price = [{"member": None, "row": None, "unit_cost": "0"}]',
        ],
        [
          'if unit_cost is None or unit_cost <= 0:\n        return None, "unit_cost_unreadable"',
          "if unit_cost is None:\n        unit_cost = Decimal(0)",
        ],
      ]);
      const differences = comparePriceAnswers(EXPECTED, answers).join("\n");
      expect(differences).toContain(
        "unpriced unit_cost_total: application gives value 0, raw files give unknown price_days_supply_not_published",
      );
      expect(differences).toContain("zero-cost unit_cost_total");
    });

    it("the nearest days supply in place of the fill's own", async () => {
      const answers = await mutant("nearest-days-supply", [
        [
          "price = prices.get(days)",
          "price = prices.get(min(prices, key=lambda d: abs(d - days))) if prices else None",
        ],
      ]);
      expect(comparePriceAnswers(EXPECTED, answers).join("\n")).toContain(
        "no-60 unit_cost_total: application gives value",
      );
    });

    it("the dispensing fee ignored", async () => {
      const answers = await mutant("fee-ignored", [
        [
          "        return readings, None\n    if fee and",
          '        return {"r0": r0, "mfp": mfp, "low": mfp, "high": mfp}, None\n    if fee and',
        ],
        [
          "    return readings, None\n\n\ndef disagreement",
          '    return {"r0": r0}, None\n\n\ndef disagreement',
        ],
      ]);
      const differences = comparePriceAnswers(EXPECTED, answers).join("\n");
      expect(differences).toContain(
        "coinsurance gross: application gives value 12346, raw files give unknown dispensing_fee_unknown",
      );
      expect(differences).toContain(
        "coinsurance member_cost: application gives value 3087",
      );
      expect(differences).toContain(
        "selected gross: application gives value 8000, raw files give unknown dispensing_fee_unknown",
      );
    });

    it("the plan-average unit cost used for a selected drug", async () => {
      const answers = await mutant("plan-average-for-selected", [
        ["mfp = Decimal(cents(price * quantity)) * CENT", "mfp = r0"],
      ]);
      const differences = comparePriceAnswers(EXPECTED, answers).join("\n");
      expect(differences).toContain(
        "selected total_lowest_fee: application gives value 10200, raw files give value 8200",
      );
      expect(differences).toContain(
        "selected maximum_fair_price_total: application gives value 10000, raw files give value 8000",
      );
    });

    it("a maximum fair price used for a drug that is not selected", async () => {
      const answers = await mutant("mfp-for-not-selected", [
        [
          "    if selected:\n        # The maximum fair price replaces",
          "    if True:\n        # The maximum fair price replaces",
        ],
        [
          "    if selected:\n        # The plan-average",
          "    if True:\n        # The plan-average",
        ],
      ]);
      const differences = comparePriceAnswers(EXPECTED, answers).join("\n");
      // A: 0.40 x 30 = 12.00 in place of the 15.00 unit cost total.
      expect(differences).toContain(
        "copay total_lowest_fee: application gives value 1250, raw files give value 1550",
      );
      expect(differences).toContain(
        "copay maximum_fair_price_total: application gives value 1200, raw files give unknown drug_not_selected",
      );
    });
  });
});
