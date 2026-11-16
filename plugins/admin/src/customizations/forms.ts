import type { AdminPageDependencies } from "../contracts.js";

/** No form capability is installed until its owning module ships. */
export function formsAvailable(_dependencies: AdminPageDependencies): boolean {
  return false;
}
