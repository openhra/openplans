/**
 * Tables whose rows come from the CMS Marketplace API or describe calls to it. The backup
 * commands in docs/self-host.md leave their data out, so a dump never carries API answers.
 * Receipts in `snapshot` stay. They hold a hash and a redacted URL, not the answer.
 */
export const CMS_API_EXPORT_EXCLUDED_TABLES: readonly string[] = [
  "cms_api_attempt",
  "cms_api_conflict",
  "cms_api_drug_coverage",
  "cms_api_provider_coverage",
  "cms_zip_attempt",
  "cms_zip_lookup",
];
/** Raw response bodies under the data directory that the backup archive leaves out. */
export const CMS_API_EXPORT_EXCLUDED_RAW = "raw/cms-marketplace-*";

/** `pg_dump` arguments that keep API-sourced rows out of a dump. */
export function pgDumpExcludeArgs(): string[] {
  return CMS_API_EXPORT_EXCLUDED_TABLES.map(
    (table) => `--exclude-table-data=${table}`,
  );
}
