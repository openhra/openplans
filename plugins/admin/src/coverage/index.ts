import type { HostAvailabilityEntry, OperatorCatalog, OperatorObservation } from "@openplans/plugin-sdk";
import type { AdminPageRegistrar } from "../contracts.js";
import { escapeHtml } from "../html.js";
import { withSessionControls } from "../session.js";
import { ADMIN_STYLES } from "../styles.js";

const PAGE_SIZE = 25;
const MAX_PAGE = 200;
const states = new Set(["available", "partial", "missing", "unknown"]);

type CoverageQuery = {
  state?: string;
  year?: number;
  market?: string;
  issuer?: string;
  offset: number;
};

function queryFrom(url: URL): CoverageQuery | null {
  const state = url.searchParams.get("state") ?? undefined;
  if (state && !/^[A-Z]{2}$/.test(state)) return null;
  const yearText = url.searchParams.get("year");
  const year = yearText === null ? undefined : Number(yearText);
  if (year !== undefined && (!Number.isInteger(year) || year < 2014 || year > 2100)) return null;
  const market = url.searchParams.get("market") ?? undefined;
  if (market && market.length > 80) return null;
  const issuer = url.searchParams.get("issuer") ?? undefined;
  if (issuer && issuer.length > 100) return null;
  const offsetText = url.searchParams.get("offset") ?? "0";
  if (!/^\d{1,5}$/.test(offsetText)) return null;
  const offset = Number(offsetText);
  if (offset % PAGE_SIZE !== 0 || offset / PAGE_SIZE > MAX_PAGE) return null;
  return { state, year, market, issuer, offset };
}

function filterRows(rows: readonly HostAvailabilityEntry[], query: CoverageQuery) {
  return rows.filter((row) =>
    (!query.state || row.state === query.state) &&
    (query.year === undefined || row.year === query.year) &&
    (!query.market || row.market === query.market) &&
    (!query.issuer || row.issuer_id === query.issuer),
  );
}

function safeStatus(value: string): string {
  return states.has(value) ? value : "unknown";
}

function table(rows: readonly HostAvailabilityEntry[]): string {
  if (!rows.length) return '<p class="unknown">No matching availability scopes were returned.</p>';
  const body = rows.map((row) => `<tr><th scope="row">${escapeHtml(row.state)} / ${row.year} / ${escapeHtml(row.market ?? "unknown channel")} / ${escapeHtml(row.issuer_id ?? "all issuers")}</th>${[row.catalog, row.premium, row.provider, row.formulary].map((value) => `<td>${escapeHtml(safeStatus(value))}</td>`).join("")}<td>${row.snapshot_id === null ? "unknown" : escapeHtml(row.snapshot_id)}</td></tr>`).join("");
  return `<div role="region" tabindex="0" aria-label="Coverage availability" class="table"><table><caption>Availability scopes in this filtered result</caption><thead><tr><th scope="col">Scope</th><th scope="col">Catalog</th><th scope="col">Premium</th><th scope="col">Provider</th><th scope="col">Formulary</th><th scope="col">Snapshot</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

function counts(rows: readonly HostAvailabilityEntry[]): string {
  const dimensions = ["catalog", "premium", "provider", "formulary"] as const;
  return `<dl>${dimensions.map((dimension) => {
    const byStatus = Object.fromEntries([...states].map((state) => [state, rows.filter((row) => safeStatus(row[dimension]) === state).length]));
    return `<div><dt>${dimension}</dt><dd>${byStatus.available} available, ${byStatus.partial} partial, ${byStatus.missing} missing, ${byStatus.unknown} unknown of ${rows.length} returned scopes</dd></div>`;
  }).join("")}</dl>`;
}

function renderCoverage(
  availability: OperatorObservation<readonly HostAvailabilityEntry[]>,
  catalog: OperatorObservation<OperatorCatalog> | undefined,
  query: CoverageQuery,
): string {
  const observedAt = availability.observedAt;
  let content: string;
  if (availability.state === "unavailable") {
    content = `<p class="unknown">Coverage availability is unknown: ${escapeHtml(availability.reason)}.</p>`;
  } else {
    const matching = filterRows(availability.value, query);
    const page = matching.slice(query.offset, query.offset + PAGE_SIZE);
    const indexText = !catalog
      ? "Search index state is unknown: catalog reader unavailable."
      : catalog.state === "unavailable"
        ? `Search index state is unknown: ${escapeHtml(catalog.reason)}.`
        : `Provider search index: ${escapeHtml(catalog.value.providerSearch)}. Generation: ${escapeHtml(catalog.value.generation)}. Observed ${escapeHtml(catalog.observedAt)}.`;
    content = `<p>Scope: filtered availability result, ${matching.length} matching of ${availability.value.length} returned scopes. Origin: canonical data availability reader. Observed ${escapeHtml(observedAt)}.</p>${counts(matching)}${table(page)}<p>Showing ${page.length ? query.offset + 1 : 0}–${query.offset + page.length} of ${matching.length} matching scopes.</p><p>${indexText}</p><p>Snapshot identifiers are shown where the canonical availability reader supplies them. Retrieval and publisher dates are unknown in this reader.</p>${query.offset > 0 ? `<a href="${escapeHtml(pageHref(query, Math.max(0, query.offset - PAGE_SIZE)))}">Previous page</a> ` : ""}${query.offset + PAGE_SIZE < matching.length ? `<a href="${escapeHtml(pageHref(query, query.offset + PAGE_SIZE))}">Next page</a>` : ""}`;
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Coverage and freshness</title><style>${ADMIN_STYLES}</style></head><body><a class="skip" href="#main">Skip to content</a><header><h1>Coverage and freshness</h1><nav aria-label="Admin sections"><a href="/admin">Overview</a></nav></header><main id="main"><form method="get" action="/admin/coverage"><label>State <input name="state" maxlength="2" pattern="[A-Z]{2}" value="${escapeHtml(query.state ?? "")}"></label><label>Year <input name="year" type="number" min="2014" max="2100" value="${query.year ?? ""}"></label><label>Exchange channel <input name="market" maxlength="80" value="${escapeHtml(query.market ?? "")}"></label><label>Issuer <input name="issuer" maxlength="100" value="${escapeHtml(query.issuer ?? "")}"></label><button type="submit">Filter</button></form><section><h2>Coverage availability</h2>${content}</section></main></body></html>`;
}

function pageHref(query: CoverageQuery, offset: number): string {
  const params = new URLSearchParams();
  if (query.state) params.set("state", query.state);
  if (query.year !== undefined) params.set("year", String(query.year));
  if (query.market) params.set("market", query.market);
  if (query.issuer) params.set("issuer", query.issuer);
  if (offset) params.set("offset", String(offset));
  return `/admin/coverage${params.size ? `?${params}` : ""}`;
}

export const registerCoverage: AdminPageRegistrar = (dependencies) => {
  dependencies.routes.add({
    method: "GET",
    path: "/admin/coverage",
    exposure: "operator",
    adminSession: true,
    contentType: "text/html",
    handler: async (c) => {
      c.header("Cache-Control", "no-store");
      const query = queryFrom(new URL(c.req.url));
      if (!query) return c.html("Invalid coverage filters.", 400);
      const scope = { db: c.get("pluginDb"), signal: c.get("pluginSignal") };
      const availabilityPromise = dependencies.operator
        ? dependencies.operator.availability(scope)
        : Promise.resolve({ state: "unavailable" as const, reason: "not_supported" as const, observedAt: dependencies.now().toISOString() });
      const catalogPromise = dependencies.operator?.catalog(scope);
      const [availability, catalog] = await Promise.all([availabilityPromise, catalogPromise]);
      return c.html(withSessionControls(renderCoverage(availability, catalog, query), c.get("pluginAdminSession")));
    },
  });
};
