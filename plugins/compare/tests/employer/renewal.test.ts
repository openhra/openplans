import { expect, it } from "vitest";
import { employerInput } from "../../src/employer-input.js";
import { renewalSubtotal } from "../../src/renewal.js";
import { readFile } from "node:fs/promises";
import {
  importMutant,
  plantMutantFile,
} from "../../../../tests/mutant-file.js";

const digest = "a".repeat(64);
const base = {
  year: 2026,
  employees: [
    {
      row: 1,
      tier: "employee_only" as const,
      input: { zip: "77002", county: "48201", year: 2026, age: 40 },
    },
    {
      row: 2,
      tier: "family" as const,
      input: { zip: "77002", county: "48201", year: 2026, age: 40 },
    },
  ],
  group_quote: {
    basis: "composite_tier" as const,
    source: {
      version: "renewal-v1",
      document_sha256: digest,
      issued_at: "2025-10-01",
      effective_at: "2026-01-01",
      expires_at: "2026-12-31",
      row_refs: ["p1", "p2"],
    },
    monthly_cents: {
      employee_only: 50000,
      employee_spouse: 90000,
      employee_children: 85000,
      family: 120000,
    },
  },
  contribution: { basis: "percentage" as const, basis_points: 7500 },
  fees: [{ name: "commission", monthly_cents: 2500 }],
};

it("calculates composite and list-billed premiums and the explicit contribution subtotal", () => {
  const input = employerInput.parse(base);
  expect(renewalSubtotal(input)).toMatchObject({
    origin: "operator_supplied",
    group_premium_monthly_cents: 170000,
    employer_contribution_monthly_cents: 127500,
    supplied_fees_monthly_cents: 2500,
    employer_contribution_subtotal_monthly_cents: 130000,
    all_in_cost_monthly_cents: null,
  });
  const list = employerInput.parse({
    ...base,
    group_quote: {
      basis: "list_billed",
      source: base.group_quote.source,
      rows: [
        { row: 1, tier: "employee_only", monthly_cents: 50000, row_ref: "r1" },
        { row: 2, tier: "family", monthly_cents: 120000, row_ref: "r2" },
      ],
    },
  });
  expect(renewalSubtotal(list).group_premium_monthly_cents).toBe(170000);
});

it("rejects missing or mismatched billed tiers, stale quote years, and incomplete census rows", () => {
  const list = {
    basis: "list_billed",
    source: base.group_quote.source,
    rows: [
      { row: 1, tier: "employee_only", monthly_cents: 50000, row_ref: "r1" },
    ],
  };
  expect(employerInput.safeParse({ ...base, group_quote: list }).success).toBe(
    false,
  );
  expect(
    employerInput.safeParse({
      ...base,
      group_quote: {
        ...list,
        rows: [
          { row: 1, tier: "family", monthly_cents: 50000, row_ref: "r1" },
          { row: 2, tier: "family", monthly_cents: 120000, row_ref: "r2" },
        ],
      },
    }).success,
  ).toBe(false);
  expect(employerInput.safeParse({ ...base, year: 2025 }).success).toBe(false);
  expect(
    employerInput.safeParse({
      ...base,
      employees: [{ ...base.employees[0], row: 2 }],
    }).success,
  ).toBe(false);
});

it("rejects a mutant that treats a missing billed tier as a zero premium", () => {
  const broken = {
    ...base,
    group_quote: {
      basis: "list_billed" as const,
      source: base.group_quote.source,
      rows: [
        {
          row: 1,
          tier: "employee_only" as const,
          monthly_cents: 50000,
          row_ref: "r1",
        },
      ],
    },
  };
  expect(employerInput.safeParse(broken).success).toBe(false);
});

it("catches employer calculation mutants in disposable source copies", async () => {
  const sourceUrl = new URL("../../src/renewal.ts", import.meta.url);
  const source = await readFile(sourceUrl, "utf8");
  const contract = (calculate: typeof renewalSubtotal) => {
    const answer = calculate(employerInput.parse(base));
    expect(answer.group_premium_monthly_cents).toBe(170000);
    expect(answer.employer_contribution_monthly_cents).toBe(127500);
    expect(answer.supplied_fees_monthly_cents).toBe(2500);
    expect(answer.employer_contribution_subtotal_monthly_cents).toBe(130000);
    expect(answer.rows).toHaveLength(base.employees.length);
  };
  const mutants = [
    [
      "family uses employee-only rate",
      "input.group_quote.monthly_cents[employee.tier]",
      'input.group_quote.monthly_cents[employee.tier === "family" ? "employee_only" : employee.tier]',
    ],
    [
      "fees omitted as zero",
      "const fees = input.fees.reduce((sum, fee) => sum + fee.monthly_cents, 0);",
      "const fees = 0;",
    ],
    [
      "commission double-counted",
      "employer_contribution_subtotal_monthly_cents: employerContribution + fees,",
      "employer_contribution_subtotal_monthly_cents: employerContribution + fees + fees,",
    ],
    [
      "unknown employee dropped from total",
      "const billed = input.employees.map((employee) => {",
      "const billed = input.employees.slice(0, -1).map((employee) => {",
    ],
  ] as const;
  for (const [label, before, after] of mutants) {
    expect(source).toContain(before);
    const mutant = await plantMutantFile(
      sourceUrl,
      source.replace(before, after),
    );
    try {
      const module = await importMutant<{
        renewalSubtotal: typeof renewalSubtotal;
      }>(mutant.url, "renewalSubtotal");
      expect(() => contract(module.renewalSubtotal), label).toThrow();
    } finally {
      await mutant.cleanup();
    }
  }
});

it("catches a mutant that defaults a missing tier premium to zero", async () => {
  const sourceUrl = new URL("../../src/employer-input.ts", import.meta.url);
  const source = await readFile(sourceUrl, "utf8");
  const before = "family: money,";
  expect(source).toContain(before);
  const mutant = await plantMutantFile(
    sourceUrl,
    source.replace(before, "family: money.default(0),"),
  );
  try {
    const module = (await import(/* @vite-ignore */ mutant.url.href)) as {
      employerInput: typeof employerInput;
    };
    expect(module.employerInput).toBeDefined();
    const missingTier = structuredClone(base);
    delete (
      missingTier.group_quote as { monthly_cents: Record<string, number> }
    ).monthly_cents.family;
    expect(() =>
      expect(() => module.employerInput.parse(missingTier)).toThrow(),
    ).toThrow();
  } finally {
    await mutant.cleanup();
  }
});

it("catches a mutant that accepts a quote from the wrong year", async () => {
  const sourceUrl = new URL("../../src/employer-input.ts", import.meta.url);
  const source = await readFile(sourceUrl, "utf8");
  const before =
    "quote.source.effective_at.slice(0, 4) !== String(input.year) ||";
  expect(source).toContain(before);
  const mutant = await plantMutantFile(
    sourceUrl,
    source.replace(before, "false ||"),
  );
  try {
    const module = (await import(/* @vite-ignore */ mutant.url.href)) as {
      employerInput: typeof employerInput;
    };
    expect(module.employerInput).toBeDefined();
    const wrongYear = {
      ...base,
      employees: base.employees.map((item) => ({
        ...item,
        input: { ...item.input, year: 2025 },
      })),
      year: 2025,
    };
    expect(() =>
      expect(() => module.employerInput.parse(wrongYear)).toThrow(),
    ).toThrow();
  } finally {
    await mutant.cleanup();
  }
});

it.each([
  [
    "an unauthorized public route",
    'exposure: "operator",',
    'exposure: "public",',
  ],
  [
    "private input written to a log",
    "const input = employerInput.parse(await c.req.json());",
    "const raw = await c.req.json(); console.log(raw); const input = employerInput.parse(raw);",
  ],
])("catches a mutant that introduces %s", async (_name, before, after) => {
  const sourceUrl = new URL("../../src/index.ts", import.meta.url);
  const source = await readFile(sourceUrl, "utf8");
  expect(source).toContain(before);
  const mutant = await plantMutantFile(
    sourceUrl,
    source.replace(before, after),
  );
  const originalLog = console.log;
  const logCalls: unknown[][] = [];
  try {
    console.log = (...args: unknown[]) => logCalls.push(args);
    const contract = async () => {
      const module = (await import(/* @vite-ignore */ mutant.url.href)) as {
        default: { setup(ctx: unknown): void };
      };
      expect(module.default).toBeDefined();
      const routes: Record<string, unknown>[] = [];
      const host = {
        enumerateHouseholdOffers: async () => ({
          status: "calculated",
          evidence: { snapshots: [] },
        }),
      };
      module.default.setup({
        config: {
          public: { quoting: true },
          tpa: { enabled: true, privateIngress: true },
        },
        calculationHost: host,
        routes: { add: (route: Record<string, unknown>) => routes.push(route) },
        mcpTools: { add: () => undefined },
      });
      const route = routes.find((row) => row.path === "/compare/v1/employer")!;
      expect(route.exposure).toBe("operator");
      const sentinel = "private-renewal-row-sentinel";
      const body = structuredClone(base);
      body.group_quote.source.row_refs[0] = sentinel;
      let responseValue: unknown;
      const handler = route.handler as (context: unknown) => Promise<unknown>;
      await handler({
        header: () => undefined,
        req: { json: async () => structuredClone(body) },
        get: () => ({ signal: new AbortController().signal }),
        json: (value: unknown) => {
          responseValue = value;
          return value;
        },
        html: (value: unknown) => value,
      });
      expect(JSON.stringify(responseValue)).not.toContain('"input"');
      expect(JSON.stringify(logCalls)).not.toContain(sentinel);
    };
    await expect(contract()).rejects.toThrow();
  } finally {
    console.log = originalLog;
    await mutant.cleanup();
  }
});
