import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { nativeRoutes } from "../../src/api/routes.js";
import type { SqlSession } from "../../src/db/database.js";

// Synthetic request inputs. The session blocks before reading any plan data.
const cases = [
  ["/quotes", { year: 2026, zip: "00987", members: [{ age: 35 }] }],
  [
    "/premium-quotes",
    {
      plan_ids: ["00000TX0000000"],
      zip: "00987",
      coverage_start: "2026-01-01",
      members: [{ age: 35, tobacco: false, relationship: "subscriber" }],
    },
  ],
  ["/benchmark?year=2026&zip=00987&ages=35", undefined],
  [
    "/ichra/affordability",
    {
      plan_start: "2026-01-01",
      employee: { date_of_birth: "1985-10-01" },
      residence: { zip: "00987" },
      hra: { self_only_annual_cents: 300_000 },
      income: [{ measure: "household", annual_cents: 4_118_000 }],
    },
  ],
] as const;

it.each(cases)(
  "disconnect cancels in-flight SQL for %s",
  async (path, body) => {
    const controller = new AbortController();
    let observed: AbortSignal | undefined;
    let cancelled = false;
    let queries = 0;
    const unexpected = async () => {
      throw new Error("SQL escaped request scope");
    };
    const db: SqlSession = {
      query: unexpected,
      exec: unexpected,
      async withRequest(signal, run) {
        observed = signal;
        return run({
          exec: unexpected,
          query: async () => {
            queries++;
            await new Promise<never>((_resolve, reject) => {
              const cancel = () => {
                cancelled = true;
                reject(new Error("synthetic SQL cancelled"));
              };
              if (signal.aborted) cancel();
              else signal.addEventListener("abort", cancel, { once: true });
            });
            return { rows: [] };
          },
        });
      },
    };
    const app = nativeRoutes(db, {
      publicQuoting: true,
      publicHousehold: true,
    });
    const work = app.fetch(
      new Request("http://localhost" + path, {
        method: body ? "POST" : "GET",
        headers: { "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      }),
    );
    await vi.waitFor(() => expect(queries).toBe(1));
    controller.abort();
    await setImmediate();
    expect(observed?.aborted).toBe(true);
    expect(cancelled).toBe(true);
    expect((await work).status).toBe(504);
    expect(queries).toBe(1);
  },
);
