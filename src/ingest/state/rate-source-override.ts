/**
 * NY rate source override, checked again at import. Off unless the operator's configuration
 * names an issuer in `ny.rateSourceOverrides`. `prepare.py` then takes that issuer's
 * family-tier rates from the cached CMS state-based exchange (SBE) rate file. The importer
 * accepts this only when
 * - the configuration names exactly the issuers the artifact overrides,
 * - each issuer's DFS approved-rates template was refused by the template guard and none of
 *   its DFS rows is served,
 * - every staged rate equals its SBE row, re-read from the original bundle bytes, and
 * - the SBE file still matches every admitted DFS rate it lists to the cent, in all eight cells.
 * Plans the SBE file does not price stay `unknown`.
 */
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { streamZipMember } from "../../fetch/index.js";
import { readCsv } from "../csv/index.js";
import type { TemplateCheck } from "./template-guard.js";

export const OVERRIDE_RULE = "ny-rate-source-override-v1";
export const CROSS_CHECK_RULE =
  "ny-sbe-rates-match-dfs-approved-to-the-cent-v1";
export const SBE_NY_URL = "https://www.cms.gov/files/zip/newyorksbepuf2026.zip";
export type RateSource = "cms-sbe";
export type RateSourceOverrides = Readonly<Record<string, RateSource>>;

/** SBE rate columns, keyed by the DFS template column they correspond to. */
export const SBE_TIERS = [
  ["4", "INDIVIDUAL RATE"],
  ["6", "COUPLE"],
  ["7", "PRIMARY SUBSCRIBER AND ONE DEPENDENT"],
  ["8", "PRIMARY SUBSCRIBER AND TWO DEPENDENTS"],
  ["9", "PRIMARY SUBSCRIBER AND THREE OR MORE DEPENDENTS"],
  ["10", "COUPLE AND ONE DEPENDENT"],
  ["11", "COUPLE AND TWO DEPENDENTS"],
  ["12", "COUPLE AND THREE OR MORE DEPENDENTS"],
] as const;
/** Where each community tier sits in the SBE rate file. */
export const SBE_TIER_COLUMNS: Record<string, string> = {
  single: "INDIVIDUAL RATE",
  couple: "COUPLE",
  adult_children:
    "PRIMARY SUBSCRIBER AND ONE DEPENDENT:PRIMARY SUBSCRIBER AND THREE OR MORE DEPENDENTS",
  family: "COUPLE AND ONE DEPENDENT:COUPLE AND THREE OR MORE DEPENDENTS",
};
const UNKNOWN_REASONS = [
  "sbe_rate_row_missing",
  "sbe_tier_columns_non_uniform",
] as const;

interface OverrideRecord {
  plan_id: string;
  issuer: string;
  region: string;
  prices: Record<"single" | "couple" | "adult_children" | "family", string>;
  child_only: string;
  metal: null;
  exchange: string;
  source_record: string;
  raw: Record<string, string>;
}
export interface OverrideIssuer {
  issuer: string;
  source: RateSource;
  refused_template: { url: string; sha256: string; reason: string };
  quality_note: string;
  records: OverrideRecord[];
  unknown_plans: {
    plan_id: string;
    region: string;
    reason: (typeof UNKNOWN_REASONS)[number];
  }[];
}
export interface CrossCheck {
  rule: typeof CROSS_CHECK_RULE;
  compared_keys: number;
  compared_cells: number;
  matched_cells: number;
  issuers: Record<string, number>;
}
export interface RateSourceOverrideBlock {
  rule: typeof OVERRIDE_RULE;
  source: RateSource;
  publication: {
    url: string;
    sha256: string;
    bytes: number;
    retrieved_at: string;
    content_type: string;
    raw_path?: string;
    member: string;
    member_sha256: string;
  };
  cross_check: CrossCheck;
  issuers: OverrideIssuer[];
}
interface ServedSource {
  records: {
    plan_id: string | null;
    issuer: string;
    region: string;
    raw: Record<string, string>;
  }[];
}

const SHA = /^[a-f0-9]{64}$/;
const PLAN_ID = /^\d{5}NY\d{7}$/;
const REGION = /^Rating Area [1-8]$/;
const MEMBER = /^NYRates\d{8}\.csv$/;
const ROW = /^(NYRates\d{8}\.csv)!row=([1-9]\d*)$/;
const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length < 1000;
const refuse = (why: string) =>
  new Error(`NY rate source override refused: ${why}`);

/** Whole cents from a published cell, or null. Cached Excel cells may carry float tails. */
export function cellCents(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const cents = Number(value) * 100,
    rounded = Math.round(cents);
  if (
    rounded <= 0 ||
    !Number.isSafeInteger(rounded) ||
    Math.abs(cents - rounded) > 0.000001
  )
    return null;
  return rounded;
}
const money = (cents: number) =>
  `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;

/** Community tiers from one SBE row, or null when a cell is unusable or dependents differ. */
export function sbePrices(cells: Record<string, string>) {
  const values = Object.fromEntries(
    SBE_TIERS.map(([column, name]) => [column, cellCents(cells[name])]),
  ) as Record<string, number | null>;
  if (Object.values(values).some((v) => v === null)) return null;
  if (
    new Set([values["7"], values["8"], values["9"]]).size !== 1 ||
    new Set([values["10"], values["11"], values["12"]]).size !== 1
  )
    return null;
  return {
    single: money(values["4"]!),
    couple: money(values["6"]!),
    adult_children: money(values["7"]!),
    family: money(values["10"]!),
  };
}

/** Same comparison as `prepare.py`: every admitted DFS key the SBE file lists, all eight cells. */
export function sbeCrossCheck(
  sources: readonly ServedSource[],
  rows: ReadonlyMap<string, { row: number; cells: Record<string, string> }>,
): { check: CrossCheck; mismatches: number } {
  const issuers: Record<string, number> = {};
  let compared = 0,
    mismatches = 0;
  for (const source of sources)
    for (const record of source.records) {
      issuers[record.issuer] ??= 0;
      const found = rows.get(`${record.plan_id}|${record.region}`);
      if (!found) continue;
      compared += 1;
      issuers[record.issuer] = (issuers[record.issuer] ?? 0) + 1;
      for (const [column, name] of SBE_TIERS) {
        const filed = cellCents(record.raw[column]);
        if (filed === null || filed !== cellCents(found.cells[name]))
          mismatches += 1;
      }
    }
  const cells = compared * SBE_TIERS.length;
  return {
    check: {
      rule: CROSS_CHECK_RULE,
      compared_keys: compared,
      compared_cells: cells,
      matched_cells: cells - mismatches,
      issuers: Object.fromEntries(
        Object.entries(issuers).sort(([a], [b]) => a.localeCompare(b)),
      ),
    },
    mismatches,
  };
}

/** The issuer's DFS template was refused, and none of its DFS rows is served. */
export function overrideAllowed(
  check: TemplateCheck,
  issuer: string,
  served: ReadonlySet<string>,
) {
  return check.decision === "refused" && !served.has(issuer);
}

/** Structural checks that need no raw bytes. */
export function validateRateSourceOverrides(
  block: RateSourceOverrideBlock,
  sources: readonly ServedSource[],
  templates: readonly TemplateCheck[],
) {
  const p = block?.publication;
  if (
    !block ||
    typeof block !== "object" ||
    block.rule !== OVERRIDE_RULE ||
    block.source !== "cms-sbe" ||
    !p ||
    p.url !== SBE_NY_URL ||
    !SHA.test(p.sha256) ||
    !SHA.test(p.member_sha256) ||
    !Number.isSafeInteger(p.bytes) ||
    p.bytes <= 0 ||
    p.bytes > 50 * 1024 ** 2 ||
    !text(p.retrieved_at) ||
    !Number.isFinite(Date.parse(p.retrieved_at)) ||
    !text(p.content_type) ||
    !MEMBER.test(p.member) ||
    !Array.isArray(block.issuers) ||
    !block.issuers.length ||
    block.issuers.length > 12
  )
    throw refuse("invalid override block");
  const served = new Set(
    sources.flatMap((s) => s.records.map((r) => r.issuer)),
  );
  const seen = new Set<string>();
  for (const entry of block.issuers) {
    const check = templates.find((c) => c.issuer_ids.includes(entry?.issuer));
    if (
      !entry ||
      !/^\d{5}$/.test(entry.issuer) ||
      seen.has(entry.issuer) ||
      entry.source !== block.source ||
      !check ||
      // The override is allowed only for an issuer whose DFS template the guard refused.
      !overrideAllowed(check, entry.issuer, served) ||
      entry.refused_template?.url !== check.url ||
      entry.refused_template.sha256 !== check.sha256 ||
      entry.refused_template.reason !== check.reason ||
      !text(entry.quality_note) ||
      !entry.quality_note.includes(String(check.reason)) ||
      !Array.isArray(entry.records) ||
      !Array.isArray(entry.unknown_plans)
    )
      throw refuse(
        `issuer ${String(entry?.issuer)} has no refused DFS template`,
      );
    seen.add(entry.issuer);
    const listed = new Set(
      (check.listed_plans ?? [])
        .filter((plan) => plan.plan_id.startsWith(entry.issuer))
        .map((plan) => `${plan.plan_id}|${plan.region}`),
    );
    const covered = new Set<string>();
    for (const record of entry.records) {
      const key = `${record?.plan_id}|${record?.region}`;
      const prices = record?.raw ? sbePrices(record.raw) : null;
      if (
        !record ||
        typeof record.plan_id !== "string" ||
        !PLAN_ID.test(record.plan_id) ||
        record.issuer !== entry.issuer ||
        !REGION.test(record.region) ||
        !listed.has(key) ||
        covered.has(key) ||
        record.child_only !== "No" ||
        record.metal !== null ||
        record.exchange !== "unknown" ||
        ROW.exec(record.source_record)?.[1] !== p.member ||
        record.raw["PLAN ID"] !== record.plan_id ||
        record.raw["RATING AREA ID"] !== record.region ||
        record.raw["ISSUER ID"] !== entry.issuer ||
        record.raw["BUSINESS YEAR"] !== "2026" ||
        record.raw["STATE CODE"] !== "NY" ||
        record.raw.AGE !== "" ||
        record.raw["RATE EFFECTIVE DATE"] !== "2026-01-01" ||
        record.raw["RATE EXPIRATION"] !== "2026-12-31" ||
        !prices ||
        JSON.stringify(prices) !== JSON.stringify(record.prices)
      )
        throw refuse("override rate differs from its SBE row");
      covered.add(key);
    }
    for (const plan of entry.unknown_plans) {
      const key = `${plan?.plan_id}|${plan?.region}`;
      if (
        !plan ||
        Object.keys(plan).length !== 3 ||
        !listed.has(key) ||
        covered.has(key) ||
        !UNKNOWN_REASONS.includes(plan.reason)
      )
        throw refuse("invalid unknown plan");
      covered.add(key);
    }
    // Every plan the refused template lists is either priced from the SBE file or unknown.
    if (covered.size !== listed.size)
      throw refuse("listed plans are neither priced nor unknown");
  }
  const c = block.cross_check;
  const issuers = [...served].sort();
  if (
    c?.rule !== CROSS_CHECK_RULE ||
    !Number.isSafeInteger(c.compared_keys) ||
    c.compared_keys <= 0 ||
    c.compared_cells !== c.compared_keys * SBE_TIERS.length ||
    c.matched_cells !== c.compared_cells ||
    JSON.stringify(Object.keys(c.issuers ?? {}).sort()) !==
      JSON.stringify(issuers) ||
    issuers.some((issuer) => !(c.issuers[issuer]! > 0))
  )
    throw refuse("the SBE cross-check did not match to the cent");
}

/** Annual family-tier rows of the SBE rate member, keyed by plan and rating area. */
export async function sbeRateRows(path: string, member: string) {
  const hash = createHash("sha256");
  const bytes = streamZipMember(path, member);
  const hashed = (async function* () {
    for await (const chunk of bytes) {
      hash.update(chunk);
      yield chunk;
    }
  })();
  const rows = new Map<
    string,
    { row: number; cells: Record<string, string> }
  >();
  for await (const record of readCsv(Readable.from(hashed))) {
    const cells = record.values as Record<string, string>;
    if (
      cells.AGE !== "" ||
      cells["RATE EFFECTIVE DATE"] !== "2026-01-01" ||
      cells["RATE EXPIRATION"] !== "2026-12-31"
    )
      continue;
    if (cells["BUSINESS YEAR"] !== "2026" || cells["STATE CODE"] !== "NY")
      throw refuse("unexpected SBE rate row scope");
    const key = `${cells["PLAN ID"]}|${cells["RATING AREA ID"]}`;
    if (rows.has(key)) throw refuse("duplicate SBE annual rate row");
    rows.set(key, { row: record.rowNumber, cells });
  }
  return { rows, memberSha256: hash.digest("hex") };
}

/** Re-derive everything from the original SBE bytes (already hash-verified by the caller). */
export async function verifyRateSourceOverrides(
  block: RateSourceOverrideBlock,
  sources: readonly ServedSource[],
  configured: RateSourceOverrides,
) {
  const wanted = Object.entries(configured).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const have = block.issuers
    .map((entry) => [entry.issuer, entry.source] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  if (JSON.stringify(wanted) !== JSON.stringify(have))
    throw refuse("configuration and artifact name different issuers");
  if (!block.publication.raw_path)
    throw refuse("original SBE publication path required");
  const { rows, memberSha256 } = await sbeRateRows(
    block.publication.raw_path,
    block.publication.member,
  );
  if (memberSha256 !== block.publication.member_sha256)
    throw refuse("SBE rate member hash mismatch");
  const { check, mismatches } = sbeCrossCheck(sources, rows);
  if (mismatches || JSON.stringify(check) !== JSON.stringify(block.cross_check))
    throw refuse("the SBE cross-check did not match to the cent");
  for (const entry of block.issuers) {
    for (const record of entry.records) {
      const found = rows.get(`${record.plan_id}|${record.region}`);
      if (
        !found ||
        record.source_record !==
          `${block.publication.member}!row=${found.row}` ||
        JSON.stringify(record.raw) !== JSON.stringify(found.cells)
      )
        throw refuse("override rate differs from its SBE row");
    }
    for (const plan of entry.unknown_plans) {
      const found = rows.get(`${plan.plan_id}|${plan.region}`);
      let reason: string | null = "sbe_rate_row_missing";
      if (found)
        reason = sbePrices(found.cells) ? null : "sbe_tier_columns_non_uniform";
      if (reason !== plan.reason) throw refuse("unknown plan has a SBE rate");
    }
  }
}
