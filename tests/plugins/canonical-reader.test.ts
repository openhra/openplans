import { expect, it } from "vitest";
import type { SqlSession } from "../../src/db/database.js";
import { canonicalReader } from "../../src/plugins/canonical-reader.js";
import { runWithScope } from "../../src/plugins/request-scope.js";

// Synthetic catalog rows, including a leading-zero issuer and a nullable channel.
const id = "00123TX0010001";
const plan = {
  base_plan_id: id,
  plan_year: 2026,
  issuer_id: "00123",
  state: "TX",
  market: "Individual",
  dental_only: false,
  on_exchange: null,
  off_exchange: true,
  snapshot_id: "synthetic-snapshot",
  source_row: 7,
};
function database(generations = ["g1", "g1"], state = false) {
  const queries: string[] = [];
  let reads = 0;
  const db: SqlSession = {
    query: async <Row extends Record<string, unknown>>(sql: string) => {
      queries.push(sql);
      let rows: Record<string, unknown>[] = [];
      if (sql.includes("api_data_generation"))
        rows = [
          {
            generation: generations[Math.min(reads++, generations.length - 1)],
          },
        ];
      else if (sql.includes("JOIN plan p"))
        rows = [{ ...plan, state_catalog: state }];
      else if (sql.includes("FROM plan_variant"))
        rows = [{ snapshot_id: plan.snapshot_id, variant_plan_id: `${id}-01` }];
      return { rows: rows as Row[] };
    },
    exec: async () => {
      throw new Error("unexpected write");
    },
  };
  return { db, queries };
}
it("batch reads typed identities with generation, public facts, cancellation and request-only caching", async () => {
  const { db, queries } = database();
  await runWithScope(async (handle) => {
    const answer = await canonicalReader.plans(
      { plan_ids: [id, `${id}-01`], year: 2026 },
      { db, signal: new AbortController().signal },
    );
    expect(answer.plans[0]!.issuer_id).toBe("00123");
    expect(answer.plans[0]!.on_exchange).toBe(null);
    expect(answer.plans[1]!.id).toBe(`${id}-01`);
    expect(answer.plans[1]!.provenance.channel_granularity).toBe("base_plan");
    expect(Object.isFrozen(answer.plans[0]!.provenance)).toBe(true);
    expect(handle.level()).toBe("request");
  });
  expect(queries.filter((q) => q.includes("JOIN plan p"))).toHaveLength(1);
  expect(queries.filter((q) => q.includes("FROM plan_variant"))).toHaveLength(
    1,
  );
  const controller = new AbortController();
  controller.abort();
  await expect(
    canonicalReader.plans(
      { plan_ids: [id], year: 2026 },
      { db, signal: controller.signal },
    ),
  ).rejects.toThrow();
});
it("retries changed public generations and refuses continuing churn", async () => {
  const request = { plan_ids: [id], year: 2026 },
    signal = new AbortController().signal;
  const retry = database(["g1", "g2", "g2", "g2"]);
  expect(
    (await canonicalReader.plans(request, { db: retry.db, signal }))
      .catalog_generation,
  ).toBe("g2");
  const churn = database(["g1", "g2", "g3", "g4"]);
  await expect(
    canonicalReader.plans(request, { db: churn.db, signal }),
  ).rejects.toThrow("msot_catalog_changed");
  await expect(
    canonicalReader.plans(
      { ...request, plan_ids: Array(101).fill(id) as string[] },
      { db: churn.db, signal },
    ),
  ).rejects.toThrow();
});
it("does not certify state-filed exchange flags without evidence", async () => {
  const { db } = database(undefined, true);
  const answer = await canonicalReader.plans(
    { plan_ids: [id], year: 2026 },
    { db, signal: new AbortController().signal },
  );
  expect(answer.plans[0]!.on_exchange).toBe(null);
  expect(answer.plans[0]!.off_exchange).toBe(null);
});

it("requires a declared kind and refuses policy-provider collisions on every host", async () => {
  const { stagingRegistrar, emptyRegistries, emptySeen } =
    await import("../../src/plugins/registries.js");
  const spec = {
    resolve: async () => {
      throw new Error("not called");
    },
  };
  for (const host of ["api", "worker", "stdio"] as const) {
    const staging = emptyRegistries(),
      seen = emptySeen();
    const base = {
      name: "@synthetic/policy",
      version: "0.1.0",
      apiVersion: "0.2" as const,
    };
    const absent = stagingRegistrar(
      staging,
      { ...base, kinds: [] },
      host,
      seen,
    );
    expect(() =>
      absent.context.catalogPolicies!.provide("synthetic-policy", spec),
    ).toThrow("plugin_kind_undeclared");
    const enabled = stagingRegistrar(
      staging,
      { ...base, kinds: ["catalogPolicies"] },
      host,
      seen,
    );
    enabled.context.catalogPolicies!.provide("synthetic-policy", spec);
    expect(staging.catalogPolicies["synthetic-policy"]!.spec).toBe(spec);
    expect(() =>
      enabled.context.catalogPolicies!.provide("synthetic-policy", spec),
    ).toThrow("plugin_provider_collision");
    const invalid = stagingRegistrar(
      emptyRegistries(),
      { ...base, kinds: ["catalogPolicies"] },
      host,
      emptySeen(),
    );
    expect(() => invalid.context.catalogPolicies!.provide("", spec)).toThrow(
      "plugin_registration_invalid",
    );
    const closed = stagingRegistrar(
      emptyRegistries(),
      { ...base, kinds: ["catalogPolicies"] },
      host,
      emptySeen(),
    );
    closed.close();
    expect(() =>
      closed.context.catalogPolicies!.provide("synthetic-policy", spec),
    ).toThrow("Registries close");
  }
});
