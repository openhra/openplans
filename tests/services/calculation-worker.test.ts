import { withDataPolicy } from "../../src/services/data-window.js";
import { ReadError } from "../../src/services/errors.js";
import {
  afterAll,
  beforeAll,
  expect,
  it,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";
import { offerCohortInputSchema } from "@openplans/plugin-sdk";
import type { SqlSession } from "../../src/db/database.js";
import { CalculationWorker } from "../../src/services/calculation-executor.js";
import { createCalculationHost } from "../../src/plugins/calculation-host.js";
import { setup } from "../compat/v1/helpers.js";

let h: Awaited<ReturnType<typeof setup>>;
const worker = new CalculationWorker(
  new URL("../../dist/services/calculation-worker.js", import.meta.url),
);
const input = offerCohortInputSchema.parse({
  zip: "77002",
  county: "48201",
  year: 2026,
  age: 40,
  metal: "silver",
});
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
  await worker.start();
});
afterAll(async () => {
  await worker.close();
  await h?.close();
});

it("returns the same calculation bytes through the caller's reader and async context", async () => {
  const context = new AsyncLocalStorage<string>();
  let reads = 0;
  let jsonReads = 0;
  const reader: SqlSession = {
    ...h.db,
    query: <Row extends Record<string, unknown>>(
      sql: string,
      parameters?: unknown[],
      options?: Parameters<SqlSession["query"]>[2],
    ) => {
      expect(context.getStore()).toBe("synthetic caller");
      reads++;
      expect(options?.jsonAsText).toBe(true);
      return h.db.query<Row>(sql, parameters, options).then((result) => {
        // Synthetic driver transport keeps JSON strings opaque on the caller thread.
        const jsonColumns = [
          ...new Set(
            result.rows.flatMap((row) =>
              Object.keys(row).filter(
                (key) =>
                  row[key] !== null &&
                  typeof row[key] === "object" &&
                  !(row[key] instanceof Date),
              ),
            ),
          ),
        ];
        if (jsonColumns.length) jsonReads++;
        const rows = result.rows.map((row) => {
          const wire = { ...row };
          for (const key of jsonColumns)
            if (row[key] !== null)
              (wire as Record<string, unknown>)[key] = JSON.stringify(row[key]);
          return wire;
        });
        return { rows, jsonColumns, synthetic_driver_parser: () => {} };
      });
    },
  };
  const signal = new AbortController().signal;
  const expected = await createCalculationHost({
    public: { quoting: true, household: true, compat: true },
  }).enumerateHouseholdOffers(input, { db: h.db, signal });
  const actual = await context.run("synthetic caller", () =>
    worker.call("enumerateHouseholdOffers", input, { db: reader, signal }),
  );
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
  expect(reads).toBeGreaterThan(0);
  expect(jsonReads).toBeGreaterThan(0);
});

it("charges the caller's shared offer budget even when the calculation refuses", async () => {
  const budget = { remainingOffers: 1 };
  await expect(
    worker.call("enumerateHouseholdOffers", input, {
      db: h.db,
      signal: new AbortController().signal,
      budget,
    }),
  ).rejects.toThrow("work_budget_exceeded");
  expect(budget.remainingOffers).toBe(0);
});

it("cancels an active query and accepts the next calculation", async () => {
  const controller = new AbortController();
  let started = () => {};
  const ready = new Promise<void>((done) => {
    started = done;
  });
  const reason = new Error("synthetic cancellation");
  const reader: SqlSession = {
    async query() {
      started();
      return new Promise<never>((_resolve, reject) =>
        controller.signal.addEventListener("abort", () => reject(reason), {
          once: true,
        }),
      );
    },
    async exec() {},
  };
  const call = worker.call("enumerateHouseholdOffers", input, {
    db: reader,
    signal: controller.signal,
  });
  const cancelled = expect(call).rejects.toBe(reason);
  await ready;
  controller.abort(reason);
  await cancelled;
  expect(
    (
      await worker.call("enumerateHouseholdOffers", input, {
        db: h.db,
        signal: new AbortController().signal,
      })
    ).status,
  ).toBe("calculated");
});

it("returns the complete four-profile distribution and adjusted benchmarks in one worker job", async () => {
  const preset = {
    zip: "77002",
    county: "48201",
    year: 2026,
    preset: "family-40-40-10-8-v1" as const,
  };
  const options = { fourProfiles: true };
  const scope = { db: h.db, signal: new AbortController().signal };
  const expected = await createCalculationHost({
    public: { quoting: true, household: false, compat: false },
  }).householdDistributions!(preset, scope, options);
  const actual = await worker.call(
    "householdDistributions",
    preset,
    scope,
    options,
  );
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
  expect(actual.benchmarks).toHaveLength(4);
  for (const entry of actual.benchmarks as { result: { location: unknown } }[])
    expect(entry.result.location).not.toHaveProperty("members");
});

it.each(["household", "four profiles"])(
  "charges the shared offer budget for %s",
  async (kind) => {
    const household =
      kind === "four profiles"
        ? {
            zip: "77002",
            county: "48201",
            year: 2026,
            preset: "family-40-40-10-8-v1",
          }
        : {
            zip: "77002",
            county: "48201",
            year: 2026,
            members: [{ age: 40, relationship: "subscriber", tobacco: false }],
          };
    const budget = { remainingOffers: 1 };
    await expect(
      worker.call(
        "householdDistributions",
        household,
        {
          db: h.db,
          signal: new AbortController().signal,
          budget,
        },
        { fourProfiles: kind === "four profiles" },
      ),
    ).rejects.toThrow("work_budget_exceeded");
    expect(budget.remainingOffers).toBe(0);
  },
);

it("carries the annual mode, frozen clock and not-loaded dependency through the worker", async () => {
  const scope = { db: h.db, signal: new AbortController().signal };
  const old = { ...input, year: 2025 };
  const clock = new Date("2027-01-01T00:00:00Z");
  await expect(
    withDataPolicy(
      { historyYears: 3 },
      () => worker.call("enumerateHouseholdOffers", old, scope),
      clock,
    ),
  ).rejects.toMatchObject({
    error: {
      code: "not_loaded",
      required_year: 2025,
      domain: "individual",
      allowed_years: [2026, 2027],
    },
  });
  await expect(
    withDataPolicy(
      { historyYears: 3 },
      () => worker.call("enumerateHouseholdOffers", old, scope),
      clock,
    ),
  ).rejects.toBeInstanceOf(ReadError);
  const currentOnly = await withDataPolicy(
    { historyYears: 1 },
    () => worker.call("enumerateHouseholdOffers", old, scope),
    new Date("2025-11-19T00:00:00Z"),
  );
  expect(currentOnly).toMatchObject({ year: 2025, status: "unknown" });
});
