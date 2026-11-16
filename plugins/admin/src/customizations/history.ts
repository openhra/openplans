import type { AdminPageRegistrar } from "../contracts.js";
import { registerUnavailable } from "../render.js";

export const registerHistory: AdminPageRegistrar = (dependencies) => {
  registerUnavailable(
    dependencies,
    "GET",
    "/admin/customizations/versions",
    "Versions",
  );
  registerUnavailable(
    dependencies,
    "GET",
    "/admin/customizations/audit",
    "Audit",
  );
};
