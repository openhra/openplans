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
dl { display: grid; grid-template-columns: fit-content(50%) minmax(0, 1fr); gap: 0.25rem 1rem;
  margin: 0; }
dt { color: var(--muted); }
dd { margin: 0; overflow-wrap: anywhere; }
.table { overflow-x: auto; }
.table:focus-visible { outline: 3px solid var(--fg); outline-offset: 2px; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 0.35rem 0.5rem; border-bottom: 1px solid var(--line);
  vertical-align: top; }
th { font-weight: 600; }
td.token { overflow-wrap: anywhere; }
td.date { white-space: nowrap; }
@media (max-width: 30rem) {
  th, td { padding: 0.3rem 0.35rem; font-size: 0.875rem; }
}
pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; font-size: 0.85rem; }
a { color: inherit; }
nav { margin: 0 0 0.75rem; }
details { border-bottom: 1px solid var(--line); padding: 0.25rem 0; }
summary { cursor: pointer; overflow-wrap: anywhere; }
details .table { margin: 0.35rem 0 0.5rem; }
`;

/** Codes that count as places but not as states. */
export const NOT_STATES = ["DC", "PR", "GU", "VI", "AS", "MP"] as const;

/**
 * "48 states and DC": states and the other places are counted from the codes themselves,
 * so the sentence follows the data.
 */
export function placesPhrase(codes: readonly string[]): string {
  const unique = [...new Set(codes)];
  const others = NOT_STATES.filter((code) => unique.includes(code));
  const states = unique.length - others.length;
  const parts = [
    ...(states ? [`${states} ${states === 1 ? "state" : "states"}`] : []),
    ...others,
  ];
  if (!parts.length) return "no states";
  return parts.length === 1
    ? parts[0]!
    : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** The family a source ID belongs to: the part before the first colon. */
export const sourceFamily = (id: string) => id.split(":")[0] || id;

const FRESHNESS: Record<string, string> = {
  "<1d": "under 1 day",
  "<7d": "under 7 days",
  "<30d": "under 30 days",
  older: "30 days or more",
  unknown: "unknown",
};
// The same buckets for retrieval, worded to follow a count: "6 retrieved under 7 days ago".
const COUNTED_AGE: Record<string, string> = {
  "<1d": "retrieved under 1 day ago",
  "<7d": "retrieved under 7 days ago",
  "<30d": "retrieved under 30 days ago",
  older: "retrieved 30 days ago or more",
  unknown: "retrieved at an unknown time",
};

/** What the two dates mean. A recent retrieval says nothing about the publisher's latest release. */
export const DATES_EXPLAINED =
  "Retrieved is when OpenPlans last downloaded a source and Published is the publisher's own " +
  "date for that copy, so a source retrieved today can still hold data published months ago.";

/** The family's publisher dates for its summary line: one date, a range, and how many are unknown. */
function publishedSummary(dates: readonly (string | null)[]): string {
  const known = dates.filter((d): d is string => d !== null).sort();
  const missing = dates.length - known.length;
  if (!known.length) return "publisher date unknown";
  const first = known[0]!;
  const last = known.at(-1)!;
  const range =
    first === last ? `published ${first}` : `published ${first} to ${last}`;
  return missing ? `${range}, ${missing} unknown` : range;
}
const age = (bucket: string) => escapeHtml(FRESHNESS[bucket] ?? bucket);
// A retrieval age under the "Retrieved" heading: "under 7 days ago".
const retrievedAgo = (bucket: string) =>
  bucket === "unknown" ? "unknown" : `${FRESHNESS[bucket] ?? bucket} ago`;

function state(value: string) {
  const css = value === "ok" || value === "down" ? value : "muted";
  return `<span class="${css}">${escapeHtml(value)}</span>`;
}

/**
 * A table in a region that scrolls sideways on its own when it is wider than the screen, so
 * the page never does. Words wrap only at spaces. `tokens` lists the columns that hold IDs,
 * hashes, times or JSON. Only those cells may break inside a token. `dates` lists token columns
 * that hold a calendar date: short enough to keep on one line, so "2026-10-30" never splits at
 * a hyphen.
 */
function table(
  caption: string,
  head: string[],
  rows: unknown[][],
  tokens: readonly number[] = [],
  dates: readonly number[] = [],
): string {
  if (!rows.length) return `<p class="muted">${escapeHtml(caption)}: none.</p>`;
  const cell = (value: unknown, column: number) =>
    tokens.includes(column)
      ? `<td class="${dates.includes(column) ? "token date" : "token"}">${escapeHtml(value)}</td>`
      : `<td>${escapeHtml(value)}</td>`;
  return `<div class="table" role="region" tabindex="0" aria-label="${escapeHtml(caption)}"><table><caption class="muted">${escapeHtml(caption)}</caption>
<thead><tr>${head.map((h) => `<th scope="col">${escapeHtml(h)}</th>`).join("")}</tr></thead>
<tbody>${rows
    .map((row) => `<tr>${row.map(cell).join("")}</tr>`)
    .join("\n")}</tbody></table></div>`;
}

/**
 * One <details> element per source family. The summary line gives the snapshot count and
 * how many fall in each age bucket; the full rows sit inside.
 */
function grouped(
  caption: string,
  head: string[],
  rows: {
    id: string;
    freshness: string;
    published: string | null;
    cells: unknown[];
  }[],
  tokens: readonly number[],
  dates: readonly number[],
): string {
  if (!rows.length) return `<p class="muted">${escapeHtml(caption)}: none.</p>`;
  const families = new Map<string, typeof rows>();
  for (const row of rows) {
    const family = sourceFamily(row.id);
    if (!families.has(family)) families.set(family, []);
    families.get(family)!.push(row);
  }
  return `<p class="muted">${escapeHtml(caption)}: ${rows.length} from ${families.size} ${families.size === 1 ? "source" : "sources"}. Open a source to see each snapshot.</p>
<p>${escapeHtml(DATES_EXPLAINED)}</p>
${[...families]
  .map(([family, members]) => {
    const buckets = Object.keys(COUNTED_AGE)
      .map(
        (bucket) =>
          [
            COUNTED_AGE[bucket]!,
            members.filter((m) => m.freshness === bucket).length,
          ] as const,
      )
      .filter(([, n]) => n);
    const count = `${members.length} ${members.length === 1 ? "snapshot" : "snapshots"}`;
    const ages =
      buckets.length === 1
        ? `${members.length === 1 ? "" : "all "}${buckets[0]![0]}`
        : buckets.map(([label, n]) => `${n} ${label}`).join(", ");
    const published = publishedSummary(members.map((m) => m.published));
    return `<details><summary>${escapeHtml(family)} <span class="muted">${escapeHtml(`${count}, ${ages}; ${published}`)}</span></summary>
${table(
  `${family} snapshots`,
  head,
  members.map((m) => m.cells),
  tokens,
  dates,
)}</details>`;
  })
  .join("\n")}`;
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

/** Where the page's header link points. */
export const HOME_URL = "https://plans.openhra.com/";

/**
 * One page for either view. No scripts, no external files. `places` is the list of state
 * codes behind `data.states`; the operator view can work it out from its issuer rows.
 */
export function renderStatusHtml(
  view: PublicStatus | OperatorStatus,
  places?: readonly string[] | null,
): string {
  const operator = isOperator(view);
  const codes =
    places ??
    (operator && view.data.issuers
      ? view.data.issuers.map((row) => row.state)
      : null);
  const parts: string[] = [];
  parts.push(`<nav><a href="${HOME_URL}">plans.openhra.com</a></nav>
<h1>OpenPlans status</h1>
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
      `<p>${escapeHtml(codes ? placesPhrase(codes) : `${view.data.states ?? "unknown"} places`)}, plan years ${escapeHtml(view.data.years?.join(", ") || "none")}.</p>`,
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
        ? grouped(
            "Active snapshots",
            ["Source", "Age", "Retrieved", "Published", "Snapshot"],
            (view as OperatorStatus).sources!.map((s) => ({
              id: s.id,
              freshness: s.freshness,
              published: s.published_at,
              cells: [
                s.id,
                FRESHNESS[s.freshness],
                s.retrieved_at ?? "unknown",
                s.published_at ?? "unknown",
                s.snapshot_id,
              ],
            })),
            [0, 2, 3, 4],
            [3],
          )
        : grouped(
            "Active snapshots",
            ["Source", "Retrieved", "Published"],
            view.sources.map((s) => ({
              id: s.id,
              freshness: s.freshness,
              published: s.published_at,
              cells: [
                s.id,
                retrievedAgo(s.freshness),
                s.published_at ?? "unknown",
              ],
            })),
            [0, 2],
            [2],
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
            [0, 2, 3],
          )
        : table(
            "Last import per source",
            ["Source", "Last success"],
            view.worker.last_ingest.map((i) => [
              i.source,
              FRESHNESS[i.last_success],
            ]),
            [0],
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
            [0, 6],
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
            [0],
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
        [0, 3],
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
            [3],
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
            [0, 1, 2],
          )
        : unknownSection("Events"),
    );
    if (view.data.issuers)
      parts.push(
        "<h2>Coverage by issuer</h2>",
        `<details><summary>${view.data.issuers.length} rows</summary>`,
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
        "</details>",
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
