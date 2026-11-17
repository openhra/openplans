import type { CalculationHost, CalculationScope } from "@openplans/plugin-sdk";
import type { EmployerInput } from "./employer-input.js";
import { marketCosts } from "./service.js";
import { renewalSubtotal } from "./renewal.js";

export async function employerCosts(
  host: CalculationHost,
  input: EmployerInput,
  scope: CalculationScope,
) {
  const individual = [];
  for (const employee of input.employees) {
    scope.signal.throwIfAborted();
    const answer = await marketCosts(host, employee.input, scope);
    individual.push({
      row: employee.row,
      tier: employee.tier,
      comparison: answer.data.comparison,
    });
  }
  return {
    schema_version: "1" as const,
    input_origin: "operator_supplied" as const,
    year: input.year,
    individual,
    renewal: renewalSubtotal(input),
    ichra: { status: "unavailable_until_slice_4" as const },
    employer_budget: {
      status: "partial" as const,
      known_subtotal_monthly_cents:
        renewalSubtotal(input).employer_contribution_subtotal_monthly_cents,
      all_in_monthly_cents: null,
    },
  };
}
