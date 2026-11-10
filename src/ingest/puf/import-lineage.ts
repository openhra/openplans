import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Database, SqlSession } from "../../db/database.js";
import { readCsv } from "../csv/index.js";
import type { CsvRow } from "../csv/index.js";
import {
  csvArchiveRows,
  importDataDirectory,
  manifestArchive,
  newestPufManifest,
  verifyImportFile,
} from "./import-source.js";
import type { ImportFile } from "./import-source.js";
import { importIssue, saveImportSnapshot } from "./import-repository.js";

/** CMS Plan ID Crosswalk PUF: maps each prior-year plan to its successor, by county. */
export const LINEAGE_KIND = "plan-id-crosswalk";
/** CMS publishes this all-zero ID when a row has no successor (or no age-off/CSR plan). */
export const NO_PLAN_ID = "00000XX0000000";
const NO_ISSUER_ID = "00000";
const PLAN_ID = /^\d{5}[A-Z]{2}\d{7}$/;
const BATCH_ROWS = 250;
const LINEAGE_COLUMNS =
  "snapshot_id,source_row,state,dental_only,prior_year,prior_plan_id,prior_issuer_id,plan_year,plan_id,issuer_id,county_fips,zip_code,crosswalk_level,crosswalk_reason,age_off_plan_id,silver_csr_plan_id,raw";

export type LineageFile = Omit<ImportFile, "kind">;
export interface LineageImportOptions {
  /** Successor (publication) year: the PY2026 file maps 2025 plans to 2026 plans. */
  year: number;
  dataDir?: string;
  /** Trusted offline file, used by fixtures. Production reads the newest acquired manifest. */
  file?: LineageFile;
  manifestPath?: string | null;
}
export interface LineageImportReport {
  import_id: string;
  year: number;
  prior_year: number;
  status: "ACTIVE" | "QUARANTINED";
  passed: boolean;
  sha256: string;
  url: string;
  manifest_path: string | null;
  input_rows: number;
  stored_rows: number;
  rejected_rows: number;
  states: string[];
  successor_plans: number;
  prior_plans: number;
  lineage_pairs: number;
  failures: string[];
  wall_seconds: number;
  report_json: string;
  report_md: string;
}

export class MissingLineageColumnsError extends Error {}

export function lineageColumns(year: number): string[] {
  const prior = year - 1;
  return [
    "State",
    "DentalPlan",
    `PlanID_${prior}`,
    `IssuerID_${prior}`,
    "FIPSCode",
    "ZipCode",
    "CrosswalkLevel",
    "ReasonForCrosswalk",
    `PlanID_${year}`,
    `IssuerID_${year}`,
    `AgeOffPlanID_${year}`,
    `SilverCSREligPlanID_${year}`,
  ];
}

function validateLineageHeader(values: Record<string, string>, year: number) {
  const missing = lineageColumns(year).filter(
    (key) => !Object.hasOwn(values, key),
  );
  if (missing.length)
    throw new MissingLineageColumnsError(
      `Missing critical crosswalk columns (PY${year}): ${missing.join(", ")}`,
    );
}

/** A published plan ID must belong to its row's state and issuer columns. */
function planIdentity(id: string, issuer: string, state: string): string {
  if (
    !PLAN_ID.test(id) ||
    id.slice(0, 5) !== issuer ||
    id.slice(5, 7) !== state
  )
    throw new Error("Invalid crosswalk plan identity");
  return id;
}

function optionalPlanId(id: string, state: string): string | null {
  if (id === NO_PLAN_ID) return null;
  if (!PLAN_ID.test(id) || id.slice(5, 7) !== state)
    throw new Error("Invalid crosswalk plan identity");
  return id;
}

export function parseLineageRow(
  row: CsvRow,
  snapshot: string,
  year: number,
): unknown[] {
  const r = row.values,
    prior = year - 1,
    state = r.State ?? "";
  if (!/^[A-Z]{2}$/.test(state)) throw new Error("Invalid crosswalk state");
  if (!/^\d{5}$/.test(r.FIPSCode ?? ""))
    throw new Error("Invalid crosswalk county");
  if (!/^\d{5}$/.test(r.ZipCode ?? ""))
    throw new Error("Invalid crosswalk ZIP");
  const dental = ({ Y: true, N: false } as Record<string, boolean>)[
    r.DentalPlan ?? ""
  ];
  if (dental === undefined) throw new Error("Invalid crosswalk dental flag");
  const priorIssuer = r[`IssuerID_${prior}`]!;
  const priorPlan = planIdentity(r[`PlanID_${prior}`]!, priorIssuer, state);
  const successorIssuer = r[`IssuerID_${year}`]!;
  const successor =
    r[`PlanID_${year}`] === NO_PLAN_ID
      ? null
      : planIdentity(r[`PlanID_${year}`]!, successorIssuer, state);
  if (successor === null && successorIssuer !== NO_ISSUER_ID)
    throw new Error("Issuer without a successor plan");
  return [
    snapshot,
    row.rowNumber,
    state,
    dental,
    prior,
    priorPlan,
    priorIssuer,
    year,
    successor,
    successor === null ? null : successorIssuer,
    r.FIPSCode,
    r.ZipCode,
    r.CrosswalkLevel,
    r.ReasonForCrosswalk,
    optionalPlanId(r[`AgeOffPlanID_${year}`]!, state),
    optionalPlanId(r[`SilverCSREligPlanID_${year}`]!, state),
    JSON.stringify(r),
  ];
}

async function insertLineageRows(tx: SqlSession, rows: unknown[][]) {
  if (!rows.length) return;
  const values: unknown[] = [];
  const groups = rows.map(
    (row) =>
      `(${row
        .map((value) => {
          values.push(value);
          return `$${values.length}`;
        })
        .join(",")})`,
  );
  await tx.query(
    `INSERT INTO plan_lineage (${LINEAGE_COLUMNS}) VALUES ${groups.join(",")}`,
    values,
  );
}

export async function cachedLineageFile(
  dataDir: string,
  year: number,
): Promise<{ file: LineageFile; manifestPath: string }> {
  const { manifest, manifestPath, directory } =
    await newestPufManifest(dataDir);
  return {
    file: await manifestArchive(directory, manifest, year, LINEAGE_KIND),
    manifestPath,
  };
}

/**
 * Imports one crosswalk publication as an immutable snapshot. Every row must parse;
 * any rejected row quarantines the snapshot and leaves the served pointer unchanged.
 */
export async function importPlanLineage(
  db: Database,
  options: LineageImportOptions,
): Promise<LineageImportReport> {
  const started = Date.now(),
    { year } = options;
  const dataDir = options.dataDir ?? importDataDirectory();
  if (![2026, 2027].includes(year) || !isAbsolute(dataDir))
    throw new TypeError("Invalid crosswalk import scope");
  const acquired = options.file
    ? { file: options.file, manifestPath: options.manifestPath ?? null }
    : await cachedLineageFile(dataDir, year);
  const { file } = acquired;
  const id = `puf-lineage-${year}-${randomUUID()}`;
  const failures: string[] = [];
  let inputRows = 0,
    rejectedRows = 0;
  await db.transaction((tx) =>
    saveImportSnapshot(
      tx,
      id,
      `cms-exchange-puf:${year}:${LINEAGE_KIND}`,
      file,
    ),
  );
  try {
    await verifyImportFile(file);
    await db.transaction(async (tx) => {
      let batch: unknown[][] = [],
        headerValidated = false;
      for await (const row of file.format === "csv"
        ? readCsv(createReadStream(file.path))
        : csvArchiveRows(file.path)) {
        if (!headerValidated) {
          validateLineageHeader(row.values, year);
          headerValidated = true;
        }
        inputRows++;
        try {
          batch.push(parseLineageRow(row, id, year));
        } catch {
          rejectedRows++;
          await importIssue(
            tx,
            id,
            "invalid_source_row",
            "Invalid crosswalk plan identity, geography or flag; source row retained in immutable input.",
            row.rowNumber,
          );
        }
        if (batch.length >= BATCH_ROWS) {
          await insertLineageRows(tx, batch);
          batch = [];
        }
      }
      await insertLineageRows(tx, batch);
    });
  } catch (error) {
    failures.push(
      error instanceof MissingLineageColumnsError
        ? error.message
        : "Crosswalk hash, archive or CSV schema failed; rows rolled back.",
    );
    await importIssue(db, id, "file_import_failed", failures.at(-1)!);
  }
  const { rows } = await db.query<{
    stored: number;
    states: string[] | null;
    successors: number;
    priors: number;
    pairs: number;
  }>(
    `SELECT count(*)::int AS stored,array_agg(DISTINCT state ORDER BY state) AS states,
      count(DISTINCT plan_id)::int AS successors,count(DISTINCT prior_plan_id)::int AS priors,
      count(DISTINCT (plan_id,prior_plan_id)) FILTER (WHERE plan_id IS NOT NULL)::int AS pairs
    FROM plan_lineage WHERE snapshot_id=$1`,
    [id],
  );
  const counts = rows[0]!;
  if (rejectedRows) failures.push(`${rejectedRows} crosswalk rows rejected`);
  if (!inputRows) failures.push("Crosswalk publication has no rows");
  if (counts.stored !== inputRows - rejectedRows)
    failures.push("Stored crosswalk rows differ from parsed input rows");
  const passed = failures.length === 0;
  await db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(1869636976)");
    if (!passed) {
      await tx.query(
        "UPDATE snapshot SET validation_state='QUARANTINED' WHERE snapshot_id=$1",
        [id],
      );
      return;
    }
    for (const next of ["VALIDATED", "RECONCILED", "ACTIVE"])
      await tx.query(
        `UPDATE snapshot SET validation_state=$2,activated_at=CASE WHEN $2='ACTIVE' THEN now() ELSE activated_at END WHERE snapshot_id=$1`,
        [id, next],
      );
    await tx.query(
      `INSERT INTO plan_lineage_active(plan_year,snapshot_id) VALUES($1,$2)
      ON CONFLICT(plan_year) DO UPDATE SET snapshot_id=EXCLUDED.snapshot_id`,
      [year, id],
    );
  });
  const stem = join(dataDir, "reports", id);
  const report: LineageImportReport = {
    import_id: id,
    year,
    prior_year: year - 1,
    status: passed ? "ACTIVE" : "QUARANTINED",
    passed,
    sha256: file.sha256,
    url: file.url,
    manifest_path: acquired.manifestPath,
    input_rows: inputRows,
    stored_rows: counts.stored,
    rejected_rows: rejectedRows,
    states: counts.states ?? [],
    successor_plans: counts.successors,
    prior_plans: counts.priors,
    lineage_pairs: counts.pairs,
    failures,
    wall_seconds: (Date.now() - started) / 1000,
    report_json: `${stem}.json`,
    report_md: `${stem}.md`,
  };
  await mkdir(join(dataDir, "reports"), { recursive: true });
  await writeFile(report.report_json, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(
    report.report_md,
    `# CMS Plan ID Crosswalk PY${year}: ${report.status}\n\nImport: ${id}. Wall time: ${report.wall_seconds}s.\n\n| Input | Stored | Rejected | States | Successor plans | Prior plans | Pairs |\n| ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n| ${inputRows} | ${counts.stored} | ${rejectedRows} | ${report.states.length} | ${counts.successors} | ${counts.priors} | ${counts.pairs} |\n\n${failures.map((f) => `- ${f}`).join("\n")}\n`,
  );
  return report;
}
