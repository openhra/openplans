import type {
  OpenPlansPlugin,
  PluginContext,
  PluginFactory,
  StatusHost,
} from "@openplans/plugin-sdk";
import { operatorView, readStatus } from "@openplans/plugin-status";
import { z } from "zod";
import { renderAdminOverview } from "./html.js";
import { withSessionControls } from "./session.js";
import { registerAdminPages } from "./pages.js";
import { navigation } from "./render.js";

export { escapeHtml, renderAdminOverview } from "./html.js";
export type { EvidencePanel } from "./html.js";

export const PLUGIN_NAME = "@openplans/plugin-admin";
export const ADMIN_PATH = "/admin";
export const PLUGIN_VERSION = "0.1.0";

const adminOptions = z
  .strictObject({
    evidenceMount: z
      .strictObject({
        directory: z
          .string()
          .min(1)
          .max(4096)
          .refine((path) => path.startsWith("/") && !path.includes("\0")),
        deploymentId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,99}$/),
      })
      .optional(),
  })
  .prefault({});

export interface AdminPluginSettings {
  host?: StatusHost;
  now?: () => Date;
}

export function createAdminPlugin(
  settings: AdminPluginSettings = {},
): OpenPlansPlugin {
  const host = settings.host ?? {};
  const now = settings.now ?? (() => new Date());
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      apiVersion: "0.1",
      kinds: ["routes"],
      options: adminOptions,
      capabilities: {
        operatorRoutes: true,
        hostStatus: true,
        operatorDiagnostics: true,
      },
    },
    setup(ctx: PluginContext) {
      const options = adminOptions.parse(ctx.options);
      ctx.routes.add({
        method: "GET",
        path: ADMIN_PATH,
        exposure: "operator",
        adminSession: true,
        contentType: "text/html",
        handler: async (c) => {
          c.header("Cache-Control", "no-store");
          try {
            const data = await readStatus(c.get("pluginDb"), {
              config: ctx.config,
              host,
              plugin: "@openplans/plugin-status",
              now: now(),
            });
            return c.html(
              withSessionControls(
                renderAdminOverview(
                  operatorView(data),
                  now().toISOString(),
                ).replace("</header>", `${navigation()}</header>`),
                c.get("pluginAdminSession"),
              ),
            );
          } catch {
            return c.html(
              withSessionControls(
                renderUnavailableOverview(now().toISOString()),
                c.get("pluginAdminSession"),
              ),
              200,
            );
          }
        },
      });
      registerAdminPages({
        routes: ctx.routes,
        operator: ctx.operatorHost,
        status: host,
        now,
        evidenceMount:
          options.evidenceMount && Object.freeze(options.evidenceMount),
      });
    },
  };
}

function renderUnavailableOverview(observedAt: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Admin overview</title></head><body><main><h1>Admin overview</h1><p>Observed ${observedAt}</p><section><h2>Service and attention</h2><p>Evidence could not be read.</p></section><section><h2>Serving scopes</h2><p>Coverage evidence is unavailable.</p></section><section><h2>Source snapshots</h2><p>Source evidence is unavailable.</p></section><section><h2>Worker observations</h2><p>Worker evidence is unavailable.</p></section><section><h2>Recent events</h2><p>Event evidence is unavailable.</p></section></main></body></html>`;
}

export const createPlugin: PluginFactory = ({ host }) =>
  createAdminPlugin({ host });

const plugin = createAdminPlugin();
export default plugin;
