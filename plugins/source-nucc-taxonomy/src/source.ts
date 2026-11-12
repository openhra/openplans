import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { FeedSource } from "@openplans/plugin-sdk";
import { parseTaxonomy, writeTaxonomy } from "./import.js";
import type { TaxonomyImport } from "./import.js";
import {
  CSV_MAX_BYTES,
  discoverRelease,
  filesPage,
  nuccHost,
  PAGE_MAX_BYTES,
  publisher,
  sourceId,
} from "./release.js";
import type { Release } from "./release.js";

export const TAXONOMY_ARGV = Object.freeze(["ingest", "taxonomy"] as const);
export const TAXONOMY_USAGE =
  "Usage: worker ingest taxonomy --accept-nucc-terms (review NUCC licensing terms before importing)";
/** Importing NUCC data is an explicit operator decision; there is no default. */
export const taxonomyArgs = z.tuple([z.literal("--accept-nucc-terms")]);

/** A feed source that also reports the import it staged, for the command's output line. */
export interface TaxonomySource extends FeedSource {
  /** The last successful stage of this instance, or undefined before one. */
  imported(): TaxonomyImport | undefined;
}

/**
 * The NUCC taxonomy feed. `plan` reads the files page and picks the current CSV, `stage` writes
 * the same rows as `importTaxonomy`. Each instance holds one run's state, so create one per run.
 */
export function createTaxonomySource(): TaxonomySource {
  let release: Release | undefined;
  let imported: TaxonomyImport | undefined;
  return {
    kind: "feed",
    id: sourceId,
    publisher,
    hosts: [nuccHost],
    command: { argv: TAXONOMY_ARGV, usage: TAXONOMY_USAGE, args: taxonomyArgs },
    imported: () => imported,
    async plan(ctx) {
      release = imported = undefined;
      const page = await ctx.fetch(filesPage, {
        expectedContent: "binary",
        maxBytes: PAGE_MAX_BYTES,
      });
      release = discoverRelease(await readFile(page.path, "utf8"));
      // Each release has its own URL, so a cached copy of it is reused without a request.
      return {
        files: [
          {
            url: release.url,
            expectedContent: "csv",
            maxBytes: CSV_MAX_BYTES,
            cache: "content",
          },
        ],
      };
    },
    async stage(_ctx, acquired, tx) {
      const file = acquired[0];
      if (!release || !file || acquired.length !== 1)
        throw new Error("NUCC taxonomy stages exactly one CSV");
      const rows = await parseTaxonomy(file.path);
      // The core records a feed source as kind 'feed'; this source has always been 'taxonomy'.
      await tx.query(
        "UPDATE source SET source_kind='taxonomy' WHERE source_id=$1 AND source_kind='feed'",
        [sourceId],
      );
      const result = await writeTaxonomy(
        tx,
        { ...release, path: file.path, metadata: file.metadata },
        rows,
      );
      imported = result;
      return { rows: result.codes, tables: ["provider_taxonomy"] };
    },
    async validate(_ctx, tx) {
      if (!imported) return { ok: false, reasonCode: "taxonomy_not_staged" };
      const { rows } = await tx.query<{ codes: number; otherRelease: number }>(
        `SELECT count(*)::int AS codes,
           count(*) FILTER (WHERE snapshot_id IS DISTINCT FROM $1 OR version IS DISTINCT FROM $2)::int AS "otherRelease"
         FROM provider_taxonomy`,
        [imported.snapshot_id, imported.version],
      );
      const [counts] = rows;
      if (!counts || counts.codes < 1)
        return { ok: false, reasonCode: "taxonomy_empty" };
      if (counts.otherRelease !== 0)
        return { ok: false, reasonCode: "taxonomy_mixed_release" };
      return { ok: true };
    },
  };
}
