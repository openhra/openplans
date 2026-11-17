import { afterAll, beforeAll, expect, it } from "vitest";
import type { SqlSession } from "../../src/db/database.js";
import { createMcpHttp } from "../../src/mcp/http.js";
import { withRequestDependencies } from "../../src/mcp/policy.js";
import { callLowestTool, callMarketSummaryTool } from "../../src/mcp/handy.js";
import { setup } from "../compat/v1/helpers.js";
import { post } from "./transport-helpers.js";
import { createResponseCache } from "../../src/api/cache/index.js";
import { MemoryCache } from "../../src/api/cache/store.js";
import { readFile } from "node:fs/promises";
import { importMutant, withMutantFile } from "../mutant-file.js";
import { replaceSyntax } from "../source-mutation.js";
import {
  premiumRateRows,
  premiumRateRowsForPlans,
} from "../../src/api/repository.js";
import { storedRate } from "../../src/services/premiums.js";

let fixture: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  fixture = await setup();
});
afterAll(async () => {
  await fixture?.close();
});
const input = { year: 2026, zip: "77002", county: "48201", age: 40 };

it("rate projection keeps all normalized age rows without decoding storage timestamps", async () => {
  const {
    rows: [key],
  } = await fixture.db.query<{
    snapshot_id: string;
    base_plan_id: string;
    rating_area_id: string;
  }>("SELECT snapshot_id,base_plan_id,rating_area_id FROM rate LIMIT 1");
  expect(key).toBeDefined();
  const { snapshot_id, base_plan_id, rating_area_id } = key!;
  const original = await fixture.db.query(
    `SELECT *,effective_date::text AS effective_date,expiration_date::text AS expiration_date
     FROM rate WHERE snapshot_id=$1 AND base_plan_id=$2 AND rating_area_id=$3`,
    [snapshot_id, base_plan_id, rating_area_id],
  );
  const expected = original.rows
    .map(storedRate)
    .sort(
      (a, b) => a.provenance.sourceRowNumber - b.provenance.sourceRowNumber,
    );
  expect(expected.length).toBeGreaterThan(1);
  for (const result of [
    await premiumRateRows(
      fixture.db,
      snapshot_id,
      base_plan_id,
      rating_area_id,
    ),
    await premiumRateRowsForPlans(
      fixture.db,
      snapshot_id,
      [base_plan_id],
      rating_area_id,
    ),
  ]) {
    expect(
      result.rows
        .map(storedRate)
        .sort(
          (a, b) => a.provenance.sourceRowNumber - b.provenance.sourceRowNumber,
        ),
    ).toEqual(expected);
    for (const row of result.rows) {
      expect(Object.values(row).some((value) => value instanceof Date)).toBe(
        false,
      );
      expect(row).not.toHaveProperty("created_at");
      expect(row).not.toHaveProperty("record_ttl");
    }
  }
  expect(
    (
      await premiumRateRows(
        fixture.db,
        snapshot_id,
        "synthetic-absent",
        rating_area_id,
      )
    ).rows,
  ).toEqual([]);
  expect(
    (await premiumRateRowsForPlans(fixture.db, snapshot_id, [], rating_area_id))
      .rows,
  ).toEqual([]);
});

it.each([
  ["get_lowest_premiums", callLowestTool],
  ["get_market_summary", callMarketSummaryTool],
] as const)(
  "%s uses one SQL scope and keeps the adapter's bytes",
  async (name, call) => {
    let scopes = 0;
    const db: SqlSession = {
      query: async () => {
        throw new Error("Unscoped SQL");
      },
      exec: async () => {
        throw new Error("Unscoped SQL");
      },
      withRequest: async (signal, run) => {
        signal.throwIfAborted();
        scopes++;
        return run(fixture.db);
      },
    };
    const app = createMcpHttp(db, {
      env: { OPENPLANS_LOWEST_PREMIUMS: "on" },
      log: () => {},
    });
    const response = await app.fetch(
      post("tools/call", { name, arguments: input }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: {
        isError?: boolean;
        structuredContent: { status: string };
        content: unknown;
      };
    };
    expect(body.result.isError).not.toBe(true);
    expect(body.result.structuredContent.status).toBe("calculated");
    expect(scopes).toBe(1);
    const expected = await call(
      { db: fixture.db, lowestPremiums: true },
      input,
    );
    expect(JSON.stringify(body.result.structuredContent)).toBe(
      JSON.stringify(expected.structuredContent),
    );
    expect(body.result.content).toEqual(expected.content);
  },
);

it("single-age MCP reuses only generation-checked public cells", async () => {
  const store = new MemoryCache(2 * 1024 * 1024);
  const cache = createResponseCache(fixture.db, undefined, { store });
  const deps = { db: fixture.db, lowestPremiums: true, cache };
  const first = await callLowestTool(deps, input);
  const keys = store
    .keys()
    .filter((key) => key.startsWith("openplans:lowest:"));
  expect(keys).toHaveLength(1);
  const second = await callLowestTool(deps, input);
  expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  // A planted stale manifest must be rejected, even under the otherwise correct cache key.
  const stale = JSON.parse((await store.get(keys[0]!))!) as {
    provenance: { input_manifest: string };
    lowest: { monthly_cents: number };
  };
  stale.provenance.input_manifest = "synthetic-stale-manifest";
  stale.lowest.monthly_cents = 1;
  await store.set(keys[0]!, JSON.stringify(stale), 30);
  expect(JSON.stringify(await callLowestTool(deps, input))).toBe(
    JSON.stringify(first),
  );
  const before = store.keys();
  await callLowestTool(
    {
      ...deps,
      principal: { id: "synthetic" },
      policy: { canEstimate: () => true },
    },
    {
      year: 2026,
      zip: "77002",
      county: "48201",
      members: [{ age: 40, relationship: "subscriber", tobacco: false }],
    },
  );
  expect(store.keys()).toEqual(before);
});

it("one pricing scope retains the background session and rejects work after cancellation", async () => {
  const controller = new AbortController();
  let scopes = 0;
  const background = fixture.db;
  const db: SqlSession = {
    ...fixture.db,
    withRequest: async (signal, run) => {
      scopes++;
      expect(signal.aborted).toBe(false);
      return run({ ...fixture.db, background });
    },
  };
  await withRequestDependencies({ db }, controller.signal, async (deps) => {
    expect(deps.db.background).toBe(background);
    await deps.db.query("SELECT 1");
    controller.abort();
    await expect(deps.db.query("SELECT 2")).rejects.toThrow();
  });
  expect(scopes).toBe(1);
});

it.each([false, true])(
  "pricing delegates prototype methods on a provider session, scoped=%s",
  async (scoped) => {
    class ProviderSession implements SqlSession {
      queries = 0;
      executions = 0;
      async query<Row extends Record<string, unknown>>() {
        this.queries++;
        return { rows: [] as Row[] };
      }
      async exec() {
        this.executions++;
      }
    }
    const session = new ProviderSession();
    const db: SqlSession = scoped
      ? {
          ...fixture.db,
          withRequest: (_signal, run) => run(session),
        }
      : session;
    await withRequestDependencies(
      { db },
      new AbortController().signal,
      async (deps) => {
        await deps.db.query("SELECT synthetic_provider()");
        await deps.db.exec("SELECT synthetic_provider()");
      },
    );
    expect(session.queries).toBe(2);
    expect(session.executions).toBe(0);
  },
);

it.each(["get_lowest_premiums", "get_market_summary"])(
  "%s cancels an in-flight SQL scope on disconnect",
  async (name) => {
    const controller = new AbortController();
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    let cancelled = 0;
    const db: SqlSession = {
      ...fixture.db,
      withRequest: async (signal, run) =>
        run({
          ...fixture.db,
          query: async () => {
            started();
            await new Promise((_, reject) =>
              signal.addEventListener(
                "abort",
                () => {
                  cancelled++;
                  reject(new Error("Synthetic cancelled query"));
                },
                { once: true },
              ),
            );
            return { rows: [] };
          },
        }),
    };
    const app = createMcpHttp(db, {
      env: { OPENPLANS_LOWEST_PREMIUMS: "on" },
      log: () => {},
    });
    const response = app.fetch(
      new Request(post("tools/call", { name, arguments: input }), {
        signal: controller.signal,
      }),
    );
    await waiting;
    controller.abort();
    expect((await response).status).toBe(504);
    expect(cancelled).toBe(1);
  },
);

it("negative control: per-query scopes fail the bounded SQL work assertion", async () => {
  const check = async (run: typeof withRequestDependencies) => {
    let scopes = 0;
    const db: SqlSession = {
      ...fixture.db,
      withRequest: async (_signal, use) => {
        scopes++;
        return use(fixture.db);
      },
    };
    await run({ db }, new AbortController().signal, async (deps) => {
      await deps.db.query("SELECT 1");
      await deps.db.query("SELECT 2");
    });
    expect(scopes).toBe(1);
  };
  await check(withRequestDependencies);
  const source = new URL("../../src/mcp/policy.ts", import.meta.url);
  await withMutantFile(
    source,
    replaceSyntax(
      await readFile(source, "utf8"),
      "? deps.db.withRequest(deadline, invoke)",
      "? invoke(deps.db)",
    ),
    async (url) => {
      const mutant = await importMutant<{
        withRequestDependencies: typeof withRequestDependencies;
      }>(url, "withRequestDependencies");
      await expect(check(mutant.withRequestDependencies)).rejects.toThrow();
    },
  );
});
