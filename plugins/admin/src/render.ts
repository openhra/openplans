import type { RouteSpec } from "@openplans/plugin-sdk";
import { ADMIN_NAVIGATION } from "./contracts.js";
import type { AdminPageDependencies } from "./contracts.js";
import { escapeHtml } from "./html.js";
import { withSessionControls } from "./session.js";
import { ADMIN_STYLES } from "./styles.js";

export function navigation(): string {
  return `<nav aria-label="Admin sections"><ul>${ADMIN_NAVIGATION.map(({ path, label }) => `<li><a href="${path}">${label}</a></li>`).join("")}</ul></nav>`;
}

export function renderUnavailable(title: string, observedAt: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>${ADMIN_STYLES}</style></head><body><a class="skip" href="#main">Skip to content</a><header><h1>${escapeHtml(title)}</h1>${navigation()}</header><main id="main"><section><h2>Unavailable</h2><p class="unknown">This feature is not installed. No changes were made.</p><p>Scope: this installation. Origin: admin capability registration. Observed ${escapeHtml(observedAt)}</p></section></main></body></html>`;
}

/** Missing implementations always refuse. Later module owners replace their own registrar. */
export function registerUnavailable(
  dependencies: AdminPageDependencies,
  method: RouteSpec["method"],
  path: RouteSpec["path"],
  title: string,
): void {
  dependencies.routes.add({
    method,
    path,
    exposure: "operator",
    adminSession: true,
    contentType: "text/html",
    handler: unavailableHandler(dependencies, title),
  });
}

export function unavailableHandler(
  dependencies: AdminPageDependencies,
  title: string,
): RouteSpec["handler"] {
  return (c) => {
    c.header("Cache-Control", "no-store");
    return c.html(
      withSessionControls(
        renderUnavailable(title, dependencies.now().toISOString()),
        c.get("pluginAdminSession"),
      ),
      503,
    );
  };
}
