import type { OperatorStatus } from "@openplans/plugin-status";

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ESCAPES[char]!);
}

export type EvidencePanel<T> =
  | { state: "available"; value: T }
  | { state: "unknown"; reason: string }
  | { state: "error"; reason: string };

function value<T>(item: T | null, label: string): EvidencePanel<T> {
  return item === null
    ? { state: "unknown", reason: `${label} evidence is unavailable.` }
    : { state: "available", value: item };
}

function panel<T>(
  title: string,
  evidence: EvidencePanel<T>,
  body: (data: T) => string,
) {
  if (evidence.state !== "available")
    return `<section aria-labelledby="${escapeHtml(title)}"><h2 id="${escapeHtml(title)}">${escapeHtml(title)}</h2><p class="unknown">${escapeHtml(evidence.reason)}</p></section>`;
  return `<section aria-labelledby="${escapeHtml(title)}"><h2 id="${escapeHtml(title)}">${escapeHtml(title)}</h2>${body(evidence.value)}</section>`;
}

function status(value: string | number | boolean | null | undefined) {
  if (value === null || value === undefined) return "unknown";
  if (value === false) return "disabled";
  return escapeHtml(value);
}

function table(caption: string, headers: string[], rows: unknown[][]) {
  if (!rows.length)
    return `<p class="muted">${escapeHtml(caption)}: no recorded rows.</p>`;
  return `<div class="scroll" role="region" tabindex="0" aria-label="${escapeHtml(caption)}"><table><caption>${escapeHtml(caption)}</caption><thead><tr>${headers.map((header) => `<th scope="col">${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

const STYLE = `
:root { color-scheme: light dark; --bg:#fff; --fg:#1a1a1a; --muted:#555; --line:#ccc; --accent:#006b65; }
@media (prefers-color-scheme: dark) { :root { --bg:#121212; --fg:#eee; --muted:#b8b8b8; --line:#444; --accent:#64d8ca; } }
* { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }
header, main { max-width:76rem; margin:auto; padding:1rem; } header { border-bottom:1px solid var(--line); }
h1 { font-size:1.5rem; margin:0; } h2 { font-size:1.15rem; margin:0 0 .5rem; } section { padding:1rem 0; border-bottom:1px solid var(--line); }
.meta,.muted,.unknown { color:var(--muted); } .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,17rem),1fr)); gap:1rem; }
.card { border:1px solid var(--line); padding:.75rem; min-width:0; } .card h3 { margin:0 0 .25rem; font-size:1rem; }
.scroll { overflow:auto; max-width:100%; } .scroll:focus-visible { outline:3px solid var(--accent); outline-offset:2px; }
table { border-collapse:collapse; width:100%; } th,td { text-align:left; vertical-align:top; padding:.4rem; border-bottom:1px solid var(--line); overflow-wrap:anywhere; }
th { font-size:.875rem; } a { color:var(--accent); } .skip { position:absolute; left:-10000px; } .skip:focus { left:1rem; background:var(--bg); }
@media (max-width:30rem) { header, main { padding:.75rem; } th,td { padding:.3rem; font-size:.875rem; } }
`;

function scopeRows(data: NonNullable<OperatorStatus["data"]>) {
  return (
    data.issuers?.map((row) => [
      row.state,
      row.year,
      row.market ?? "unknown",
      row.issuer_id ?? "unknown",
      row.catalog,
      row.premium,
      row.provider,
      row.formulary,
    ]) ?? null
  );
}

/** Renders only the allowlisted status DTO. It never serializes host config or options. */
export function renderAdminOverview(
  statusData: OperatorStatus,
  observedAt = new Date().toISOString(),
): string {
  const scopes = scopeRows(statusData.data);
  const sourceRows =
    statusData.sources?.map((row) => [
      row.id,
      row.snapshot_id,
      row.retrieved_at ?? "unknown",
      row.published_at ?? "unknown",
    ]) ?? null;
  const workerRows =
    statusData.worker.last_ingest?.map((row) => [
      row.source,
      row.last_success,
      row.last_success_at ?? "unknown",
      row.reason_codes.join(", ") || "none recorded",
    ]) ?? null;
  const eventRows =
    statusData.events.recent?.map((row) => [
      row.type,
      row.time,
      row.payload ? "Recorded" : "Payload unavailable",
    ]) ?? null;
  const observations = [
    ["API request", "ok"],
    ["Database", statusData.db],
    ["Worker", statusData.worker.last_ingest === null ? "unknown" : "observed"],
    ["Cache", statusData.cache.enabled ? "enabled" : "disabled"],
  ];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Admin overview</title><style>${STYLE}</style></head><body><a class="skip" href="#main">Skip to overview</a><header><h1>Admin overview</h1><p class="meta">Installation overview · Version ${escapeHtml(statusData.version)} · Observed ${escapeHtml(observedAt)}</p></header><main id="main"><section aria-labelledby="attention"><h2 id="attention">Service and attention</h2><div class="grid">${observations.map(([name, current]) => `<div class="card"><h3>${escapeHtml(name)}</h3><p>${status(current)}</p></div>`).join("")}</div></section>${panel("Serving scopes", value(scopes, "Coverage"), (rows) => table("Scope availability", ["State", "Year", "Market", "Issuer", "Catalog", "Premium", "Provider", "Formulary"], rows))}${panel("Source snapshots", value(sourceRows, "Source"), (rows) => table("Active source snapshots", ["Source", "Snapshot", "Retrieved", "Publisher date"], rows))}<div class="grid">${panel("Worker observations", value(workerRows, "Worker"), (rows) => table("Recent import observations", ["Source", "Last success", "Observed at", "Reasons"], rows))}${panel("Recent events", value(eventRows, "Event"), (rows) => table("Recorded events", ["Type", "Time", "Payload"], rows))}</div>${panel("Cache", { state: "available", value: statusData.cache }, (cache) => `<p>State: ${status(cache.enabled)} · Backend: ${escapeHtml(cache.backend)} · Hits: ${status(cache.hits)} · Misses: ${status(cache.misses)} · Bypasses: ${status(cache.bypasses)} · Bytes: ${status(cache.bytes)}</p>`)}</main></body></html>`;
}
