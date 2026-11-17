import { escapeHtml } from "./print.js";

type EmployerAnswer = {
  year: number;
  renewal: {
    origin: string;
    quote_basis: string;
    employee_count: number;
    group_premium_monthly_cents: number;
    employer_contribution_monthly_cents: number;
    supplied_fees_monthly_cents: number;
    employer_contribution_subtotal_monthly_cents: number;
    rows: {
      row: number;
      tier: string;
      group_monthly_cents: number;
      row_ref: string;
    }[];
  };
};
const money = (cents: number | null) =>
  cents === null ? "Unknown" : `$${(cents / 100).toFixed(2)}`;
export function printEmployer(answer: EmployerAnswer) {
  const rows = answer.renewal.rows
    .map(
      (row) =>
        `<tr><td>${row.row}</td><td>${escapeHtml(row.tier)}</td><td>${money(row.group_monthly_cents)}</td><td>${escapeHtml(row.row_ref)}</td></tr>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Private renewal comparison</title><style>body{font:12pt/1.4 system-ui;color:#000}table{border-collapse:collapse;width:100%}th,td{text-align:left;border-bottom:1px solid #555;padding:.4rem}thead{display:table-header-group}@page{size:auto;margin:14mm}@media print{tr{break-inside:avoid}}</style></head><body><h1>Private fully insured renewal comparison</h1><p>Operator-supplied census and quote · ${answer.year} · ${answer.renewal.employee_count} employees</p><p>Individual plan prices are calculated for each supplied employee household. ICHRA calculation: unavailable until slice 4.</p><h2>Employer contribution subtotal</h2><p>Group premium: ${money(answer.renewal.group_premium_monthly_cents)} monthly</p><p>Employer contribution: ${money(answer.renewal.employer_contribution_monthly_cents)} monthly</p><p>Supplied fees: ${money(answer.renewal.supplied_fees_monthly_cents)} monthly</p><p><strong>Known subtotal: ${money(answer.renewal.employer_contribution_subtotal_monthly_cents)} monthly</strong></p><p>All-in cost: Unknown</p><table><thead><tr><th>Row</th><th>Tier</th><th>Group premium</th><th>Quote row</th></tr></thead><tbody>${rows}</tbody></table><p>Source origin: operator-supplied. Inputs are request-only.</p></body></html>`;
}
