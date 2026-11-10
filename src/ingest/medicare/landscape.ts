import type { Database } from "../../db/database.js";
import { inspectZip } from "../../fetch/index.js";
import { readCsv } from "../csv/index.js";
import { countyKey } from "../geo/states.js";
import {
  isEmployerGroupPlan,
  planKeyFromParts,
} from "../../domain/medicare/index.js";
import type { CachedArchive } from "./acquire.js";
import { countyMap } from "./county-codes.js";
import { importRelease, insertRows } from "./release.js";
import type { ReleaseReport } from "./release.js";
import { archiveLimits } from "./sources.js";
import { memberText } from "./tabular.js";

const shared = [
  "Contract Year",
  "Contract Category Type",
  "US Territory",
  "State Territory Abbreviation",
  "State Territory Name",
  "County Name",
  "Contract ID",
  "Plan ID",
  "Segment ID",
];
const costs = [
  "Special Needs Plan (SNP) Indicator",
  "SNP Type",
  "SNP Institutional Type",
];
const tail = [
  "Dual Eligible SNP (D-SNP) Integration Status",
  "D-SNP Applicable Integrated Plan (AIP) Identifier",
  "Chronic or Disabling Condition SNP (C-SNP) Condition Type",
  "Medicare Zero-Dollar Cost Sharing D-SNP",
  "Part D Coverage Indicator",
  "National PDP",
  "Drug Benefit Category",
  "Drug Benefit Type",
  "Voluntary De Minimis Program Participant",
  "Part D Basic Premium At or Below Regional Benchmark",
  "Low Income Subsidy (LIS) Auto Enrollment",
  "Offers Drug Tier with No Part D Deductible",
  "Annual Part D Deductible Amount",
  "Part D Basic Premium",
  "Part D Supplemental Premium",
  "Part D Total Premium",
  "Low Income Premium Subsidy (LIPS) Amount",
  "Part D LIPS (CMS Pays)",
  "Part D Low Income Beneficiary Premium Amount",
  "Part D Out-of-Pocket (OOP) Threshold",
  "Part C Premium",
  "Monthly Consolidated Premium (Part C + D)",
  "In-Network Maximum Out-of-Pocket (MOOP) Amount",
  "Part C Summary Star Rating",
  "Part D Summary Star Rating",
  "Overall Star Rating",
  "MA Region Code",
  "MA Region",
  "PDP Region Code",
  "PDP Region",
];
const organization = [
  "Sanctioned Plan",
  "Parent Organization Name",
  "Contract Name",
  "Organization Marketing Name",
  "Organization Type",
  "Plan Name",
  "Plan Type",
];

/** Audited published headers (CY2026 release 202609 and CY2027 release 202611). */
export const landscapeHeaders: readonly (readonly string[])[] = [
  [
    ...shared,
    "ContractPlanID",
    "ContractPlanSegmentID",
    ...organization,
    ...costs,
    "SNP Institutional Category",
    ...tail,
  ],
  [
    ...shared,
    "Contract Plan ID",
    "Contract Plan Segment ID",
    ...organization,
    "Enrollment Capacity Limit Accepted",
    "Enrollment Capacity Limit Amount",
    ...costs,
    ...tail,
  ],
];

/** Cells that differ by county or state for one plan segment; all others must agree. */
export const countyCells = new Set([
  "US Territory",
  "State Territory Abbreviation",
  "State Territory Name",
  "County Name",
  "Low Income Premium Subsidy (LIPS) Amount",
  "MA Region Code",
  "MA Region",
  "PDP Region Code",
  "PDP Region",
]);

export function assertLandscapeHeader(header: readonly string[]): void {
  if (
    !landscapeHeaders.some(
      (known) =>
        known.length === header.length &&
        known.every((name, i) => name === header[i]),
    )
  )
    throw new Error("Landscape header differs from every audited release");
}

function yesNo(value: string | undefined): boolean | null {
  if (value === "Yes") return true;
  if (value === "No") return false;
  return null;
}

const planColumns = [
  "snapshot_id",
  "contract_year",
  "contract_id",
  "plan_id",
  "segment_id",
  "contract_category",
  "plan_type",
  "plan_name",
  "snp_type",
  "part_d_coverage",
  "cells",
  "source_row",
] as const;
const countyColumns = [
  "snapshot_id",
  "contract_id",
  "plan_id",
  "segment_id",
  "state",
  "county_name",
  "all_counties",
  "county_fips",
  "lips_amount",
  "ma_region_code",
  "pdp_region_code",
  "source_row",
] as const;

export async function importLandscape(
  db: Database,
  cached: CachedArchive,
): Promise<ReleaseReport> {
  const limits = archiveLimits.landscape;
  const member = (await inspectZip(cached.path, limits)).members.find((entry) =>
    /CY\d{4}_Landscape_\d{6}\.csv$/i.test(entry.name),
  )?.name;
  if (!member) throw new Error("Landscape archive has no CSV");
  return importRelease(db, cached, member, async (tx, snapshotId) => {
    const map = await countyMap(tx);
    if (!map.pairs.length)
      throw new Error("Import the CMS contract service-area files first");
    const names = new Map<string, Set<string>>();
    for (const pair of map.pairs) {
      const key = `${pair.state}:${countyKey(pair.county)}`;
      if (!names.has(key)) names.set(key, new Set());
      names.get(key)!.add(pair.fips);
    }
    const plans = new Map<
      string,
      { cells: Record<string, string>; row: number }
    >();
    const counties: unknown[][] = [];
    const counts = {
      rows: 0,
      segments: 0,
      county_rows: 0,
      all_counties_rows: 0,
      county_fips_resolved: 0,
      county_fips_unresolved: 0,
      county_fips_ambiguous: 0,
      employer_group_rows_skipped: 0,
      county_map_conflicted_ssa_codes: map.conflicted.length,
      county_map_ma_alternate_ssa_codes: map.maAlternates.length,
    };
    let checked = false;
    for await (const row of readCsv(
      memberText(cached.path, member, limits, "utf-8"),
    )) {
      if (!checked) {
        assertLandscapeHeader(Object.keys(row.values));
        checked = true;
      }
      counts.rows++;
      const v = row.values;
      const cells = Object.fromEntries(
        Object.entries(v).map(([name, value]) => [name, value.trim()]),
      );
      if (Number(cells["Contract Year"]) !== cached.archive.year)
        throw new Error("Landscape row has another contract year");
      const key = planKeyFromParts(
        cells["Contract ID"],
        cells["Plan ID"],
        cells["Segment ID"],
      );
      if (isEmployerGroupPlan(key.planId)) {
        counts.employer_group_rows_skipped++;
        continue;
      }
      const id = `${key.contractId}-${key.planId}-${key.segmentId}`;
      const plan = Object.fromEntries(
        Object.entries(cells).filter(([name]) => !countyCells.has(name)),
      );
      const existing = plans.get(id);
      if (!existing) plans.set(id, { cells: plan, row: row.rowNumber });
      else if (
        Object.keys(plan).some((name) => plan[name] !== existing.cells[name])
      )
        throw new Error(`Landscape segment ${id} differs across counties`);
      const state = cells["State Territory Abbreviation"] ?? "";
      const county = cells["County Name"] ?? "";
      if (!/^[A-Z]{2}$/.test(state) || !county)
        throw new Error("Landscape row has no state or county");
      const all = county === "All Counties";
      let fips: string | null = null;
      if (all) counts.all_counties_rows++;
      else {
        const found = names.get(`${state}:${countyKey(county)}`);
        if (found?.size === 1) {
          fips = [...found][0]!;
          counts.county_fips_resolved++;
        } else if (found) counts.county_fips_ambiguous++;
        else counts.county_fips_unresolved++;
      }
      counts.county_rows++;
      counties.push([
        snapshotId,
        key.contractId,
        key.planId,
        key.segmentId,
        state,
        county,
        all,
        fips,
        cells["Low Income Premium Subsidy (LIPS) Amount"] || null,
        cells["MA Region Code"] || null,
        cells["PDP Region Code"] || null,
        row.rowNumber,
      ]);
      if (counties.length >= 1000)
        await insertRows(tx, "medicare_plan_county", countyColumns, counties);
    }
    await insertRows(tx, "medicare_plan_county", countyColumns, counties);
    const batch: unknown[][] = [];
    for (const [id, plan] of plans) {
      const [contract, planId, segment] = id.split("-");
      const snp = plan.cells["SNP Type"];
      const partD = plan.cells["Part D Coverage Indicator"];
      batch.push([
        snapshotId,
        cached.archive.year,
        contract,
        planId,
        segment,
        plan.cells["Contract Category Type"],
        plan.cells["Plan Type"],
        plan.cells["Plan Name"],
        snp && snp !== "Not Applicable" ? snp : null,
        yesNo(partD),
        JSON.stringify(plan.cells),
        plan.row,
      ]);
      if (batch.length >= 500)
        await insertRows(tx, "medicare_plan", planColumns, batch);
    }
    await insertRows(tx, "medicare_plan", planColumns, batch);
    counts.segments = plans.size;
    if (!counts.segments) throw new Error("Empty Landscape release");
    return counts;
  });
}
