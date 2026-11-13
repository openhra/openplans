import type { OpenPlansPlugin } from "@openplans/plugin-sdk";
import { nuccHost } from "./release.js";
import { createTaxonomySource } from "./source.js";

export {
  CSV_MAX_BYTES,
  discoverRelease,
  expectedHash,
  filesPage,
  nuccHost,
  PAGE_MAX_BYTES,
  publisher,
  sourceId,
} from "./release.js";
export type { AcquiredRelease, Release } from "./release.js";
export { importTaxonomy, parseTaxonomy, writeTaxonomy } from "./import.js";
export type { TaxonomyImport, TaxonomyRow } from "./import.js";
export {
  createTaxonomySource,
  TAXONOMY_ARGV,
  TAXONOMY_USAGE,
  taxonomyArgs,
} from "./source.js";
export type { TaxonomySource } from "./source.js";

/**
 * The core plugin loads this source itself, so `worker ingest taxonomy` works without any
 * plugin configuration. Listing the package in `plugins` as well is refused: its command would
 * repeat a core command.
 */
const plugin: OpenPlansPlugin = {
  manifest: {
    name: "@openplans/source-nucc-taxonomy",
    version: "0.1.1",
    apiVersion: "0.1",
    kinds: ["sources"],
    capabilities: { network: [nuccHost], writes: ["staging"] },
  },
  setup(ctx) {
    ctx.sources.add(createTaxonomySource());
  },
};
export default plugin;
