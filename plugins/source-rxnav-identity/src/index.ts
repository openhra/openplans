import packageJson from "../package.json" with { type: "json" };
import type { OpenPlansPlugin } from "@openplans/plugin-sdk";
import { RXNAV_HOST } from "./constants.js";
import { createRxnavIdentitySource } from "./source.js";

export * from "./constants.js";
export { mapHistory, mapNames, mapProperties } from "./response.js";
export type { RxnavConfirmation } from "./response.js";
export type { RxnavAnswer } from "./source.js";
export { createRxnavIdentitySource } from "./source.js";

/**
 * The core plugin registers this source itself when `OPENPLANS_RXNAV_IDENTITY=on`, so it needs
 * no entry under `plugins`.
 */
const plugin: OpenPlansPlugin = {
  manifest: {
    name: "@openplans/source-rxnav-identity",
    version: packageJson.version,
    apiVersion: "0.2",
    kinds: ["sources"],
    capabilities: { network: [RXNAV_HOST] },
  },
  setup(ctx) {
    ctx.sources.add(createRxnavIdentitySource());
  },
};
export default plugin;
