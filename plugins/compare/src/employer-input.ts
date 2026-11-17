import { z } from "zod";
import { offerCohortInputSchema } from "@openplans/plugin-sdk";
import {
  MAX_CENSUS_ROWS,
  sequentialCensusOrdinals,
} from "@openplans/plugin-sdk";

const money = z.int().nonnegative().max(100_000_000);
const date = z.iso.date();
const employee = z.strictObject({
  row: z.int().positive(),
  input: offerCohortInputSchema,
  tier: z.enum([
    "employee_only",
    "employee_spouse",
    "employee_children",
    "family",
  ]),
});
const source = z.strictObject({
  version: z.string().min(1).max(80),
  document_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  issued_at: date,
  effective_at: date,
  expires_at: date,
  row_refs: z.array(z.string().min(1).max(80)).min(1).max(200),
});
const quote = z.discriminatedUnion("basis", [
  z.strictObject({
    basis: z.literal("composite_tier"),
    source,
    monthly_cents: z.strictObject({
      employee_only: money,
      employee_spouse: money,
      employee_children: money,
      family: money,
    }),
  }),
  z.strictObject({
    basis: z.literal("list_billed"),
    source,
    rows: z
      .array(
        z.strictObject({
          row: z.int().positive(),
          tier: employee.shape.tier,
          monthly_cents: money,
          row_ref: z.string().min(1).max(80),
        }),
      )
      .min(1)
      .max(MAX_CENSUS_ROWS),
  }),
]);

export const employerInput = z
  .strictObject({
    year: z.int().min(2014).max(9999),
    employees: z.array(employee).min(1).max(MAX_CENSUS_ROWS),
    group_quote: quote,
    contribution: z.discriminatedUnion("basis", [
      z.strictObject({
        basis: z.literal("fixed_per_employee"),
        monthly_cents: money,
      }),
      z.strictObject({
        basis: z.literal("percentage"),
        basis_points: z.int().min(0).max(10_000),
      }),
    ]),
    fees: z
      .array(
        z.strictObject({
          name: z.string().min(1).max(80),
          monthly_cents: money,
        }),
      )
      .max(20),
  })
  .superRefine((input, ctx) => {
    const rows = input.employees.map((item) => item.row);
    if (!sequentialCensusOrdinals(rows))
      ctx.addIssue({
        code: "custom",
        path: ["employees"],
        message: "Rows must be sequential",
      });
    if (input.employees.some((item) => item.input.year !== input.year))
      ctx.addIssue({
        code: "custom",
        path: ["employees"],
        message: "Year mismatch",
      });
    const quote = input.group_quote;
    if (
      quote.source.effective_at.slice(0, 4) !== String(input.year) ||
      quote.source.expires_at < quote.source.effective_at ||
      quote.source.issued_at > quote.source.effective_at
    )
      ctx.addIssue({
        code: "custom",
        path: ["group_quote", "source"],
        message: "Invalid quote dates",
      });
    if (quote.basis === "list_billed") {
      const expected = input.employees.map((item) => item.row).join(",");
      if (
        quote.rows
          .map((item) => item.row)
          .sort((a, b) => a - b)
          .join(",") !== expected
      )
        ctx.addIssue({
          code: "custom",
          path: ["group_quote", "rows"],
          message: "One billed row is required per employee",
        });
      for (const row of quote.rows)
        if (input.employees[row.row - 1]?.tier !== row.tier)
          ctx.addIssue({
            code: "custom",
            path: ["group_quote", "rows"],
            message: "Billed tier mismatch",
          });
    }
  });
export type EmployerInput = z.output<typeof employerInput>;
