import { open } from "node:fs/promises";
import type { AnnualDomain } from "@openplans/plugin-sdk";
import { resolveAnnualPolicy } from "../domain/data-window.js";
import { currentDataPolicy } from "../services/data-window.js";

export interface AnnualSkip {
  dataset: string;
  year: number;
  reason: "outside_data_window";
}

/** Importers reject before opening source payloads or writing any receipt. */
export class AnnualImportSkipped extends Error {
  constructor(
    readonly skip: AnnualSkip,
    readonly skipped: readonly AnnualSkip[] = [skip],
  ) {
    super(skip.reason);
  }
}

export function planAnnualWork(
  dataset: string,
  years: readonly number[],
  domain: AnnualDomain = "individual",
  now?: Date,
): { years: number[]; skipped: AnnualSkip[]; allowed_years: number[] | null } {
  const context = currentDataPolicy();
  const requested = [...new Set(years)];
  if (
    requested.some(
      (year) => !Number.isInteger(year) || year < 2006 || year > 9999,
    )
  )
    throw new TypeError("Invalid annual import year");
  const policy = resolveAnnualPolicy(
    context.config.historyYears,
    [],
    { individual: requested, medicare: requested },
    now ?? new Date(context.time),
    "build",
  );
  const allowed = policy.domains[domain].allowed_years;
  return {
    allowed_years: policy.history_years === "all" ? null : allowed,
    years: requested.filter((year) => allowed.includes(year)),
    skipped: requested
      .filter((year) => !allowed.includes(year))
      .map((year) => ({
        dataset,
        year,
        reason: "outside_data_window",
      })),
  };
}

export function requireImportYear(
  dataset: string,
  year: number,
  domain: AnnualDomain = "individual",
): void {
  const skip = planAnnualWork(dataset, [year], domain).skipped[0];
  if (skip) throw new AnnualImportSkipped(skip);
}

export function skipAnnualCommand(
  dataset: string,
  year: number,
  output: { out(message: string): void },
  domain: AnnualDomain = "individual",
): boolean {
  const work = planAnnualWork(dataset, [year], domain);
  if (!work.skipped.length) return false;
  output.out(JSON.stringify({ skipped: work.skipped }));
  return true;
}

/** Prepared JSON artifacts put their plan year in a bounded header, ahead of source rows. */
export async function requireAnnualDocument(
  path: string,
  dataset: string,
): Promise<number> {
  const file = await open(path, "r");
  try {
    const header = Buffer.alloc(65536);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    const year = /"plan_year"\s*:\s*(\d{4})\b/.exec(
      header.toString("utf8", 0, bytesRead),
    );
    if (!year) throw new Error("Annual artifact header requires a plan year");
    const value = Number(year[1]);
    requireImportYear(dataset, value);
    return value;
  } finally {
    await file.close();
  }
}

export function reportImportSkip(
  error: unknown,
  output: { out(message: string): void },
): boolean {
  if (!(error instanceof AnnualImportSkipped)) return false;
  output.out(JSON.stringify({ skipped: error.skipped }));
  return true;
}

/** Developer copy runners must check embedded years before inserting a batch. */
export function requireImportRows(
  dataset: string,
  rows: readonly Record<string, unknown>[],
): void {
  const years = rows.flatMap((row) =>
    [row.plan_year, row.contract_year]
      .filter((year) => year !== undefined)
      .map(Number),
  );
  const skip = planAnnualWork(dataset, years).skipped[0];
  if (skip) throw new AnnualImportSkipped(skip);
}
