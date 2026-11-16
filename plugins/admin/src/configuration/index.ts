import type { Context } from "hono";
import type {
  OperatorHost,
  OperatorApproval,
  OperatorConfiguration,
  OperatorObservation,
  OperatorPluginIdentity,
  OperatorSetting,
  PluginRouteEnv,
} from "@openplans/plugin-sdk";
import { z } from "zod";
import type { AdminPageRegistrar } from "../contracts.js";
import { escapeHtml } from "../html.js";
import { withSessionControls } from "../session.js";
import { navigation } from "../render.js";

const proposalForm = z.strictObject({
  key: z.literal("admin.instances"),
  value: z.string().regex(/^(?:[1-9]|[1-5][0-9]|6[0-4])$/),
});

export const registerConfiguration: AdminPageRegistrar = (dependencies) => {
  dependencies.routes.add({
    method: "GET",
    path: "/admin/configuration",
    exposure: "operator",
    adminSession: true,
    contentType: "text/html",
    handler: async (c) => {
      c.header("Cache-Control", "no-store");
      const observedAt = dependencies.now().toISOString();
      const host = dependencies.operator;
      const observation = host
        ? await safeConfiguration(host, c, observedAt)
        : unavailable("not_supported", observedAt);
      return c.html(
        withSessionControls(
          renderConfiguration(observation, observedAt),
          c.get("pluginAdminSession"),
        ),
        observation.state === "available" ? 200 : 503,
      );
    },
  });

  dependencies.routes.add({
    method: "POST",
    path: "/admin/configuration/proposal",
    exposure: "operator",
    adminSession: true,
    contentType: "application/json",
    handler: async (c) => {
      c.header("Cache-Control", "no-store");
      const form = proposalForm.safeParse(await c.req.parseBody());
      if (!form.success) return c.json({ error: "invalid_proposal" }, 400);

      const host = dependencies.operator;
      if (!host) return c.json({ error: "configuration_unavailable" }, 503);
      const observedAt = dependencies.now().toISOString();
      const observation = await safeConfiguration(host, c, observedAt);
      if (observation.state !== "available")
        return c.json({ error: observation.reason }, 503);

      const current = observation.value.settings.find(
        (setting) => setting.key === "admin.instances",
      );
      if (!current || typeof current.displayValue !== "number")
        return c.json({ error: "setting_unavailable" }, 503);

      const value = Number(form.data.value);
      const proposal = {
        schemaVersion: 1,
        status: "not_applied",
        generatedAt: observedAt,
        changes: [
          {
            key: "admin.instances",
            current: current.displayValue,
            currentSource: current.source,
            applies: current.appliedAt,
            proposed: value,
          },
        ],
      };
      return new Response(JSON.stringify(proposal, null, 2), {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition":
            'attachment; filename="openplans-config-proposal.json"',
          "Cache-Control": "no-store",
        },
      });
    },
  });
};

async function safeConfiguration(
  host: OperatorHost,
  c: Context<PluginRouteEnv>,
  observedAt: string,
): Promise<OperatorObservation<OperatorConfiguration>> {
  try {
    return await host.configuration({
      db: c.get("pluginDb"),
      signal: c.get("pluginSignal"),
    });
  } catch {
    return unavailable("read_failed", observedAt);
  }
}

function unavailable(
  reason: Extract<
    OperatorObservation<unknown>,
    { state: "unavailable" }
  >["reason"],
  observedAt: string,
): OperatorObservation<OperatorConfiguration> {
  return { state: "unavailable", reason, observedAt };
}

function renderConfiguration(
  observation: OperatorObservation<OperatorConfiguration>,
  observedAt: string,
): string {
  const body =
    observation.state === "unavailable"
      ? `<section><h2>Effective settings</h2><p class="unknown">Configuration is unknown: ${escapeHtml(observation.reason)}.</p><p>Origin: operator diagnostics · Observed ${escapeHtml(observation.observedAt)}</p></section><section><h2>Plugins and approvals</h2><p class="unknown">Approval evidence is unavailable until configuration diagnostics are available.</p></section><section><h2>Proposals</h2><p>Proposal preparation is unavailable without effective configuration evidence. No changes were made.</p></section>`
      : renderAvailable(observation.value, observedAt);

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Configuration</title><style>:root{color-scheme:light dark;--bg:#fff;--fg:#1a1a1a;--muted:#555;--line:#ccc;--accent:#006b65}@media(prefers-color-scheme:dark){:root{--bg:#121212;--fg:#eee;--muted:#b8b8b8;--line:#444;--accent:#64d8ca}}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}header,main{max-width:76rem;margin:auto;padding:1rem}header{border-bottom:1px solid var(--line)}h1{font-size:1.5rem;margin:0}h2{font-size:1.15rem;margin:0 0 .5rem}section{padding:1rem 0;border-bottom:1px solid var(--line)}.meta,.muted,.unknown{color:var(--muted)}.scroll{overflow:auto;max-width:100%}.scroll:focus-visible{outline:3px solid var(--accent);outline-offset:2px}table{border-collapse:collapse;width:100%}th,td{text-align:left;vertical-align:top;padding:.4rem;border-bottom:1px solid var(--line);overflow-wrap:anywhere}th{font-size:.875rem}a,button{color:var(--accent)}button,input{font:inherit}button{min-height:44px;padding:.4rem .8rem}@media(max-width:30rem){header,main{padding:.75rem}th,td{padding:.3rem;font-size:.875rem}}</style></head><body><a href="#main">Skip to content</a><header><h1>Configuration</h1><p class="meta">Installation · Origin: operator diagnostics · Observed ${escapeHtml(observedAt)}</p>${navigation()}</header><main id="main">${body}</main></body></html>`;
}

function renderAvailable(
  configuration: OperatorConfiguration,
  observedAt: string,
): string {
  const settings = configuration.settings.map((setting) => settingRow(setting));
  const plugins = configuration.plugins.map((plugin) => pluginRow(plugin));
  const instances = configuration.settings.find(
    (setting) => setting.key === "admin.instances",
  );
  const proposalFormHtml =
    instances && typeof instances.displayValue === "number"
      ? `<form method="post" action="/admin/configuration/proposal"><input type="hidden" name="key" value="admin.instances"><label for="instances">Proposed maximum admin instances</label><input id="instances" name="value" type="number" min="1" max="64" step="1" value="${escapeHtml(instances.displayValue)}" required><p class="muted">Schema: integer from 1 to 64. The current environment override and startup timing are shown above. This downloads inert JSON; it does not save or apply settings.</p><button type="submit">Download proposal · not applied</button></form>`
      : `<p class="unknown">No supported proposal setting is available. No changes were made.</p>`;

  return `<section><h2>Effective settings</h2><p>Configured and effective values are reported separately by origin. Secret values show presence only.</p>${table("Allowlisted effective settings", ["Key", "Effective safe value", "Origin", "Process", "Applies", "Access"], settings)}<p class="muted">Environment overrides take precedence when reported by the host. Values apply at startup.</p><p>Observed ${escapeHtml(observedAt)}</p></section><section><h2>Plugins and approvals</h2>${table("Plugin identities", ["Configured identity", "Configured", "Loaded", "Loaded version", "Loaded hash", "Approval", "Approved version", "Approved hash"], plugins)}</section><section><h2>Source access</h2><p>Source admission and policy-gated access remain read-only. No source checks were run.</p></section><section><h2>Proposals</h2>${proposalFormHtml}<p class="muted">A downloaded proposal is not applied. Apply it through the existing release workflow.</p></section>`;
}

function settingRow(setting: OperatorSetting): unknown[] {
  let value = displayValue(setting.displayValue);
  if (setting.reason === "secret_presence_only") {
    if (setting.displayValue === "configured") value = "configured";
    else if (setting.displayValue === "unset") value = "unset";
    else value = "unknown";
  }
  return [
    setting.key,
    value,
    setting.source,
    setting.process,
    setting.appliedAt,
    "Read-only",
  ];
}

function displayValue(value: OperatorSetting["displayValue"]): string {
  if (value === null) return "unknown";
  if (value === false) return "disabled";
  if (value === true) return "enabled";
  return String(value);
}

function pluginRow(plugin: OperatorPluginIdentity): unknown[] {
  const approval = safeApproval(plugin.approved);
  const loadedHash = safeHash(plugin.loaded?.sha256);
  let approvalStatus = "unverified";
  if (approval.state === "available") {
    if (!plugin.loaded) {
      approvalStatus = "receipt recorded, package not loaded";
    } else if (
      loadedHash === approval.sha256 &&
      plugin.loaded.version === approval.version
    ) {
      approvalStatus = "loaded package matches approval";
    } else {
      approvalStatus = "approval does not match loaded package";
    }
  }
  return [
    plugin.name ?? "unknown identity",
    plugin.configured ? "yes" : "no",
    loadedState(plugin),
    plugin.loaded?.version ?? "unknown",
    loadedHash ?? "unknown",
    approvalStatus,
    approval.state === "available" ? approval.version : "unknown",
    approval.state === "available" ? approval.sha256 : "unknown",
  ];
}

function loadedState(plugin: OperatorPluginIdentity): string {
  if (plugin.loaded) return "loaded";
  if (plugin.enabled) return "enabled, load unknown";
  return "not loaded";
}

function safeApproval(approval: OperatorApproval): OperatorApproval {
  if (
    approval.state !== "available" ||
    !safeHash(approval.sha256) ||
    !approval.version ||
    !approval.deploymentId ||
    !Number.isFinite(Date.parse(approval.completedAt))
  )
    return { state: "unverified", reason: "evidence_unavailable" };
  return approval;
}

function safeHash(hash: string | null | undefined): string | undefined {
  return typeof hash === "string" && /^[a-f0-9]{64}$/i.test(hash)
    ? hash
    : undefined;
}

function table(caption: string, headers: string[], rows: unknown[][]): string {
  if (!rows.length)
    return `<p>${escapeHtml(caption)}: no recorded entries.</p>`;
  return `<div class="scroll" role="region" tabindex="0" aria-label="${escapeHtml(caption)}"><table><caption>${escapeHtml(caption)}</caption><thead><tr>${headers.map((header) => `<th scope="col">${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
