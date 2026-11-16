import type { AdminPageRegistrar } from "../contracts.js";
import { registerUnavailable } from "../render.js";

export const registerPublish: AdminPageRegistrar = (dependencies) => {
  registerUnavailable(
    dependencies,
    "POST",
    "/admin/customizations/publish",
    "Publish",
  );
  registerUnavailable(
    dependencies,
    "POST",
    "/admin/customizations/reactivate",
    "Reactivate",
  );
  registerUnavailable(
    dependencies,
    "GET",
    "/admin/customizations/result",
    "Publication result",
  );
};
