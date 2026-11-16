import type { AdminPageRegistrar } from "../contracts.js";
import { registerUnavailable } from "../render.js";

export const registerPreview: AdminPageRegistrar = (dependencies) => {
  registerUnavailable(
    dependencies,
    "POST",
    "/admin/customizations/validate",
    "Validate draft",
  );
  registerUnavailable(
    dependencies,
    "POST",
    "/admin/customizations/preview",
    "Preview",
  );
};
