import type { EmployerInput } from "./employer-input.js";

export function renewalSubtotal(input: EmployerInput) {
  const billed = input.employees.map((employee) => {
    const row =
      input.group_quote.basis === "composite_tier"
        ? {
            row: employee.row,
            tier: employee.tier,
            monthly_cents: input.group_quote.monthly_cents[employee.tier],
            row_ref: employee.tier,
          }
        : input.group_quote.rows.find(
            (candidate) => candidate.row === employee.row,
          )!;
    const employerContributionCents =
      input.contribution.basis === "fixed_per_employee"
        ? Math.min(row.monthly_cents, input.contribution.monthly_cents)
        : Math.floor(
            (row.monthly_cents * input.contribution.basis_points + 5_000) /
              10_000,
          );
    return {
      row: employee.row,
      tier: row.tier,
      group_monthly_cents: row.monthly_cents,
      employer_contribution_monthly_cents: employerContributionCents,
      row_ref: row.row_ref,
    };
  });
  const groupPremium = billed.reduce(
    (sum, row) => sum + row.group_monthly_cents,
    0,
  );
  const employerContribution = billed.reduce(
    (sum, row) => sum + row.employer_contribution_monthly_cents,
    0,
  );
  const fees = input.fees.reduce((sum, fee) => sum + fee.monthly_cents, 0);
  return {
    origin: "operator_supplied" as const,
    quote_basis: input.group_quote.basis,
    quote_source: input.group_quote.source,
    employee_count: billed.length,
    group_premium_monthly_cents: groupPremium,
    employer_contribution_monthly_cents: employerContribution,
    supplied_fees_monthly_cents: fees,
    employer_contribution_subtotal_monthly_cents: employerContribution + fees,
    all_in_cost_monthly_cents: null,
    rows: billed,
  };
}
