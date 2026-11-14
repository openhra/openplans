// CMS worked examples run end to end: imported Part D and PBP rows, the estimate service, the HTTP
// route and the MCP tool. Expected figures come from tests/fixtures/medicare-costs/oracles.json,
// transcribed by hand from the pinned CMS documents.
//
// The plan rows below are synthetic edits of the fixture cut of the 2026 Q3 files. Each oracle
// plan files the benefit its CMS example describes (benefit type, deductible, tier cost sharing,
// insulin row and selected-drug flag). RxCUIs starting 99 are synthetic. A selected drug's proxy NDC
// is a real entry on the CMS 2026 selected-drug list, so the flag and the list agree; the other
// NDCs, starting 99, are synthetic and on no list. No price source
// is loaded for estimates, so the test supplies each example's CMS price at the service's
// `estimate` seam, labelled `cms_worked_example`. It also asserts the insulin and vaccine facts the
// example states, at the `drugFacts` seam, because no admitted file lists them. Everything else
// (benefit type, deductible, cost sharing, selected-drug flag, rules) comes from the imported rows.
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createApp } from "../../../src/api/app.js";
import { MemoryCache } from "../../../src/api/cache/store.js";
import { loadConfig } from "../../../src/config/index.js";
import type {
  EstimateRequest,
  EstimateResult,
  FillRequest,
  PriceEvidence,
} from "../../../src/domain/medicare/part-d-cost/engine.js";
import {
  createEstimator,
  engineDeps,
  estimateDrugCosts,
} from "../../../src/domain/medicare/part-d-cost/engine.js";
import { yearRules } from "../../../src/domain/medicare/part-d-cost/repository.js";
import { roundHalfUpCents } from "../../../src/domain/medicare/part-d-cost/decimal.js";
import {
  maximumFairPrice,
  mfpTotal,
} from "../../../src/domain/medicare/part-d-cost/mfp.js";
import { pricingDeps } from "../../../src/domain/medicare/part-d-cost/price.js";
import type { Transport } from "../../../src/fetch/index.js";
import {
  acquireSpuf,
  cachedSpuf,
  importSpuf,
  parseSpufUrl,
} from "../../../src/ingest/medicare/spuf.js";
import { createMcpHttp } from "../../../src/mcp/http.js";
import {
  assertEstimateHonest,
  estimateOutputSchema,
  MEDICARE_ESTIMATE_TOOL,
} from "../../../src/mcp/medicare-estimate.js";
import {
  drugCostDeps,
  estimateProvenanceProblems,
} from "../../../src/services/medicare-drug-cost.js";
import type {
  DrugCostDeps,
  DrugCostEstimate,
} from "../../../src/services/medicare-drug-cost.js";
import { post } from "../../mcp/transport-helpers.js";
import { loadedDatabase, lookup, spufArchive, spufUrl } from "./helpers.js";
import type { Loaded } from "./helpers.js";

/** The parts of an estimate answer these tests read. */
interface Figure {
  status: string;
  cents: number | null;
  minimum_cents?: number;
  maximum_cents?: number;
  reason?: string | null;
  evidence_refs: string[];
}
interface Fill {
  /** Price figures are read field by field against the expected ones. */
  price?: { figures?: Record<string, Record<string, unknown>> };
  figures: Record<
    | "patient_pay"
    | "troop_increment"
    | "gross_below_threshold"
    | "gross_above_threshold"
    | "manufacturer_discount"
    | "selected_drug_subsidy"
    | "covered_plan_paid"
    | "non_covered_plan_paid",
    Figure
  >;
  after: { troop: Figure };
  plan_phase?: { begin?: string; end?: string };
}
interface EvidenceItem {
  id: string;
  kind: string;
  table?: string;
  document?: string;
  source_row?: number;
  source_rows?: number[];
}
interface EstimateAnswer {
  status: string;
  reason?: string;
  price_basis?: string;
  fills?: Fill[];
  snapshot_ids: string[];
  plan_figures: { plan_deductible: Figure; standard_deductible: Figure };
  benefit_type: { origin: string };
  rules_documents: { id: string }[];
  evidence: EvidenceItem[];
}
interface ToolOutput {
  error: unknown;
  data: EstimateAnswer | null;
}
const API_TOKEN = "synthetic-oracle-api-grant";
const MCP_TOKEN = "synthetic-oracle-mcp-grant";

interface Oracle {
  id: string;
  document: string;
  section: string;
  contractYear: number;
  inputs: Record<string, string>;
  expected: Record<string, string>;
}
const oracleFile = JSON.parse(
  readFileSync(
    new URL("../../fixtures/medicare-costs/oracles.json", import.meta.url),
    "utf8",
  ),
) as {
  annualRuleCells: {
    cells: Record<string, Record<string, string>>;
  };
  workedExamples: Oracle[];
};

// ---------- synthetic oracle plans ----------

interface OraclePlan {
  contract: string;
  plan: string;
  formulary: string;
  formularyVersion: string;
  /** PBP mrx_benefit_type: 1 DS, 2 AE, 3 BA, 4 EA. */
  benefitType: "1" | "3" | "4";
  deductible: string;
  /** Beneficiary cost rows: coverage level, tier, cost type, amount, deductible applies. */
  costs: [string, number, string, string, "Y" | "N"][];
  /** Insulin rows: tier, copay, coinsurance. */
  insulin: [number, string, string][];
}
const plans: Record<string, OraclePlan> = {
  // C7 examples 1 and 4: a defined standard plan, 25% after the standard deductible.
  ds: {
    contract: "S4802",
    plan: "013",
    formulary: "00026191",
    formularyVersion: "18",
    benefitType: "1",
    deductible: "615",
    costs: [
      ["1", 1, "2", "0.25", "Y"],
      ["3", 1, "1", "0", "Y"],
    ],
    insulin: [],
  },
  // C7 example 3: a basic alternative plan with a $40 copay.
  ba: {
    contract: "S4802",
    plan: "155",
    formulary: "00026195",
    formularyVersion: "18",
    benefitType: "3",
    deductible: "615",
    costs: [
      ["1", 1, "1", "40", "Y"],
      ["3", 1, "1", "0", "Y"],
    ],
    insulin: [],
  },
  // C7 example 5: an enhanced alternative plan, $400 deductible, then 20%.
  ea: {
    contract: "H0504",
    plan: "015",
    formulary: "00026258",
    formularyVersion: "29",
    benefitType: "4",
    deductible: "400",
    costs: [
      ["1", 1, "2", "0.20", "Y"],
      ["3", 1, "1", "0", "Y"],
    ],
    insulin: [],
  },
  // C7 examples 8 and 9 and C12 example 1: insulin rows on tiers 1, 2 and 3.
  insulin: {
    contract: "H0028",
    plan: "042",
    formulary: "00026408",
    formularyVersion: "16",
    benefitType: "4",
    deductible: "0",
    costs: [1, 2, 3].flatMap(
      (tier): [string, number, string, string, "Y" | "N"][] => [
        ["1", tier, "2", "0.25", "N"],
        ["3", tier, "1", "0", "N"],
      ],
    ),
    insulin: [
      [1, "35.00", "0.25"],
      [2, "35.00", "0.20"],
      [3, "30.00", "0.25"],
    ],
  },
};

interface Setup {
  plan: keyof typeof plans;
  rxcui: string;
  ndc: string;
  tier: number;
  selected: "Y" | "N";
  /** Facts the CMS example states that no admitted file settles. */
  facts: FillRequest["classification"];
}
const notSpecial: FillRequest["classification"] = {
  insulin: false,
  acip_vaccine: false,
  program: "unknown",
};
const insulin = (
  program: FillRequest["classification"]["program"],
): FillRequest["classification"] => ({
  insulin: true,
  acip_vaccine: false,
  program,
});
const setups: Record<string, Setup> = {
  "ds-deductible-crossing": {
    plan: "ds",
    rxcui: "9900001",
    ndc: "00003089321",
    tier: 1,
    selected: "Y",
    facts: notSpecial,
  },
  "ds-catastrophic-crossing": {
    plan: "ds",
    rxcui: "9900001",
    ndc: "00003089321",
    tier: 1,
    selected: "Y",
    facts: notSpecial,
  },
  "selected-drug-copay-ceiling": {
    plan: "ba",
    rxcui: "9900002",
    ndc: "00003142711",
    tier: 1,
    selected: "Y",
    facts: notSpecial,
  },
  "ea-mapping-crossing": {
    plan: "ea",
    rxcui: "9900003",
    ndc: "00006011201",
    tier: 1,
    selected: "Y",
    facts: notSpecial,
  },
  // C7 section 3 calls these products applicable drugs; the formulary flag says N.
  "insulin-lesser-of": {
    plan: "insulin",
    rxcui: "9900004",
    ndc: "99000000004",
    tier: 1,
    selected: "N",
    facts: insulin("applicable"),
  },
  "insulin-catastrophic-crossing": {
    plan: "insulin",
    rxcui: "9900005",
    ndc: "99000000005",
    tier: 2,
    selected: "N",
    facts: insulin("applicable"),
  },
  "selected-insulin-mfp-ceiling": {
    plan: "insulin",
    rxcui: "9900006",
    ndc: "00169210011",
    tier: 3,
    selected: "Y",
    facts: insulin("unknown"),
  },
};

// ---------- synthetic plan-average prices for the worked examples ----------

/**
 * Each worked example gets a synthetic 30-day pricing row for its proxy NDC and a quantity in NDC
 * units. For a drug that is not selected, unit cost x quantity is the example's ingredient cost.
 * A selected drug is priced from the maximum fair price on the pinned CMS list for its real NDC
 * instead, so its quantity is chosen to make that price x quantity round to the example's
 * ingredient cost, and its plan-average unit cost total differs from it on purpose. The fill goes
 * to a retail channel whose synthetic in-area pharmacies all file the example's dispensing fee,
 * so ingredient cost plus fee is the example's gross drug cost. Unit costs, quantities and
 * pharmacies are synthetic; the ingredient costs and fees are the CMS figures in oracles.json, and
 * the maximum fair prices are the CMS file's.
 */
interface PricedSetup {
  channel: "preferred_retail" | "standard_retail";
  unitCost: string;
  quantity: string;
  /** PDF pages of the example's narrative and PDE table in its pinned document. */
  pages: string;
}
const priced: Record<string, PricedSetup> = {
  // C7 example 1: $100.00 ingredient cost, $0.00 fee. Selected: $4.145072 x 24.125 = $100.00.
  "ds-deductible-crossing": {
    channel: "standard_retail",
    unitCost: "10.0000",
    quantity: "24.125",
    pages: "3-4",
  },
  // C7 example 4: $390.00 ingredient cost, $10.00 fee. Same NDC and row as example 1.
  // Selected: $4.145072 x 94.0876 = $390.00.
  "ds-catastrophic-crossing": {
    channel: "preferred_retail",
    unitCost: "10.0000",
    quantity: "94.0876",
    pages: "6-7",
  },
  // C7 example 3: $40.00 ingredient cost, $0.00 fee. Selected: $6.052894 x 6.6084 = $40.00.
  "selected-drug-copay-ceiling": {
    channel: "preferred_retail",
    unitCost: "4.0000",
    quantity: "6.6084",
    pages: "5-6",
  },
  // C7 example 5: $7,200.00 ingredient cost, $0.00 fee.
  // Selected: $3.907885 x 1842.4288 = $7,200.00.
  "ea-mapping-crossing": {
    channel: "preferred_retail",
    unitCost: "720.0000",
    quantity: "1842.4288",
    pages: "7-9",
  },
  // C7 example 8: $100.00 ingredient cost, $0.00 fee.
  "insulin-lesser-of": {
    channel: "standard_retail",
    unitCost: "10.0000",
    quantity: "10",
    pages: "12-13",
  },
  // C7 example 9: $492.00 ingredient cost, $8.00 fee.
  "insulin-catastrophic-crossing": {
    channel: "preferred_retail",
    unitCost: "49.2000",
    quantity: "10",
    pages: "13-14",
  },
  // C12 example 1: $119.00 ingredient cost (the maximum fair price), $10.00 fee.
  // Selected: $6.956927 x 17.1053 = $119.00.
  "selected-insulin-mfp-ceiling": {
    channel: "preferred_retail",
    unitCost: "11.9000",
    quantity: "17.1053",
    pages: "1-3",
  },
};
/**
 * Synthetic in-area retail pharmacies per oracle plan and preferred status: 30-day brand, generic
 * and selected-drug fees. Every pharmacy of a group files the same fees, so the lowest and highest
 * fee agree and the fee itself is the CMS figure. On the insulin plan the preferred pharmacies
 * file $8.00 for brand and generic drugs (example 9, an applicable drug) and $10.00 for selected
 * drugs (C12 example 1, a selected drug).
 */
const pharmacies: Record<
  keyof typeof plans,
  { preferred: [string, string, string]; standard: [string, string, string] }
> = {
  ds: { preferred: ["10", "10", "10"], standard: ["0", "0", "0"] },
  ba: { preferred: ["0", "0", "0"], standard: ["0", "0", "0"] },
  ea: { preferred: ["0", "0", "0"], standard: ["0", "0", "0"] },
  insulin: { preferred: ["8", "8", "10"], standard: ["0", "0", "0"] },
};

const planKey = (plan: OraclePlan) => `${plan.contract}-${plan.plan}-0`;
const prefixOf = (plan: OraclePlan) => `${plan.contract}|${plan.plan}|000|`;
const oraclePlans = Object.values(plans);

const edit = (
  files: Record<string, Buffer>,
  change: (lines: string[]) => string[],
) => {
  const name = Object.keys(files).find((item) => item.endsWith(".txt"))!;
  const text = files[name]!.toString("latin1");
  const lines = text.split(/\r?\n/).filter((line) => line !== "");
  files[name] = Buffer.from(change(lines).join("\r\n") + "\r\n", "latin1");
};

/** Rewrites the fixture Part D members so each oracle plan files its example's benefit. */
function partDEdits(outer: string, inner: Record<string, Buffer>) {
  const ours = (line: string) =>
    oraclePlans.some((plan) => line.startsWith(prefixOf(plan)));
  if (outer.startsWith("plan information"))
    edit(inner, (lines) =>
      lines.map((line) => {
        const plan = oraclePlans.find((p) => line.startsWith(prefixOf(p)));
        if (!plan) return line;
        const cells = line.split("|");
        cells[7] = plan.deductible;
        return cells.join("|");
      }),
    );
  else if (outer.startsWith("beneficiary cost"))
    edit(inner, (lines) => [
      ...lines.filter((line) => !ours(line)),
      ...oraclePlans.flatMap((plan) =>
        plan.costs.map(([level, tier, type, amount, deductible]) => {
          const channel = [type, amount, "0", "0"];
          return [
            plan.contract,
            plan.plan,
            "000",
            level,
            tier,
            "1",
            ...channel,
            ...channel,
            ...channel,
            ...channel,
            "N",
            deductible,
          ].join("|");
        }),
      ),
    ]);
  else if (outer.startsWith("insulin beneficiary cost"))
    edit(inner, (lines) => [
      ...lines.filter((line) => !ours(line)),
      ...oraclePlans.flatMap((plan) =>
        plan.insulin.map(([tier, copay, rate]) =>
          [
            plan.contract,
            plan.plan,
            "000",
            tier,
            "1",
            copay,
            copay,
            copay,
            copay,
            rate,
            rate,
            rate,
            rate,
          ].join("|"),
        ),
      ),
    ]);
  else if (outer.startsWith("pharmacy networks file"))
    edit(inner, (lines) => [
      ...lines.filter((line) => !ours(line)),
      ...(outer.includes("part 1")
        ? (Object.keys(pharmacies) as (keyof typeof plans)[]).flatMap(
            (name, p) => {
              const plan = plans[name]!;
              return (["preferred", "standard"] as const).flatMap(
                (status, s) => {
                  const [brand, generic, selected] = pharmacies[name]![status];
                  // Two synthetic pharmacies per group, numbers starting 99.
                  return [1, 2].map((n) =>
                    [
                      plan.contract,
                      plan.plan,
                      "000",
                      `99${String(p * 100 + s * 10 + n).padStart(10, "0")}`,
                      "99999",
                      status === "preferred" ? "Y" : "N",
                      "N",
                      "Y",
                      "N",
                      "1",
                      "0",
                      ...[brand, generic, selected].flatMap((fee) => [
                        fee,
                        fee,
                        fee,
                      ]),
                    ].join("|"),
                  );
                },
              );
            },
          )
        : []),
    ]);
  else if (outer.startsWith("pricing file"))
    edit(inner, (lines) => [
      ...lines,
      ...[
        ...new Map(
          Object.entries(priced).map(([id, price]) => {
            const s = setups[id]!;
            const plan = plans[s.plan]!;
            return [
              `${prefixOf(plan)}${s.ndc}`,
              `${prefixOf(plan)}${s.ndc}|30|${price.unitCost}`,
            ] as const;
          }),
        ).values(),
      ],
    ]);
  else if (outer.startsWith("basic drugs formulary"))
    edit(inner, (lines) => [
      ...lines,
      ...[
        ...new Map(
          Object.values(setups).map((s) => [s.rxcui, s] as const),
        ).values(),
      ].map((s) => {
        const plan = plans[s.plan]!;
        return [
          plan.formulary,
          plan.formularyVersion,
          "2026",
          s.rxcui,
          s.ndc,
          s.tier,
          "N",
          " ",
          " ",
          "N",
          "N",
          s.selected,
        ].join("|");
      }),
    ]);
}

/** Sets each oracle plan's PBP benefit type. */
function pbpEdits(family: string, files: Record<string, Buffer>) {
  if (family !== "pbp") return;
  const text = files["pbp_mrx.txt"]!.toString("latin1");
  const lines = text.split(/\r?\n/);
  const header = lines[0]!.split("\t");
  const at = header.indexOf("mrx_benefit_type");
  files["pbp_mrx.txt"] = Buffer.from(
    lines
      .map((line, index) => {
        if (index === 0 || !line) return line;
        const cells = line.split("\t");
        const plan = oraclePlans.find(
          (p) => cells[0] === p.contract && cells[1] === p.plan,
        );
        if (plan) cells[at] = plan.benefitType;
        return cells.join("\t");
      })
      .join("\n"),
    "latin1",
  );
}

// ---------- requests ----------

const cents = (dollars: string) => Math.round(Number(dollars) * 100);
const FILL = "oracle-fill-1";

function scheduleFor(oracle: Oracle) {
  const setup = setups[oracle.id]!;
  const plan = plans[setup.plan]!;
  const troop = cents(oracle.inputs.openingTroop!);
  const gross = cents(oracle.inputs.openingGrossCoveredDrugCost!);
  const date = `${oracle.contractYear}-06-01`;
  return {
    scenario: "non_lis_no_other_payer",
    channel: "preferred_retail",
    opening_state:
      troop || gross
        ? {
            kind: "provided",
            as_of: date,
            gross_covered_drug_cost_cents: gross,
            troop_cents: troop,
            plan_deductible_met_cents: Math.min(troop, cents(plan.deductible)),
          }
        : { kind: "new_calendar_year" },
    fills: [
      {
        fill_id: FILL,
        date,
        rxcui: setup.rxcui,
        quantity: "30",
        unit: "each",
        days_supply: 30,
      },
    ],
  };
}

function priceFor(oracle: Oracle): PriceEvidence {
  return {
    status: "value",
    amount: oracle.inputs.grossDrugCost ?? oracle.inputs.negotiatedPrice!,
    basis: "cms_worked_example",
    reference: `${oracle.document} ${oracle.id}`,
    ...(oracle.inputs.maximumFairPrice
      ? { maximum_fair_price: oracle.inputs.maximumFairPrice }
      : {}),
  };
}

/** The same schedule priced from the synthetic plan-average rows instead of the CMS amount. */
function planAverageScheduleFor(oracle: Oracle) {
  const schedule = scheduleFor(oracle);
  const price = priced[oracle.id]!;
  return {
    ...schedule,
    price_basis: "cms_plan_average",
    channel: price.channel,
    fills: schedule.fills.map((fill) => ({
      ...fill,
      quantity: price.quantity,
      unit: "ndc_unit",
    })),
  };
}

/** The example's CMS dispensing fee; $0.00 when its PDE table reports none. */
const feeOf = (oracle: Oracle) => oracle.inputs.dispensingFee ?? "0.00";
const grossOf = (oracle: Oracle) =>
  oracle.inputs.grossDrugCost ?? oracle.inputs.negotiatedPrice!;
const ingredientOf = (oracle: Oracle) =>
  oracle.inputs.ingredientCost ?? grossOf(oracle);

/**
 * Figures the dispensing fee cannot move, worked by hand from each example's own arithmetic. The
 * plan-average path also prices every fill of a drug that is not selected as if the unit cost
 * already included the fee (unit cost alone), so a figure is exact only when the example's figure
 * is the same with and without the fee:
 *
 * - C7 example 9: the $20.00 left to the threshold fixes patient pay and TrOOP. The amount below
 *   the threshold is $20.00 over the $35.00 copay's share of the gross cost ($285.71 of $500.00,
 *   $281.14 of $492.00), so it moves, and so do the amounts that follow from it.
 *
 * A selected drug is priced from its maximum fair price, which excludes the fee, so its examples
 * (C7 examples 1, 3, 4 and 5, C12 example 1) have no such reading and every figure is exact. In
 * C12 example 1, 25% of the $119.00 maximum fair price caps patient pay at $29.75.
 */
const feeIndependent: Record<string, string[]> = {
  "insulin-catastrophic-crossing": ["patientPay", "troopIncrement"],
};
/** Selected drugs: the flag says so and the proxy NDC is on the CMS list. */
const viaMfp = (oracle: Oracle) => setups[oracle.id]!.selected === "Y";
/** Unit cost x quantity in cents, rounded half up as the application rounds it. */
const unitCostCents = (oracle: Oracle) => {
  const price = priced[oracle.id]!;
  return Number(roundHalfUpCents(mfpTotal(price.unitCost, price.quantity)!));
};

/**
 * Compares a plan-average answer with the CMS example. The price block must rebuild the example's
 * ingredient cost and gross drug cost to the cent. With a $0.00 fee every figure must be the CMS
 * figure. With a fee, the fee-independent figures must be the CMS figure and every other one must
 * be unknown for the fee, or bounded with both ends at the CMS figure; never another value.
 */
function planAverageMismatches(
  oracle: Oracle,
  answer: EstimateAnswer | null,
  label: string,
): string[] {
  const fill = answer?.fills?.[0];
  if (!fill)
    return [
      `${oracle.id} (${label}): no fill, ${answer?.status} ${answer?.reason}`,
    ];
  const out: string[] = [];
  const priceFigures = fill.price?.figures ?? {};
  const gross = cents(grossOf(oracle));
  const selected = viaMfp(oracle);
  const hasFee = cents(feeOf(oracle)) !== 0 && !selected;
  const want: Record<string, Record<string, unknown>> = {
    unit_cost_total: {
      status: "value",
      cents: selected ? unitCostCents(oracle) : cents(ingredientOf(oracle)),
    },
    maximum_fair_price_total: selected
      ? { status: "value", cents: cents(ingredientOf(oracle)) }
      : { status: "unknown", cents: null, reason: "drug_not_selected" },
    total_lowest_fee: { status: "value", cents: gross },
    total_highest_fee: { status: "value", cents: gross },
    gross: hasFee
      ? {
          status: "bounded",
          cents: null,
          minimum_cents: gross,
          maximum_cents: gross,
          reason: "dispensing_fee_unknown",
        }
      : { status: "value", cents: gross },
  };
  for (const [key, expected] of Object.entries(want)) {
    const got = priceFigures[key];
    const picked = got
      ? Object.fromEntries(
          Object.keys(expected).map((name) => [name, got[name]]),
        )
      : null;
    if (JSON.stringify(picked) !== JSON.stringify(expected))
      out.push(
        `${oracle.id}.price.${key} (${label}): expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`,
      );
  }
  if (!hasFee) return [...out, ...mismatches(oracle, answer, label)];
  const exact = new Set(feeIndependent[oracle.id] ?? []);
  const exactOnly: Oracle = {
    ...oracle,
    expected: Object.fromEntries(
      Object.entries(oracle.expected).filter(([key]) => exact.has(key)),
    ),
  };
  out.push(...mismatches(exactOnly, answer, label));
  const figures: Record<string, Figure> = {
    patientPay: fill.figures.patient_pay,
    troopIncrement: fill.figures.troop_increment,
    grossBelowThreshold: fill.figures.gross_below_threshold,
    grossAboveThreshold: fill.figures.gross_above_threshold,
    manufacturerDiscount: fill.figures.manufacturer_discount,
    selectedDrugSubsidy: fill.figures.selected_drug_subsidy,
    coveredPlanPaid: fill.figures.covered_plan_paid,
    nonCoveredPlanPaid: fill.figures.non_covered_plan_paid,
  };
  for (const [key, value] of Object.entries(oracle.expected)) {
    if (exact.has(key)) continue;
    const figure = figures[key];
    if (!figure) {
      out.push(`${oracle.id}.${key} (${label}): not reported`);
      continue;
    }
    const atCms =
      figure.status === "bounded" &&
      figure.minimum_cents === cents(value) &&
      figure.maximum_cents === cents(value);
    const unknownForFee =
      figure.status === "unknown" &&
      figure.cents === null &&
      String(figure.reason).split("+").includes("dispensing_fee_unknown");
    if (!atCms && !unknownForFee)
      out.push(
        `${oracle.id}.${key} (${label}): expected unknown for the fee or bounds at ${value}, got ${JSON.stringify(figure)}`,
      );
  }
  return out;
}

/** The oracle currently running; the seams read it. */
let current: Oracle | null = null;
type Estimate = (request: EstimateRequest) => EstimateResult;
let engine: Estimate = estimateDrugCosts;
type ReadBundle = DrugCostDeps["readBundle"];
let bundleEdit: (
  bundle: Awaited<ReturnType<ReadBundle>>,
) => Awaited<ReturnType<ReadBundle>> = (bundle) => bundle;

/** The only two test seams: the CMS example's price and its stated insulin/vaccine facts. */
function installSeams() {
  const readBundle = drugCostDeps.readBundle;
  vi.spyOn(drugCostDeps, "drugFacts").mockImplementation(
    () => setups[current!.id]!.facts,
  );
  vi.spyOn(drugCostDeps, "estimate").mockImplementation((request) =>
    engine({ ...request, prices: { [FILL]: priceFor(current!) } }),
  );
  vi.spyOn(drugCostDeps, "readBundle").mockImplementation(async (db, query) =>
    bundleEdit(await readBundle(db, query)),
  );
}

/** Compares every expected figure of an oracle with an estimate answer. */
function mismatches(
  oracle: Oracle,
  answer: EstimateAnswer | null,
  label: string,
): string[] {
  if (!answer?.fills?.[0])
    return [
      `${oracle.id} (${label}): no fill, ${answer?.status} ${answer?.reason}`,
    ];
  const fill = answer.fills[0];
  const figures: Record<string, Figure> = {
    patientPay: fill.figures.patient_pay,
    troopIncrement: fill.figures.troop_increment,
    grossBelowThreshold: fill.figures.gross_below_threshold,
    grossAboveThreshold: fill.figures.gross_above_threshold,
    selectedDrugSubsidy: fill.figures.selected_drug_subsidy,
    manufacturerDiscount: fill.figures.manufacturer_discount,
    coveredPlanPaid: fill.figures.covered_plan_paid,
    nonCoveredPlanPaid: fill.figures.non_covered_plan_paid,
    closingTroop: fill.after.troop,
  };
  return Object.entries(oracle.expected).flatMap(([key, value]) => {
    let got: string;
    if (key === "beginningPhase" || key === "endingPhase")
      got = String(
        fill.plan_phase?.[key === "beginningPhase" ? "begin" : "end"],
      );
    else {
      const figure = figures[key];
      if (!figure) return [`${oracle.id}.${key} (${label}): not reported`];
      got =
        figure.status === "value"
          ? (figure.cents! / 100).toFixed(2)
          : `unknown:${figure.reason}`;
    }
    return got === value
      ? []
      : [`${oracle.id}.${key} (${label}): expected ${value}, got ${got}`];
  });
}

describe("CMS worked examples through the HTTP route and the MCP tool", () => {
  let loaded: Loaded;
  let http: ReturnType<typeof createApp>;
  let mcp: ReturnType<typeof createMcpHttp>;

  beforeAll(async () => {
    loaded = await loadedDatabase(pbpEdits);
    const transport: Transport = async () => ({
      status: 200,
      headers: { "content-type": "application/zip" },
      body: Readable.from([await spufArchive(partDEdits)]),
    });
    const archive = parseSpufUrl(spufUrl)!;
    await acquireSpuf(archive, {
      dataDir: loaded.dataDir,
      dependencies: { lookup, transport },
    });
    const cached = (await cachedSpuf(archive.kind, loaded.dataDir))[0]!;
    await importSpuf(loaded.db, cached);
    // The synthetic pricing rows and fee ranges, for the plan-average requests only.
    await importSpuf(loaded.db, cached, ["pricing", "dispensing_fee"]);
    http = createApp(
      loaded.db,
      { premiumToken: API_TOKEN },
      { store: new MemoryCache(1 << 20), config: loadConfig({}) },
    );
    mcp = createMcpHttp(loaded.db, {
      env: { OPENPLANS_MCP_TOKEN: MCP_TOKEN },
      log: () => {},
    });
  }, 300_000);
  afterAll(async () => {
    await loaded?.cleanup();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    current = null;
    engine = estimateDrugCosts;
    bundleEdit = (bundle) => bundle;
  });

  const switchesOn = () => {
    vi.stubEnv("OPENPLANS_MEDICARE_PART_D", "on");
    vi.stubEnv("OPENPLANS_MEDICARE_DRUG_COST", "on");
  };
  async function viaHttp(
    oracle: Oracle,
    schedule: Record<string, unknown> = scheduleFor(oracle),
  ): Promise<EstimateAnswer> {
    current = oracle;
    const plan = plans[setups[oracle.id]!.plan]!;
    const response = await http.request(
      `/v1/medicare/plans/${planKey(plan)}/drug-cost-estimates?year=${oracle.contractYear}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${API_TOKEN}`,
        },
        body: JSON.stringify(schedule),
      },
    );
    expect(response.status, oracle.id).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    return response.json();
  }
  async function viaMcp(
    oracle: Oracle,
    schedule: Record<string, unknown> = scheduleFor(oracle),
  ): Promise<ToolOutput> {
    current = oracle;
    const plan = plans[setups[oracle.id]!.plan]!;
    const response = await mcp.fetch(
      post(
        "tools/call",
        {
          name: MEDICARE_ESTIMATE_TOOL,
          arguments: {
            plan_key: planKey(plan),
            year: oracle.contractYear,
            ...schedule,
          },
        },
        { authorization: `Bearer ${MCP_TOKEN}` },
      ),
    );
    expect(response.status, oracle.id).toBe(200);
    const body: { result: { structuredContent: ToolOutput } } =
      await response.json();
    return body.result.structuredContent;
  }

  it("covers every worked example in the fixture", () => {
    expect(oracleFile.workedExamples.map((o) => o.id).sort()).toEqual(
      Object.keys(setups).sort(),
    );
  });

  it("serves the Table V-2 cells as the plan figures of both years", () => {
    for (const [year, cells] of Object.entries(
      oracleFile.annualRuleCells.cells,
    )) {
      const rules = yearRules(Number(year));
      expect(rules.status).toBe("value");
      if (rules.status !== "value") continue;
      expect(
        `$${(rules.standard_deductible.cents! / 100).toLocaleString("en-US")}`,
      ).toBe(cells.Deductible);
      expect(
        `$${(rules.out_of_pocket_threshold.cents! / 100).toLocaleString("en-US")}`,
      ).toBe(cells["Out-of-Pocket Threshold"]);
    }
  });

  for (const oracle of oracleFile.workedExamples) {
    it(`${oracle.document} ${oracle.id}: every expected figure over HTTP and MCP`, async () => {
      switchesOn();
      installSeams();
      const route = await viaHttp(oracle);
      expect(mismatches(oracle, route, "http")).toEqual([]);
      expect(estimateProvenanceProblems(route)).toEqual([]);
      // The plan deductible names every county row of the plan: one group when the rows agree.
      const plan = plans[setups[oracle.id]!.plan]!;
      const county = (
        await loaded.db.query<{ source_row: number }>(
          `SELECT source_row FROM partd_plan
           WHERE snapshot_id=$1 AND contract_id=$2 AND plan_id=$3 ORDER BY source_row`,
          [route.snapshot_ids[0], plan.contract, plan.plan],
        )
      ).rows.map((row) => row.source_row);
      const deductibleRefs: string[] =
        route.plan_figures.plan_deductible.evidence_refs;
      const named = deductibleRefs.flatMap((id) => {
        const item = route.evidence.find((entry) => entry.id === id);
        return item!.kind === "source_rows"
          ? item!.source_rows!
          : [item!.source_row!];
      });
      expect(named).toEqual(county);
      expect(deductibleRefs.length).toBe(county.length > 1 ? 1 : county.length);
      // The plan's own filing settled the benefit type; the caller cannot assert it.
      expect(route.benefit_type.origin).toBe("pbp_filing");
      expect(route.plan_figures.standard_deductible.cents).toBe(
        oracle.contractYear === 2026 ? 61500 : 70000,
      );

      // Every rule the answer cites, drug-list rows included, is in its document list.
      const documents = new Set(route.rules_documents.map((doc) => doc.id));
      for (const item of route.evidence)
        if (item.kind === "rule") expect(documents).toContain(item.document);
      const output = await viaMcp(oracle);
      expect(estimateOutputSchema.safeParse(output).success).toBe(true);
      expect(output.error, JSON.stringify(output.error)).toBeNull();
      expect(output.data).toEqual(route);
      expect(mismatches(oracle, output.data, "mcp")).toEqual([]);
      expect(() =>
        assertEstimateHonest(output, route as DrugCostEstimate),
      ).not.toThrow();
    });
  }

  it("without the CMS price, the same requests give unknown amounts, never zero", async () => {
    switchesOn();
    vi.spyOn(drugCostDeps, "drugFacts").mockImplementation(
      () => setups[current!.id]!.facts,
    );
    for (const oracle of oracleFile.workedExamples) {
      const route = await viaHttp(oracle);
      const pay = route.fills![0]!.figures.patient_pay;
      expect(pay.status, oracle.id).toBe("unknown");
      expect(pay.cents).toBeNull();
      expect(pay.reason).toBeTruthy();
      expect(route.status).not.toBe("estimated");
    }
  });

  describe("priced from synthetic plan-average rows", () => {
    const pricesOn = () => {
      switchesOn();
      vi.stubEnv("OPENPLANS_MEDICARE_DRUG_COST_PRICES", "on");
    };
    /** Only the stated insulin facts are seamed; prices come from the imported rows. */
    const factsOnly = () =>
      vi
        .spyOn(drugCostDeps, "drugFacts")
        .mockImplementation(() => setups[current!.id]!.facts);

    it("prices every worked example", () => {
      expect(Object.keys(priced).sort()).toEqual(Object.keys(setups).sort());
      for (const oracle of oracleFile.workedExamples) {
        const price = priced[oracle.id]!;
        const setup = setups[oracle.id]!;
        // A selected drug's maximum fair price x quantity is the CMS ingredient cost, to the
        // cent; for any other drug the unit cost x quantity is.
        const mfp = maximumFairPrice(2026, setup.ndc, "2026-06-01");
        if (viaMfp(oracle)) {
          expect(mfp.status, oracle.id).toBe("value");
          if (mfp.status !== "value") continue;
          expect(
            Number(roundHalfUpCents(mfpTotal(mfp.unit_price, price.quantity)!)),
            oracle.id,
          ).toBe(cents(ingredientOf(oracle)));
          expect(unitCostCents(oracle)).not.toBe(cents(ingredientOf(oracle)));
        } else {
          expect(mfp.status, oracle.id).toBe("unknown");
          expect(unitCostCents(oracle), oracle.id).toBe(
            cents(ingredientOf(oracle)),
          );
        }
        expect(cents(ingredientOf(oracle)) + cents(feeOf(oracle))).toBe(
          cents(grossOf(oracle)),
        );
      }
    });

    for (const oracle of oracleFile.workedExamples)
      it(`${oracle.document} pp. ${priced[oracle.id]!.pages} ${oracle.id}: plan-average price over HTTP and MCP`, async () => {
        pricesOn();
        factsOnly();
        current = oracle;
        const schedule = planAverageScheduleFor(oracle);
        const route = await viaHttp(oracle, schedule);
        expect(planAverageMismatches(oracle, route, "http")).toEqual([]);
        expect(estimateProvenanceProblems(route)).toEqual([]);
        expect(route.price_basis).toBe("cms_plan_average");
        // The price cites the synthetic pricing row and the fee ranges it used.
        expect(
          route.evidence.some(
            (item) => item.kind === "source_row" && item.table === "pricing",
          ),
        ).toBe(true);
        expect(route.evidence.some((item) => item.kind === "fee_range")).toBe(
          true,
        );
        const output = await viaMcp(oracle, schedule);
        expect(estimateOutputSchema.safeParse(output).success).toBe(true);
        expect(output.error, JSON.stringify(output.error)).toBeNull();
        expect(output.data).toEqual(route);
        expect(planAverageMismatches(oracle, output.data, "mcp")).toEqual([]);
        expect(() =>
          assertEstimateHonest(output, route as DrugCostEstimate),
        ).not.toThrow();
      });

    // Each planted mutant changes how the plan-average price is read. Some example must fail.
    type PlanAverage = Extract<PriceEvidence, { status: "plan_average" }>;
    const rewrite =
      (change: (price: PlanAverage) => PlanAverage): Estimate =>
      (request) =>
        estimateDrugCosts({
          ...request,
          prices: Object.fromEntries(
            Object.entries(request.prices).map(([id, price]) => [
              id,
              price.status === "plan_average" ? change(price) : price,
            ]),
          ),
        });
    const zero = { status: "value" as const, lowest: "0", highest: "0" };
    const priceMutants: Record<string, Estimate> = {
      "dispensing fee dropped (unit cost alone)": rewrite((price) => ({
        ...price,
        fees: {
          brand_or_generic: zero,
          selected_or_brand: zero,
          any_fee_type: zero,
        },
      })),
      "brand fee charged for a selected drug": rewrite((price) => ({
        ...price,
        fees: { ...price.fees, selected_or_brand: price.fees.brand_or_generic },
      })),
      "quantity read as one unit": rewrite((price) => ({
        ...price,
        quantity: "1",
        unit_cost_total: price.unit_cost,
      })),
      "plan average used in place of the maximum fair price for a selected drug":
        createEstimator({
          ...engineDeps,
          pricing: { ...pricingDeps, ingredient: () => "plan_average" },
        }),
      "maximum fair price applied to a drug that is not selected":
        createEstimator({
          ...engineDeps,
          pricing: { ...pricingDeps, ingredient: () => "maximum_fair_price" },
        }),
    };
    // Examples each maximum fair price mutant must break: every selected one, every other one.
    const ids = (selected: boolean) =>
      oracleFile.workedExamples
        .filter((oracle) => viaMfp(oracle) === selected)
        .map((oracle) => oracle.id);
    const mustFail: Record<string, string[]> = {
      "plan average used in place of the maximum fair price for a selected drug":
        ids(true),
      "maximum fair price applied to a drug that is not selected": ids(false),
    };
    for (const [name, mutant] of Object.entries(priceMutants))
      it(`catches the planted mutant: ${name}`, async () => {
        pricesOn();
        factsOnly();
        engine = mutant;
        vi.spyOn(drugCostDeps, "estimate").mockImplementation((request) =>
          engine(request),
        );
        const failures: string[] = [];
        for (const oracle of oracleFile.workedExamples) {
          let answer: EstimateAnswer;
          try {
            answer = await viaHttp(oracle, planAverageScheduleFor(oracle));
          } catch (error) {
            failures.push(`${oracle.id}: ${String(error)}`);
            continue;
          }
          failures.push(...planAverageMismatches(oracle, answer, "http"));
        }
        expect(failures.length, name).toBeGreaterThan(0);
        for (const id of mustFail[name] ?? [])
          expect(
            failures.some((line) => line.startsWith(id)),
            `${name}: ${id}`,
          ).toBe(true);
      });
  });

  // Each planted mutant changes one input the oracles depend on. Some oracle must fail.
  const mutants: Record<string, () => void> = {
    "price dropped at the service": () => {
      engine = (request) => estimateDrugCosts({ ...request, prices: {} });
    },
    "2027 rules relabelled for a 2026 plan": () => {
      engine = createEstimator({
        ...engineDeps,
        rules: (year) => ({ ...yearRules(2027), contract_year: year }),
      });
    },
    "enhanced alternative filing read as basic": () => {
      bundleEdit = (bundle) =>
        bundle.status === "available" &&
        bundle.benefit_type?.status === "value" &&
        bundle.benefit_type.type === "EA"
          ? {
              ...bundle,
              benefit_type: { ...bundle.benefit_type, type: "BA" },
            }
          : bundle;
    },
    "selected-drug flag ignored": () => {
      bundleEdit = (bundle) =>
        bundle.status === "available"
          ? {
              ...bundle,
              drugs: bundle.drugs.map((drug) => ({
                ...drug,
                packages: drug.packages.map((p) => ({
                  ...p,
                  selected_drug: false,
                })),
              })),
            }
          : bundle;
    },
    "plan deductible ignored": () => {
      bundleEdit = (bundle) =>
        bundle.status === "available"
          ? {
              ...bundle,
              deductible: { status: "value", cents: 0, raw: "0" },
            }
          : bundle;
    },
  };
  for (const [name, plant] of Object.entries(mutants)) {
    it(`catches the planted mutant: ${name}`, async () => {
      switchesOn();
      installSeams();
      plant();
      const failures: string[] = [];
      for (const oracle of oracleFile.workedExamples) {
        let answer: EstimateAnswer;
        try {
          answer = await viaHttp(oracle);
        } catch (error) {
          failures.push(`${oracle.id}: ${String(error)}`);
          continue;
        }
        failures.push(...mismatches(oracle, answer, "http"));
      }
      expect(failures.length, name).toBeGreaterThan(0);
    });
  }
});
