import type { Context } from "hono";
import type {
  CatalogPolicyResolution,
  PluginRouteEnv,
} from "@openplans/plugin-sdk";
import type { AdminPageRegistrar } from "../contracts.js";
import { escapeHtml } from "../html.js";
import {
  INSPECT_BODY_LIMIT,
  inspectAnnotation,
  inspectInputSchema,
} from "./service.js";

export function inspectPage(dependencies: Parameters<AdminPageRegistrar>[0]) {
  return (c: Context<PluginRouteEnv>) => {
    c.header("Cache-Control", "no-store");
    const availability = dependencies.operator?.msot
      ? '<form method="post" action="/admin/customizations/inspect"><label>Source ID <input name="source_id" required maxlength="100"></label><label>Plan IDs <textarea name="plan_ids" required maxlength="4096" aria-describedby="plan-id-help"></textarea></label><p id="plan-id-help">Enter one plan ID per line. Up to 25 IDs.</p><label>Plan year <input name="year" type="number" min="2014" max="2100" required></label><label>As of <input name="as_of" type="date"></label><button type="submit">Inspect annotations</button></form>'
      : '<p class="unknown">MSoT inspection is unavailable. No changes were made.</p>';
    return c.html(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Customization inspection</title></head><body><main><h1>Customization inspection</h1><p>Read-only payment annotation preview. Public catalog selection stays unchanged.</p>${availability}</main></body></html>`,
    );
  };
}

async function boundedText(c: Context<PluginRouteEnv>): Promise<string | null> {
  const reader = c.req.raw.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > INSPECT_BODY_LIMIT) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function boundedJson(c: Context<PluginRouteEnv>) {
  const body = await boundedText(c);
  if (body === null) return { error: "inspect_body_too_large" as const };
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return { error: "inspect_invalid_json" as const };
  }
}

export const registerInspect: AdminPageRegistrar = (dependencies) => {
  dependencies.routes.add({
    method: "POST",
    path: "/admin/customizations/inspect",
    exposure: "operator",
    adminSession: true,
    contentType: "application/json",
    handler: async (c) => {
      c.header("Cache-Control", "no-store");
      c.header("Vary", "Cookie");
      if (!dependencies.operator)
        return c.json(
          {
            state: "unavailable",
            reason: "not_supported",
            error: { code: "not_supported" },
            observedAt: dependencies.now().toISOString(),
          },
          503,
        );
      const contentType = c.req.header("content-type") ?? "";
      const isForm = contentType.startsWith(
        "application/x-www-form-urlencoded",
      );
      let body: unknown;
      if (isForm) {
        const raw = await boundedText(c);
        if (raw === null)
          return c.json({ error: { code: "inspect_body_too_large" } }, 413);
        const form = new URLSearchParams(raw);
        body = {
          field: "custom_payment_allowed",
          source_id: form.get("source_id"),
          plan_ids: (form.get("plan_ids") ?? "")
            .split(/\r?\n/)
            .map((id) => id.trim())
            .filter(Boolean),
          year: Number(form.get("year")),
          ...(form.get("as_of") ? { as_of: form.get("as_of") } : {}),
        };
      } else {
        body = await boundedJson(c);
      }
      if (body && typeof body === "object" && "error" in body)
        return c.json(
          { error: { code: body.error } },
          body.error === "inspect_body_too_large" ? 413 : 400,
        );
      const input = inspectInputSchema.safeParse(body);
      if (!input.success)
        return c.json({ error: { code: "inspect_invalid_input" } }, 400);
      try {
        const observation = await inspectAnnotation(
          dependencies.operator.msot,
          input.data,
          { db: c.get("pluginDb"), signal: c.get("pluginSignal") },
        );
        if (
          observation.state === "available" &&
          !validResolution(observation.value)
        )
          return c.json(
            {
              state: "unavailable",
              reason: "read_failed",
              error: { code: "read_failed" },
              observedAt: dependencies.now().toISOString(),
            },
            503,
          );
        if (isForm && observation.state === "available")
          return c.html(renderInspection(observation.value), 200);
        return c.json(
          observation.state === "available"
            ? observation
            : { ...observation, error: { code: observation.reason } },
          observation.state === "available" ? 200 : 503,
        );
      } catch {
        return c.json(
          {
            state: "unavailable",
            reason: "read_failed",
            error: { code: "read_failed" },
            observedAt: dependencies.now().toISOString(),
          },
          503,
        );
      }
    },
  });
};

function renderInspection(value: CatalogPolicyResolution): string {
  const rows = value.plans
    .map((plan) => {
      const channels = (["on_exchange", "off_exchange", "unknown"] as const)
        .map((channel) => {
          const result = plan.msot.by_market_segment[channel];
          if (!result) return "";
          const field = result.fields.custom_payment_allowed;
          if (!field)
            return `<tr><th scope="row">${escapeHtml(plan.public.id)} / ${channel}</th><td>${escapeHtml(result.applicability)}</td><td>unknown</td><td>unknown</td><td>unknown</td><td>${escapeHtml(plan.public.provenance.snapshot_id)} row ${plan.public.provenance.source_row}</td></tr>`;
          const label =
            field.state === "unknown" ? "unknown" : String(field.value);
          const provenance = value.msot.provenance.find(
            (entry) => entry.id === field.provenance_ref,
          );
          return `<tr><th scope="row">${escapeHtml(plan.public.id)} / ${channel}</th><td>${escapeHtml(result.applicability)}</td><td>${escapeHtml(label)}</td><td>${escapeHtml(field.origin)}</td><td>${escapeHtml(provenance?.reason_code ?? "unknown")}</td><td>${escapeHtml(plan.public.provenance.snapshot_id)} row ${plan.public.provenance.source_row}</td></tr>`;
        })
        .join("");
      return channels;
    })
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Annotation inspection</title></head><body><main><h1>Annotation inspection</h1><p>Read-only preview. Catalog generation ${escapeHtml(value.msot.catalog_generation)}. Source ${escapeHtml(value.msot.source_id)} version ${value.msot.version} hash ${escapeHtml(value.msot.version_hash)}. As of ${escapeHtml(value.msot.as_of)}.</p><div role="region" tabindex="0" aria-label="Annotation results"><table><caption>Payment annotations by plan and exchange channel. Unknown is preserved as unknown.</caption><thead><tr><th scope="col">Plan and channel</th><th scope="col">Applicability</th><th scope="col">Annotation</th><th scope="col">Origin</th><th scope="col">Reason</th><th scope="col">Public evidence</th></tr></thead><tbody>${rows}</tbody></table></div><p>Public catalog values remain unchanged. This annotation does not establish insurer acceptance or binding authority.</p></main></body></html>`;
}

function validResolution(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const result = value as { plans?: unknown; msot?: { source_id?: unknown } };
  return (
    Array.isArray(result.plans) &&
    result.plans.length <= 25 &&
    typeof result.msot?.source_id === "string" &&
    result.plans.every((plan) => {
      if (!plan || typeof plan !== "object") return false;
      const row = plan as {
        public?: unknown;
        msot?: { by_market_segment?: unknown };
      };
      const channels = row.msot?.by_market_segment;
      return (
        !!row.public &&
        !!channels &&
        typeof channels === "object" &&
        Object.keys(channels).every((channel) =>
          ["on_exchange", "off_exchange", "unknown"].includes(channel),
        )
      );
    })
  );
}
