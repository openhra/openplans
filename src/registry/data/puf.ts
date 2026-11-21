import { basename, extname } from "node:path";
import { z } from "zod";
import type { FeedSource } from "@openplans/plugin-sdk";
import type { PackageManifest } from "@openplans/plugin-sdk/dist/package-manifest.js";
import type { Database } from "../../db/database.js";
import { accessState } from "../../fetch/admission.js";
import { importPufs } from "../../ingest/puf/import.js";
import type { PufImportReport } from "../../ingest/puf/import.js";
import { IMPORT_KINDS } from "../../ingest/puf/import-source.js";
import type { ImportKind } from "../../ingest/puf/import-source.js";
import { importTables } from "../../ingest/puf/import-parse.js";

const argsSchema = z.tuple([
  z.literal("--year"),
  z.enum(["2025", "2026", "2027"]),
  z.literal("--state"),
  z.string().regex(/^[A-Z]{2}$/),
]);

/** Only the shipped PUF parser handles these files; no package-provided importer runs. */
export function packagePufSource(
  manifest: Extract<PackageManifest, { kind: "data" }>,
  responseHosts: readonly string[] = [],
): FeedSource {
  let scope: z.infer<typeof argsSchema>;
  let report: PufImportReport | undefined;
  const kindOf = (path: string): ImportKind => {
    const kind = basename(path, extname(path));
    if (
      !(IMPORT_KINDS as readonly string[]).includes(kind) ||
      ![".csv", ".zip"].includes(extname(path))
    )
      throw new Error("package_puf_file_role_invalid");
    return kind as ImportKind;
  };
  if (
    manifest.data.files.length !== IMPORT_KINDS.length ||
    new Set(manifest.data.files.map((file) => kindOf(file.path))).size !==
      IMPORT_KINDS.length
  )
    throw new Error("package_puf_source_set_incomplete");
  return {
    kind: "feed",
    id: "cms-exchange-puf-package",
    publisher: "Centers for Medicare & Medicaid Services",
    dataScope: {
      kind: "annual",
      domain: "individual",
      years: (args) => [Number(argsSchema.parse(args)[1])],
    },
    hosts: [
      ...new Set([
        ...manifest.data.files.map((file) => new URL(file.origin.url).hostname),
        ...responseHosts,
      ]),
    ],
    command: {
      argv: ["ingest", "package", "puf"],
      usage: "--year YYYY --state ST",
      args: argsSchema,
    },
    async plan(_ctx, args) {
      scope = argsSchema.parse(args);
      if (
        JSON.stringify(manifest.planYears) !==
        JSON.stringify([Number(scope[1])])
      )
        throw new Error("package_puf_year_mismatch");
      return {
        files: manifest.data.files.map((file) => ({
          url: file.origin.url,
          expectedContent: extname(file.path) === ".zip" ? "zip" : "csv",
          maxBytes: file.bytes,
          expectedSha256: file.sha256,
          cache: "content",
        })),
      };
    },
    async stage(ctx, acquired, tx) {
      // The core feed transaction owns commit/rollback. The importer keeps its usual
      // reconciliation and publication statements, all invisible until that outer commit.
      const db: Database = {
        ...tx,
        transaction: (run) => run(tx),
        withSession: (run) => run(tx),
        close: async () => {},
      };
      report = await importPufs(db, {
        year: Number(scope[1]),
        state: scope[3],
        dataDir: ctx.dataDir,
        writeReports: false,
        files: acquired.map((file) => {
          const original = manifest.data.files.find(
            (entry) => entry.origin.url === file.url,
          )!;
          return {
            kind: kindOf(original.path),
            path: file.path,
            format: extname(original.path) === ".zip" ? "zip" : "csv",
            sha256: file.sha256,
            bytes: file.bytes,
            url: file.url,
            retrievedAt: file.metadata.fetched_at,
            metadata: {
              ...file.metadata,
              access_policy: file.metadata.access_policy && {
                ...file.metadata.access_policy,
                hosts: file.metadata.access_policy.hosts.map((host) => ({
                  ...host,
                  state: accessState.parse(host.state),
                })),
              },
            },
          };
        }),
      });
      for (const file of report.files) {
        const original = manifest.data.files.find(
          (entry) => kindOf(entry.path) === file.kind,
        )!;
        const parent = acquired.find(
          (entry) => entry.url === original.origin.url,
        )!;
        await tx.query(
          `INSERT INTO quality_issue(snapshot_id,severity,issue_code,explanation)
           VALUES ($1,'info','data_package_feed_parent',$2)`,
          [file.snapshot_id, JSON.stringify({ snapshotId: parent.snapshotId })],
        );
      }
      await tx.query(
        `INSERT INTO quality_issue(snapshot_id,severity,issue_code,explanation)
         VALUES ($1,'info','data_package_feed_parent',$2)`,
        [
          report.import_id,
          JSON.stringify({
            snapshotIds: acquired.map((file) => file.snapshotId),
          }),
        ],
      );
      return {
        rows: report.files.reduce((sum, file) => sum + file.stored_rows, 0),
        tables: [
          ...Object.values(importTables),
          "plan",
          "plan_variant",
          "issuer",
          "state_rating_rule",
          "service_area",
          "puf_active_catalog",
          "puf_market_catalog",
          "data_availability",
        ],
      };
    },
    async validate() {
      return report?.passed
        ? { ok: true }
        : { ok: false, reasonCode: "package_puf_reconciliation_failed" };
    },
  };
}
