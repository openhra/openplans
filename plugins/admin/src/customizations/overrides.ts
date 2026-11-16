import type { AdminPageDependencies } from "../contracts.js";
import { unavailableHandler } from "../render.js";

/** No form capability is installed until its owning module ships. */
export function overridesAvailable(
  _dependencies: AdminPageDependencies,
): boolean {
  return false;
}

export const overridesHandler = (dependencies: AdminPageDependencies) =>
  unavailableHandler(dependencies, "Overrides");
