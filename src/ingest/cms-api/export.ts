import { CMS_API_EXPORT_EXCLUDED_TABLES } from "@openplans/source-cms-marketplace-api";

/**
 * Tables whose rows come from the CMS Marketplace API or describe calls to it, and the raw
 * bodies the backup archive leaves out. The list lives in the source package; `worker
 * backup-args` prints the arguments for an installation.
 */
export {
  CMS_API_EXPORT_EXCLUDED_RAW,
  CMS_API_EXPORT_EXCLUDED_TABLES,
} from "@openplans/source-cms-marketplace-api";

/** `pg_dump` arguments that keep API-sourced rows out of a dump. */
export function pgDumpExcludeArgs(): string[] {
  return CMS_API_EXPORT_EXCLUDED_TABLES.map(
    (table) => `--exclude-table-data=${table}`,
  );
}
