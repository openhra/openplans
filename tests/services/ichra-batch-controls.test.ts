import { withDataPolicy } from "../../src/services/data-window.js";
import {
  afterAll,
  beforeAll,
  expect,
  it,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import type * as Batch from "../../src/services/ichra-batch.js";
import type { SqlSession } from "../../src/db/database.js";
import type * as Validation from "../../src/api/validation.js";
import {
  censusRows,
  ichraAffordabilityBatch,
} from "../../src/services/ichra-batch.js";
import { ichraRequest } from "../../src/api/validation.js";
import { ichraAffordability as guardedIchraAffordability } from "../../src/services/ichra.js";
import { plantMutant } from "../../src/plugins/testing/index.js";
import { setup } from "../compat/v1/helpers.js";

// SYNTHETIC employee, real unmodified CMS fixture rows. Mutants live only in temporary copies.
const input = {
  plan_start: "2026-01-01",
  employee: { date_of_birth: "1985-10-01" },
  residence: { zip: "77002" },
  hra: { self_only_annual_cents: 312789 },
  income: [{ measure: "household", annual_cents: 4118923 }],
};
const batchInput = () => ({ rows: [{ row: 1, input }] });
const signal = () => new AbortController().signal;
const census = new URL("../../plugins/sdk/src/census-rows.ts", import.meta.url);
const service = new URL("../../src/services/ichra-batch.ts", import.meta.url);
const validation = new URL("../../src/api/validation.ts", import.meta.url);
let h: Awaited<ReturnType<typeof setup>>;
// Annual source fixtures use a fixed UTC calendar, independently of the machine date.
function fixtureClock() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-19T00:00:00Z"));
}
beforeAll(fixtureClock);
beforeEach(fixtureClock);
afterEach(() => vi.useRealTimers());
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => {
  await h?.close();
});

const employeeEqualityTest = (actual: unknown, expected: unknown) =>
  expect(JSON.stringify(actual), "employee equality test").toBe(
    JSON.stringify(expected),
  );
const logPrivacyTest = (logs: unknown) =>
  expect(JSON.stringify(logs), "log privacy test").not.toContain("4118923");
const batchSizeTest = (parse: typeof censusRows) =>
  expect(
    () =>
      parse({ rows: Array.from({ length: 26 }, () => ({ row: 1, input })) }),
    "batch size test",
  ).toThrow();
const identityFieldTest = (parse: typeof ichraRequest) =>
  expect(
    () =>
      parse({
        ...input,
        employee: { ...input.employee, name: "synthetic-identity" },
      }),
    "identity field test",
  ).toThrow();

it("batch size test kills a 26-row acceptance mutant", async () => {
  batchSizeTest(censusRows);
  const mutant = await plantMutant(
    census,
    "export const MAX_CENSUS_ROWS = 25;",
    "export const MAX_CENSUS_ROWS = 26;",
  );
  try {
    const module = (await import(mutant.path)) as {
      censusRows: typeof censusRows;
    };
    const oversized = {
      rows: Array.from({ length: 26 }, (_, index) => ({
        row: index + 1,
        input,
      })),
    };
    expect(module.censusRows(oversized)).toHaveLength(26);
    expect(() => batchSizeTest(module.censusRows)).toThrow("batch size test");
  } finally {
    await mutant.cleanup();
  }
});
it("identity field test kills an accepted employee-name mutant", async () => {
  identityFieldTest(ichraRequest);
  const mutant = await plantMutant(
    validation,
    'onlyFields(employee, ICHRA_FIELDS.employee, "employee.");',
    "void employee;",
  );
  try {
    const module = (await import(mutant.path)) as typeof Validation;
    expect(() => identityFieldTest(module.ichraRequest)).toThrow(
      "identity field test",
    );
  } finally {
    await mutant.cleanup();
  }
});
it("employee equality test kills a one-cent result mutant", async () => {
  const expected = await ichraAffordability(h.db, ichraRequest(input));
  const baseline = await ichraAffordabilityBatch(
    h.db,
    censusRows(batchInput()),
    signal(),
  );
  employeeEqualityTest(
    baseline.rows[0]!.status !== "invalid" && baseline.rows[0]!.result,
    expected,
  );
  const mutant = await plantMutant(
    service,
    'results.push({ ...base, status: result.status === "calculated" ? "calculated" : "unknown", result, });',
    'results.push({ ...base, status: result.status === "calculated" ? "calculated" : "unknown", result: { ...result, monthly_hra_cents: { ...result.monthly_hra_cents, numerator: result.monthly_hra_cents.numerator + result.monthly_hra_cents.denominator } } });',
  );
  try {
    const module = (await import(mutant.path)) as typeof Batch;
    const answer = await module.ichraAffordabilityBatch(
      h.db,
      module.censusRows(batchInput()),
      signal(),
    );
    expect(() =>
      employeeEqualityTest(
        answer.rows[0]!.status !== "invalid" && answer.rows[0]!.result,
        expected,
      ),
    ).toThrow("employee equality test");
  } finally {
    await mutant.cleanup();
  }
});
it("log privacy test kills a census-value logging mutant", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const mutant = await plantMutant(
    service,
    "const results: CensusRowResult[] = [];",
    "const results: CensusRowResult[] = []; console.log(JSON.stringify(rows));",
  );
  try {
    await ichraAffordabilityBatch(h.db, censusRows(batchInput()), signal());
    logPrivacyTest(log.mock.calls);
    const module = (await import(mutant.path)) as typeof Batch;
    await module.ichraAffordabilityBatch(
      h.db,
      module.censusRows(batchInput()),
      signal(),
    );
    expect(() => logPrivacyTest(log.mock.calls)).toThrow("log privacy test");
  } finally {
    log.mockRestore();
    await mutant.cleanup();
  }
});
it("operator market restriction test kills removal of the cheapest public plan", async () => {
  const expected = await ichraAffordability(h.db, ichraRequest(input));
  const cheapest = expected.lcsp?.plan_ids[0];
  expect(cheapest).toBeTruthy();
  const restricted: SqlSession = {
    ...h.db,
    query: async <T extends Record<string, unknown>>(
      sql: string,
      parameters?: unknown[],
    ) => {
      const answer = await h.db.query<T>(sql, parameters);
      return {
        rows: answer.rows.filter((row) => row.base_plan_id !== cheapest),
      };
    },
  };
  const answer = await ichraAffordabilityBatch(
    restricted,
    censusRows(batchInput()),
    signal(),
  );
  expect(() =>
    employeeEqualityTest(
      answer.rows[0]!.status !== "invalid" && answer.rows[0]!.result,
      expected,
    ),
  ).toThrow("employee equality test");
});

it("response byte cap refuses a complete answer instead of truncating rows", async () => {
  const mutant = await plantMutant(
    service,
    "export const MAX_CENSUS_RESPONSE_BYTES = 1_048_576;",
    "export const MAX_CENSUS_RESPONSE_BYTES = 100;",
  );
  try {
    const module = (await import(mutant.path)) as typeof Batch;
    await expect(
      module.ichraAffordabilityBatch(
        h.db,
        module.censusRows(batchInput()),
        signal(),
      ),
    ).rejects.toThrow("BATCH_RESPONSE_TOO_LARGE");
  } finally {
    await mutant.cleanup();
  }
});

it("employee equality test kills missing evidence and an invented verdict for unknown data", async () => {
  const expected = await ichraAffordability(h.db, ichraRequest(input));
  expect(expected.lcsp?.provenance).toBeTruthy();
  const missingEvidence = {
    ...expected,
    lcsp: { ...expected.lcsp, provenance: null },
  };
  expect(() => employeeEqualityTest(missingEvidence, expected)).toThrow(
    "employee equality test",
  );
  const unknown = await ichraAffordability(
    h.db,
    ichraRequest({ ...input, plan_start: "2027-01-01" }),
  );
  expect(unknown.status).toBe("unknown");
  expect(() =>
    employeeEqualityTest(
      { ...unknown, status: "calculated", verdicts: [{ affordable: false }] },
      unknown,
    ),
  ).toThrow("employee equality test");
});

function ichraAffordability(
  ...args: Parameters<typeof guardedIchraAffordability>
) {
  return withDataPolicy(
    { historyYears: 3 },
    () => guardedIchraAffordability(...args),
    new Date(`${args[1].planStart.slice(0, 4)}-11-19T00:00:00Z`),
  );
}
