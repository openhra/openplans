import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { planResponse } from "../../../src/compat/v1/mapping.js";
import { countyDisplayNames } from "../../../src/compat/v1/geography.js";
import type { SqlSession } from "../../../src/db/database.js";
import { BASE, headers, searchBody, setup } from "./helpers.js";
import { assertShape } from "./shape.js";

let h: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => {
  await h?.close();
});

const search = async (extra = {}) => {
  const response = await h.app.request(`${BASE}/plans/medical/search`, {
    method: "POST",
    headers,
    body: JSON.stringify(searchBody({ ids: ["87226TX0100013"], ...extra })),
  });
  expect(response.status).toBe(200);
  return { response, body: (await response.json()) as any };
};

function planContract(plan: any) {
  assertShape(
    {
      id: "synthetic-shape-only",
      premium: 0,
      premium_subsidized: null,
      networks: [],
      source: "cms_puf",
      premium_source: "cms_puf",
    },
    plan,
  );
  assert.equal(plan.premium_subsidized, null);
  assert.ok(Object.hasOwn(plan, "premium_subsidized"));
  assert.equal(plan.source, "cms_puf");
  assert.equal(plan.premium_source, "cms_puf");
  assert.ok(
    [null, "both", "both_markets", "on_market", "off_market"].includes(
      plan.plan_market,
    ),
  );
  assert.deepEqual(plan.providers, []);
  for (const key of [
    "plan_key",
    "hios_id",
    "hios_candidates",
    "hios_match_provenance",
  ])
    assert.ok(!Object.hasOwn(plan, key));
}

it("preserves nullable fields and existing federal wire fields without inventing coverage", async () => {
  const { response, body } = await search();
  planContract(body.plans[0]);
  expect(body.plans[0].premium).toBe(529.28);
  expect(response.headers.get("Link")).toContain("/v1/plans");
  const expanded = await search({ providers: [{ npi: "1000000000" }] });
  expect(expanded.body.plans[0].providers).toEqual([]);
  expect(expanded.body.coverages).toEqual([]);
  expect(expanded.response.headers.get("x-openplans-gaps")).toContain(
    "provider_and_drug_coverage_unavailable",
  );
  const drugOnly = await search({ drug_packages: [] });
  expect(drugOnly.body.plans[0].providers).toEqual([]);
});

it("negative controls: a renamed field, null-to-absent swap, and wrong source enum fail the same contract", async () => {
  const { body } = await search();
  const original = body.plans[0];
  planContract(original);
  const renamed = structuredClone(original);
  renamed.premium_amount = renamed.premium;
  delete renamed.premium;
  expect(() => planContract(renamed)).toThrow("premium");
  const absent = structuredClone(original);
  delete absent.premium_subsidized;
  expect(() => planContract(absent)).toThrow("premium_subsidized");
  const wrongEnum = structuredClone(original);
  wrongEnum.source = "synthetic-unsupported-feed";
  expect(() => planContract(wrongEnum)).toThrow();
});

it("keeps state feeds unknown and audit details native without changing premiums or identity", () => {
  const native = {
    id: "synthetic-native-key",
    source: "state_filed_tier",
    premium_source: "state_filed_tier",
    on_market: null,
    off_market: null,
    plan_market: null,
    premium: 123.45,
    premium_subsidized: null,
    premiums_by_applicant: [],
    plan_key: "synthetic-native-key",
    hios_id: null,
    hios_match: "unmatched",
    hios_candidates: [],
    hios_match_provenance: { source: "synthetic" },
  };
  const output = planResponse(native);
  expect(output).toEqual({
    id: native.id,
    source: null,
    premium_source: null,
    on_market: null,
    off_market: null,
    plan_market: null,
    premium: 123.45,
    premium_subsidized: null,
    premiums_by_applicant: [],
    plan_key: native.plan_key,
    hios_id: null,
    hios_match: "unmatched",
  });
  expect(native.hios_match).toBe("unmatched");
  expect(
    planResponse({ plan_market: "both", on_market: true, off_market: true })
      .plan_market,
  ).toBe("both");
  expect(planResponse({ plan_market: "on_market" }).plan_market).toBe(
    "on_market",
  );
  expect(planResponse({ plan_market: "off_market" }).plan_market).toBe(
    "off_market",
  );
  expect(Object.hasOwn(planResponse({}), "source")).toBe(false);
  expect(Object.hasOwn(planResponse({ source: null }), "source")).toBe(true);
  expect(planResponse({ providers: null })).toEqual({ providers: null });
  expect(Object.hasOwn(planResponse({}), "providers")).toBe(false);
});

it("keeps public identity labels and complete provenance accessible on the native detail", async () => {
  const { body } = await search();
  const response = await h.app.request("/v1/plans/87226TX0100013?year=2026");
  expect(response.status).toBe(200);
  const native = (await response.json()) as any;
  expect(body.plans[0].carrier_name).toBe(native.issuer.marketing_names[0]);
  expect(body.plans[0].networks.map((n: any) => n.name)).toEqual(
    native.network.records.map((n: any) => n.network_name),
  );
  expect(native.provenance.snapshot_ids).toBeTruthy();
  expect(native.network.records[0].snapshot_id).toBeTruthy();
  expect(native.cost_sharing.selected_variant_id).toBeTruthy();
});

it("uses verified retained Census labels outside loaded county rows and rejects a corrupted snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openplans-county-labels-"));
  try {
    const bytes = await readFile(
      new URL("../../fixtures/geo/zcta-county-tx.psv", import.meta.url),
    );
    const path = join(directory, "public-county-cut.psv");
    await writeFile(path, bytes);
    const snapshot = {
      raw_path: path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      compressed_bytes: String(bytes.length),
    };
    const db = {
      query: async (sql: string) => ({
        rows: sql.includes("FROM snapshot") ? [snapshot] : [],
      }),
    } as unknown as SqlSession;
    expect((await countyDisplayNames(db, ["48201"])).get("48201")).toBe(
      "Harris County",
    );
    expect((await countyDisplayNames(db, ["99999"])).has("99999")).toBe(false);
    await writeFile(
      path,
      Buffer.from(bytes.toString().replace("Harris County", "Harris Xounty")),
    );
    await expect(countyDisplayNames(db, ["48201"])).rejects.toThrow(
      "hash mismatch",
    );
    // Missing raw mounts must retain honest fallbacks, never guess a legal suffix.
    await rm(path);
    expect((await countyDisplayNames(db, ["48201"])).size).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
