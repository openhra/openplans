// `worker backup-args`: dump exclusions for the core and registered pass-through sources.
import { describe, expect, it } from "vitest";
import type { PassThroughSource, Question } from "@openplans/plugin-sdk";
import { CMS_API_EXPORT_EXCLUDED_TABLES } from "../../src/ingest/cms-api/export.js";
import { backupArgs, runBackupArgs } from "../../src/worker/backup-args.js";

type Source = PassThroughSource<Question, unknown>;
const source = (
  id: string,
  level: Source["cache"]["level"],
  storage?: string[],
  excludeFromBackups?: boolean,
): Source =>
  ({
    kind: "passthrough",
    id,
    cache: { level, excludeFromBackups },
    ...(storage ? { storage: { excludedTables: storage } } : {}),
  }) as unknown as Source;

describe("worker backup-args", () => {
  it("prints the six CMS tables and the core tables with no source registered", () => {
    const out: string[] = [];
    expect(
      runBackupArgs([], { out: (l) => out.push(l), error: () => {} }, []),
    ).toBe(0);
    expect(out).toEqual([
      [
        ...CMS_API_EXPORT_EXCLUDED_TABLES,
        "passthrough_answer",
        "passthrough_attempt",
        "passthrough_conflict",
      ]
        .map((table) => `--exclude-table-data=${table}`)
        .join(" "),
    ]);
  });

  it("adds a stored source's own tables unless it opts back in", () => {
    const args = backupArgs([
      source("synthetic-own", "stored", ["plg_syn_answer", "plg_syn_attempt"]),
      source("synthetic-kept", "stored", ["plg_kept_answer"], false),
    ]);
    expect(args).toContain("--exclude-table-data=plg_syn_answer");
    expect(args).toContain("--exclude-table-data=plg_syn_attempt");
    expect(args).not.toContain("--exclude-table-data=plg_kept_answer");
    expect(new Set(args).size).toBe(args.length);
  });

  it("prints the excluded tables as a JSON manifest", () => {
    const out: string[] = [];
    expect(
      runBackupArgs(
        ["--manifest"],
        { out: (l) => out.push(l), error: () => {} },
        [source("synthetic-own", "stored", ["plg_syn_answer"])],
      ),
    ).toBe(0);
    expect(JSON.parse(out[0]!)).toEqual({
      excluded_table_data: [
        ...CMS_API_EXPORT_EXCLUDED_TABLES,
        "passthrough_answer",
        "passthrough_attempt",
        "passthrough_conflict",
        "plg_syn_answer",
      ],
    });
  });

  it("prints raw-body exclusions for the archive and refuses other arguments", () => {
    expect(
      backupArgs(
        [source("synthetic-own", "stored"), source("synthetic-none", "none")],
        true,
      ),
    ).toEqual([
      "--exclude=raw/cms-marketplace-*",
      "--exclude=raw/synthetic-own-*",
    ]);
    const errors: string[] = [];
    expect(
      runBackupArgs(
        ["--all"],
        { out: () => {}, error: (l) => errors.push(l) },
        [],
      ),
    ).toBe(1);
    expect(errors).toEqual(["Usage: worker backup-args [--tar | --manifest]"]);
  });
});
