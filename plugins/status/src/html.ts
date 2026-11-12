import type { OperatorStatus, PublicStatus } from "./views.js";

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

// Inline only: the route's policy allows inline styles and nothing else.
export const STYLE = `
:root { color-scheme: light dark; --bg: #ffffff; --fg: #1a1a1a; --muted: #555555;
  --line: #d0d0d0; --ok: #116329; --down: #a40e26; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #121212; --fg: #ececec; --muted: #b0b0b0; --line: #3a3a3a;
    --ok: #6fdd8b; --down: #ff8a8a; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 52rem; margin: 0 auto; padding: 1rem; }
h1 { font-size: 1.5rem; margin: 0 0 0.25rem; }
h2 { font-size: 1.15rem; margin: 1.75rem 0 0.5rem; }
p { margin: 0.5rem 0; }
.muted { color: var(--muted); }
.ok { color: var(--ok); font-weight: 600; }
.down { color: var(--down); font-weight: 600; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 1rem; margin: 0; }
dt { color: var(--muted); }
dd { margin: 0; overflow-wrap: anywhere; }
.table { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 0.35rem 0.5rem; border-bottom: 1px solid var(--line);
  vertical-align: top; overflow-wrap: anywhere; }
th { font-weight: 600; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; font-size: 0.85rem; }
`;

const FRESHNESS: Record<string, string> = {
  "<1d": "under 1 day",
  "<7d": "under 7 days",
  "<30d": "under 30 days",
  older: "30 days or more",
  unknown: "unknown",
};
const age = (bucket: string) => escapeHtml(FRESHNESS[bucket] ?? bucket);

function state(value: string) {
  const css = value === "ok" || value === "down" ? value : "muted";
  return `<span class="${css}">${escapeHtml(value)}</span>`;
}

function table(caption: string, head: string[], rows: unknown[][]): string {
  if (!rows.length) return `<p class="muted">${escapeHtml(caption)}: none.</p>`;
  return `<div class="table"><table><caption class="muted">${escapeHtml(caption)}</caption>
<thead><tr>${head.map((h) => `<th scope="col">${escapeHtml(h)}</th>`).join("")}</tr></thead>
<tbody>${rows
    .map(
      (row) =>
        `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`,
    )
    .join("\n")}</tbody></table></div>`;
}

function onOff(value: boolean | null) {
  if (value === null) return "unknown";
  return value ? "yes" : "no";
}
const unknownSection = (name: string) =>
  `<p class="muted">${escapeHtml(name)} could not be read.</p>`;

function isOperator(
  view: PublicStatus | OperatorStatus,
): view is OperatorStatus {
  return "pool" in view;
}

/** One page for either view. No scripts, no external files. */
export function renderStatusHtml(view: PublicStatus | OperatorStatus): string {
  const operator = isOperator(view);
  const parts: string[] = [];
  parts.push(`<h1>OpenPlans status</h1>
<p class="muted">${operator ? "Operator detail. Do not share this page." : "Public summary. It can be up to 30 seconds old."} The same data is at <a href="${operator ? "/status/operator.json" : "/status.json"}">${operator ? "/status/operator.json" : "/status.json"}</a>.</p>
<h2>Service</h2>
<dl>
<dt>Version</dt><dd>${escapeHtml(view.version)}</dd>
<dt>API</dt><dd>${state(view.api)}</dd>
<dt>Database</dt><dd>${state(view.db)}</dd>
<dt>Response cache</dt><dd>${view.cache.enabled ? "on" : "off"}</dd>
<dt>Plugins</dt><dd>${operator ? view.plugins.length : view.plugins}</dd>
<dt>Last health change</dt><dd>${age(view.health_transitions.last_change)}</dd>
${operator ? `<dt>Waiting for a database connection</dt><dd>${escapeHtml(view.pool.waiting ?? "unknown")}</dd>` : ""}
</dl>`);

  parts.push("<h2>Data coverage</h2>");
  if (view.data.status_counts) {
    parts.push(
      `<p>${escapeHtml(view.data.states)} states, plan years ${escapeHtml(view.data.years?.join(", ") || "none")}.</p>`,
    );
    const counts = view.data.status_counts;
    const statuses = Object.keys(
      counts.catalog,
    ) as (keyof typeof counts.catalog)[];
    parts.push(
      table(
        "Rows by status",
        ["Status", "Catalog", "Premiums", "Providers", "Formulary"],
        statuses.map((s) => [
          s.replaceAll("_", " "),
          counts.catalog[s],
          counts.premium[s],
          counts.provider[s],
          counts.formulary[s],
        ]),
      ),
    );
  } else parts.push(unknownSection("Coverage"));

  parts.push("<h2>Sources</h2>");
  if (view.sources)
    parts.push(
      operator
        ? table(
            "Active snapshots",
            ["Source", "Age", "Retrieved", "Snapshot"],
            (view as OperatorStatus).sources!.map((s) => [
              s.id,
              FRESHNESS[s.freshness],
              s.retrieved_at ?? "unknown",
              s.snapshot_id,
            ]),
          )
        : table(
            "Active snapshots",
            ["Source", "Age"],
            view.sources.map((s) => [s.id, FRESHNESS[s.freshness]]),
          ),
    );
  else parts.push(unknownSection("Sources"));

  parts.push("<h2>Imports</h2>");
  if (view.worker.last_ingest)
    parts.push(
      operator
        ? table(
            "Last import per source",
            [
              "Source",
              "Last success",
              "At",
              "Recent failures",
              "Recent durations (ms)",
            ],
            (view as OperatorStatus).worker.last_ingest!.map((i) => [
              i.source,
              FRESHNESS[i.last_success],
              i.last_success_at ?? "never",
              i.reason_codes.join(", ") || "none",
              i.durations_ms.join(", ") || "none",
            ]),
          )
        : table(
            "Last import per source",
            ["Source", "Last success"],
            view.worker.last_ingest.map((i) => [
              i.source,
              FRESHNESS[i.last_success],
            ]),
          ),
    );
  else parts.push(unknownSection("Imports"));

  parts.push("<h2>Pass-through sources</h2>");
  if (view.passthrough)
    parts.push(
      operator
        ? table(
            "Daily budget",
            [
              "Source",
              "On",
              "Budget",
              "Cache level",
              "Requests today",
              "Daily limit",
              "Paused until",
              "Cache hit rate",
            ],
            (view as OperatorStatus).passthrough!.map((p) => [
              p.id,
              onOff(p.enabled),
              p.budget,
              p.level,
              p.daily_requests,
              p.max_daily_requests,
              p.blocked_until ?? "not paused",
              p.hit_rate === null
                ? "unknown"
                : `${Math.round(p.hit_rate * 100)}%`,
            ]),
          )
        : table(
            "Daily budget",
            ["Source", "On", "Budget", "Cache level"],
            view.passthrough.map((p) => [
              p.id,
              onOff(p.enabled),
              p.budget,
              p.level,
            ]),
          ),
    );
  else parts.push(unknownSection("Pass-through sources"));

  if (operator) {
    parts.push(
      "<h2>Cache</h2>",
      `<dl><dt>Backend</dt><dd>${escapeHtml(view.cache.backend)}</dd>
<dt>Hits</dt><dd>${escapeHtml(view.cache.hits ?? "unknown")}</dd>
<dt>Misses</dt><dd>${escapeHtml(view.cache.misses ?? "unknown")}</dd>
<dt>Bypasses</dt><dd>${escapeHtml(view.cache.bypasses ?? "unknown")}</dd>
<dt>Bytes</dt><dd>${escapeHtml(view.cache.bytes ?? "unknown")}</dd></dl>`,
      "<h2>Plugins</h2>",
      table(
        "Loaded plugins",
        ["Name", "Version", "API version", "Package SHA-256"],
        view.plugins.map((p) => [
          p.name,
          p.version ?? "unknown",
          p.apiVersion ?? "unknown",
          p.sha256 ?? "unknown",
        ]),
      ),
      "<h2>Health changes</h2>",
      view.health_transitions.history
        ? table(
            "Last 50, newest first",
            ["Component", "From", "To", "At"],
            view.health_transitions.history.map((h) => [
              h.component,
              h.from,
              h.to,
              h.at,
            ]),
          )
        : unknownSection("Health history"),
      "<h2>Recent events</h2>",
      view.events.recent
        ? table(
            "Last 20, newest first",
            ["Type", "At", "Payload"],
            view.events.recent.map((e) => [
              e.type,
              e.time,
              JSON.stringify(e.payload),
            ]),
          )
        : unknownSection("Events"),
    );
    if (view.data.issuers)
      parts.push(
        "<h2>Coverage by issuer</h2>",
        table(
          "One row per state, year, market and issuer",
          [
            "State",
            "Year",
            "Market",
            "Issuer",
            "Catalog",
            "Premiums",
            "Providers",
            "Formulary",
          ],
          view.data.issuers.map((r) => [
            r.state,
            r.year,
            r.market ?? "not recorded",
            r.issuer_id ?? "all issuers",
            r.catalog,
            r.premium,
            r.provider,
            r.formulary,
          ]),
        ),
      );
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenPlans status</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${parts.join("\n")}
</main>
</body>
</html>
`;
}
