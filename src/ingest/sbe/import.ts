import type { Database } from "../../db/database.js";
import { importPufs } from "../puf/import.js";
import type { PufImportOptions } from "../puf/import.js";
import { importDataDirectory, importRows } from "../puf/import-source.js";
import { acquireSbe, cachedSbe, sbePublications } from "./source.js";
import { activateSbeRules } from "./rules.js";

export async function importSbe(
  db: Database,
  options: PufImportOptions & { acquire?: boolean },
) {
  const dataDir = options.dataDir ?? importDataDirectory();
  const link = options.files
    ? undefined
    : (await sbePublications(dataDir, options.acquire !== false)).find(
        (l) => l.state === options.state && l.year === options.year,
      );
  if (!options.files && !link)
    throw new Error("SBE state/year is not published");
  const files =
    options.files ??
    (await (options.acquire === false ? cachedSbe : acquireSbe)(
      link!,
      dataDir,
    ));
  if (files.some((file) => file.source !== "cms_sbe_puf" || !file.member))
    throw new Error("SBE import requires explicit source/member provenance");
  if (
    files.some((file) => file.format === "zip") &&
    files.some(
      (file) =>
        file.format !== "zip" ||
        file.path !== files[0]!.path ||
        file.sha256 !== files[0]!.sha256 ||
        file.url !== files[0]!.url,
    )
  )
    throw new Error("Mixed SBE archive versions");
  let individual = false;
  for await (const row of importRows(
    files.find((f) => f.kind === "plan-attributes")!,
  )) {
    if (
      row.values.StateCode !== options.state ||
      row.values.BusinessYear !== String(options.year)
    )
      throw new Error("SBE bundle scope mismatch");
    individual ||= row.values.MarketCoverage === "Individual";
  }
  const publish = !["NY", "VT"].includes(options.state) && individual;
  const report = await importPufs(db, { ...options, dataDir, files, publish });
  if (report.passed && publish)
    await activateSbeRules(db, dataDir, options.year);
  return {
    ...report,
    source: "cms_sbe_puf",
    serving: report.passed && publish,
    ...(!publish
      ? {
          serving_reason: ["NY", "VT"].includes(options.state)
            ? "existing_state_filed_tier_path_preserved"
            : "shop_only_federal_catalog_preserved",
        }
      : {}),
  };
}
