import type { MarketAnswer } from "./service.js";

const escapes: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
export const escapeHtml = (value: unknown) =>
  String(value ?? "Unknown").replace(/[&<>"']/g, (char) => escapes[char]!);
const money = (cents: number | undefined | null) =>
  cents === null || cents === undefined
    ? "Unknown"
    : `$${(cents / 100).toFixed(2)}`;

/** Display only. All prices and counts come from the same canonical answer as REST and MCP. */
export function printMarket(answer: MarketAnswer): string {
  const cell = answer.data.comparison;
  const metal = String(cell.basis.metal ?? "silver");
  const household = Array.isArray(cell.basis.household)
    ? cell.basis.household
        .map(
          (member) =>
            `${String((member as Record<string, unknown>).relationship)} age ${String((member as Record<string, unknown>).age)}`,
        )
        .join(", ")
    : `Age ${String(cell.basis.age)}`;
  const stats = cell.statistics;
  const counts = cell.denominator;
  const json = escapeHtml(JSON.stringify(cell.evidence, null, 2));
  const query = new URLSearchParams({
    year: String(cell.year),
    metal,
    ...(typeof cell.location.zip === "string"
      ? { zip: cell.location.zip }
      : {}),
    ...(typeof cell.location.county === "string"
      ? { county: cell.location.county }
      : {}),
    ...(Array.isArray(cell.basis.household)
      ? { members: JSON.stringify(cell.basis.household) }
      : { age: String(cell.basis.age) }),
    evidence_page: String(cell.evidence.page),
    data_generation: cell.data_generation,
  });
  const jsonUrl = `/compare/v1/market?${query}`;
  query.set("evidence_page", String(cell.evidence.next_page));
  const nextPage = cell.evidence.next_page
    ? `<form method="post" action="/compare/v1/print">${[...query].map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`).join("")}<button type="submit">Next evidence page</button></form>`
    : "";
  const figures = [
    money(stats?.median?.display_cents),
    money(stats?.mean?.display_cents),
    money(stats?.lowest_cents),
    `${money(stats?.p25_cents)} to ${money(stats?.p75_cents)}`,
    `${counts.rated_count ?? "Unknown"} / ${counts.candidate_count ?? "Unknown"}`,
  ];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(metal)} offer prices</title><style>
body{font:12pt/1.4 system-ui,sans-serif;color:#000;background:#fff;max-width:70rem;margin:auto;padding:1rem}table{border-collapse:collapse;width:100%}th,td{text-align:left;border-bottom:1px solid #555;padding:.4rem}thead{display:table-header-group}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:8pt}tr{break-inside:avoid}td{white-space:nowrap}nav{margin:1rem 0}a{color:#064c90}@page{margin:14mm}@media print{body{padding:0;font-size:10pt}.appendix{break-before:page}nav{display:none}}
</style></head><body><nav aria-label="Distribution actions"><a href="/compare/v1">Change inputs</a> · <a href="${escapeHtml(jsonUrl)}">Inspect JSON evidence</a><p>Use your browser’s Print command for Letter or A4.</p>${nextPage}</nav><h1>${escapeHtml(metal)} offer prices</h1><p>Median gross monthly premium across available base plans.</p><p>ZIP ${escapeHtml(cell.location.zip)} · County ${escapeHtml(cell.location.county)} · ${cell.year} · Starts ${escapeHtml(cell.basis.coverage_start)} · ${escapeHtml(household)} · Non-tobacco</p><p>Individual medical · On-exchange · Public catalog · Observed ${escapeHtml(answer.freshness.checked_at)}</p><p>Status: ${escapeHtml(cell.status)}. ${escapeHtml(cell.reason ?? "Complete within the admitted catalog.")}</p><table><caption>USD per month across ${escapeHtml(metal)} plans</caption><thead><tr>${["Median", "Mean", "Lowest", "P25 to P75", "Rated / candidates"].map((label) => `<th scope="col">${label}</th>`).join("")}</tr></thead><tbody><tr>${figures.map((value) => `<td>${escapeHtml(value)}</td>`).join("")}</tr></tbody></table><p>These are prices across plans, unweighted by enrollment. Quartiles use nearest rank. Median and mean display fractional cents rounded half up. ${stats?.small_offer_set ? "Small offer set: fewer than four rated plans." : ""}</p><p>Excluded: ${escapeHtml(counts.excluded_count)}. Unknown candidates: ${escapeHtml(counts.unknown_count)}. ${escapeHtml(cell.exclusions.map((row) => `${row.reason}: ${row.count}`).join("; "))}</p><p>Group costs: unavailable from public evidence. Employer budgets, subsidies and group savings are not calculated. This sheet is not a bindable quote.</p><section class="appendix"><h2>Sources and method</h2><p>Generation ${escapeHtml(cell.data_generation)}. Catalog: ${escapeHtml(cell.completeness.catalog)}. Rates: ${escapeHtml(cell.completeness.rates)}.</p><p>Exact median: ${escapeHtml(stats?.median ? `${stats.median.numerator}/${stats.median.denominator}` : null)} cents. Exact mean: ${escapeHtml(stats?.mean ? `${stats.mean.numerator}/${stats.mean.denominator}` : null)} cents.</p><p>Denominator: distinct on-exchange medical base plans in this metal at the resolved location, including counted family exclusions and unresolved candidates. CSR variants do not add offers. Statistics use eligible, rated plans only and stay unknown if any potentially eligible offer is unresolved. Source completeness covers the admitted catalog, not every plan sold.</p><p>Evidence page ${cell.evidence.page}. ${cell.evidence.next_page ? `More evidence is available on page ${cell.evidence.next_page} with this generation.` : "No further evidence pages."} Statistics use the entire cohort.</p><pre>${json}</pre></section></body></html>`;
}
