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
import type { DrugCostDeps } from "../../../src/services/medicare-drug-cost.js";
import { post } from "../../mcp/transport-helpers.js";
import { loadedDatabase, lookup, spufArchive, spufUrl } from "./helpers.js";
import type { Loaded } from "./helpers.js";

type Json = ReturnType<typeof JSON.parse>;
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
function mismatches(oracle: Oracle, answer: Json, label: string): string[] {
  if (!answer?.fills?.[0])
    return [
      `${oracle.id} (${label}): no fill, ${answer?.status} ${answer?.reason}`,
    ];
  const fill = answer.fills[0];
  const figures: Record<string, Json> = {
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
          ? (figure.cents / 100).toFixed(2)
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
    await importSpuf(
      loaded.db,
      (await cachedSpuf(archive.kind, loaded.dataDir))[0]!,
    );
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
  async function viaHttp(oracle: Oracle): Promise<Json> {
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
        body: JSON.stringify(scheduleFor(oracle)),
      },
    );
    expect(response.status, oracle.id).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    return response.json();
  }
  async function viaMcp(oracle: Oracle): Promise<Json> {
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
            ...scheduleFor(oracle),
          },
        },
        { authorization: `Bearer ${MCP_TOKEN}` },
      ),
    );
    expect(response.status, oracle.id).toBe(200);
    const body = await response.json();
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
      // The plan's own filing settled the benefit type; the caller cannot assert it.
      expect(route.benefit_type.origin).toBe("pbp_filing");
      expect(route.plan_figures.standard_deductible.cents).toBe(
        oracle.contractYear === 2026 ? 61500 : 70000,
      );

      // Every rule the answer cites, drug-list rows included, is in its document list.
      const documents = new Set(
        route.rules_documents.map((doc: Json) => doc.id),
      );
      for (const item of route.evidence)
        if (item.kind === "rule") expect(documents).toContain(item.document);
      const output = await viaMcp(oracle);
      expect(estimateOutputSchema.safeParse(output).success).toBe(true);
      expect(output.error, JSON.stringify(output.error)).toBeNull();
      expect(output.data).toEqual(route);
      expect(mismatches(oracle, output.data, "mcp")).toEqual([]);
      expect(() => assertEstimateHonest(output, route)).not.toThrow();
    });
  }

  it("without the CMS price, the same requests give unknown amounts, never zero", async () => {
    switchesOn();
    vi.spyOn(drugCostDeps, "drugFacts").mockImplementation(
      () => setups[current!.id]!.facts,
    );
    for (const oracle of oracleFile.workedExamples) {
      const route = await viaHttp(oracle);
      const pay = route.fills[0].figures.patient_pay;
      expect(pay.status, oracle.id).toBe("unknown");
      expect(pay.cents).toBeNull();
      expect(pay.reason).toBeTruthy();
      expect(route.status).not.toBe("estimated");
    }
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
        let answer: Json;
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
