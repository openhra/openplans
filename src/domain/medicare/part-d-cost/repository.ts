import { readFileSync } from "node:fs";
import type { SqlSession } from "../../../db/database.js";
import { spufChannels, spufCodes } from "../../../ingest/medicare/spuf.js";
import type { SpufChannel, SpufTable } from "../../../ingest/medicare/spuf.js";
import type { PlanKey } from "../ids.js";
import { formatPlanKey } from "../ids.js";
import type { BenefitTypeEvidence, PbpRelease } from "./classification.js";
import { decodeBenefitType } from "./classification.js";

/**
 * Reads one plan's Part D benefit evidence from a single pinned release, decoded field by field
 * with a source row behind every value. It does no arithmetic and makes no coverage decision.
 * A field whose meaning the record layout and the loaded files do not settle stays unknown.
 */

export const BUNDLE_VERSION = "1";
/** Tables a bundle reads; a release lacking any of them cannot be pinned. */
export const bundleTables = [
  "plan",
  "formulary",
  "beneficiary_cost",
  "insulin_cost",
  "excluded_drug",
  "indication_coverage",
] as const satisfies readonly SpufTable[];

/** One stored source row; `fields` names the raw columns the figure was read from. */
export interface RowRef {
  snapshot_id: string;
  table: SpufTable;
  source_row: number;
  fields: string[];
}
/** A published dollar amount. Blank and zero are distinct: blank is `not_reported`. */
export type MoneyFigure =
  | { status: "value"; cents: number; raw: string }
  | { status: "not_reported"; raw: "" }
  | { status: "unknown"; raw: string; reason: string };
/** A coinsurance fraction kept as exact decimal text: `.25` is 25%, so `rate` is `"0.25"`. */
export type RateFigure =
  | { status: "value"; rate: string; basis_points: number; raw: string }
  | { status: "not_reported"; raw: "" }
  | { status: "unknown"; raw: string; reason: string };
export type Flag = boolean | "unknown";
export type Phase =
  (typeof spufCodes.coverageLevel)[keyof typeof spufCodes.coverageLevel];
export type Supply =
  (typeof spufCodes.daysSupply)[keyof typeof spufCodes.daysSupply];

export interface ChannelCost {
  channel: SpufChannel;
  status: "copay" | "coinsurance" | "not_offered" | "unknown";
  /** Copay in cents or coinsurance rate; null when not offered or the type is unknown. */
  amount: MoneyFigure | RateFigure | null;
  minimum: MoneyFigure;
  maximum: MoneyFigure;
  reason: string | null;
}
export interface TierCost {
  tier: number;
  phase: Phase;
  supply: Supply;
  specialty_tier: Flag;
  deductible_applies: Flag;
  channels: ChannelCost[];
  evidence: RowRef[];
}
export interface InsulinChannel {
  channel: SpufChannel;
  status: "filed" | "not_offered" | "unknown";
  copay: MoneyFigure;
  coinsurance: RateFigure;
  reason: string | null;
  /** Benefit rows that show the channel is not offered, when the insulin cells are blank. */
  derived_from: RowRef[];
}
export interface InsulinCost {
  /** Null when the file leaves the tier out, as it does for defined standard plans. */
  tier: number | null;
  supply: Supply;
  channels: InsulinChannel[];
  evidence: RowRef[];
}
export interface Package {
  proxy_ndc: string;
  tier: number | null;
  prior_authorization: Flag;
  step_therapy: Flag;
  quantity_limit: Flag;
  quantity_limit_amount: string | null;
  quantity_limit_days: string | null;
  selected_drug: Flag;
  formulary_version: string | null;
  evidence: RowRef;
}
export interface DrugEvidence {
  rxcui: string;
  /** `not_listed` means absent from the published file, not a coverage denial. */
  status: "listed" | "not_listed" | "unknown";
  reason: string | null;
  /** `ambiguous` when several proxy NDCs are listed; the reader never picks one. */
  product: "single" | "ambiguous" | "none";
  packages: Package[];
  /** Supplemental (excluded-drug) listings stay separate from ordinary Part D listings. */
  supplemental: { tier: number | null; evidence: RowRef }[];
  indications: { disease: string; evidence: RowRef }[];
}
export interface Conflict {
  code: string;
  detail: string;
  evidence: RowRef[];
  /** The amounts the plan filed, kept when the conflict sets them aside. */
  filed?: { channel: SpufChannel; raw: string }[];
}
/** The plan file's SNP code (C1/C2): 0 not a SNP, 1 chronic, 2 dual-eligible, 3 institutional. */
export type SpecialNeedsPlan = (
  | { status: "value"; code: "0" | "1" | "2" | "3"; snp: boolean }
  | { status: "unknown"; raw: string; reason: string }
) & { evidence: RowRef[] };
export interface RuleFigure {
  cents?: number;
  basis_points?: number;
  citations: { document: string; section: string; page?: number }[];
}
export type YearRules =
  | {
      status: "value";
      contract_year: number;
      standard_deductible: RuleFigure;
      out_of_pocket_threshold: RuleFigure;
      deductible_cost_sharing: RuleFigure;
      initial_coverage_cost_sharing: RuleFigure;
      catastrophic_cost_sharing: RuleFigure;
      documents: { id: string; url: string; sha256: string }[];
    }
  | { status: "unknown"; contract_year: number; reason: "rules_not_loaded" };

export interface PinnedRelease {
  snapshot_id: string;
  kind: string;
  contract_year: number;
  as_of: string;
  sha256: string;
  url: string;
}
export type BenefitBundle =
  | {
      status: "available";
      bundle_version: string;
      plan_key: string;
      contract_year: number;
      release: PinnedRelease;
      formulary_id: string;
      deductible: MoneyFigure;
      deductible_evidence: RowRef[];
      special_needs_plan: SpecialNeedsPlan;
      /**
       * The plan's drug benefit type from the PBP release of the same year. Absent when the bundle
       * was built without a PBP read, which the engine treats as unknown.
       */
      benefit_type?: BenefitTypeEvidence;
      tiers: TierCost[];
      insulin: InsulinCost[];
      drugs: DrugEvidence[];
      rules: YearRules;
      conflicts: Conflict[];
      gaps: string[];
    }
  | {
      status: "unknown";
      bundle_version: string;
      plan_key: string;
      contract_year: number;
      reason: string;
      release: PinnedRelease | null;
    };

// ---------- field decoding (pure) ----------

const has = <T extends object>(
  table: T,
  key: string,
): key is Extract<keyof T, string> =>
  Object.prototype.hasOwnProperty.call(table, key);

/** Dollars in the layout's 9(12.2) format; more than two decimals is not a cent amount. */
export function decodeMoney(value: string | undefined): MoneyFigure {
  const raw = (value ?? "").trim();
  if (!raw) return { status: "not_reported", raw: "" };
  const match = /^(\d{0,12})(?:\.(\d{1,2}))?$/.exec(raw);
  if (!match || (!match[1] && !match[2]))
    return { status: "unknown", raw, reason: "unreadable_amount" };
  return {
    status: "value",
    cents:
      Number(match[1] || "0") * 100 + Number((match[2] ?? "").padEnd(2, "0")),
    raw,
  };
}

/** A coinsurance cell: a fraction of one, never a percentage. */
export function decodeRate(value: string | undefined): RateFigure {
  const raw = (value ?? "").trim();
  if (!raw) return { status: "not_reported", raw: "" };
  const match = /^(\d*)(?:\.(\d{1,4}))?$/.exec(raw);
  if (!match || (!match[1] && !match[2]))
    return { status: "unknown", raw, reason: "unreadable_rate" };
  const whole = Number(match[1] || "0");
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  const scaled = whole * 10000 + Number((match[2] ?? "").padEnd(4, "0"));
  if (scaled > 10000)
    return { status: "unknown", raw, reason: "rate_above_one" };
  if (fraction.length > 2)
    return { status: "unknown", raw, reason: "rate_finer_than_basis_point" };
  return {
    status: "value",
    rate: fraction ? `${whole}.${fraction}` : String(whole),
    basis_points: scaled,
    raw,
  };
}

/**
 * A minimum or maximum cost-sharing cell, decoded like any amount. What a bound means (zero is
 * no bound, and which combinations are recognised) is decided in bounds.ts, not here.
 */
export function decodeBound(value: string | undefined): MoneyFigure {
  return decodeMoney(value);
}

export function decodeFlag(value: string | undefined): Flag {
  const text = (value ?? "").trim();
  if (text === "Y") return true;
  if (text === "N") return false;
  return "unknown";
}

function decodeTier(value: string | undefined): number | null | "invalid" {
  const text = (value ?? "").trim();
  if (text === "" || text === ".") return null;
  return /^\d{1,2}$/.test(text) ? Number(text) : "invalid";
}

/** One channel of a Beneficiary Cost row. */
export function decodeChannel(
  cells: Record<string, string>,
  channel: (typeof spufChannels)[number],
  codes = spufCodes,
): ChannelCost {
  const typeCode = (cells[`COST_TYPE_${channel.suffix}`] ?? "").trim();
  const minimum = decodeBound(cells[`COST_MIN_AMT_${channel.suffix}`]);
  const maximum = decodeBound(cells[`COST_MAX_AMT_${channel.suffix}`]);
  const amountCell = cells[`COST_AMT_${channel.suffix}`];
  const base = { channel: channel.channel, minimum, maximum };
  if (!has(codes.costType, typeCode))
    return {
      ...base,
      status: "unknown",
      amount: null,
      reason: "unknown_cost_type",
    };
  const type = codes.costType[typeCode];
  if (type === "not_offered")
    return { ...base, status: "not_offered", amount: null, reason: null };
  if (type === "coinsurance")
    return {
      ...base,
      status: "coinsurance",
      amount: decodeRate(amountCell),
      reason: null,
    };
  return {
    ...base,
    status: "copay",
    amount: decodeMoney(amountCell),
    reason: null,
  };
}

const channelFields = (suffix: string) =>
  ["COST_TYPE", "COST_AMT", "COST_MIN_AMT", "COST_MAX_AMT"].map(
    (field) => `${field}_${suffix}`,
  );

export interface StoredRow {
  cells: Record<string, string>;
  source_row: number;
}

/**
 * Decodes Beneficiary Cost rows of one plan. Unknown codes, the retired coverage-gap phase,
 * disagreeing duplicates and catastrophic cost sharing that the year's rules forbid become
 * conflicts; identical duplicates collapse with both rows cited.
 */
export function decodeTierCosts(
  snapshotId: string,
  rows: StoredRow[],
  rules: YearRules,
  codes = spufCodes,
): { tiers: TierCost[]; conflicts: Conflict[] } {
  const conflicts: Conflict[] = [];
  const byKey = new Map<string, { tier: TierCost; cells: string }>();
  const disputed = new Set<string>();
  const fields = [
    "COVERAGE_LEVEL",
    "TIER",
    "DAYS_SUPPLY",
    ...spufChannels.flatMap((channel) => channelFields(channel.suffix)),
    "TIER_SPECIALTY_YN",
    "DED_APPLIES_YN",
  ];
  for (const row of [...rows].sort((a, b) => a.source_row - b.source_row)) {
    const ref: RowRef = {
      snapshot_id: snapshotId,
      table: "beneficiary_cost",
      source_row: row.source_row,
      fields,
    };
    const level = (row.cells.COVERAGE_LEVEL ?? "").trim();
    const supplyCode = (row.cells.DAYS_SUPPLY ?? "").trim();
    const tier = decodeTier(row.cells.TIER);
    if (!has(codes.coverageLevel, level)) {
      conflicts.push({
        code:
          level === "2"
            ? "retired_coverage_gap_phase"
            : "unknown_coverage_level",
        detail: `COVERAGE_LEVEL ${JSON.stringify(level)}`,
        evidence: [ref],
      });
      continue;
    }
    if (!has(codes.daysSupply, supplyCode)) {
      conflicts.push({
        code: "unknown_days_supply",
        detail: `DAYS_SUPPLY ${JSON.stringify(supplyCode)}`,
        evidence: [ref],
      });
      continue;
    }
    if (typeof tier !== "number") {
      conflicts.push({
        code: "unknown_tier",
        detail: `TIER ${JSON.stringify(row.cells.TIER ?? "")}`,
        evidence: [ref],
      });
      continue;
    }
    const decoded: TierCost = {
      tier,
      phase: codes.coverageLevel[level],
      supply: codes.daysSupply[supplyCode],
      specialty_tier: decodeFlag(row.cells.TIER_SPECIALTY_YN),
      deductible_applies: decodeFlag(row.cells.DED_APPLIES_YN),
      channels: spufChannels.map((channel) =>
        decodeChannel(row.cells, channel, codes),
      ),
      evidence: [ref],
    };
    const key = `${tier}|${level}|${supplyCode}`;
    const cells = JSON.stringify(
      fields.map((field) => (row.cells[field] ?? "").trim()),
    );
    const existing = byKey.get(key);
    if (existing) {
      existing.tier.evidence.push(ref);
      if (existing.cells !== cells) disputed.add(key);
      continue;
    }
    byKey.set(key, { tier: decoded, cells });
  }
  const tiers: TierCost[] = [];
  for (const [key, { tier }] of byKey) {
    if (disputed.has(key)) {
      conflicts.push({
        code: "duplicate_cost_rows_disagree",
        detail: `tier ${tier.tier}, ${tier.phase}, ${tier.supply}`,
        evidence: tier.evidence,
      });
      continue;
    }
    if (tier.phase === "catastrophic" && rules.status === "value") {
      // A filed nonzero amount contradicts zero catastrophic cost sharing; unknown stays unknown.
      const filed = tier.channels.some(
        (channel) =>
          channel.amount?.status === "value" &&
          ("cents" in channel.amount
            ? channel.amount.cents
            : channel.amount.basis_points) !== 0,
      );
      if (filed && rules.catastrophic_cost_sharing.basis_points === 0) {
        // The row is set aside, but what the plan filed stays visible in the conflict.
        conflicts.push({
          code: "catastrophic_cost_sharing_conflicts_with_rules",
          detail: `tier ${tier.tier}, ${tier.supply}: the year's rules set no catastrophic cost sharing`,
          evidence: tier.evidence,
          filed: tier.channels
            .filter(
              (channel) =>
                channel.amount?.status === "value" &&
                ("cents" in channel.amount
                  ? channel.amount.cents
                  : channel.amount.basis_points) !== 0,
            )
            .map((channel) => ({
              channel: channel.channel,
              raw: channel.amount!.raw,
            })),
        });
        continue;
      }
    }
    tiers.push(tier);
  }
  tiers.sort(
    (a, b) =>
      a.tier - b.tier ||
      a.phase.localeCompare(b.phase) ||
      a.supply.localeCompare(b.supply),
  );
  return { tiers, conflicts };
}

/**
 * Decodes Insulin Beneficiary Cost rows. Blank insulin cells mean the channel is not offered only
 * when the plan's pre-deductible and initial-coverage rows for the same tier and supply all say
 * so; otherwise they stay unknown. A blank tier is kept as null, never spread over every tier.
 */
export function decodeInsulin(
  snapshotId: string,
  rows: StoredRow[],
  tierRows: StoredRow[],
  codes = spufCodes,
): { insulin: InsulinCost[]; conflicts: Conflict[] } {
  const conflicts: Conflict[] = [];
  const insulin: InsulinCost[] = [];
  const seen = new Map<string, InsulinCost>();
  for (const row of [...rows].sort((a, b) => a.source_row - b.source_row)) {
    const tier = decodeTier(row.cells.TIER);
    const supplyCode = (row.cells.DAYS_SUPPLY ?? "").trim();
    const fields = [
      "TIER",
      "DAYS_SUPPLY",
      ...spufChannels.flatMap((channel) => [
        `COPAY_AMT_${channel.suffix}_INSLN`,
        `COIN_AMT_${channel.suffix}_INSLN`,
      ]),
    ];
    const ref: RowRef = {
      snapshot_id: snapshotId,
      table: "insulin_cost",
      source_row: row.source_row,
      fields,
    };
    if (tier === "invalid" || !has(codes.daysSupply, supplyCode)) {
      conflicts.push({
        code: tier === "invalid" ? "unknown_tier" : "unknown_days_supply",
        detail: `insulin TIER ${JSON.stringify(row.cells.TIER ?? "")}, DAYS_SUPPLY ${JSON.stringify(supplyCode)}`,
        evidence: [ref],
      });
      continue;
    }
    const key = `${tier}|${supplyCode}`;
    const earlier = seen.get(key);
    if (earlier) {
      conflicts.push({
        code: "duplicate_insulin_rows",
        detail: `insulin tier ${tier ?? "blank"}, ${codes.daysSupply[supplyCode]}`,
        evidence: [...earlier.evidence, ref],
      });
      continue;
    }
    // Catastrophic rows file $0 even for channels not offered before it, so they prove nothing.
    const matching = tierRows.filter(
      (other) =>
        tier !== null &&
        ["0", "1"].includes((other.cells.COVERAGE_LEVEL ?? "").trim()) &&
        decodeTier(other.cells.TIER) === tier &&
        (other.cells.DAYS_SUPPLY ?? "").trim() === supplyCode,
    );
    const channels = spufChannels.map((channel): InsulinChannel => {
      const copay = decodeMoney(row.cells[`COPAY_AMT_${channel.suffix}_INSLN`]);
      const coinsurance = decodeRate(
        row.cells[`COIN_AMT_${channel.suffix}_INSLN`],
      );
      const base = {
        channel: channel.channel,
        copay,
        coinsurance,
        derived_from: [] as RowRef[],
      };
      if (
        copay.status === "not_reported" &&
        coinsurance.status === "not_reported"
      ) {
        const notOffered =
          matching.length > 0 &&
          matching.every(
            (other) =>
              (other.cells[`COST_TYPE_${channel.suffix}`] ?? "").trim() === "0",
          );
        return notOffered
          ? {
              ...base,
              status: "not_offered",
              reason: null,
              derived_from: matching.map((other) => ({
                snapshot_id: snapshotId,
                table: "beneficiary_cost",
                source_row: other.source_row,
                fields: [`COST_TYPE_${channel.suffix}`],
              })),
            }
          : { ...base, status: "unknown", reason: "blank_insulin_cost" };
      }
      if (copay.status !== "value" || coinsurance.status !== "value")
        return {
          ...base,
          status: "unknown",
          reason: "incomplete_insulin_cost",
        };
      return { ...base, status: "filed", reason: null };
    });
    const decoded: InsulinCost = {
      tier,
      supply: codes.daysSupply[supplyCode],
      channels,
      evidence: [ref],
    };
    seen.set(key, decoded);
    insulin.push(decoded);
  }
  return { insulin, conflicts };
}

/** County rows of one plan must agree on formulary, deductible and suppression. */
export function decodePlanRows(
  snapshotId: string,
  rows: (StoredRow & { formulary_id: string; suppressed: boolean })[],
  rules: YearRules,
): {
  formularies: string[];
  suppressed: boolean;
  deductible: MoneyFigure;
  evidence: RowRef[];
  special_needs_plan: SpecialNeedsPlan;
  conflicts: Conflict[];
} {
  const evidence = [...rows]
    .sort((a, b) => a.source_row - b.source_row)
    .map((row): RowRef => ({
      snapshot_id: snapshotId,
      table: "plan",
      source_row: row.source_row,
      fields: ["FORMULARY_ID", "DEDUCTIBLE", "PLAN_SUPPRESSED_YN"],
    }));
  const conflicts: Conflict[] = [];
  const values = [
    ...new Set(rows.map((row) => (row.cells.DEDUCTIBLE ?? "").trim())),
  ];
  let deductible: MoneyFigure =
    values.length === 1
      ? decodeMoney(values[0])
      : {
          status: "unknown",
          raw: values.join("|"),
          reason: "plan_rows_disagree",
        };
  if (values.length > 1)
    conflicts.push({
      code: "plan_rows_disagree",
      detail: `DEDUCTIBLE ${values.map((v) => JSON.stringify(v)).join(", ")}`,
      evidence,
    });
  if (
    deductible.status === "value" &&
    rules.status === "value" &&
    deductible.cents > rules.standard_deductible.cents!
  ) {
    conflicts.push({
      code: "plan_deductible_exceeds_standard",
      detail: `${deductible.raw} is above the year's standard deductible`,
      evidence,
    });
    deductible = {
      status: "unknown",
      raw: deductible.raw,
      reason: "plan_deductible_exceeds_standard",
    };
  }
  return {
    formularies: [...new Set(rows.map((row) => row.formulary_id))].sort(),
    suppressed: rows.some((row) => row.suppressed),
    deductible,
    evidence,
    special_needs_plan: decodeSpecialNeedsPlan(snapshotId, rows, conflicts),
    conflicts,
  };
}

/** The SNP code of a plan's county rows; rows that disagree or an unlisted code stay unknown. */
function decodeSpecialNeedsPlan(
  snapshotId: string,
  rows: StoredRow[],
  conflicts: Conflict[],
): SpecialNeedsPlan {
  const evidence = [...rows]
    .sort((a, b) => a.source_row - b.source_row)
    .map((row): RowRef => ({
      snapshot_id: snapshotId,
      table: "plan",
      source_row: row.source_row,
      fields: ["SNP"],
    }));
  const values = [...new Set(rows.map((row) => (row.cells.SNP ?? "").trim()))];
  if (values.length !== 1) {
    if (values.length > 1)
      conflicts.push({
        code: "plan_rows_disagree",
        detail: `SNP ${values.map((v) => JSON.stringify(v)).join(", ")}`,
        evidence,
      });
    return {
      status: "unknown",
      raw: values.join("|"),
      reason: values.length ? "plan_rows_disagree" : "snp_not_reported",
      evidence,
    };
  }
  const code = values[0]!;
  if (code === "")
    return { status: "unknown", raw: "", reason: "snp_not_reported", evidence };
  if (code !== "0" && code !== "1" && code !== "2" && code !== "3")
    return {
      status: "unknown",
      raw: code,
      reason: "unknown_snp_code",
      evidence,
    };
  return { status: "value", code, snp: code !== "0", evidence };
}

/** Formulary rows of one RxCUI: every proxy NDC is kept; several make the product ambiguous. */
export function decodeDrug(
  snapshotId: string,
  year: number,
  rxcui: string,
  rows: (StoredRow & { ndc: string; tier: number | null })[],
  excluded: StoredRow[],
  indications: StoredRow[],
): DrugEvidence {
  const ref = (table: SpufTable, row: StoredRow, fields: string[]): RowRef => ({
    snapshot_id: snapshotId,
    table,
    source_row: row.source_row,
    fields,
  });
  const sorted = [...rows].sort(
    (a, b) => a.ndc.localeCompare(b.ndc) || a.source_row - b.source_row,
  );
  const wrongYear = sorted.filter(
    (row) =>
      row.cells.CONTRACT_YEAR !== undefined &&
      row.cells.CONTRACT_YEAR.trim() !== String(year),
  );
  const packages = sorted.map((row): Package => ({
    proxy_ndc: row.ndc,
    tier: row.tier,
    prior_authorization: decodeFlag(row.cells.PRIOR_AUTHORIZATION_YN),
    step_therapy: decodeFlag(row.cells.STEP_THERAPY_YN),
    quantity_limit: decodeFlag(row.cells.QUANTITY_LIMIT_YN),
    quantity_limit_amount: row.cells.QUANTITY_LIMIT_AMOUNT?.trim() || null,
    quantity_limit_days: row.cells.QUANTITY_LIMIT_DAYS?.trim() || null,
    selected_drug: decodeFlag(row.cells.SELECTED_DRUG_YN),
    formulary_version: row.cells.FORMULARY_VERSION?.trim() || null,
    evidence: ref("formulary", row, [
      "FORMULARY_ID",
      "RXCUI",
      "NDC",
      "TIER_LEVEL_VALUE",
      "PRIOR_AUTHORIZATION_YN",
      "STEP_THERAPY_YN",
      "QUANTITY_LIMIT_YN",
      "SELECTED_DRUG_YN",
    ]),
  }));
  const supplemental = excluded.map((row) => {
    const tier = decodeTier(row.cells.TIER);
    return {
      tier: typeof tier === "number" ? tier : null,
      evidence: ref("excluded_drug", row, ["RXCUI", "TIER"]),
    };
  });
  const indicationList = indications.map((row) => ({
    disease: (row.cells.DISEASE ?? "").trim(),
    evidence: ref("indication_coverage", row, ["RXCUI", "DISEASE"]),
  }));
  const common = { rxcui, packages, supplemental, indications: indicationList };
  if (wrongYear.length)
    return {
      ...common,
      status: "unknown",
      reason: "formulary_year_mismatch",
      product: "none",
    };
  if (!packages.length)
    return { ...common, status: "not_listed", reason: null, product: "none" };
  if (packages.some((item) => item.tier === null))
    return {
      ...common,
      status: "unknown",
      reason: "tier_unreadable",
      product: packages.length > 1 ? "ambiguous" : "single",
    };
  return {
    ...common,
    status: "listed",
    reason: packages.length > 1 ? "ambiguous_drug_product" : null,
    product: packages.length > 1 ? "ambiguous" : "single",
  };
}

// ---------- reviewed annual rules ----------

interface ParameterFile {
  schemaVersion: number;
  years: Record<
    string,
    Record<
      string,
      {
        value: number;
        citations: { document: string; section: string; page?: number }[];
      }
    >
  >;
}
interface DocumentFile {
  documents: { id: string; url: string; sha256: string }[];
}
const dataUrl = (name: string) =>
  new URL(`../../../../data/medicare-part-d/${name}`, import.meta.url);
let rulesCache: { parameters: ParameterFile; documents: DocumentFile } | null =
  null;

/** The reviewed 2026/2027 parameters (data/medicare-part-d); another year is not loaded. */
export function yearRules(year: number, files = loadRuleFiles()): YearRules {
  const entry = files.parameters.years[String(year)];
  if (!entry)
    return {
      status: "unknown",
      contract_year: year,
      reason: "rules_not_loaded",
    };
  const figure = (name: string, unit: "cents" | "basis_points"): RuleFigure => {
    const parameter = entry[name];
    if (!parameter) throw new Error(`Part D rules for ${year} lack ${name}`);
    return {
      [unit]: parameter.value,
      citations: parameter.citations.map(({ document, section, page }) => ({
        document,
        section,
        ...(page === undefined ? {} : { page }),
      })),
    };
  };
  const rules = {
    standard_deductible: figure("standardDeductibleCents", "cents"),
    out_of_pocket_threshold: figure("outOfPocketThresholdCents", "cents"),
    deductible_cost_sharing: figure(
      "deductibleCostSharingBasisPoints",
      "basis_points",
    ),
    initial_coverage_cost_sharing: figure(
      "initialCoverageCostSharingBasisPoints",
      "basis_points",
    ),
    catastrophic_cost_sharing: figure(
      "catastrophicCostSharingBasisPoints",
      "basis_points",
    ),
  };
  const cited = new Set(
    Object.values(rules).flatMap((rule) =>
      rule.citations.map((citation) => citation.document),
    ),
  );
  return {
    status: "value",
    contract_year: year,
    ...rules,
    documents: files.documents.documents
      .filter((document) => cited.has(document.id))
      .map(({ id, url, sha256 }) => ({ id, url, sha256 })),
  };
}
export function loadRuleFiles() {
  rulesCache ??= {
    parameters: JSON.parse(
      readFileSync(dataUrl("parameters.json"), "utf8"),
    ) as ParameterFile,
    documents: JSON.parse(
      readFileSync(dataUrl("documents.json"), "utf8"),
    ) as DocumentFile,
  };
  return rulesCache;
}

// ---------- provenance check (pure) ----------

/** Every value in a bundle must cite a row of the pinned release; returns what is missing. */
export function bundleProvenanceProblems(bundle: BenefitBundle): string[] {
  if (bundle.status !== "available") return [];
  const problems: string[] = [];
  const snapshot = bundle.release.snapshot_id;
  const check = (where: string, refs: RowRef[], table: SpufTable) => {
    if (!refs.length) problems.push(`${where}: no source row`);
    for (const ref of refs) {
      if (ref.snapshot_id !== snapshot)
        problems.push(`${where}: cites another release`);
      if (ref.table !== table)
        problems.push(`${where}: cites ${ref.table}, not ${table}`);
      if (!Number.isInteger(ref.source_row) || ref.source_row < 1)
        problems.push(`${where}: invalid source row`);
      if (!ref.fields.length) problems.push(`${where}: no source fields`);
    }
  };
  check("deductible", bundle.deductible_evidence, "plan");
  check("special needs plan", bundle.special_needs_plan.evidence, "plan");
  const benefit = bundle.benefit_type;
  if (benefit?.status === "value") {
    if (!benefit.evidence.length) problems.push("benefit type: no source row");
    for (const ref of benefit.evidence) {
      if (ref.snapshot_id !== benefit.release.snapshot_id)
        problems.push("benefit type: cites another release");
      if (ref.table !== "pbp_mrx")
        problems.push(`benefit type: cites ${ref.table}, not pbp_mrx`);
      if (!Number.isInteger(ref.source_row) || ref.source_row < 1)
        problems.push("benefit type: invalid source row");
    }
    if (benefit.release.contract_year !== bundle.contract_year)
      problems.push("benefit type: PBP release of another year");
    if (!benefit.citations.length)
      problems.push("benefit type: no dictionary citation");
  }
  for (const tier of bundle.tiers)
    check(
      `tier ${tier.tier} ${tier.phase} ${tier.supply}`,
      tier.evidence,
      "beneficiary_cost",
    );
  for (const row of bundle.insulin) {
    check(
      `insulin ${row.tier ?? "blank"} ${row.supply}`,
      row.evidence,
      "insulin_cost",
    );
    for (const channel of row.channels)
      if (channel.status === "not_offered")
        check(
          `insulin ${row.tier} ${row.supply} ${channel.channel}`,
          channel.derived_from,
          "beneficiary_cost",
        );
  }
  for (const drug of bundle.drugs) {
    for (const item of drug.packages)
      check(
        `drug ${drug.rxcui} ${item.proxy_ndc}`,
        [item.evidence],
        "formulary",
      );
    for (const item of drug.supplemental)
      check(
        `drug ${drug.rxcui} supplemental`,
        [item.evidence],
        "excluded_drug",
      );
    for (const item of drug.indications)
      check(
        `drug ${drug.rxcui} indication`,
        [item.evidence],
        "indication_coverage",
      );
  }
  for (const conflict of bundle.conflicts)
    if (!conflict.evidence.length)
      problems.push(`conflict ${conflict.code}: no source row`);
  return problems;
}

// ---------- persistence read ----------

export interface BundleRequest {
  plan: PlanKey;
  year: number;
  rxcuis: readonly string[];
  /** Pins an exact release; otherwise the newest ACTIVE release with every bundle table. */
  snapshotId?: string;
}

/**
 * Pins one release once and reads every table from it. Selection is by contract year only.
 * A release of another year is never borrowed, and a missing release is `not_loaded`.
 */
export async function readBenefitBundle(
  db: SqlSession,
  request: BundleRequest,
): Promise<BenefitBundle> {
  const { plan, year } = request;
  const planKey = formatPlanKey(plan);
  const head = {
    bundle_version: BUNDLE_VERSION,
    plan_key: planKey,
    contract_year: year,
  };
  const rxcuis = [...new Set(request.rxcuis)];
  if (!rxcuis.every((rxcui) => /^\d{1,10}$/.test(rxcui)))
    return {
      ...head,
      status: "unknown",
      reason: "invalid_rxcui",
      release: null,
    };
  const release = (
    await db.query<{
      snapshot_id: string;
      kind: string;
      contract_year: number;
      as_of: string;
      sha256: string;
      url: string;
    }>(
      `SELECT r.snapshot_id,r.kind,r.contract_year,r.as_of::text AS as_of,s.sha256,s.requested_url AS url
       FROM partd_release r JOIN snapshot s USING(snapshot_id)
       WHERE s.validation_state='ACTIVE' AND r.contract_year=$1 AND r.tables @> $2::text[]
         AND ($3::text IS NULL OR r.snapshot_id=$3)
       ORDER BY r.as_of DESC, r.snapshot_id LIMIT 1`,
      [year, [...bundleTables], request.snapshotId ?? null],
    )
  ).rows[0];
  if (!release || release.contract_year !== year)
    return {
      ...head,
      status: "unknown",
      reason: request.snapshotId ? "release_not_active" : "not_loaded",
      release: null,
    };
  const snapshot = release.snapshot_id;
  const rules = yearRules(year);
  const planRows = (
    await db.query<{
      formulary_id: string;
      suppressed: boolean;
      cells: Record<string, string>;
      source_row: number;
    }>(
      `SELECT formulary_id,suppressed,cells,source_row FROM partd_plan
       WHERE snapshot_id=$1 AND contract_id=$2 AND plan_id=$3 AND segment_id=$4 ORDER BY source_row`,
      [snapshot, plan.contractId, plan.planId, plan.segmentId],
    )
  ).rows;
  if (!planRows.length)
    return {
      ...head,
      status: "unknown",
      reason: "plan_not_in_part_d_files",
      release,
    };
  const planned = decodePlanRows(snapshot, planRows, rules);
  if (planned.suppressed)
    return {
      ...head,
      status: "unknown",
      reason: "plan_suppressed_by_cms",
      release,
    };
  if (planned.formularies.length > 1)
    return {
      ...head,
      status: "unknown",
      reason: "several_formularies_listed",
      release,
    };
  const formularyId = planned.formularies[0]!;
  const planCells = (table: string, rxcuiFilter: boolean) =>
    db
      .query<{
        cells: Record<string, string>;
        source_row: number;
        rxcui: string | null;
      }>(
        `SELECT cells,source_row,rxcui FROM partd_plan_row WHERE snapshot_id=$1 AND table_name=$2
         AND contract_id=$3 AND plan_id=$4 AND (segment_id IS NULL OR segment_id=$5)
         AND (NOT $6 OR rxcui = ANY($7::text[])) ORDER BY source_row`,
        [
          snapshot,
          table,
          plan.contractId,
          plan.planId,
          plan.segmentId,
          rxcuiFilter,
          rxcuis,
        ],
      )
      .then((result) => result.rows);
  const costRows = await planCells("beneficiary_cost", false);
  const insulinRows = await planCells("insulin_cost", false);
  const excludedRows = rxcuis.length
    ? await planCells("excluded_drug", true)
    : [];
  const indicationRows = rxcuis.length
    ? await planCells("indication_coverage", true)
    : [];
  const formularyRows = rxcuis.length
    ? (
        await db.query<{
          rxcui: string;
          ndc: string;
          tier: number | null;
          cells: Record<string, string>;
          source_row: number;
        }>(
          `SELECT rxcui,ndc,tier,cells,source_row FROM partd_formulary_drug
           WHERE snapshot_id=$1 AND formulary_id=$2 AND rxcui = ANY($3::text[]) ORDER BY rxcui,ndc,source_row`,
          [snapshot, formularyId, rxcuis],
        )
      ).rows
    : [];
  const tierCosts = decodeTierCosts(snapshot, costRows, rules);
  const insulin = decodeInsulin(snapshot, insulinRows, costRows);
  const drugs = rxcuis.map((rxcui) =>
    decodeDrug(
      snapshot,
      year,
      rxcui,
      formularyRows.filter((row) => row.rxcui === rxcui),
      excludedRows.filter((row) => row.rxcui === rxcui),
      indicationRows.filter((row) => row.rxcui === rxcui),
    ),
  );
  const benefitType = await readPbpBenefitType(db, plan, year);
  // What this bundle does not read: names, networks and prices; the benefit type when the PBP
  // files do not settle it.
  const gaps = [
    "drug_names_not_in_bundle",
    "pharmacy_network_not_in_bundle",
    "pricing_not_in_bundle",
    ...(benefitType.status === "value" ? [] : ["benefit_mapping_unknown"]),
    ...(rules.status === "unknown" ? ["rules_not_loaded"] : []),
  ];
  return {
    ...head,
    status: "available",
    release,
    formulary_id: formularyId,
    deductible: planned.deductible,
    deductible_evidence: planned.evidence,
    special_needs_plan: planned.special_needs_plan,
    benefit_type: benefitType,
    tiers: tierCosts.tiers,
    insulin: insulin.insulin,
    drugs,
    rules,
    conflicts: [
      ...planned.conflicts,
      ...tierCosts.conflicts,
      ...insulin.conflicts,
    ],
    gaps,
  };
}

/**
 * The plan's drug benefit type from the newest ACTIVE PBP release of the same contract year. A
 * release of another year is never borrowed; no release, no row or a blank cell stays unknown.
 */
export async function readPbpBenefitType(
  db: SqlSession,
  plan: PlanKey,
  year: number,
): Promise<BenefitTypeEvidence> {
  const release = (
    await db.query<PbpRelease & Record<string, unknown>>(
      `SELECT r.snapshot_id,r.contract_year,r.as_of::text AS as_of,s.sha256,s.requested_url AS url
       FROM medicare_release r JOIN snapshot s USING(snapshot_id)
       WHERE r.family='pbp' AND r.contract_year=$1 AND s.validation_state='ACTIVE'
       ORDER BY r.as_of DESC, r.snapshot_id LIMIT 1`,
      [year],
    )
  ).rows[0];
  if (!release || release.contract_year !== year)
    return {
      status: "unknown",
      reason: "pbp_not_loaded",
      raw: null,
      release: null,
      evidence: [],
      citations: [],
    };
  const rows = (
    await db.query<{ fields: Record<string, string>; source_row: number }>(
      `SELECT fields,source_row FROM medicare_pbp_row
       WHERE snapshot_id=$1 AND table_name='pbp_mrx' AND contract_id=$2 AND plan_id=$3 AND segment_id=$4
       ORDER BY source_row`,
      [release.snapshot_id, plan.contractId, plan.planId, plan.segmentId],
    )
  ).rows;
  const codes = (
    await db.query<{ codes: Record<string, string> }>(
      `SELECT codes FROM medicare_pbp_field
       WHERE snapshot_id=$1 AND table_name='pbp_mrx' AND field='mrx_benefit_type'`,
      [release.snapshot_id],
    )
  ).rows[0];
  return decodeBenefitType(release, rows, codes?.codes ?? null);
}
