import type { RateRow } from "../../src/domain/rating/types.js";
import { createCalculationHost } from "../../src/plugins/calculation-host.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { CalculationQueue } from "../../src/services/calculation-queue.js";
import { expect, it } from "vitest";
import { setTimeout, setImmediate } from "node:timers/promises";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { SqlSession } from "../../src/db/database.js";
import { ratePremium } from "../../src/services/premiums.js";
import { requestReads } from "../../src/services/request-reads.js";
import { rebaseImports, replaceSyntax } from "../source-mutation.js";

async function yieldsBeforeRating(rate: typeof ratePremium) {
  let turn = false;
  let observed = false;
  const stopped = new Error("synthetic database stop");
  const db: SqlSession = {
    async query() {
      observed = turn;
      throw stopped;
    },
    async exec() {},
  };
  void setImmediate().then(() => {
    turn = true;
  });
  const args: Parameters<typeof ratePremium> = [
    db,
    {
      state: "TX",
      plan_year: 2026,
      market: "Individual",
      dental_only: false,
      base_plan_id: "synthetic",
      issuer_id: "synthetic",
      metal: "silver",
      plan_name: "Synthetic scheduling plan",
      network_id: "synthetic",
      service_area_id: "synthetic",
      on_exchange: true,
      off_exchange: false,
      snapshot_id: "synthetic",
      source_row: 2,
    },
    "synthetic",
    // The synthetic reader throws before these inputs can be used.
    {} as Parameters<typeof ratePremium>[3],
    {} as Parameters<typeof ratePremium>[4],
  ];
  await expect(rate(...args)).rejects.toBe(stopped);
  await setTimeout(1);
  expect(observed, "rating must let the pending event-loop turn run").toBe(
    true,
  );
}

async function boundedReads(factory: typeof requestReads) {
  // Synthetic rows exercise scheduling and grouping, not premium amounts.
  const plans = Array.from({ length: 25 }, (_, i) => ({
    base_plan_id: `synthetic-${i}`,
    snapshot_id: "synthetic",
  }));
  const batches: string[][] = [];
  const db: SqlSession = {
    async query<Row extends Record<string, unknown>>(
      _sql: string,
      parameters?: unknown[],
    ) {
      const bases = parameters![1] as string[];
      batches.push([...bases]);
      return {
        rows: bases.flatMap((base) => [
          { base_plan_id: base, source_row: 2, raw: {} },
          { base_plan_id: base, source_row: 3, raw: {} },
        ]) as unknown as Row[],
      };
    },
    async exec() {},
  };
  const reads = factory(db, 4);
  reads.plan(plans);
  // Start outside the first sorted batch, then visit every plan in reverse order.
  for (const plan of [...plans].reverse()) {
    const rates = await reads.rateRows("synthetic", plan.base_plan_id, "area");
    expect(rates.rows.map((row) => [row.base_plan_id, row.source_row])).toEqual(
      [
        [plan.base_plan_id, 2],
        [plan.base_plan_id, 3],
      ],
    );
    expect(
      (await reads.exchangeAttributes(plan)).rows.map((row) => row.source_row),
    ).toEqual([2, 3]);
  }
  expect(
    batches.every((bases) => bases.length <= 4),
    "raw row decoding batches must be bounded",
  ).toBe(true);
  expect(batches).toHaveLength(14);
  const count = batches.length;
  await reads.rateRows("synthetic", plans[0]!.base_plan_id, "area");
  await reads.exchangeAttributes(plans[0]!);
  expect(batches).toHaveLength(count);
}

async function mutant<T>(
  file: string,
  from: string,
  to: string,
  check: (module: T) => Promise<void>,
) {
  const url = new URL(file, import.meta.url);
  const source = replaceSyntax(await readFile(url, "utf8"), from, to);
  const directory = await mkdtemp(
    join(process.cwd(), "node_modules/.event-loop-control-"),
  );
  try {
    const path = join(directory, "mutant.ts");
    await writeFile(path, rebaseImports(source, url));
    await check((await import(pathToFileURL(path).href)) as T);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

it("lets cheap work run before rating another plan", async () =>
  yieldsBeforeRating(ratePremium));
it("bounds raw row batches without losing or reordering plan rows", async () =>
  boundedReads(requestReads));
it("rejects a microtask-only yield mutant", async () => {
  await mutant<{ ratePremium: typeof ratePremium }>(
    "../../src/services/premiums.ts",
    "await setImmediate();",
    "await Promise.resolve();",
    async (changed) => {
      await expect(yieldsBeforeRating(changed.ratePremium)).rejects.toThrow(
        "pending event-loop turn",
      );
    },
  );
});
it("rejects an unbounded decoding batch mutant", async () => {
  await mutant<{ requestReads: typeof requestReads }>(
    "../../src/services/request-reads.ts",
    "bases.length >= batchSize",
    "false",
    async (changed) => {
      await expect(boundedReads(changed.requestReads)).rejects.toThrow(
        "decoding batches must be bounded",
      );
    },
  );
});

async function boundedQueue(Queue: typeof CalculationQueue) {
  const queue = new Queue();
  const signal = new AbortController().signal;
  let release = () => {};
  const blocked = new Promise<void>((done) => {
    release = done;
  });
  const order: number[] = [];
  const jobs = [
    queue.run(signal, () => blocked),
    ...Array.from({ length: 8 }, (_, index) =>
      queue.run(signal, async () => {
        order.push(index);
      }),
    ),
  ];
  let refusal: string | undefined;
  const overflow = queue
    .run(signal, async () => {})
    .then(
      () => {
        refusal = "accepted";
      },
      (error: Error) => {
        refusal = error.message;
      },
    );
  try {
    await setTimeout(1);
    expect(refusal, "bounded queue must refuse excess work").toBe(
      "calculation_queue_full",
    );
  } finally {
    release();
    await Promise.all([...jobs, overflow]);
  }
  expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
}

it("serializes calculations with a bounded FIFO queue", async () =>
  boundedQueue(CalculationQueue));
it("drops cancelled queued work and releases the next calculation after failure", async () => {
  const queue = new CalculationQueue();
  const controller = new AbortController();
  let release = () => {};
  const blocked = new Promise<void>((done) => {
    release = done;
  });
  const first = queue.run(new AbortController().signal, () => blocked);
  let ran = false;
  const cancelled = queue.run(controller.signal, async () => {
    ran = true;
  });
  const cancellation = expect(cancelled).rejects.toThrow("synthetic cancel");
  controller.abort(new Error("synthetic cancel"));
  await cancellation;
  const failed = queue.run(new AbortController().signal, async () => {
    throw new Error("synthetic calculation failure");
  });
  const failure = expect(failed).rejects.toThrow(
    "synthetic calculation failure",
  );
  const next = queue.run(new AbortController().signal, async () => "available");
  release();
  await first;
  await failure;
  expect(await next).toBe("available");
  expect(ran).toBe(false);
});
it("rejects an unbounded queue mutant", async () => {
  await mutant<{ CalculationQueue: typeof CalculationQueue }>(
    "../../src/services/calculation-queue.ts",
    "this.waiting.length >= 8",
    "this.waiting.length >= Infinity",
    async (changed) => {
      await expect(boundedQueue(changed.CalculationQueue)).rejects.toThrow(
        "bounded queue must refuse excess work",
      );
    },
  );
});

async function requestContext(Queue: typeof CalculationQueue) {
  const context = new AsyncLocalStorage<string>();
  const queue = new Queue();
  const signal = new AbortController().signal;
  let release = () => {};
  const blocked = new Promise<void>((done) => {
    release = done;
  });
  const first = context.run("first", () => queue.run(signal, () => blocked));
  const second = context.run("second", () =>
    queue.run(signal, async () => context.getStore()),
  );
  release();
  await first;
  expect(await second, "queued caller context must survive").toBe("second");
}

it("retains each queued caller's asynchronous request context", async () =>
  requestContext(CalculationQueue));
it("rejects a lost request-context mutant", async () => {
  await mutant<{ CalculationQueue: typeof CalculationQueue }>(
    "../../src/services/calculation-queue.ts",
    "AsyncLocalStorage.snapshot()",
    "((run: () => void) => run())",
    async (changed) => {
      await expect(requestContext(changed.CalculationQueue)).rejects.toThrow(
        "queued caller context",
      );
    },
  );
});

it("shares one calculation limit across plugin hosts and keeps their readers", async () => {
  const settings = { public: { quoting: true, household: true, compat: true } };
  const firstHost = createCalculationHost(settings);
  const secondHost = createCalculationHost(settings);
  let release = () => {};
  const blocked = new Promise<void>((done) => {
    release = done;
  });
  const firstError = new Error("synthetic first reader");
  const secondError = new Error("synthetic second reader");
  let secondRead = false;
  const firstDb: SqlSession = {
    async query() {
      await blocked;
      throw firstError;
    },
    async exec() {},
  };
  const secondDb: SqlSession = {
    async query() {
      secondRead = true;
      throw secondError;
    },
    async exec() {},
  };
  const input = {
    zip: "77002",
    county: "48201",
    year: 2026,
    preset: "family-40-40-10-8-v1" as const,
  };
  const first = expect(
    firstHost.householdDistributions!(input, {
      db: firstDb,
      signal: new AbortController().signal,
    }),
  ).rejects.toBe(firstError);
  const second = expect(
    secondHost.householdDistributions!(input, {
      db: secondDb,
      signal: new AbortController().signal,
    }),
  ).rejects.toBe(secondError);
  try {
    await setTimeout(1);
    expect(secondRead).toBe(false);
  } finally {
    release();
  }
  await Promise.all([first, second]);
  expect(secondRead).toBe(true);
});

async function sharedDecodedRates(factory: typeof requestReads) {
  const db: SqlSession = {
    async query<Row extends Record<string, unknown>>() {
      return { rows: [{ synthetic: true }] as unknown as Row[] };
    },
    async exec() {},
  };
  let decodes = 0;
  const decode = (row: Record<string, unknown>) => {
    decodes++;
    return row as unknown as RateRow;
  };
  const reads = factory(db, 4);
  const first = await reads.parsedRateRows(
    "snapshot-a",
    "plan-a",
    "area-a",
    decode,
  );
  for (let tier = 0; tier < 4; tier++)
    expect(
      await reads.parsedRateRows("snapshot-a", "plan-a", "area-a", decode),
    ).toBe(first);
  expect(decodes, "one decode per plan and area per request").toBe(1);
  await reads.parsedRateRows("snapshot-b", "plan-a", "area-a", decode);
  await reads.parsedRateRows("snapshot-a", "plan-b", "area-a", decode);
  await reads.parsedRateRows("snapshot-a", "plan-a", "area-b", decode);
  await factory(db, 4).parsedRateRows("snapshot-a", "plan-a", "area-a", decode);
  expect(decodes).toBe(5);
}
it("shares decoded rates across tiers, separating snapshots, plans, areas and requests", async () =>
  sharedDecodedRates(requestReads));
it("rejects a mutant that decodes again for every household tier", async () => {
  await mutant<{ requestReads: typeof requestReads }>(
    "../../src/services/request-reads.ts",
    "const key = JSON.stringify([snapshotId, base, area]);",
    "const key = JSON.stringify([snapshotId, base, area]) + parsedRates.size;",
    async (changed) => {
      await expect(sharedDecodedRates(changed.requestReads)).rejects.toThrow();
    },
  );
});
