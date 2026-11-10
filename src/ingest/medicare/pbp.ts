import type { Database, SqlSession } from "../../db/database.js";
import { inspectZip } from "../../fetch/index.js";
import type { ZipMember } from "../../fetch/index.js";
import {
  isEmployerGroupPlan,
  parseMoney,
  planKeyFromParts,
} from "../../domain/medicare/index.js";
import type { CachedArchive } from "./acquire.js";
import { readDictionary } from "./dictionary.js";
import {
  assertHeaderMatches,
  assertTypedCell,
  parseSasLayout,
} from "./layout.js";
import type { SasLayout } from "./layout.js";
import { importRelease, insertRows } from "./release.js";
import type { ReleaseReport } from "./release.js";
import { archiveLimits } from "./sources.js";
import { memberText, namedFields, tabTable } from "./tabular.js";

/** Core benefit tables kept as filed (phase 1). VBID, step and model-test tables stay out. */
export const benefitTables = [
  "pbp_section_a",
  "pbp_section_d",
  "pbp_b1a_inpat_hosp",
  "pbp_b1b_inpat_hosp",
  "pbp_b2_snf",
  "pbp_b4_emerg_urgent",
  "pbp_b6_home_health",
  "pbp_b7_health_prof",
  "pbp_b8_clin_diag_ther",
  "pbp_b9_outpat_hosp",
  "pbp_b10_amb_trans",
  "pbp_b11_dme_prosth_orth_sup",
  "pbp_b14_preventive",
  "pbp_b16_dental",
  "pbp_b17_eye_exams_wear",
  "pbp_b18_hearing_exams_aids",
  "pbp_mrx",
  "pbp_mrx_tier",
] as const;
const keyColumns = ["pbp_a_hnumber", "pbp_a_plan_identifier", "segment_id"];

function find(members: ZipMember[], base: string, extension: string) {
  return members.find(
    (entry) =>
      entry.name.toLowerCase() === `${base}.${extension}`.toLowerCase(),
  )?.name;
}

async function layoutFor(
  path: string,
  members: ZipMember[],
  base: string,
): Promise<{ data: string; layout: SasLayout }> {
  const limits = archiveLimits.pbp;
  const data = find(members, base, "txt"),
    sas = find(members, base, "sas");
  if (!data || !sas) throw new Error(`PBP archive lacks ${base}`);
  let text = "";
  for await (const chunk of memberText(path, sas, limits, "windows-1252"))
    text += chunk;
  return { data, layout: parseSasLayout(text) };
}

async function* typedRows(path: string, members: ZipMember[], base: string) {
  const { data, layout } = await layoutFor(path, members, base);
  const table = await tabTable(
    memberText(path, data, archiveLimits.pbp, "windows-1252"),
  );
  assertHeaderMatches(table.header, layout, base);
  for await (const row of table.rows) {
    for (let i = 0; i < table.header.length; i++)
      assertTypedCell(
        layout,
        table.header[i]!.trim().toLowerCase(),
        row.fields[i]!,
        base,
        row.rowNumber,
      );
    yield {
      rowNumber: row.rowNumber,
      values: namedFields(table.header, row.fields, row.rowNumber),
    };
  }
}

export type Amount =
  | { status: "value"; cents: number; source: string }
  | { status: "none"; source: string }
  | { status: "unknown"; source: string };

/** A yes/no question (1 = yes, 2 = no, per the PBP dictionary) followed by its amount. */
export function amount(
  values: Record<string, string>,
  question: string,
  field: string,
): Amount {
  const answer = (values[question] ?? "").trim();
  if (answer === "2") return { status: "none", source: question };
  const cell = parseMoney(values[field]);
  if (answer === "1" && cell.status === "value")
    return { status: "value", cents: cell.cents, source: field };
  return { status: "unknown", source: field };
}

export function sectionASummary(values: Record<string, string>) {
  const text = (name: string) => (values[name] ?? "").trim() || null;
  return {
    organization_website: text("pbp_a_org_website"),
    formulary_website: text("pbp_a_formulary_web_addr"),
    pharmacy_website: text("pbp_a_pharmacy_website"),
    provider_directory_website: text("pbp_a_phys_web_addr"),
    member_phone: text("pbp_a_curmbr_phone"),
    prospective_member_phone: text("pbp_a_prombr_phone"),
    part_d_member_phone: text("pbp_a_pd_curmbr_phone"),
    part_d_prospective_member_phone: text("pbp_a_pd_prombr_phone"),
    tty_member_phone: text("pbp_a_ttytdd_curmbr_phone"),
    segment_name: text("pbp_a_segment_name"),
    plan_geography: text("pbp_a_plan_geog_name"),
  };
}

export function sectionDSummary(values: Record<string, string>) {
  const premium = parseMoney(values.pbp_d_mplusc_premium);
  return {
    medical_deductible: amount(
      values,
      "pbp_d_ann_deduct_yn",
      "pbp_d_ann_deduct_amt",
    ),
    in_network_deductible: amount(
      values,
      "pbp_d_inn_deduct_yn",
      "pbp_d_inn_deduct_amt",
    ),
    out_of_network_deductible: amount(
      values,
      "pbp_d_oon_deduct_yn",
      "pbp_d_oon_deduct_amt",
    ),
    moop_in_network: amount(
      values,
      "pbp_d_out_pocket_amt_yn",
      "pbp_d_out_pocket_amt",
    ),
    moop_combined: amount(
      values,
      "pbp_d_comb_max_enr_amt_yn",
      "pbp_d_comb_max_enr_amt",
    ),
    moop_out_of_network: amount(
      values,
      "pbp_d_oon_max_enr_oopc_yn",
      "pbp_d_oon_max_enr_oopc_amt",
    ),
    part_b_premium_reduction: amount(
      values,
      "pbp_d_mco_pay_reduct_yn",
      "pbp_d_mco_pay_reduct_amt",
    ),
    plan_premium:
      premium.status === "value"
        ? {
            status: "value" as const,
            cents: premium.cents,
            source: "pbp_d_mplusc_premium",
          }
        : { status: "unknown" as const, source: "pbp_d_mplusc_premium" },
  };
}

const areaColumns = [
  "snapshot_id",
  "contract_id",
  "plan_id",
  "segment_id",
  "source",
  "ssa_county_code",
  "county_name",
  "state",
  "region_type",
  "region_code",
  "region_name",
  "partial_county",
  "pending",
  "source_row",
] as const;
const rowColumns = [
  "snapshot_id",
  "table_name",
  "contract_id",
  "plan_id",
  "segment_id",
  "fields",
  "source_row",
] as const;

function flag(
  value: string | undefined,
  name: string,
  rowNumber: number,
): boolean {
  const text = (value ?? "").trim();
  // PlanArea marks a partial county with "*", as the contract service-area files do.
  if (text === "1" || (name === "partial_flag" && text === "*")) return true;
  if (text === "0" || text === "") return false;
  throw new Error(`PBP ${name} is not 0/1 at line ${rowNumber}`);
}

async function loadAreas(
  tx: SqlSession,
  snapshotId: string,
  path: string,
  members: ZipMember[],
  year: number,
  counts: Record<string, number>,
) {
  const batch: unknown[][] = [];
  for (const base of ["planarea", "planregionarea"]) {
    const source = base === "planarea" ? "plan_area" : "plan_region_area";
    for await (const row of typedRows(path, members, base)) {
      const v = row.values;
      counts[`${source}_rows`] = (counts[`${source}_rows`] ?? 0) + 1;
      if (Number(v.contract_year) !== year)
        throw new Error(`${base} row has another contract year`);
      // Demonstration contracts outside the H/R/S/E series (X0001 in CY2026) are not plans.
      if (!/^[EHRS]\d{4}$/.test((v.contract_id ?? "").trim())) {
        counts[`${source}_other_contract_skipped`] =
          (counts[`${source}_other_contract_skipped`] ?? 0) + 1;
        continue;
      }
      const key = planKeyFromParts(v.contract_id, v.plan_id, v.segment_id);
      if (
        flag(v.eghp_flag, "eghp_flag", row.rowNumber) ||
        isEmployerGroupPlan(key.planId)
      ) {
        counts[`${source}_employer_group_skipped`] =
          (counts[`${source}_employer_group_skipped`] ?? 0) + 1;
        continue;
      }
      const ssa = source === "plan_area" ? (v.county_code ?? "").trim() : null;
      if (ssa !== null && !/^\d{5}$/.test(ssa))
        throw new Error(
          `PlanArea county code invalid at line ${row.rowNumber}`,
        );
      batch.push([
        snapshotId,
        key.contractId,
        key.planId,
        key.segmentId,
        source,
        ssa,
        (v.county ?? "").trim() || null,
        (v.stcd ?? "").trim() || null,
        (v.region_type ?? "").trim() || null,
        (v.ma_or_pdp_region_code ?? "").trim() || null,
        (v.region ?? "").trim() || null,
        flag(v.partial_flag, "partial_flag", row.rowNumber),
        flag(v.pending_flag, "pending_flag", row.rowNumber),
        row.rowNumber,
      ]);
      counts[`${source}_loaded`] = (counts[`${source}_loaded`] ?? 0) + 1;
      if (batch.length >= 2000)
        await insertRows(tx, "medicare_plan_area", areaColumns, batch);
    }
  }
  await insertRows(tx, "medicare_plan_area", areaColumns, batch);
}

export async function importPbp(
  db: Database,
  cached: CachedArchive,
): Promise<ReleaseReport> {
  const limits = archiveLimits.pbp;
  const members = (await inspectZip(cached.path, limits)).members;
  const dictionary = await readDictionary(cached.path, limits);
  return importRelease(
    db,
    cached,
    "pbp_*.txt, PlanArea.txt, PlanRegionArea.txt",
    async (tx, snapshotId) => {
      const counts: Record<string, number> = {};
      const employer = new Set<string>();
      const summaries = new Map<
        string,
        {
          planType: string | null;
          summary: Record<string, unknown>;
          rows: Record<string, number>;
        }
      >();
      const batch: unknown[][] = [];
      for (const table of benefitTables) {
        let loaded = 0,
          skipped = 0;
        for await (const row of typedRows(cached.path, members, table)) {
          const v = row.values;
          const key = planKeyFromParts(
            v[keyColumns[0]!],
            v[keyColumns[1]!],
            v[keyColumns[2]!],
          );
          const id = `${key.contractId}-${key.planId}-${key.segmentId}`;
          if (
            table === "pbp_section_a" &&
            (v.pbp_a_eghp_yn ?? "").trim() === "1"
          )
            employer.add(id);
          if (employer.has(id) || isEmployerGroupPlan(key.planId)) {
            skipped++;
            continue;
          }
          if (table === "pbp_section_a" || table === "pbp_section_d") {
            const entry = summaries.get(id) ?? {
              planType: null,
              summary: {},
              rows: {},
            };
            if (entry.rows[table]) throw new Error(`${table} repeats ${id}`);
            entry.rows[table] = row.rowNumber;
            if (table === "pbp_section_a") {
              entry.planType = (v.pbp_a_plan_type ?? "").trim() || null;
              Object.assign(entry.summary, sectionASummary(v));
            } else Object.assign(entry.summary, sectionDSummary(v));
            summaries.set(id, entry);
          }
          const fields = Object.fromEntries(
            Object.entries(v).filter(([, value]) => value.trim() !== ""),
          );
          batch.push([
            snapshotId,
            table,
            key.contractId,
            key.planId,
            key.segmentId,
            JSON.stringify(fields),
            row.rowNumber,
          ]);
          loaded++;
          if (batch.length >= 500)
            await insertRows(tx, "medicare_pbp_row", rowColumns, batch);
        }
        await insertRows(tx, "medicare_pbp_row", rowColumns, batch);
        counts[`${table}_rows`] = loaded;
        counts[`${table}_employer_group_skipped`] = skipped;
      }
      const plans: unknown[][] = [];
      for (const [id, entry] of summaries) {
        const [contract, plan, segment] = id.split("-");
        plans.push([
          snapshotId,
          contract,
          plan,
          segment,
          entry.planType,
          JSON.stringify(entry.summary),
          JSON.stringify(entry.rows),
        ]);
        if (plans.length >= 500)
          await insertRows(
            tx,
            "medicare_pbp_plan",
            [
              "snapshot_id",
              "contract_id",
              "plan_id",
              "segment_id",
              "plan_type_code",
              "summary",
              "source_rows",
            ],
            plans,
          );
      }
      await insertRows(
        tx,
        "medicare_pbp_plan",
        [
          "snapshot_id",
          "contract_id",
          "plan_id",
          "segment_id",
          "plan_type_code",
          "summary",
          "source_rows",
        ],
        plans,
      );
      counts.plan_summaries = summaries.size;
      const wanted = new Set<string>(benefitTables);
      const fields: unknown[][] = [];
      for (const field of dictionary) {
        if (!wanted.has(field.table)) continue;
        fields.push([
          snapshotId,
          field.table,
          field.field,
          field.dataType || null,
          field.title || null,
          JSON.stringify(field.codes),
        ]);
        if (fields.length >= 500)
          await insertRows(
            tx,
            "medicare_pbp_field",
            [
              "snapshot_id",
              "table_name",
              "field",
              "data_type",
              "title",
              "codes",
            ],
            fields,
          );
      }
      await insertRows(
        tx,
        "medicare_pbp_field",
        ["snapshot_id", "table_name", "field", "data_type", "title", "codes"],
        fields,
      );
      counts.dictionary_fields = dictionary.filter((field) =>
        wanted.has(field.table),
      ).length;
      await loadAreas(
        tx,
        snapshotId,
        cached.path,
        members,
        cached.archive.year,
        counts,
      );
      if (!counts.plan_area_loaded)
        throw new Error("PBP release has no plan service areas");
      return counts;
    },
  );
}
