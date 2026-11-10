import type { Database } from "../../db/database.js";
import { importPufs } from "../puf/import.js";
import type { PufImportOptions } from "../puf/import.js";
import {
  importDataDirectory,
  importRows,
  isStateCatalogSource,
} from "../puf/import-source.js";
import { acquireSbe, cachedSbe, sbePublications } from "./source.js";
import {
  cachedGeorgiaAccess,
  georgiaAccessSelectable,
  georgiaQuoteRecovery,
} from "./georgia.js";
import { activateSbeRules } from "./rules.js";
import { SHOP_MARKET } from "../puf/import-repository.js";

export async function importSbe(
  db: Database,
  options: PufImportOptions & { acquire?: boolean },
) {
  const dataDir = options.dataDir ?? importDataDirectory();
  const links = options.files
    ? []
    : await sbePublications(dataDir, options.acquire !== false);
  const link = links.find(
    (l) => l.state === options.state && l.year === options.year,
  );
  // Georgia Access's own files serve only a year CMS has not published, from the cache.
  const georgia =
    !options.files &&
    !link &&
    options.state === "GA" &&
    georgiaAccessSelectable(links, options.year);
  if (!options.files && !link && !georgia)
    throw new Error("SBE state/year is not published");
  let files = options.files;
  if (!files && georgia)
    files = await cachedGeorgiaAccess(dataDir, options.year, {
      recoverUnescapedQuotes: georgiaQuoteRecovery(),
    });
  files ??= await (options.acquire === false ? cachedSbe : acquireSbe)(
    link!,
    dataDir,
  );
  if (
    files.some((file) => !isStateCatalogSource(file.source) || !file.member) ||
    new Set(files.map((file) => file.source)).size !== 1
  )
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
  let individual = false,
    shop = false;
  for await (const row of importRows(
    files.find((f) => f.kind === "plan-attributes")!,
  )) {
    if (
      row.values.StateCode !== options.state ||
      row.values.BusinessYear !== String(options.year)
    )
      throw new Error("SBE bundle scope mismatch");
    individual ||= row.values.MarketCoverage === "Individual";
    shop ||= row.values.MarketCoverage === SHOP_MARKET;
  }
  const filedTierState = ["NY", "VT"].includes(options.state);
  const publish = !filedTierState && individual;
  // A SHOP-only bundle never replaces the individual catalog; it serves only its SHOP rows.
  const marketsWithoutPublish =
    !filedTierState && !individual && shop ? [SHOP_MARKET] : [];
  const report = await importPufs(db, {
    ...options,
    dataDir,
    files,
    publish,
    marketsWithoutPublish,
  });
  if (report.passed && publish)
    await activateSbeRules(db, dataDir, options.year);
  return {
    ...report,
    source: files[0]!.source!,
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
