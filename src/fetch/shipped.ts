import { cmsFallbackUnavailable } from "../config/cms-fallback.js";
import { loadConfig } from "../config/index.js";
import { fileURLToPath } from "node:url";

/** True only when the operator opted in with `OPENPLANS_CMS_FALLBACK=on` (default off). */
export function cmsFallbackEnabled(): boolean {
  return !cmsFallbackUnavailable() && loadConfig().cmsFallback.enabled;
}

/**
 * Publisher manifests shipped with OpenPlans: reviewed federal public-domain sources that a new
 * installation needs, re-reviewed by the maintainers at each release (data/access/README.md).
 * `OPENPLANS_SHIPPED_ACCESS=off` withdraws them, leaving only an operator manifest. The keyed
 * CMS Marketplace API entry is added only with `OPENPLANS_CMS_FALLBACK=on`.
 */
/** The shipped registry of per-site approval slugs (data/access/site-approvals.json). */
export const siteRegistryPath = (): string =>
  fileURLToPath(
    new URL("../../data/access/site-approvals.json", import.meta.url),
  );

export function shippedManifestPaths(): readonly string[] {
  const config = loadConfig();
  if (!config.access.shipped) return [];
  const path = (name: string) =>
    fileURLToPath(new URL(`../../data/access/${name}`, import.meta.url));
  return [
    path("federal-publishers.json"),
    ...(config.cmsFallback.enabled ? [path("cms-marketplace-api.json")] : []),
  ];
}
