import type { AdminPageDependencies } from "../contracts.js";
import { unavailableHandler } from "../render.js";

/** No form capability is installed until its owning module ships. */
export function fieldsAvailable(_dependencies: AdminPageDependencies): boolean {
  return false;
}

export const fieldsHandler = (dependencies: AdminPageDependencies) =>
  unavailableHandler(dependencies, "Fields");
