import type { OpenPlansPlugin } from "@openplans/plugin-sdk";
import { CMS_API_HOST } from "./constants.js";
import { createCmsMarketplaceSource } from "./source.js";

export * from "./constants.js";
export { buildRequest, mapResponse, parseBody } from "./response.js";
export type { CmsQuestion, CmsStatement } from "./response.js";
export { budget, questionHash, storage, storedCounts } from "./storage.js";
export type { CmsApiAvailability } from "./storage.js";
export { createCmsMarketplaceSource } from "./source.js";
export type { CmsApiEvidence, CmsSourceHost } from "./source.js";

/**
 * The core plugin registers this source itself when `OPENPLANS_CMS_FALLBACK=on`, with the
 * host's RxNorm check. Listed under `plugins` instead, it registers without that check, so a
 * drug `NotCovered` always stays `unknown`.
 */
const plugin: OpenPlansPlugin = {
  manifest: {
    name: "@openplans/source-cms-marketplace-api",
    version: "0.1.0",
    apiVersion: "0.1",
    kinds: ["sources"],
    capabilities: { network: [CMS_API_HOST] },
  },
  setup(ctx) {
    ctx.sources.add(createCmsMarketplaceSource());
  },
};
export default plugin;
