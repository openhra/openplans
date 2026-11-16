import type { AdminPageRegistrar } from "../contracts.js";
import { registerUnavailable } from "../render.js";

export const registerDrafts: AdminPageRegistrar = (dependencies) => {
  registerUnavailable(
    dependencies,
    "POST",
    "/admin/customizations/draft",
    "Save draft",
  );
};
