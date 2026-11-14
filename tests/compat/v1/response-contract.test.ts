import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  mapPlan,
  mapQuote,
  planResponse,
} from "../../../src/compat/v1/mapping.js";
import { countyDisplayNames } from "../../../src/compat/v1/geography.js";
import type { SqlSession } from "../../../src/db/database.js";
import { BASE, headers, searchBody, setup, TOKEN } from "./helpers.js";
import { assertShape } from "./shape.js";

let h: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => {
  await h?.close();
});

interface WirePlan extends Record<string, unknown> {
  networks: { name: string; provider_directory_url?: string | null }[];
}

const search = async (extra = {}) => {
  const response = await h.app.request(`${BASE}/plans/medical/search`, {
    method: "POST",
    headers,
    body: JSON.stringify(searchBody({ ids: ["87226TX0100013"], ...extra })),
  });
  expect(response.status).toBe(200);
  return {
    response,
    body: (await response.json()) as {
      coverages: unknown[];
      plans: WirePlan[];
    },
  };
};

function planContract(plan: Record<string, unknown>) {
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
    (
      [null, "both", "both_markets", "on_market", "off_market"] as unknown[]
    ).includes(plan.plan_market),
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

function wirePlanContract(value: unknown) {
  assert.ok(value !== null && typeof value === "object");
  const plan = value as Record<string, unknown>;
  assertShape(
    {
      id: "synthetic-shape-only",
      premium: 0,
      premium_subsidized: null,
      networks: [
        { id: null, name: "synthetic network", provider_directory_url: null },
      ],
      carrier: {
        id: null,
        issuer_id: "synthetic issuer",
        name: null,
        logo_url: null,
      },
      source: "cms",
      premium_source: "cms",
    },
    plan,
  );
  assert.equal(plan.premium_subsidized, null);
  assert.ok(Object.hasOwn(plan, "premium_subsidized"));
  // CMS publications use the wire enum, while native provenance retains cms_puf.
  assert.equal(plan.source, "cms");
  assert.equal(plan.premium_source, "cms");
  assert.ok(
    plan.plan_market === null ||
      (typeof plan.plan_market === "string" &&
        ["both_markets", "on_market", "off_market"].includes(plan.plan_market)),
  );
  assert.ok(!Object.hasOwn(plan, "providers"));
  for (const key of [
    "plan_key",
    "hios_id",
    "hios_candidates",
    "hios_match_provenance",
  ])
    assert.ok(!Object.hasOwn(plan, key));
}

it("keeps the native intermediate contract before applying the final wire vocabulary", async () => {
  const id = "87226TX0100013";
  const detail = await h.app.request(`/v1/plans/${id}?year=2026`);
  expect(detail.status).toBe(200);
  const view = (await detail.json()) as Parameters<typeof mapPlan>[0];
  const response = await h.app.request("/v1/premium-quotes", {
    method: "POST",
    headers: { ...headers, authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      plan_ids: [id],
      county: "48201",
      coverage_start: "2026-01-01",
      members: [{ age: 35, tobacco: false, relationship: "subscriber" }],
    }),
  });
  expect(response.status).toBe(200);
  const quote = (await response.json()) as {
    quotes: Parameters<typeof mapQuote>[0][];
  };
  // Source and coverage vocabulary change only at the final wire boundary.
  planContract({ ...mapPlan(view, id), ...mapQuote(quote.quotes[0]!) });
});

it("preserves nullable federal fields and omits a plan-level coverage extension", async () => {
  const { response, body } = await search();
  wirePlanContract(body.plans[0]);
  expect(body.plans[0]!.premium).toBe(529.28);
  expect(response.headers.get("Link")).toContain("/v1/plans");
  const expanded = await search({ providers: [{ npi: "1000000000" }] });
  expect(Object.hasOwn(expanded.body.plans[0]!, "providers")).toBe(false);
  expect(expanded.body.coverages).toEqual([]);
  expect(expanded.response.headers.get("x-openplans-gaps")).toContain(
    "provider_and_drug_coverage_unavailable",
  );
  const drugOnly = await search({ drug_packages: [] });
  expect(Object.hasOwn(drugOnly.body.plans[0]!, "providers")).toBe(false);
});

it("negative controls: a renamed field, null-to-absent swap, wrong enum and wrong nesting fail the same contract", async () => {
  const { body } = await search();
  const original = body.plans[0]!;
  wirePlanContract(original);
  const renamed = structuredClone(original);
  renamed.premium_amount = renamed.premium;
  delete renamed.premium;
  expect(() => wirePlanContract(renamed)).toThrow("premium");
  const absent = structuredClone(original);
  delete absent.premium_subsidized;
  expect(() => wirePlanContract(absent)).toThrow("premium_subsidized");
  const wrongEnum = structuredClone(original);
  wrongEnum.source = "synthetic-unsupported-feed";
  expect(() => wirePlanContract(wrongEnum)).toThrow();
  const wrongNesting: Record<string, unknown> = structuredClone(original);
  wrongNesting.networks = { networks: wrongNesting.networks };
  expect(() => wirePlanContract(wrongNesting)).toThrow("expected array");
  const wrongMarket = structuredClone(original);
  wrongMarket.plan_market = "both";
  expect(() => wirePlanContract(wrongMarket)).toThrow();
  const wrongSource = structuredClone(original);
  wrongSource.source = "carrier";
  expect(() => wirePlanContract(wrongSource)).toThrow();
});

it("maps state source enums and keeps audit details native without changing premiums or identity", () => {
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
    // A filed state source has the state wire enum; exchange availability stays unknown.
    source: "state",
    premium_source: "state",
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
  expect(native.source).toBe("state_filed_tier");
  expect(native.premium_source).toBe("state_filed_tier");
  expect(
    planResponse({ plan_market: "both", on_market: true, off_market: true })
      .plan_market,
  ).toBe("both_markets");
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
  const emptyProviders = { providers: [] };
  expect(planResponse(emptyProviders)).toEqual({});
  expect(emptyProviders).toEqual({ providers: [] });
  expect(
    planResponse({ source: "cms_puf", premium_source: "cms_puf" }),
  ).toEqual({
    source: "cms",
    premium_source: "cms",
  });
  expect(planResponse({ source: "carrier", premium_source: "cms" })).toEqual({
    source: "carrier",
    premium_source: "cms",
  });
});

it("keeps public identity labels and complete provenance accessible on the native detail", async () => {
  const { body } = await search();
  const response = await h.app.request("/v1/plans/87226TX0100013?year=2026");
  expect(response.status).toBe(200);
  const native = (await response.json()) as {
    issuer: { marketing_names: string[] };
    network: { records: { network_name: string; snapshot_id: string }[] };
    provenance: { snapshot_ids: unknown };
    cost_sharing: { selected_variant_id: string };
  };
  expect(body.plans[0]!.carrier_name).toBe(native.issuer.marketing_names[0]);
  expect(body.plans[0]!.networks.map((n) => n.name)).toEqual(
    native.network.records.map((n) => n.network_name),
  );
  expect(native.provenance.snapshot_ids).toBeTruthy();
  expect(native.network.records[0]!.snapshot_id).toBeTruthy();
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

/** Unpublished flags stay null; a network without a published directory has no URL key.
 * Federal plans carry no state filing keys. */
function residualShapeContract(plan: Record<string, unknown>) {
  assert.equal(plan.telemedicine, null);
  assert.ok(Object.hasOwn(plan, "telemedicine"));
  for (const network of plan.networks as Record<string, unknown>[]) {
    assert.ok(Object.hasOwn(network, "name"));
    if (Object.hasOwn(network, "provider_directory_url"))
      assert.match(String(network.provider_directory_url), /^https?:\/\/\S+$/);
  }
  for (const key of ["plan_key", "hios_id", "hios_match"])
    assert.ok(!Object.hasOwn(plan, key), key);
}

it("omits a blank network directory from the wire plan", async () => {
  const { body } = await search();
  residualShapeContract(body.plans[0]!);
  const view = (await (
    await h.app.request("/v1/plans/87226TX0100013?year=2026")
  ).json()) as Parameters<typeof mapPlan>[0];
  const blank = {
    ...view,
    network: {
      ...view.network,
      records: view.network.records.map((record) => ({
        ...record,
        network_url: "  ",
      })),
    },
  } as Parameters<typeof mapPlan>[0];
  const mapped = planResponse(mapPlan(blank, "87226TX0100013"));
  residualShapeContract(mapped);
  for (const network of mapped.networks as Record<string, unknown>[])
    expect(Object.hasOwn(network, "provider_directory_url")).toBe(false);
});

it("negative controls: an invented telehealth flag, an empty directory URL or filing keys on a federal plan fail the shape contract", async () => {
  const { body } = await search();
  const invented = structuredClone(body.plans[0]!);
  invented.telemedicine = true;
  expect(() => residualShapeContract(invented)).toThrow();
  const emptyUrl = structuredClone(body.plans[0]!);
  emptyUrl.networks[0]!.provider_directory_url = "";
  expect(() => residualShapeContract(emptyUrl)).toThrow();
  const leaked = structuredClone(body.plans[0]!);
  leaked.plan_key = "synthetic-native-key";
  expect(() => residualShapeContract(leaked)).toThrow("plan_key");
  // Removing a required wire key still fails the base contract.
  const missing: Record<string, unknown> = structuredClone(body.plans[0]!);
  delete missing.networks;
  expect(() => wirePlanContract(missing)).toThrow("networks");
});
