import type { OperatorTelemetry } from "@openplans/plugin-sdk";
import { z } from "zod";
import type { AdminPageRegistrar } from "../contracts.js";
import { escapeHtml } from "../html.js";
import { navigation, unavailableHandler } from "../render.js";
import { withSessionControls } from "../session.js";
import { ADMIN_STYLES } from "../styles.js";

const bounds = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 15000];
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const snapshotSchema = z.object({
  collection: z.enum(["not_enabled", "complete", "partial"]),
  since: z.iso.datetime().nullable(),
  until: z.iso.datetime(),
  drops: counter,
  lastFlush: z.iso.datetime().nullable().optional(),
  failed: z.boolean().optional(),
  droppedBuckets: counter.optional(),
  series: z
    .array(
      z
        .object({
          transport: z.enum(["http", "mcp"]),
          operation: z.string().regex(/^[a-zA-Z0-9_.:-]{1,120}$/),
          owner: z
            .string()
            .regex(/^(core|@[a-z0-9._-]+\/[a-z0-9._-]+)$/)
            .max(120),
          outcome: z.enum(["completed", "cancelled", "timeout"]),
          statusClass: z.enum(["2xx", "3xx", "4xx", "429", "5xx"]),
          count: counter,
          durationBuckets: z.array(counter).length(12),
        })
        .refine(
          (row) =>
            row.durationBuckets.reduce((sum, value) => sum + value, 0) ===
            row.count,
        ),
    )
    .max(128),
  resets: counter.optional(),
  seriesCap: counter.max(128).optional(),
  memoryCap: counter.max(16777216).optional(),
  reservedBytes: counter.max(16777216).optional(),
});

function p95(buckets: readonly number[]): string {
  const count = buckets.reduce((sum, value) => sum + value, 0);
  if (count < 20) return "Unavailable, fewer than 20 samples";
  let sum = 0;
  for (let i = 0; i < buckets.length; i++) {
    sum += buckets[i] ?? 0;
    if (sum >= Math.ceil(count * 0.95))
      return bounds[i] === undefined ? "Above 15 s" : `${bounds[i]} ms`;
  }
  return "Unavailable";
}
function traffic(data: OperatorTelemetry, transport: "http" | "mcp") {
  const rows = data.series.filter(
    (row) => row.transport === transport && row.operation !== "other",
  );
  const eligible = rows.filter((row) => row.outcome === "completed");
  const count = eligible.reduce((sum, row) => sum + row.count, 0);
  const errors = eligible
    .filter((row) => row.statusClass === "5xx")
    .reduce((sum, row) => sum + row.count, 0);
  const buckets = Array<number>(12).fill(0);
  for (const row of eligible)
    row.durationBuckets.forEach((value, index) => {
      buckets[index] = (buckets[index] ?? 0) + value;
    });
  return `<section><h2>${transport === "http" ? "HTTP operations" : "MCP tool completions"}</h2><p>Eligible completions: ${count}. 5xx / eligible completions: ${count ? `${errors} / ${count}` : "Undefined, no eligible completions"}. Approximate p95: ${p95(buckets)}.</p></section>`;
}

export function renderMetrics(
  value: unknown,
  observedAt: string,
  cache?: { hits: number; misses: number; bypasses: number },
): string {
  const parsed = snapshotSchema.safeParse(value);
  let content =
    '<section><h2>Traffic and errors</h2><p class="unknown">Collection unavailable. The collector is disabled or this window was not collected.</p></section>';
  if (parsed.success && parsed.data.collection !== "not_enabled") {
    const data = parsed.data;
    let storageStatus = "No successful flush observed";
    if (data.lastFlush)
      storageStatus = data.failed
        ? "Last attempt failed"
        : "Last attempt succeeded";
    content = `<section><h2>Current-process observation</h2><p>Window: ${escapeHtml(data.since ?? "Unknown")} to ${escapeHtml(data.until)}. Admin traffic is excluded.</p><p>Collection: ${data.collection}. Only this HTTP host is observed. Other processes and stdio are not included. The five-minute buffer resets on rollover or restart. Retained history requires the separate storage switch.</p><p>Series cap: ${data.seriesCap ?? 128}. Memory cap: ${data.memoryCap ?? 16777216} bytes. Reserved row bytes: ${data.reservedBytes ?? "Unknown"}. Drops since process start: ${data.drops}. Window resets: ${data.resets ?? "Unknown"}.</p><p>Last flush: ${escapeHtml(data.lastFlush ?? "Unavailable")}. Storage: ${storageStatus}. Dropped buffer windows: ${data.droppedBuckets ?? "Unknown"}. Crashes lose unflushed samples. Gaps and other instances are not reconstructed.</p></section>${traffic(data, "http")}${traffic(data, "mcp")}<section><h2>Operation samples</h2><div class="table-wrap" style="overflow-x:auto" role="region" aria-label="Operation samples" tabindex="0"><table><caption>Counts and approximate p95 by operation. Handler duration is not CPU usage.</caption><thead><tr><th scope="col">Transport</th><th scope="col">Operation</th><th scope="col">Owner</th><th scope="col">Outcome</th><th scope="col">Status</th><th scope="col">Samples</th><th scope="col">Approximate p95</th></tr></thead><tbody>${data.series.map((row) => `<tr><td>${row.operation === "other" ? "Folded" : row.transport}</td><th scope="row">${escapeHtml(row.operation)}</th><td>${escapeHtml(row.owner)}</td><td>${row.operation === "other" ? "Unknown" : row.outcome}</td><td>${row.operation === "other" ? "Unknown" : row.statusClass}</td><td>${row.count}</td><td>${row.operation === "other" ? "Unavailable, folded overflow" : p95(row.durationBuckets)}</td></tr>`).join("")}</tbody></table></div><p>Histogram upper bounds in ms: ${bounds.join(", ")}, then above 15 s. MCP envelopes are HTTP operations; tools are separate samples. Do not add the two denominators.</p></section>`;
  }
  let cacheContent = '<p class="unknown">Cache counters are unavailable.</p>';
  if (
    cache &&
    [cache.hits, cache.misses, cache.bypasses].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    )
  ) {
    const denominator = cache.hits + cache.misses;
    cacheContent = `<p>Since process start. Hits: ${cache.hits}. Misses: ${cache.misses}. Bypasses: ${cache.bypasses}. Hits / hits plus misses: ${denominator ? `${cache.hits} / ${denominator}` : "Undefined, no cache lookups"}.</p>`;
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Metrics</title><style>${ADMIN_STYLES}</style></head><body><a class="skip" href="#main">Skip to content</a><header><h1>Metrics</h1>${navigation()}</header><main id="main">${content}<section><h2>Cache and source budgets</h2>${cacheContent}<p>Byte accounting and source budgets are unavailable in this view. Unknown budgets have no denominator.</p></section><p>Observed ${escapeHtml(observedAt)}. Refresh this page manually.</p></main></body></html>`;
}

export const registerMetrics: AdminPageRegistrar = (dependencies) => {
  dependencies.routes.add({
    method: "GET",
    path: "/admin/metrics",
    exposure: "operator",
    adminSession: true,
    contentType: "text/html",
    handler: async (c) => {
      if (!dependencies.operator?.telemetry && !dependencies.status.cacheStats)
        return unavailableHandler(dependencies, "Metrics")(c);
      c.header("Cache-Control", "no-store");
      let value: unknown;
      try {
        const result = await dependencies.operator?.telemetry?.read(
          { window: "current_process" },
          { db: c.get("pluginDb"), signal: c.get("pluginSignal") },
        );
        if (result?.state === "available") value = result.value;
      } catch {
        /* Show unavailable evidence without exception text. */
      }
      let cache: ReturnType<NonNullable<typeof dependencies.status.cacheStats>>;
      try {
        cache = dependencies.status.cacheStats?.();
      } catch {
        /* Independent evidence panel. */
      }
      return c.html(
        withSessionControls(
          renderMetrics(value, dependencies.now().toISOString(), cache),
          c.get("pluginAdminSession"),
        ),
      );
    },
  });
};
