// Plan benefit type and drug classes for the Part D cost engine: where each fact comes from, the
// CMS worked examples run with those facts taken from evidence rather than from the caller, and
// planted mutants. Expected oracle figures come from tests/fixtures/medicare-costs/oracles.json.
// Every other price and plan below is synthetic and labelled so. The last block reads the cached
// CMS archives and runs only when OPENPLANS_DATA_DIR holds them; nothing is downloaded.
import { PGlite } from "@electric-sql/pglite";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parsePlanKey } from "../../src/domain/medicare/index.js";
import type {
  BenefitTypeEvidence,
  ClassificationFile,
  PbpRelease,
} from "../../src/domain/medicare/part-d-cost/classification.js";
import {
  classifyDrug,
  decodeBenefitType,
  loadClassificationFile,
  resolveBenefitType,
} from "../../src/domain/medicare/part-d-cost/classification.js";
import {
  formatCents,
  parseDecimal,
  roundHalfUpCents,
} from "../../src/domain/medicare/part-d-cost/decimal.js";
import type {
  BenefitType,
  EngineDeps,
  EstimateRequest,
  EstimateResult,
  FillResult,
  PriceEvidence,
} from "../../src/domain/medicare/part-d-cost/engine.js";
import {
  createEstimator,
  engineDeps,
} from "../../src/domain/medicare/part-d-cost/engine.js";
import type { DrugProgram } from "../../src/domain/medicare/part-d-cost/program-rules.js";
import type {
  BenefitBundle,
  ChannelCost,
  InsulinCost,
  MoneyFigure,
  Package,
  RowRef,
  TierCost,
} from "../../src/domain/medicare/part-d-cost/repository.js";
import {
  bundleProvenanceProblems,
  decodeFlag,
  readBenefitBundle,
  readPbpBenefitType,
  yearRules,
} from "../../src/domain/medicare/part-d-cost/repository.js";
import type { Database } from "../../src/db/database.js";
import { migrate } from "../../src/db/migrate.js";
import type { Transport } from "../../src/fetch/index.js";
import { streamZipMember } from "../../src/fetch/index.js";
import { importMedicare } from "../../src/ingest/medicare/command.js";
import { archiveLimits } from "../../src/ingest/medicare/sources.js";
import {
  acquireSpuf,
  cachedSpuf,
  importSpuf,
  parseSpufUrl,
  spufChannels,
  spufTableRows,
} from "../../src/ingest/medicare/spuf.js";
import type { SpufKind } from "../../src/ingest/medicare/spuf.js";
import { memberText, tabTable } from "../../src/ingest/medicare/tabular.js";
import { readXlsxRows } from "../../src/ingest/xlsx/index.js";
import {
  fixtureDirectory,
  lookup,
  seedCache,
  spufArchive,
  spufUrl,
  xlsx,
} from "../ingest/medicare/helpers.js";
import { coreMigrations, testDatabase } from "../pglite.js";

const file = loadClassificationFile();
const documents = (name: string) =>
  (
    JSON.parse(
      readFileSync(
        new URL(`../../data/medicare-part-d/${name}`, import.meta.url),
        "utf8",
      ),
    ) as {
      documents: {
        id: string;
        contractYear?: number;
        members?: { name: string; sheet: string }[];
      }[];
    }
  ).documents;
const manifest = [
  ...documents("documents.json"),
  ...documents("pbp-documents.json"),
];

// The PBP data dictionary's mrx_benefit_type codes, written out here apart from the pin file.
const DICTIONARY: Record<string, [BenefitType, string]> = {
  "1": ["DS", "Defined Standard"],
  "2": ["AE", "Actuarially Equivalent Standard"],
  "3": ["BA", "Basic Alternative"],
  "4": ["EA", "Enhanced Alternative"],
};

// ---------- pins ----------

/** Problems with the classification pins; the planted edits below must each produce one. */
function pinProblems(pins: ClassificationFile): string[] {
  const problems: string[] = [];
  const years = Object.keys(pins.years).sort();
  if (years.join() !== "2026,2027") problems.push(`years ${years.join()}`);
  for (const year of years) {
    const entry = pins.years[year]!;
    const codes = Object.entries(entry.benefitType.codes);
    if (codes.length !== 4) problems.push(`${year}: ${codes.length} codes`);
    let previousRow = 0;
    for (const [code, pin] of codes) {
      const expected = DICTIONARY[code];
      if (!expected || expected[0] !== pin.type || expected[1] !== pin.label)
        problems.push(`${year}: code ${code} is ${pin.type} ${pin.label}`);
      for (const citation of pin.citations) {
        const doc = manifest.find((item) => item.id === citation.document);
        if (!doc)
          problems.push(`${year}: unknown document ${citation.document}`);
        else if (doc.contractYear !== Number(year))
          problems.push(
            `${year}: code ${code} cites a PBP archive of another year`,
          );
        const member = doc?.members?.find(
          (item) => item.name === citation.member,
        );
        if (!member || member.sheet !== citation.sheet)
          problems.push(
            `${year}: code ${code} cites an unpinned member or sheet`,
          );
        if (citation.quote !== `${code} ${pin.label}`)
          problems.push(`${year}: code ${code} quote ${citation.quote}`);
        if (previousRow && citation.row !== previousRow + 1)
          problems.push(
            `${year}: code ${code} row ${citation.row} out of order`,
          );
        previousRow = citation.row ?? 0;
      }
    }
    const layout = year === "2026" ? "C1" : "C2";
    const flag = entry.selectedDrugFlag;
    if (
      flag.field !== "SELECTED_DRUG_YN" ||
      flag.yes !== "Y" ||
      flag.no !== "N"
    )
      problems.push(`${year}: selected-drug flag field`);
    if (!flag.citations.some((citation) => citation.document === layout))
      problems.push(`${year}: selected-drug flag does not cite ${layout}`);
    for (const citation of flag.citations) {
      if (!manifest.some((item) => item.id === citation.document))
        problems.push(`${year}: unknown document ${citation.document}`);
      if (!citation.quote?.trim())
        problems.push(`${year}: citation without a quote`);
    }
    for (const key of [
      "insulin",
      "acip_vaccine",
      "manufacturer_discount",
      "selected_drug_list",
    ] as const)
      if (!entry.unsourced[key]?.reason)
        problems.push(`${year}: ${key} reason`);
  }
  return problems;
}
const clone = (): ClassificationFile => JSON.parse(JSON.stringify(file));

describe("classification pins (data/medicare-part-d/drug-classes.json)", () => {
  it("pass every check", () => {
    expect(pinProblems(file)).toEqual([]);
  });
  it("catch a swapped year, a wrong code, a missing year and a lost source", () => {
    const swapped = clone();
    const a = swapped.years["2026"]!.benefitType.codes["4"]!.citations[0]!;
    a.document = "C14";
    a.member = "PBP_Benefits_2027_dictionary.xlsx";
    a.sheet = "PBP_Benefits_2027_dictionary";
    expect(pinProblems(swapped).join()).toContain("another year");

    const relabelled = clone();
    relabelled.years["2027"]!.benefitType.codes["3"]!.type = "EA";
    expect(pinProblems(relabelled).join()).toContain("code 3 is EA");

    const missing = clone();
    delete missing.years["2027"];
    expect(pinProblems(missing).join()).toContain("years 2026");

    const unsourced = clone();
    unsourced.years["2026"]!.selectedDrugFlag.citations = [];
    expect(pinProblems(unsourced).join()).toContain("does not cite C1");
  });
});

// ---------- benefit type ----------

const release = (year = 2026, snapshot = "pbp-synthetic"): PbpRelease => ({
  snapshot_id: snapshot,
  contract_year: year,
  as_of: `${year - 1}-10-01`,
  sha256: "0".repeat(64),
  url: "synthetic",
});
const pbpRow = (code: string | null, row = 2) => ({
  fields: (code === null ? {} : { mrx_benefit_type: code }) as Record<
    string,
    string
  >,
  source_row: row,
});

describe("benefit type from the PBP filing", () => {
  it("decodes every dictionary code with its row and citation", () => {
    for (const year of [2026, 2027])
      for (const [code, [type, label]] of Object.entries(DICTIONARY)) {
        const found = decodeBenefitType(release(year), [pbpRow(code, 7)], null);
        expect(found).toMatchObject({ status: "value", type, code, label });
        expect(found.evidence).toEqual([
          {
            snapshot_id: "pbp-synthetic",
            table: "pbp_mrx",
            source_row: 7,
            fields: ["mrx_benefit_type"],
          },
        ]);
        expect(found.citations[0]!.document).toBe(
          year === 2026 ? "C13" : "C14",
        );
      }
  });
  it("keeps a blank, unknown, disagreeing or missing filing unknown", () => {
    const reason = (found: BenefitTypeEvidence) =>
      found.status === "unknown" ? found.reason : found.type;
    expect(reason(decodeBenefitType(release(), [pbpRow(null)], null))).toBe(
      "benefit_type_not_reported",
    );
    expect(reason(decodeBenefitType(release(), [pbpRow("5")], null))).toBe(
      "unknown_benefit_type_code",
    );
    expect(
      reason(decodeBenefitType(release(), [pbpRow("1"), pbpRow("4", 3)], null)),
    ).toBe("pbp_rows_disagree");
    expect(reason(decodeBenefitType(release(), [], null))).toBe(
      "plan_not_in_pbp_files",
    );
    expect(reason(decodeBenefitType(release(2028), [pbpRow("4")], null))).toBe(
      "benefit_type_codes_not_pinned",
    );
  });
  it("checks the release's own dictionary label where it carries one", () => {
    const one = (codes: Record<string, string>) =>
      decodeBenefitType(release(), [pbpRow("4")], codes);
    expect(one({ "4": "Enhanced  Alternative " }).status).toBe("value");
    expect(one({ "1": "Defined Standard" }).status).toBe("value");
    expect(one({ "4": "Basic Alternative" })).toMatchObject({
      status: "unknown",
      reason: "benefit_type_codes_differ_from_pinned_dictionary",
    });
  });
  it("prefers the filing, refuses a contradicting caller and labels an assertion", () => {
    const filed = decodeBenefitType(release(), [pbpRow("4")], null);
    expect(resolveBenefitType("unknown", filed)).toMatchObject({
      type: "EA",
      origin: "pbp_filing",
    });
    expect(resolveBenefitType("EA", filed)).toMatchObject({ type: "EA" });
    expect(resolveBenefitType("DS", filed)).toEqual({
      conflict: "benefit_type_conflicts_with_plan_filing",
    });
    const blank = decodeBenefitType(release(), [pbpRow(null)], null);
    expect(resolveBenefitType("BA", blank)).toMatchObject({
      type: "BA",
      origin: "caller_assertion",
      evidence: [],
    });
    expect(resolveBenefitType("unknown", blank)).toMatchObject({
      type: "unknown",
      reason: "benefit_type_not_reported",
    });
    expect(resolveBenefitType("unknown", undefined)).toMatchObject({
      type: "unknown",
      reason: "benefit_type_unknown",
    });
  });
});

// ---------- drug classes ----------

let rowCounter = 0;
const ref = (table: RowRef["table"]): RowRef => ({
  snapshot_id: "synthetic",
  table,
  source_row: ++rowCounter,
  fields: [],
});
/**
 * A real NDC-11 on the CMS selected-drug list for 2026 and 2027 (Eliquis 5 mg, C16), and a
 * synthetic NDC on no list. A flagged package gets the listed NDC so the two sources agree.
 */
const LISTED_NDC = "00003089321";
const OFF_LIST_NDC = "00000000001";
const pkg = (
  selected: Package["selected_drug"],
  tier = 1,
  ndc = selected === true ? LISTED_NDC : OFF_LIST_NDC,
): Package => ({
  proxy_ndc: ndc,
  tier,
  prior_authorization: false,
  step_therapy: false,
  quantity_limit: false,
  quantity_limit_amount: null,
  quantity_limit_days: null,
  selected_drug: selected,
  formulary_version: "1",
  evidence: ref("formulary"),
});
const open = {
  insulin: "unknown",
  acip_vaccine: "unknown",
  program: "unknown",
} as const;

describe("drug classes", () => {
  it("settles the selected-drug program from the formulary flag, with its row", () => {
    const flagged = pkg(true);
    const found = classifyDrug(2026, flagged, open);
    if ("conflict" in found) throw new Error(found.conflict);
    expect(found.program.options).toEqual(["selected"]);
    expect(found.program.origin).toBe(
      "formulary_flag_and_cms_selected_drug_list",
    );
    expect(found.program.evidence).toEqual([
      { ...flagged.evidence, fields: ["SELECTED_DRUG_YN"] },
    ]);
    expect(found.program.citations.map((c) => c.document)).toEqual([
      "C1",
      "C3",
      "C16",
      "C15",
      "C15",
      "C23",
    ]);
    const later = classifyDrug(2027, pkg(true), open);
    if ("conflict" in later) throw new Error(later.conflict);
    expect(later.program.citations.map((c) => c.document)).toEqual([
      "C2",
      "C16",
      "C15",
      "C15",
      "C23",
    ]);
  });
  it("leaves applicable and non-applicable open when the flag is N", () => {
    const found = classifyDrug(2026, pkg(false), open);
    if ("conflict" in found) throw new Error(found.conflict);
    expect(found.program.options).toEqual(["applicable", "not_applicable"]);
    expect(found.program.reason).toBe("applicable_drug_list_not_cached");
    const narrowed = classifyDrug(2026, pkg(false), {
      ...open,
      program: "applicable",
    });
    if ("conflict" in narrowed) throw new Error(narrowed.conflict);
    expect(narrowed.program).toMatchObject({
      options: ["applicable"],
      origin: "caller_assertion_within_formulary_flag",
    });
  });
  it("refuses a caller program the flag rules out", () => {
    expect(
      classifyDrug(2026, pkg(false), { ...open, program: "selected" }),
    ).toEqual({
      conflict: "drug_program_conflicts_with_formulary",
    });
    expect(
      classifyDrug(2026, pkg(true), { ...open, program: "not_applicable" }),
    ).toEqual({ conflict: "drug_program_conflicts_with_formulary" });
  });
  it("keeps every program open when neither the flag nor the list settles it", () => {
    const found = classifyDrug(2026, pkg("unknown", 1, "unreadable"), open);
    if ("conflict" in found) throw new Error(found.conflict);
    expect(found.program.options).toEqual([
      "selected",
      "applicable",
      "not_applicable",
    ]);
    expect(found.program.reason).toBe("selected_drug_flag_unknown");
  });
  it("has no source for insulin or vaccine status, so open stays open", () => {
    const found = classifyDrug(2026, pkg(false), open);
    if ("conflict" in found) throw new Error(found.conflict);
    expect(found.insulin).toEqual({
      value: "unknown",
      origin: "unknown",
      reason: "insulin_product_list_not_cached",
    });
    expect(found.acip_vaccine).toEqual({
      value: "unknown",
      origin: "unknown",
      reason: "acip_vaccine_list_not_cached",
    });
    const asserted = classifyDrug(2026, pkg(false), {
      ...open,
      insulin: true,
    });
    if ("conflict" in asserted) throw new Error(asserted.conflict);
    expect(asserted.insulin).toEqual({
      value: true,
      origin: "caller_assertion",
      reason: null,
    });
  });
});

// ---------- engine with evidence-backed facts (synthetic bundles) ----------

const d = (text: string) => parseDecimal(text)!;
const money = (cents: number): MoneyFigure => ({
  status: "value",
  cents,
  raw: formatCents(BigInt(cents)),
});
const toCents = (text: string) => Number(roundHalfUpCents(d(text)));
function channels(spec: { copay?: string; rate?: string }): ChannelCost[] {
  return spufChannels.map((channel) => ({
    channel: channel.channel,
    status: spec.copay !== undefined ? "copay" : "coinsurance",
    amount:
      spec.copay !== undefined
        ? money(toCents(spec.copay))
        : {
            status: "value",
            rate: spec.rate!,
            basis_points: toCents(spec.rate!) * 100,
            raw: spec.rate!,
          },
    minimum: money(0),
    maximum: money(0),
    reason: null,
  }));
}
const tier = (
  phase: TierCost["phase"],
  spec: { copay?: string; rate?: string },
  deductible = true,
  tierNumber = 1,
): TierCost => ({
  tier: tierNumber,
  phase,
  supply: "30_days",
  specialty_tier: false,
  deductible_applies: deductible,
  channels: channels(spec),
  evidence: [ref("beneficiary_cost")],
});
const insulinCost = (
  tierNumber: number,
  copay: string,
  coinsurance: string,
): InsulinCost => ({
  tier: tierNumber,
  supply: "30_days",
  channels: spufChannels.map((channel) => ({
    channel: channel.channel,
    status: "filed",
    copay: money(toCents(copay)),
    coinsurance: {
      status: "value",
      rate: coinsurance,
      basis_points: toCents(coinsurance) * 100,
      raw: coinsurance,
    },
    reason: null,
    derived_from: [],
  })),
  evidence: [ref("insulin_cost")],
});
const filed = (code: string | null, year = 2026): BenefitTypeEvidence =>
  decodeBenefitType(release(year), [pbpRow(code, 11)], null);

function plan(spec: {
  benefit?: BenefitTypeEvidence;
  deductibleCents: number;
  tiers: TierCost[];
  insulin?: InsulinCost[];
  selected: Package["selected_drug"];
  tierNumber?: number;
  ndc?: string;
}): BenefitBundle {
  return {
    status: "available",
    bundle_version: "1",
    plan_key: "H9000-001-0",
    contract_year: 2026,
    release: {
      snapshot_id: "synthetic",
      kind: "synthetic",
      contract_year: 2026,
      as_of: "2026-01-01",
      sha256: "0".repeat(64),
      url: "synthetic",
    },
    formulary_id: "00000001",
    deductible: money(spec.deductibleCents),
    deductible_evidence: [ref("plan")],
    special_needs_plan: {
      status: "value",
      code: "0",
      snp: false,
      evidence: [{ ...ref("plan"), fields: ["SNP"] }],
    },
    ...(spec.benefit ? { benefit_type: spec.benefit } : {}),
    tiers: spec.tiers,
    insulin: spec.insulin ?? [],
    drugs: [
      {
        rxcui: "2000",
        status: "listed",
        reason: null,
        product: "single",
        packages: [pkg(spec.selected, spec.tierNumber ?? 1, spec.ndc)],
        supplemental: [],
        indications: [],
      },
    ],
    rules: yearRules(2026),
    conflicts: [],
    gaps: [],
  };
}
function estimate(
  bundle: BenefitBundle,
  options: {
    benefit?: BenefitType | "unknown";
    price: string;
    troop: string;
    gross: string;
    met?: number;
    insulin?: boolean | "unknown";
    vaccine?: boolean | "unknown";
    program?: DrugProgram | "unknown";
    deps?: EngineDeps;
  },
): EstimateResult {
  const troop = toCents(options.troop);
  const gross = toCents(options.gross);
  const input: EstimateRequest = {
    contract_year: 2026,
    scenario: "non_lis_no_other_payer",
    benefit_type: options.benefit ?? "unknown",
    bundle,
    channel: "preferred_retail",
    opening:
      troop || gross
        ? {
            kind: "provided",
            as_of: "2026-06-01",
            gross_cents: gross,
            troop_cents: troop,
            plan_deductible_met_cents: options.met ?? 0,
          }
        : { kind: "new_calendar_year" },
    fills: [
      {
        fill_id: "f1",
        date: "2026-06-01",
        rxcui: "2000",
        days_supply: 30,
        quantity: "30",
        unit: "unit",
        classification: {
          insulin: options.insulin ?? "unknown",
          acip_vaccine: options.vaccine ?? "unknown",
          program: options.program ?? "unknown",
        },
      },
    ],
    prices: {
      f1: {
        status: "value",
        amount: options.price,
        basis: "cms_worked_example",
        reference: "C7 section 1",
      } satisfies PriceEvidence,
    },
  };
  return createEstimator(options.deps ?? engineDeps)(input);
}
const fillOf = (result: EstimateResult): FillResult => {
  if (!("fills" in result)) throw new Error(JSON.stringify(result));
  return result.fills[0]!;
};
const shown = (figure: FillResult["patient_pay"]) =>
  figure.status === "value"
    ? formatCents(BigInt(figure.cents))
    : `unknown:${figure.reason}`;

interface Oracle {
  id: string;
  inputs: Record<string, string>;
  expected: Record<string, string>;
}
const oracles = (
  JSON.parse(
    readFileSync(
      new URL("../fixtures/medicare-costs/oracles.json", import.meta.url),
      "utf8",
    ),
  ) as { workedExamples: Oracle[] }
).workedExamples;
const oracle = (id: string) => oracles.find((item) => item.id === id)!;

/** C7 example 5: an EA plan with a $400 deductible and 20% coinsurance; the selected flag is Y. */
const eaPlan = (benefit?: BenefitTypeEvidence) =>
  plan({
    benefit,
    deductibleCents: 40000,
    tiers: [tier("initial_coverage", { rate: "0.20" })],
    selected: true,
  });
function eaFigures(result: EstimateResult) {
  const f = fillOf(result);
  return {
    patientPay: shown(f.patient_pay),
    troopIncrement: shown(f.troop_increment),
    grossBelowThreshold: shown(f.gross_below_threshold),
    grossAboveThreshold: shown(f.gross_above_threshold),
    selectedDrugSubsidy: shown(f.selected_drug_subsidy),
    coveredPlanPaid: shown(f.covered_plan_paid),
    nonCoveredPlanPaid: shown(f.non_covered_plan_paid),
    beginningPhase: f.plan_phase?.begin ?? "none",
    endingPhase: f.plan_phase?.end ?? "none",
  };
}
const ea = oracle("ea-mapping-crossing");
const eaRun = (benefit?: BenefitTypeEvidence, deps?: EngineDeps) =>
  estimate(eaPlan(benefit), {
    price: ea.inputs.grossDrugCost!,
    troop: ea.inputs.openingTroop!,
    gross: ea.inputs.openingGrossCoveredDrugCost!,
    // All opening TrOOP went to the $400 plan deductible.
    met: toCents(ea.inputs.openingTroop!),
    insulin: false,
    vaccine: false,
    deps,
  });

/** C7 example 3: copay ceiling for a selected drug on a BA plan. */
const sel = oracle("selected-drug-copay-ceiling");
const selectedRun = (
  selected: Package["selected_drug"],
  deps?: EngineDeps,
  program: DrugProgram | "unknown" = "unknown",
  ndc?: string,
) =>
  estimate(
    plan({
      benefit: filed("3"),
      deductibleCents: 0,
      tiers: [
        tier("initial_coverage", { copay: sel.inputs.filedCopay! }, false),
      ],
      selected,
      ndc,
    }),
    {
      price: sel.inputs.grossDrugCost!,
      troop: sel.inputs.openingTroop!,
      gross: sel.inputs.openingGrossCoveredDrugCost!,
      insulin: false,
      vaccine: false,
      program,
      deps,
    },
  );

/**
 * C7 examples 8 and 9: covered insulin on a basic or an EA plan; the insulin status is asserted.
 * The tier's own 50% coinsurance is synthetic, so a drug on the tier that is not insulin pays a
 * different amount from the insulin ceiling.
 */
const insulinRun = (
  id: "insulin-lesser-of" | "insulin-catastrophic-crossing",
  benefitCode: string,
  insulin: boolean | "unknown",
  deps?: EngineDeps,
) => {
  const example = oracle(id);
  return estimate(
    plan({
      benefit: filed(benefitCode),
      deductibleCents: 0,
      tiers: [tier("initial_coverage", { rate: "0.50" }, false, 3)],
      insulin: [
        insulinCost(
          3,
          example.inputs.insulinCopay!,
          example.inputs.insulinCoinsurance!,
        ),
      ],
      selected: false,
      tierNumber: 3,
    }),
    {
      price: example.inputs.grossDrugCost!,
      troop: example.inputs.openingTroop!,
      gross: example.inputs.openingGrossCoveredDrugCost!,
      insulin,
      vaccine: false,
      program: "applicable",
      deps,
    },
  );
};
const vaccineRun = (vaccine: boolean | "unknown", deps?: EngineDeps) =>
  estimate(
    plan({
      benefit: filed("1"),
      deductibleCents: 61500,
      tiers: [tier("initial_coverage", { rate: "0.25" })],
      selected: false,
    }),
    {
      price: "200.00",
      troop: "0",
      gross: "0",
      insulin: false,
      vaccine,
      program: "not_applicable",
      deps,
    },
  );

/** Named checks a correct engine passes; each planted mutant must fail at least one. */
function failingChecks(deps: EngineDeps = engineDeps): string[] {
  const failures: string[] = [];
  const check = (name: string, ok: boolean) => {
    if (!ok) failures.push(name);
  };
  const got: Record<string, string> = eaFigures(eaRun(filed("4"), deps));
  check(
    "ea oracle from the EA filing",
    Object.entries(ea.expected).every(
      ([key, value]) => !(key in got) || got[key] === value,
    ),
  );
  const conflict = estimate(eaPlan(filed("4")), {
    benefit: "DS",
    price: "10.00",
    troop: "0",
    gross: "0",
    insulin: false,
    vaccine: false,
    deps,
  });
  check(
    "caller type contradicting the filing",
    conflict.status === "unknown" &&
      "reason" in conflict &&
      conflict.reason === "benefit_type_conflicts_with_plan_filing",
  );
  // An NDC the list cannot read leaves the flag as the only source.
  const selected = fillOf(selectedRun(true, deps, "unknown", "unreadable"));
  check(
    "selected ceiling from the formulary flag",
    shown(selected.patient_pay) === sel.expected.patientPay &&
      shown(selected.selected_drug_subsidy) ===
        sel.expected.selectedDrugSubsidy,
  );
  check(
    "flag N refuses a selected-drug claim",
    fillOf(selectedRun(false, deps, "selected", "unreadable")).patient_pay
      .status === "unknown",
  );
  const lesser = oracle("insulin-lesser-of");
  check(
    "asserted insulin oracle",
    shown(
      fillOf(insulinRun("insulin-lesser-of", "3", true, deps)).patient_pay,
    ) === lesser.expected.patientPay,
  );
  const unknownInsulin = fillOf(
    insulinRun("insulin-lesser-of", "3", "unknown", deps),
  );
  check(
    "open insulin status stays unknown",
    unknownInsulin.patient_pay.status === "unknown",
  );
  check(
    "tier insulin row does not make the drug insulin",
    fillOf(insulinRun("insulin-lesser-of", "3", false, deps)).patient_pay
      .status === "value" &&
      shown(
        fillOf(insulinRun("insulin-lesser-of", "3", false, deps)).patient_pay,
      ) !== lesser.expected.patientPay,
  );
  check(
    "asserted vaccine pays nothing",
    shown(fillOf(vaccineRun(true, deps)).patient_pay) === "0.00",
  );
  check(
    "open vaccine status stays unknown",
    fillOf(vaccineRun("unknown", deps)).patient_pay.status === "unknown",
  );
  return failures;
}

describe("CMS worked examples with facts from evidence", () => {
  it("C7 example 5 (EA mapping) with the type from the PBP filing", () => {
    const result = eaRun(filed("4"));
    for (const [key, value] of Object.entries(eaFigures(result)))
      if (key in ea.expected) expect(value, key).toBe(ea.expected[key]);
    if (!("fills" in result)) throw new Error("no fills");
    expect(result.benefit_type).toMatchObject({
      value: "EA",
      origin: "pbp_filing",
    });
    const f = result.fills[0]!;
    expect(f.evidence).toContainEqual({
      kind: "pbp_row",
      snapshot_id: "pbp-synthetic",
      table: "pbp_mrx",
      source_row: 11,
      fields: ["mrx_benefit_type"],
    });
    expect(
      f.evidence.some(
        (item) =>
          item.kind === "rule" && item.document === "C13" && item.row === 25382,
      ),
    ).toBe(true);
    expect(result.rules_documents.map((doc) => doc.id)).toEqual(
      expect.arrayContaining(["C1", "C13"]),
    );
  });
  it("the same claim on a basic plan filing does not reproduce the EA figures", () => {
    for (const code of ["1", "2", "3"]) {
      const figures = eaFigures(eaRun(filed(code)));
      expect(figures.troopIncrement, code).not.toBe(ea.expected.troopIncrement);
    }
  });
  it("an unknown filing with no caller type leaves the EA amounts unknown, saying why", () => {
    const result = eaRun(filed(null));
    const f = fillOf(result);
    expect(f.troop_increment.status).toBe("unknown");
    if (!("gaps" in result)) throw new Error("no gaps");
    expect(result.gaps).toEqual(
      expect.arrayContaining([
        "benefit_type_unknown",
        "benefit_type_not_reported",
      ]),
    );
    expect(result.benefit_type).toMatchObject({
      value: "unknown",
      origin: "unknown",
      reason: "benefit_type_not_reported",
    });
  });
  it("a bundle without a PBP read behaves as before: the caller's type is an assertion", () => {
    const result = estimate(eaPlan(), {
      benefit: "EA",
      price: ea.inputs.grossDrugCost!,
      troop: ea.inputs.openingTroop!,
      gross: ea.inputs.openingGrossCoveredDrugCost!,
      met: toCents(ea.inputs.openingTroop!),
      insulin: false,
      vaccine: false,
    });
    expect(eaFigures(result).patientPay).toBe(ea.expected.patientPay);
    if (!("fills" in result)) throw new Error("no fills");
    expect(result.benefit_type).toMatchObject({
      value: "EA",
      origin: "caller_assertion",
      evidence: [],
    });
  });
  it("C7 example 3 (selected-drug ceiling) with the program from the formulary flag", () => {
    const f = fillOf(selectedRun(true));
    expect(shown(f.patient_pay)).toBe(sel.expected.patientPay);
    expect(shown(f.selected_drug_subsidy)).toBe(
      sel.expected.selectedDrugSubsidy,
    );
    expect(shown(f.troop_increment)).toBe(sel.expected.troopIncrement);
    expect(f.classification?.program).toMatchObject({
      options: ["selected"],
      origin: "formulary_flag_and_cms_selected_drug_list",
    });
    expect(
      f.evidence.some(
        (item) =>
          item.kind === "source_row" &&
          item.table === "formulary" &&
          item.fields.includes("SELECTED_DRUG_YN"),
      ),
    ).toBe(true);
  });
  it("a drug the flag marks N cannot take the selected-drug ceiling", () => {
    // Not selected and not a known applicable drug: the full $40 copay.
    const f = fillOf(selectedRun(false, undefined, "not_applicable"));
    expect(shown(f.patient_pay)).toBe("40.00");
    expect(f.classification?.program.origin).toBe(
      "caller_assertion_within_formulary_flag",
    );
    // Left open, the discount-program question decides the amount, and no cached file answers it.
    const result = selectedRun(false);
    expect(fillOf(result).patient_pay).toMatchObject({
      status: "unknown",
      reason: expect.stringContaining("drug_program_unknown"),
    });
    if (!("gaps" in result)) throw new Error("no gaps");
    expect(result.gaps).toContain("applicable_drug_list_not_cached");
    expect(
      fillOf(selectedRun(false, undefined, "selected")).patient_pay,
    ).toMatchObject({
      status: "unknown",
      reason: "drug_program_conflicts_with_formulary",
    });
  });
  it("with an unreadable flag the CMS list settles the selected-drug ceiling", () => {
    const f = fillOf(selectedRun("unknown", undefined, "unknown", LISTED_NDC));
    expect(shown(f.patient_pay)).toBe(sel.expected.patientPay);
    expect(f.classification?.program).toMatchObject({
      options: ["selected"],
      origin: "cms_selected_drug_list",
    });
    expect(
      f.evidence.some(
        (item) =>
          item.kind === "rule" &&
          item.document === "C16" &&
          item.row !== undefined,
      ),
    ).toBe(true);
  });
  it("an unreadable flag and no list entry leave the copay ceiling unknown", () => {
    const result = selectedRun("unknown", undefined, "unknown", "unreadable");
    expect(fillOf(result).patient_pay).toMatchObject({
      status: "unknown",
      reason: expect.stringContaining("drug_program_unknown"),
    });
    if (!("gaps" in result)) throw new Error("no gaps");
    expect(result.gaps).toContain("selected_drug_flag_unknown");
  });
  it("C7 examples 8 and 9 (insulin) on a BA and an EA filing, insulin asserted", () => {
    for (const code of ["3", "4"])
      for (const id of [
        "insulin-lesser-of",
        "insulin-catastrophic-crossing",
      ] as const) {
        const example = oracle(id);
        const f = fillOf(insulinRun(id, code, true));
        expect(shown(f.patient_pay), `${id} ${code}`).toBe(
          example.expected.patientPay,
        );
        expect(shown(f.troop_increment), `${id} ${code}`).toBe(
          example.expected.troopIncrement,
        );
        expect(f.classification?.insulin.origin).toBe("caller_assertion");
      }
  });
  it("a plan's insulin row for a tier never makes a drug on that tier insulin", () => {
    const result = insulinRun("insulin-lesser-of", "3", "unknown");
    const f = fillOf(result);
    expect(f.patient_pay).toMatchObject({
      status: "unknown",
      reason: expect.stringContaining("insulin_classification_unknown"),
    });
    if (!("gaps" in result)) throw new Error("no gaps");
    expect(result.gaps).toContain("insulin_product_list_not_cached");
    // Declared not insulin, the drug pays the tier's synthetic 50%, not the insulin ceiling.
    expect(
      shown(fillOf(insulinRun("insulin-lesser-of", "3", false)).patient_pay),
    ).toBe("50.00");
  });
  it("an ACIP vaccine pays nothing when asserted; open status stays unknown", () => {
    expect(shown(fillOf(vaccineRun(true)).patient_pay)).toBe("0.00");
    const result = vaccineRun("unknown");
    expect(fillOf(result).patient_pay).toMatchObject({
      status: "unknown",
      reason: expect.stringContaining("vaccine_classification_unknown"),
    });
    if (!("gaps" in result)) throw new Error("no gaps");
    expect(result.gaps).toContain("acip_vaccine_list_not_cached");
  });
});

describe("planted mutants (classification)", () => {
  it("the real engine passes every check", () => {
    expect(failingChecks()).toEqual([]);
  });
  const mutant = (classify: Partial<EngineDeps["classify"]>): EngineDeps => ({
    ...engineDeps,
    classify: { ...engineDeps.classify, ...classify },
  });
  it("catches a resolver that lets the caller override the filing", () => {
    const deps = mutant({
      benefitType: (caller, filedType) =>
        caller === "unknown"
          ? resolveBenefitType(caller, filedType)
          : resolveBenefitType(caller, undefined),
    });
    expect(failingChecks(deps)).toContain(
      "caller type contradicting the filing",
    );
  });
  it("catches an EA filing mapped as a basic plan", () => {
    const deps = mutant({
      benefitType: (caller, filedType) => {
        const found = resolveBenefitType(caller, filedType);
        return "type" in found && found.type === "EA"
          ? { ...found, type: "BA" }
          : found;
      },
    });
    expect(failingChecks(deps)).toContain("ea oracle from the EA filing");
  });
  it("catches a classifier that ignores the formulary flag", () => {
    const deps = mutant({
      drug: (year, item, caller) =>
        classifyDrug(year, { ...item, selected_drug: "unknown" }, caller),
    });
    expect(failingChecks(deps)).toEqual(
      expect.arrayContaining([
        "selected ceiling from the formulary flag",
        "flag N refuses a selected-drug claim",
      ]),
    );
  });
  it("catches a classifier that guesses insulin or vaccine status", () => {
    const guessInsulin = mutant({
      drug: (year, item, caller) =>
        classifyDrug(year, item, {
          ...caller,
          insulin: caller.insulin === "unknown" ? true : caller.insulin,
        }),
    });
    expect(failingChecks(guessInsulin)).toContain(
      "open insulin status stays unknown",
    );
    const guessVaccine = mutant({
      drug: (year, item, caller) =>
        classifyDrug(year, item, {
          ...caller,
          acip_vaccine:
            caller.acip_vaccine === "unknown" ? false : caller.acip_vaccine,
        }),
    });
    expect(failingChecks(guessVaccine)).toContain(
      "open vaccine status stays unknown",
    );
  });
  it("catches insulin inferred from the plan's insulin tier", () => {
    const deps = mutant({
      drug: (year, item, caller) =>
        classifyDrug(year, item, {
          ...caller,
          insulin: item.tier === 3 ? true : caller.insulin,
        }),
    });
    expect(failingChecks(deps)).toContain(
      "tier insulin row does not make the drug insulin",
    );
  });
});

// ---------- reading the filing from imported fixture archives ----------

/** The fixture PBP pbp_mrx.txt, read here apart from the importer: plan key to raw code. */
async function rawFixtureTypes(): Promise<Map<string, string>> {
  const text = await readFile(
    join(fixtureDirectory, "pbp", "pbp_mrx.txt"),
    "latin1",
  );
  const [head, ...lines] = text.split(/\r?\n/).filter((line) => line !== "");
  const header = head!.split("\t").map((cell) => cell.trim().toLowerCase());
  const at = (name: string) => header.indexOf(name);
  const out = new Map<string, string>();
  for (const line of lines) {
    const cells = line.split("\t");
    out.set(
      `${cells[at("pbp_a_hnumber")]!.trim()}-${cells[at("pbp_a_plan_identifier")]!.trim()}-${Number(cells[at("segment_id")])}`,
      (cells[at("mrx_benefit_type")] ?? "").trim(),
    );
  }
  return out;
}

/** Adds dictionary rows for mrx_benefit_type to the fixture workbook (code 4 under `label`). */
const withDictionaryLabel =
  (label: string) => (family: string, files: Record<string, Buffer>) => {
    if (family !== "pbp") return;
    const text = readFileSync(
      join(fixtureDirectory, "pbp", "dictionary.tsv"),
      "utf8",
    );
    const rows = text
      .split(/\r?\n/)
      .filter((line) => line !== "")
      .map((line) => line.split("\t"));
    rows.push([
      "pbp_mrx",
      "mrx_benefit_type",
      "CHAR",
      "1",
      "",
      "Type of drug benefit",
      "Type of drug benefit",
      "MRx Drug Benefit Type",
      "4",
      label,
      "",
    ]);
    files["PBP_Benefits_2026_dictionary.xlsx"] = xlsx(rows);
  };
/** Rewrites one plan's mrx_benefit_type cell in the fixture pbp_mrx.txt. */
const withCode =
  (planPrefix: string, code: string) =>
  (family: string, files: Record<string, Buffer>) => {
    if (family !== "pbp") return;
    const text = files["pbp_mrx.txt"]!.toString("latin1");
    const lines = text.split("\n");
    const header = lines[0]!.replace(/\r$/, "").split("\t");
    const at = header.findIndex(
      (cell) => cell.trim().toLowerCase() === "mrx_benefit_type",
    );
    let changed = 0;
    for (let i = 1; i < lines.length; i++) {
      const cells = lines[i]!.split("\t");
      if (cells.slice(0, 2).join("-") !== planPrefix) continue;
      cells[at] = code;
      lines[i] = cells.join("\t");
      changed++;
    }
    if (changed !== 1)
      throw new Error(`edit of ${planPrefix} changed ${changed} rows`);
    files["pbp_mrx.txt"] = Buffer.from(lines.join("\n"), "latin1");
  };

describe("benefit type read from imported fixture archives", () => {
  const opened: { db: Database; dir: string }[] = [];
  let directory: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "part-d-special-"));
  });
  afterAll(async () => {
    for (const item of opened) await item.db.close();
    await rm(directory, { recursive: true, force: true });
  });
  async function imported(
    mutate?: Parameters<typeof seedCache>[1],
    withSpuf = false,
  ): Promise<Database> {
    const migrations = await coreMigrations();
    const dataDir = await mkdtemp(join(directory, "cache-"));
    const db = testDatabase(new PGlite());
    opened.push({ db, dir: dataDir });
    try {
      await migrate(db, migrations.directory);
      await seedCache(dataDir, mutate);
      await importMedicare(db, { year: 2026, family: "pbp" }, dataDir);
      if (withSpuf) {
        const bytes = await spufArchive();
        const transport: Transport = async () => ({
          status: 200,
          headers: { "content-type": "application/zip" },
          body: Readable.from([bytes]),
        });
        const archive = parseSpufUrl(spufUrl)!;
        await acquireSpuf(archive, {
          dataDir,
          dependencies: { lookup, transport },
        });
        await importSpuf(db, (await cachedSpuf(archive.kind, dataDir))[0]!);
      }
      return db;
    } finally {
      await migrations.cleanup();
    }
  }
  const read = (db: Database, key: string, year = 2026) =>
    readPbpBenefitType(db, parsePlanKey(key)!, year);
  const summary = (found: BenefitTypeEvidence) =>
    found.status === "value" ? found.type : `unknown:${found.reason}`;

  it("matches a separate reading of the raw fixture for every plan", async () => {
    const db = await imported();
    const raw = await rawFixtureTypes();
    expect(raw.size).toBe(7);
    for (const [key, code] of raw) {
      const found = await read(db, key);
      const expected = code
        ? DICTIONARY[code]![0]
        : "unknown:benefit_type_not_reported";
      expect(summary(found), key).toBe(expected);
      expect(found.evidence).toHaveLength(1);
      expect(found.release?.contract_year).toBe(2026);
    }
    expect(summary(await read(db, "H9999-001-0"))).toBe(
      "unknown:plan_not_in_pbp_files",
    );
    expect(summary(await read(db, "H0028-042-0", 2027))).toBe(
      "unknown:pbp_not_loaded",
    );
  }, 180_000);

  it("catches an edited filing and a disagreeing release dictionary", async () => {
    const edited = await imported(withCode("S4802-013", "4"));
    expect(summary(await read(edited, "S4802-013-0"))).toBe("EA");
    const agrees = await imported(withDictionaryLabel("Enhanced Alternative"));
    expect(summary(await read(agrees, "H0028-042-0"))).toBe("EA");
    const differs = await imported(withDictionaryLabel("Basic Alternative"));
    expect(summary(await read(differs, "H0028-042-0"))).toBe(
      "unknown:benefit_type_codes_differ_from_pinned_dictionary",
    );
    // Other codes the release dictionary does not carry still decode from the pins.
    expect(summary(await read(differs, "S4802-013-0"))).toBe("AE");
  }, 300_000);

  it("puts the filing in the benefit bundle with its PBP source row", async () => {
    const db = await imported(undefined, true);
    const bundle = await readBenefitBundle(db, {
      plan: parsePlanKey("H0028-042-0")!,
      year: 2026,
      rxcuis: ["861007"],
    });
    if (bundle.status !== "available") throw new Error(bundle.reason);
    expect(bundle.benefit_type).toMatchObject({
      status: "value",
      type: "EA",
      code: "4",
    });
    expect(bundle.benefit_type?.release?.snapshot_id).not.toBe(
      bundle.release.snapshot_id,
    );
    expect(bundle.gaps).not.toContain("benefit_mapping_unknown");
    expect(bundleProvenanceProblems(bundle)).toEqual([]);
    const broken: BenefitBundle = {
      ...bundle,
      benefit_type: {
        ...(bundle.benefit_type as Extract<
          BenefitTypeEvidence,
          { status: "value" }
        >),
        evidence: [],
      },
    };
    expect(bundleProvenanceProblems(broken)).toContain(
      "benefit type: no source row",
    );
    const blank = await readBenefitBundle(db, {
      plan: parsePlanKey("R4182-001-0")!,
      year: 2026,
      rxcuis: [],
    });
    if (blank.status === "available") {
      expect(blank.benefit_type?.status).toBe("unknown");
      expect(blank.gaps).toContain("benefit_mapping_unknown");
    }
  }, 300_000);
});

// ---------- cached CMS archives (OPENPLANS_DATA_DIR) ----------

interface Cached {
  kind: SpufKind;
  year: number;
  spuf: string;
  pbp: string;
  /** From a separate tab split of pbp_mrx.txt: rows by raw mrx_benefit_type. */
  pbpCodes: Record<string, number>;
  /** SPUF plan segments by the benefit type of their PBP row. */
  planTypes: Record<string, number>;
  /** Distinct RxCUIs whose formulary rows say SELECTED_DRUG_YN = Y. */
  selectedRxcuis: number;
  selectedRows: number;
  formularyRows: number;
}
// Counts taken separately from the raw text with a pipe and tab split.
const cachedArchives: Cached[] = [
  {
    kind: "quarterly",
    year: 2026,
    spuf: "16315ea97f043eea8f8539dc2ac2d8343b8054890e12615953767a8b6688d82b",
    pbp: "1720048e668f6c9e4abc47c512e537c013600de12860d28aea4f8308b5e51de4",
    pbpCodes: { "1": 310, "2": 184, "3": 273, "4": 4765, "": 2547 },
    planTypes: { DS: 307, AE: 184, BA: 273, EA: 4754 },
    selectedRxcuis: 46,
    selectedRows: 12424,
    formularyRows: 1129364,
  },
  {
    kind: "monthly",
    year: 2027,
    spuf: "5f3bbe4e9ca29bce965403f3780d66452ec446cef5bf01fa050d3c6a990f053c",
    pbp: "6d8430e2ecb51acf3cc8547f12dd73506aa73f0dccf034cc3c3393868576ff47",
    pbpCodes: { "1": 207, "2": 194, "3": 27, "4": 5067, "": 2476 },
    planTypes: { DS: 207, AE: 194, BA: 27, EA: 5067 },
    selectedRxcuis: 94,
    selectedRows: 25754,
    formularyRows: 963666,
  },
];
const dataDir = process.env.OPENPLANS_DATA_DIR;
const pbpPath = (sha: string) =>
  dataDir ? join(dataDir, "raw", "cms-medicare-pbp", sha, "payload") : "";
const located = await Promise.all(
  cachedArchives.map(async (expected) => {
    if (!dataDir || !existsSync(pbpPath(expected.pbp))) return null;
    const cached = await cachedSpuf(expected.kind, dataDir);
    return (
      cached.find(
        (entry) =>
          entry.metadata.sha256 === expected.spuf &&
          entry.archive.year === expected.year,
      ) ?? null
    );
  }),
);
const planKey = (contract = "", planId = "", segment = "") =>
  `${contract.trim()}-${planId.trim()}-${Number(segment)}`;

describe.each(
  cachedArchives.map((expected, i) => [expected.year, expected, i] as const),
)("cached %i archives", (_year, expected, index) => {
  const cached = located[index];
  it.skipIf(!cached)(
    "give every Part D plan a benefit type from its PBP row",
    async () => {
      const table = await tabTable(
        memberText(
          pbpPath(expected.pbp),
          "pbp_mrx.txt",
          archiveLimits.pbp,
          "windows-1252",
        ),
      );
      const column = (name: string) =>
        table.header.findIndex((cell) => cell.trim().toLowerCase() === name);
      const [h, p, s, b] = [
        "pbp_a_hnumber",
        "pbp_a_plan_identifier",
        "segment_id",
        "mrx_benefit_type",
      ].map(column);
      const pbp = release(expected.year, "cache");
      const decoded = new Map<string, BenefitTypeEvidence>();
      const codes: Record<string, number> = {};
      for await (const row of table.rows) {
        const code = (row.fields[b!] ?? "").trim();
        codes[code] = (codes[code] ?? 0) + 1;
        const key = planKey(row.fields[h!], row.fields[p!], row.fields[s!]);
        expect(decoded.has(key), key).toBe(false);
        decoded.set(
          key,
          decodeBenefitType(
            pbp,
            [
              {
                fields: code ? { mrx_benefit_type: code } : {},
                source_row: row.rowNumber,
              },
            ],
            null,
          ),
        );
      }
      expect(codes).toEqual(expected.pbpCodes);
      const types: Record<string, number> = {};
      const seen = new Set<string>();
      for await (const row of spufTableRows(cached!.path, "plan")) {
        const key = planKey(
          row.values.CONTRACT_ID,
          row.values.PLAN_ID,
          row.values.SEGMENT_ID,
        );
        if (seen.has(key)) continue;
        seen.add(key);
        const found = decoded.get(key);
        let name = "missing";
        if (found)
          name =
            found.status === "value" ? found.type : `unknown:${found.reason}`;
        types[name] = (types[name] ?? 0) + 1;
      }
      expect(types).toEqual(expected.planTypes);
    },
    600_000,
  );
  it.skipIf(!cached)(
    "flag selected drugs consistently: an RxCUI is never both Y and N",
    async () => {
      const byRxcui = new Map<string, Set<string>>();
      let rows = 0;
      let selectedRows = 0;
      for await (const row of spufTableRows(cached!.path, "formulary")) {
        rows++;
        const flag = decodeFlag(row.values.SELECTED_DRUG_YN);
        expect(flag, `row ${row.rowNumber}`).not.toBe("unknown");
        if (flag === true) selectedRows++;
        const rxcui = row.values.RXCUI!.trim();
        const set = byRxcui.get(rxcui) ?? new Set<string>();
        set.add(String(flag));
        byRxcui.set(rxcui, set);
      }
      expect(rows).toBe(expected.formularyRows);
      expect(selectedRows).toBe(expected.selectedRows);
      expect([...byRxcui.values()].filter((set) => set.size > 1)).toEqual([]);
      expect(
        [...byRxcui.values()].filter((set) => set.has("true")).length,
      ).toBe(expected.selectedRxcuis);
    },
    600_000,
  );
  it.skipIf(!cached)(
    "cite dictionary rows that say what the pins quote",
    async () => {
      const pins = file.years[String(expected.year)]!.benefitType;
      const citations = Object.values(pins.codes).flatMap(
        (code) => code.citations,
      );
      const member = citations[0]!.member!;
      const directory = await mkdtemp(join(tmpdir(), "openplans-pbp-classes-"));
      try {
        const path = join(directory, "dictionary.xlsx");
        await pipeline(
          Readable.from(
            streamZipMember(pbpPath(expected.pbp), member, archiveLimits.pbp),
          ),
          createWriteStream(path, { flags: "wx" }),
        );
        const rows: string[][] = [];
        for await (const row of readXlsxRows(path, { maxRows: 200_000 }))
          rows.push(row);
        for (const citation of citations) {
          const cells = rows[citation.row! - 1]!;
          expect(`${cells[8]} ${cells[9]}`.trim()).toBe(citation.quote);
          // The field name sits on the first row of the code block.
          let at = citation.row!;
          while (!(rows[at - 1]![1] ?? "").trim()) at--;
          expect(
            `${rows[at - 1]![0]!.trim()}.${rows[at - 1]![1]!.trim()}`,
          ).toBe("pbp_mrx.mrx_benefit_type");
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
