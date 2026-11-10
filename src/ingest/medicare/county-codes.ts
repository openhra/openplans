import type { Database, SqlSession } from "../../db/database.js";
import { inspectZip } from "../../fetch/index.js";
import { readCsv } from "../csv/index.js";
import type { CachedArchive } from "./acquire.js";
import { importRelease, insertRows } from "./release.js";
import type { ReleaseReport } from "./release.js";
import { archiveLimits } from "./sources.js";
import { memberText } from "./tabular.js";

const columns = [
  "snapshot_id",
  "ssa_county_code",
  "county_fips",
  "state",
  "county_name",
  "first_source_row",
] as const;

/** Distinct SSA/FIPS pairs of one monthly MA or PDP contract service-area file. */
export async function importServiceArea(
  db: Database,
  cached: CachedArchive,
): Promise<ReleaseReport> {
  const limits = archiveLimits.service_area;
  const member = (await inspectZip(cached.path, limits)).members.find((entry) =>
    /_Cnty_SA_\d{4}_\d{2}\.csv$/i.test(entry.name),
  )?.name;
  if (!member) throw new Error("Service-area archive has no county CSV");
  return importRelease(db, cached, member, async (tx, snapshotId) => {
    const seen = new Map<string, unknown[]>();
    let rows = 0,
      unmapped = 0,
      national = 0;
    for await (const row of readCsv(
      memberText(cached.path, member, limits, "utf-8"),
    )) {
      rows++;
      const v = row.values;
      const ssa = (v.SSA ?? "").trim(),
        fips = (v.FIPS ?? "").trim();
      const county = (v.COUNTY ?? v.County ?? "").trim(),
        state = (v.STCD ?? v.State ?? "").trim();
      if (!("SSA" in v) || !("FIPS" in v))
        throw new Error("Service-area header changed");
      if (!ssa && !fips) {
        national++;
        continue;
      }
      if (!/^\d{5}$/.test(ssa)) throw new Error("Invalid SSA county code");
      if (!fips) {
        unmapped++;
        continue;
      }
      if (!/^\d{5}$/.test(fips)) throw new Error("Invalid county FIPS");
      const key = `${ssa}:${fips}`;
      if (!seen.has(key))
        seen.set(key, [snapshotId, ssa, fips, state, county, row.rowNumber]);
    }
    const batch: unknown[][] = [];
    for (const value of seen.values()) {
      batch.push(value);
      if (batch.length >= 1000)
        await insertRows(tx, "medicare_county_code", columns, batch);
    }
    await insertRows(tx, "medicare_county_code", columns, batch);
    if (!seen.size) throw new Error("Service-area file has no county codes");
    return {
      rows,
      pairs: seen.size,
      rows_without_fips: unmapped,
      rows_without_county: national,
    };
  });
}

export interface CountyCode {
  ssa: string;
  fips: string;
  state: string;
  county: string;
  evidence: "pdp_service_area" | "ma_service_area";
}
export interface CountyMap {
  pairs: CountyCode[];
  /** SSA codes the PDP and MA files map to disjoint FIPS sets: left unmapped (unknown). */
  conflicted: string[];
  /** SSA codes where the MA file adds FIPS codes the PDP file does not list (kept from PDP only). */
  maAlternates: string[];
  snapshots: string[];
}

/**
 * The newest active PDP file is primary (PDP regions cover every county). The newest MA file adds
 * SSA codes the PDP file lacks. The MA file also lists retired codes beside current ones (Miami-Dade
 * 12025 next to 12086), so extra MA codes for a PDP-mapped SSA code are reported, not used. Only
 * disjoint mappings are conflicts, and those SSA codes stay unmapped.
 */
export async function countyMap(db: SqlSession): Promise<CountyMap> {
  const releases = (
    await db.query<{ snapshot_id: string; kind: string }>(
      `SELECT DISTINCT ON (split_part(r.as_of_label,'-',1)) r.snapshot_id, split_part(r.as_of_label,'-',1) AS kind
       FROM medicare_release r JOIN snapshot s USING(snapshot_id)
       WHERE r.family='service_area' AND s.validation_state='ACTIVE'
       ORDER BY split_part(r.as_of_label,'-',1), r.as_of DESC, r.imported_at DESC`,
    )
  ).rows;
  const by = (kind: string) =>
    releases.find((r) => r.kind === kind)?.snapshot_id;
  const load = async (snapshot: string | undefined) =>
    snapshot
      ? (
          await db.query<{
            ssa: string;
            fips: string;
            state: string;
            county: string;
          }>(
            `SELECT ssa_county_code AS ssa, county_fips AS fips, state, county_name AS county
             FROM medicare_county_code WHERE snapshot_id=$1 ORDER BY ssa_county_code, county_fips`,
            [snapshot],
          )
        ).rows
      : [];
  const pdp = await load(by("pdp")),
    ma = await load(by("ma"));
  const sets = (rows: { ssa: string; fips: string }[]) => {
    const map = new Map<string, Set<string>>();
    for (const row of rows) {
      if (!map.has(row.ssa)) map.set(row.ssa, new Set());
      map.get(row.ssa)!.add(row.fips);
    }
    return map;
  };
  const pdpSets = sets(pdp),
    maSets = sets(ma);
  const conflicted: string[] = [],
    maAlternates: string[] = [];
  for (const [ssa, mine] of pdpSets) {
    const other = maSets.get(ssa);
    if (!other) continue;
    if (![...other].some((fips) => mine.has(fips))) conflicted.push(ssa);
    else if ([...other].some((fips) => !mine.has(fips))) maAlternates.push(ssa);
  }
  const blocked = new Set(conflicted);
  const pairs: CountyCode[] = [
    ...pdp
      .filter((row) => !blocked.has(row.ssa))
      .map((row) => ({ ...row, evidence: "pdp_service_area" as const })),
    ...ma
      .filter((row) => !pdpSets.has(row.ssa))
      .map((row) => ({ ...row, evidence: "ma_service_area" as const })),
  ];
  return {
    pairs,
    conflicted,
    maAlternates,
    snapshots: [by("pdp"), by("ma")].filter((id): id is string => !!id),
  };
}
