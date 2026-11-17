import type { AdminPageRegistrar } from "../contracts.js";
import { unavailableHandler } from "../render.js";
import { fieldsAvailable, fieldsHandler } from "./fields.js";
import { overridesAvailable, overridesHandler } from "./overrides.js";
import { registerDrafts } from "./drafts.js";
import { registerPreview } from "./preview.js";
import { registerPublish } from "./publish.js";
import { registerHistory } from "./history.js";
import { inspectPage, registerInspect } from "./inspect.js";

export const registerCustomizations: AdminPageRegistrar = (dependencies) => {
  const source = dependencies.operator?.msot
    ? inspectPage(dependencies)
    : unavailableHandler(dependencies, "Customizations");
  const fields = fieldsHandler(dependencies);
  const overrides = overridesHandler(dependencies);
  dependencies.routes.add({
    method: "GET",
    path: "/admin/customizations",
    exposure: "operator",
    adminSession: true,
    contentType: "text/html",
    handler: (c) => {
      const view = c.req.query("view") ?? "source";
      if (view === "source") return source(c);
      if (view === "fields")
        return fieldsAvailable(dependencies)
          ? fields(c)
          : unavailableHandler(dependencies, "Fields")(c);
      if (view === "overrides")
        return overridesAvailable(dependencies)
          ? overrides(c)
          : unavailableHandler(dependencies, "Overrides")(c);
      return c.html("<p>Unsupported customization view.</p>", 400);
    },
  });
  registerInspect(dependencies);
  registerDrafts(dependencies);
  registerPreview(dependencies);
  registerPublish(dependencies);
  registerHistory(dependencies);
};
