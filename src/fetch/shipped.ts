import { fileURLToPath } from "node:url";

/** True only when the operator opted in with `OPENPLANS_CMS_FALLBACK=on` (default off). */
export function cmsFallbackEnabled(): boolean {
  return process.env.OPENPLANS_CMS_FALLBACK === "on";
}

/**
 * Publisher manifests shipped with OpenPlans: reviewed federal public-domain sources that a new
 * installation needs, re-reviewed by the maintainers at each release (data/access/README.md).
 * `OPENPLANS_SHIPPED_ACCESS=off` withdraws them, leaving only an operator manifest. The keyed
 * CMS Marketplace API entry is added only with `OPENPLANS_CMS_FALLBACK=on`.
 */
export function shippedManifestPaths(): readonly string[] {
  if (process.env.OPENPLANS_SHIPPED_ACCESS === "off") return [];
  const path = (name: string) =>
    fileURLToPath(new URL(`../../data/access/${name}`, import.meta.url));
  return [
    path("federal-publishers.json"),
    ...(cmsFallbackEnabled() ? [path("cms-marketplace-api.json")] : []),
  ];
}
