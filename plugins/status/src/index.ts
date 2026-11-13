import { z } from "zod";
import type {
  OpenPlansPlugin,
  PluginContext,
  PluginFactory,
  SqlSession,
} from "@openplans/plugin-sdk";
import { renderStatusHtml } from "./html.js";
import { runHealthProbe } from "./probe.js";
import { readStatus } from "./read.js";
import type { StatusHost } from "./read.js";
import { applicationVersion } from "./version.js";
import { operatorView, publicStatusSchema, publicView } from "./views.js";

export { renderStatusHtml, escapeHtml, STYLE } from "./html.js";
export {
  COMPONENTS,
  DELIVERY_WINDOW_MS,
  HEALTH_KEY,
  HISTORY_LIMIT,
  healthStateSchema,
  nextHealth,
  runHealthProbe,
} from "./probe.js";
export type { Component, Health, HealthEntry, HealthState } from "./probe.js";
export { CMS_FALLBACK_ID, readStatus, redactLocations } from "./read.js";
export type { PluginEntry, StatusData, StatusHost } from "./read.js";
export { applicationVersion } from "./version.js";
export {
  ageBucket,
  operatorStatusSchema,
  operatorView,
  publicStatusSchema,
  publicView,
} from "./views.js";
export type { OperatorStatus, PublicStatus } from "./views.js";

export const PLUGIN_NAME = "@openplans/plugin-status";
export const PLUGIN_VERSION = "0.1.1";
export const PUBLIC_TTL_SECONDS = 30;
export const PROBE_ARGV = ["status-page", "health-probe"] as const;

export interface StatusPluginSettings {
  /** Values only the host knows. The default reads the version from the core package.json. */
  host?: StatusHost;
  now?: () => Date;
}

/**
 * Builds the plugin. The default export is `createStatusPlugin()`; the core loader calls
 * `createPlugin({ host })` instead, because the manifest declares `capabilities.hostStatus`.
 */
export function createStatusPlugin(
  settings: StatusPluginSettings = {},
): OpenPlansPlugin {
  const host: StatusHost = settings.host ?? { version: applicationVersion };
  const now = settings.now ?? (() => new Date());
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      apiVersion: "0.1",
      kinds: ["routes", "mcpTools", "workerCommands", "schedules"],
      capabilities: {
        operatorRoutes: true,
        writes: ["events"],
        hostStatus: true,
      },
    },
    setup(ctx: PluginContext) {
      const read = (db: SqlSession) =>
        readStatus(db, {
          config: ctx.config,
          host,
          plugin: ctx.plugin.name,
          now: now(),
        });
      ctx.routes.add({
        method: "GET",
        path: "/status",
        exposure: "public",
        cache: { ttlSeconds: PUBLIC_TTL_SECONDS },
        contentType: "text/html",
        handler: async (c) =>
          c.html(renderStatusHtml(publicView(await read(c.get("pluginDb"))))),
      });
      ctx.routes.add({
        method: "GET",
        path: "/status.json",
        exposure: "public",
        cache: { ttlSeconds: PUBLIC_TTL_SECONDS },
        contentType: "application/json",
        handler: async (c) => c.json(publicView(await read(c.get("pluginDb")))),
      });
      // Operator detail: the host checks the token, answers 404 when none is set and never caches.
      ctx.routes.add({
        method: "GET",
        path: "/status/operator",
        exposure: "operator",
        contentType: "text/html",
        handler: async (c) => {
          c.header("Cache-Control", "no-store");
          return c.html(
            renderStatusHtml(operatorView(await read(c.get("pluginDb")))),
          );
        },
      });
      ctx.routes.add({
        method: "GET",
        path: "/status/operator.json",
        exposure: "operator",
        contentType: "application/json",
        handler: async (c) => {
          c.header("Cache-Control", "no-store");
          return c.json(operatorView(await read(c.get("pluginDb"))));
        },
      });
      ctx.mcpTools.add({
        name: "get_status",
        title: "Service status",
        description:
          "Returns the public status summary that /status.json serves: version, database state, " +
          "coverage counts by status, source age buckets, last import age per source, cache on " +
          "or off, pass-through budget state, plugin count and the age of the last health change.",
        inputSchema: z.strictObject({}),
        outputSchema: publicStatusSchema,
        readOnly: true,
        handler: async (_input, tool) => publicView(await read(tool.db)),
      });
      ctx.workerCommands.add({
        argv: PROBE_ARGV,
        usage: "worker status-page health-probe",
        timeoutMs: 20_000,
        run: (_args, worker) =>
          runHealthProbe(worker, {
            cacheProbe: host.cacheProbe && (() => host.cacheProbe!()),
            now,
          }),
      });
      ctx.schedules.add({
        name: "health-probe",
        cron: "* * * * *",
        command: PROBE_ARGV,
        maxRunMs: 30_000,
      });
    },
  };
}

/** The factory the core loader calls with its read-only status view. */
export const createPlugin: PluginFactory = ({ host }) =>
  createStatusPlugin({
    host: { ...host, version: host.version ?? applicationVersion },
  });

const plugin: OpenPlansPlugin = createStatusPlugin();
export default plugin;
