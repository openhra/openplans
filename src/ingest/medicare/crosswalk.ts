import type { Database } from "../../db/database.js";
import { inspectZip } from "../../fetch/index.js";
import type { CachedArchive } from "./acquire.js";
import { importRelease, insertRows } from "./release.js";
import type { ReleaseReport } from "./release.js";
import { archiveLimits } from "./sources.js";
import { memberText, namedFields, tabTable } from "./tabular.js";

export const crosswalkHeader = [
  "previous_contract_id",
  "previous_plan_id",
  "previous_plan_name",
  "previous_snp_type",
  "previous_snp_institutional",
  "current_contract_id",
  "current_plan_id",
  "current_plan_name",
  "current_snp_type",
  "current_snp_institutional",
  "status",
];
const columns = [
  "snapshot_id",
  "contract_year",
  "previous_contract_id",
  "previous_plan_id",
  "previous_plan_name",
  "current_contract_id",
  "current_plan_id",
  "current_plan_name",
  "status",
  "source_row",
] as const;

function contract(value: string | undefined): string | null {
  const text = (value ?? "").trim();
  // Terminated plans publish no current plan (TERMINATED); new plans no previous one (NEW).
  if (!text || text === "TERMINATED" || text === "NEW") return null;
  if (!/^[EHRS]\d{4}$/.test(text))
    throw new Error("Invalid crosswalk contract");
  return text;
}
function plan(value: string | undefined): string | null {
  const text = (value ?? "").trim();
  if (!text || text === "TERMINATED" || text === "NEW") return null;
  if (!/^\d{1,3}$/.test(text)) throw new Error("Invalid crosswalk plan");
  return text.padStart(3, "0");
}

/** Prior-year to current-year plan lineage (plan level; the file has no segments). */
export async function importCrosswalk(
  db: Database,
  cached: CachedArchive,
): Promise<ReleaseReport> {
  const limits = archiveLimits.crosswalk;
  const member = (await inspectZip(cached.path, limits)).members.find((entry) =>
    /^PlanCrosswalk\d{4}_\d{8}\.txt$/i.test(entry.name),
  )?.name;
  if (!member) throw new Error("Crosswalk archive has no text table");
  return importRelease(db, cached, member, async (tx, snapshotId) => {
    const table = await tabTable(
      memberText(cached.path, member, limits, "windows-1252"),
      "\t",
      1024 * 1024,
      true,
    );
    const header = table.header.map((name) => name.trim().toLowerCase());
    if (
      header.length !== crosswalkHeader.length ||
      header.some((name, i) => name !== crosswalkHeader[i])
    )
      throw new Error("Crosswalk header changed");
    const counts: Record<string, number> = { rows: 0 };
    const batch: unknown[][] = [];
    for await (const row of table.rows) {
      const v = namedFields(header, row.fields, row.rowNumber);
      const status = (v.status ?? "").trim();
      if (!status) throw new Error("Crosswalk row has no status");
      counts.rows!++;
      counts[status] = (counts[status] ?? 0) + 1;
      batch.push([
        snapshotId,
        cached.archive.year,
        contract(v.previous_contract_id),
        plan(v.previous_plan_id),
        (v.previous_plan_name ?? "").trim() || null,
        contract(v.current_contract_id),
        plan(v.current_plan_id),
        ((v.current_plan_name ?? "").trim() || null) === "TERMINATED"
          ? null
          : (v.current_plan_name ?? "").trim() || null,
        status,
        row.rowNumber,
      ]);
      if (batch.length >= 1000)
        await insertRows(tx, "medicare_plan_crosswalk", columns, batch);
    }
    await insertRows(tx, "medicare_plan_crosswalk", columns, batch);
    if (!counts.rows) throw new Error("Empty crosswalk");
    return counts;
  });
}
