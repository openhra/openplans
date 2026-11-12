import type { PassThroughSource, Question } from "@openplans/plugin-sdk";
import { CMS_API_EXPORT_EXCLUDED_TABLES } from "../ingest/cms-api/export.js";
import { currentRegistries } from "../plugins/registries.js";
import { passThroughExcludedTables } from "../plugins/sources/passthrough.js";
import type { WorkerOutput } from "./commands.js";

const usage = "Usage: worker backup-args [--tar | --manifest]";

type Source = PassThroughSource<Question, unknown>;
const registered = (): Source[] =>
  currentRegistries()
    .sources.map((entry) => entry.spec)
    .filter((spec): spec is Source => spec.kind === "passthrough");

/**
 * Tables whose data a backup leaves out: the CMS Marketplace API tables, the pass-through core
 * tables, and each registered stored source's own tables unless it opted back in.
 */
export function backupExcludedTables(sources: readonly Source[]): string[] {
  return [
    ...new Set([
      ...CMS_API_EXPORT_EXCLUDED_TABLES,
      ...passThroughExcludedTables(sources),
    ]),
  ];
}

/** `pg_dump` arguments, or with `--tar` the archive's raw-body exclusions. */
export function backupArgs(sources: readonly Source[], tar = false): string[] {
  if (tar)
    return [
      "--exclude=raw/cms-marketplace-*",
      ...sources
        .filter((source) => source.cache.level === "stored")
        .map((source) => `--exclude=raw/${source.id}-*`),
    ].filter((value, index, all) => all.indexOf(value) === index);
  return backupExcludedTables(sources).map(
    (table) => `--exclude-table-data=${table}`,
  );
}

/**
 * `worker backup-args [--tar | --manifest]`: prints the arguments on one line, for a shell to
 * splice in. `--manifest` prints the excluded tables as JSON instead; keep it with the dump for
 * `worker backup-restored`.
 */
export function runBackupArgs(
  args: string[],
  output: WorkerOutput,
  sources: readonly Source[] = registered(),
): number {
  if (
    args.length > 1 ||
    (args.length === 1 && !["--tar", "--manifest"].includes(args[0]!))
  ) {
    output.error(usage);
    return 1;
  }
  if (args[0] === "--manifest") {
    output.out(
      JSON.stringify({ excluded_table_data: backupExcludedTables(sources) }),
    );
    return 0;
  }
  output.out(backupArgs(sources, args[0] === "--tar").join(" "));
  return 0;
}
