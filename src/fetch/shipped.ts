import { fileURLToPath } from "node:url";

/**
 * Publisher manifests shipped with OpenPlans: reviewed federal public-domain sources that a new
 * installation needs, re-reviewed by the maintainers at each release (data/access/README.md).
 * `OPENPLANS_SHIPPED_ACCESS=off` withdraws them, leaving only an operator manifest.
 */
export function shippedManifestPaths(): readonly string[] {
  if (process.env.OPENPLANS_SHIPPED_ACCESS === "off") return [];
  return [
    fileURLToPath(
      new URL("../../data/access/federal-publishers.json", import.meta.url),
    ),
  ];
}
