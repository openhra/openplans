import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app.js";
import { importFormulary } from "../../src/ingest/qhp/formulary.js";
import { fixture, scope, setup } from "../ingest/qhp/formulary-helpers.js";

type Row = Record<string, unknown>;
type Availability = { issuer_id: string; drug_status?: string };
type Drug = { rxnorm_id: string; plans: Row[] };
type Search = { exact_concept_required: boolean; candidates: Row[] };
type Bulk = { results: { requested_plan_id: string; rxcui: string }[] };
type Variant = { base_plan_id: string; variant_plan_id: string };

describe("drug HTTP workflow (synthetic fixtures and mutants)", () => {
  let h: Awaited<ReturnType<typeof setup>>, app: ReturnType<typeof createApp>;
  let plan: string, drugs: Drug[], code: string;
  beforeAll(async () => {
    h = await setup();
    app = createApp(h.db, {});
    drugs = await fixture("drugs");
    plan = h.catalog.plans[0].base_plan_id;
    code = drugs[0]?.rxnorm_id ?? "";
    await h.replace(drugs);
    await importFormulary(h.db, scope);
    // Synthetic mapping rows exercise plumbing; no claim that this NDC or relationship describes these drugs.
    await h.db
      .exec(`INSERT INTO rx_ndc VALUES ('rx','990000201','00071015523','N',0);
      INSERT INTO rx_relation VALUES ('rx','990000401','990000101','has_ingredient','N',0),
      ('rx','990000401','990000301','has_tradename','N',1)`);
  });
  afterAll(async () => {
    await h?.close();
  });
  const get = async <T = Row>(url: string) => {
    const response = await app.request(url);
    return { status: response.status, body: (await response.json()) as T };
  };
  const post = async <T = Row>(body: unknown) => {
    const response = await app.request("/v1/drug-coverage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as T };
  };
  it("returns search candidates with names and TTY, then resolves an exact concept and its published links", async () => {
    const search = await get<Search>("/v1/drugs?q=metformin");
    expect(search.status).toBe(200);
    expect(search.body.exact_concept_required).toBe(true);
    expect(search.body.candidates).toContainEqual(
      expect.objectContaining({
        rxcui: "990000401",
        name: expect.stringContaining("metformin"),
        tty: "SCD",
      }),
    );
    expect(
      search.body.candidates.every(
        (c) => c.suppress === "N" && !("status" in c),
      ),
    ).toBe(true);
    const detail = await get("/v1/drugs/990000401");
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      rxcui: "990000401",
      ingredients: [expect.objectContaining({ rxcui: "990000101" })],
      brand_generic_links: expect.arrayContaining([
        expect.objectContaining({ rxcui: "990000301", rela: "has_tradename" }),
      ]),
      patient_price: null,
    });
    expect(
      (await get<{ ndcs: string[] }>("/v1/drugs/990000201")).body.ndcs,
    ).toEqual(["00071015523"]);
    expect((await get("/v1/drugs/999999999999")).status).toBe(404);
    expect(
      (await get<Search>("/v1/drugs?q=nothing-matches")).body,
    ).toMatchObject({ candidates: [], terminology_status: "available" });
  });
  it("says why a drug search is empty when no terminology release is active", async () => {
    // Like the MCP search_drugs tool and the compatibility drug search: an empty list alone
    // cannot tell "no match" from "no terminology".
    const loaded = await get<Search>("/v1/drugs?q=metformin");
    expect(loaded.body).toMatchObject({ terminology_status: "available" });
    expect(loaded.body).not.toHaveProperty("reason");
    await h.db.query(
      "UPDATE snapshot SET validation_state='QUARANTINED' WHERE snapshot_id='rx'",
    );
    try {
      for (const url of [
        "/v1/drugs?q=metformin",
        "/v1/drugs?ndc=00071-0155-23",
      ])
        expect((await get(url)).body, url).toMatchObject({
          terminology_status: "unknown",
          reason: "rxnorm_terminology_unavailable",
        });
    } finally {
      await h.db.query(
        "UPDATE snapshot SET validation_state='ACTIVE' WHERE snapshot_id='rx'",
      );
    }
  });
  it("normalizes hyphenated NDCs without losing zeros; a stripped code fails validation", async () => {
    const hyphenated = await get("/v1/drugs?ndc=00071-0155-23");
    expect(hyphenated).toEqual(await get("/v1/drugs?ndc=00071015523"));
    expect(hyphenated.body).toMatchObject({
      ndc: "00071015523",
      rxcuis: ["990000201"],
    });
    expect((await get("/v1/drugs?ndc=71015523")).status).toBe(400);
  });
  it("returns a result for every exact pair, variant membership and nullable flags with provenance", async () => {
    const plans = h.catalog.plans
        .slice(0, 2)
        .map((p: { base_plan_id: string }) => p.base_plan_id),
      codes = [code, "990000101"];
    const bulk = await post<Bulk>({
      plan_ids: plans,
      rxcuis: codes,
      year: 2026,
    });
    expect(bulk.status).toBe(200);
    expect(bulk.body.results).toHaveLength(4);
    expect(
      bulk.body.results.map((r) => [r.requested_plan_id, r.rxcui]),
    ).toEqual(plans.flatMap((p: string) => codes.map((c) => [p, c])));
    const covered = bulk.body.results[0];
    expect(covered).toMatchObject({
      status: "listed_covered",
      tier_status: "resolved",
      cost_sharing: null,
      patient_price: null,
      evidence: expect.arrayContaining([
        expect.objectContaining({
          source_id: "synthetic-harness",
          snapshot_id: expect.any(String),
          source_record: 0,
        }),
      ]),
    });
    expect(bulk.body.results[1]).toMatchObject({
      status: "not_listed",
      drug_tier: null,
      tier_status: null,
      prior_authorization: null,
    });
    const variant = h.catalog.variants.find(
      (v: Variant) => v.base_plan_id === plan,
    )?.variant_plan_id;
    expect(
      (await get(`/v1/plans/${variant}/drugs/${code}?year=2026`)).body,
    ).toMatchObject({
      requested_plan_id: variant,
      base_hios_id: plan,
      status: "listed_covered",
    });
    const mutant = structuredClone(drugs);
    for (const edge of mutant[0]?.plans ?? []) {
      edge.drug_tier = "SYNTHETIC-UNKNOWN";
      delete edge.prior_authorization;
    }
    await h.replace(mutant);
    expect((await importFormulary(h.db, scope)).status).toBe("ACTIVE");
    expect(
      (await get(`/v1/plans/${plan}/drugs/${code}?year=2026`)).body,
    ).toMatchObject({
      status: "listed_covered",
      drug_tier: "SYNTHETIC-UNKNOWN",
      tier_status: "unresolved",
      prior_authorization: null,
      cost_sharing: null,
    });
  });
  it("lists manifest completeness and makes a denied issuer unknown, even with older ACTIVE evidence", async () => {
    const before = (
      await get<Availability[]>("/v1/data-availability?state=TX&year=2026")
    ).body;
    expect(before.find((r) => r.issuer_id === "00010")).toMatchObject({
      drug_status: "complete",
      drug_coverage: { status: "complete" },
    });
    // Synthetic denial in a newer discovery. The old source remains immutable and ACTIVE.
    await h.db
      .exec(`INSERT INTO qhp_index(qhp_index_id,discovery_id,issuer_id,plan_year,state,registry_snapshot_id,registry_row,status,discovered_at)
      VALUES ('synthetic-denied','synthetic-denied','00010',2026,'TX','registry',1,'access_denied',clock_timestamp())`);
    for (const rxcui of [code, "990000101"])
      expect(
        (await get(`/v1/plans/${plan}/drugs/${rxcui}?year=2026`)).body,
      ).toMatchObject({
        status: "unknown",
        reason: "source_access_denied",
        drug_tier: null,
        patient_price: null,
        evidence: [],
      });
    const availability = (await get<Availability[]>("/v1/data-availability"))
      .body;
    expect(availability.find((r) => r.issuer_id === "00010")).toMatchObject({
      drug_status: "access_denied",
    });
    expect(() =>
      expect(
        availability.find((r) => r.issuer_id === "00010")?.drug_status,
      ).toBe("complete"),
    ).toThrow();
  });
  it("validates queries and bounded batches without coercing numeric IDs or inventing years", async () => {
    for (const url of [
      "/v1/drugs",
      "/v1/drugs?q=",
      "/v1/drugs?q=a&ndc=00071015523",
      "/v1/drugs?q=a&limit=101",
      "/v1/drugs/abc",
      `/v1/plans/${plan}/drugs/${code}`,
      `/v1/plans/${plan}/drugs/${code}?year=2101`,
    ]) {
      const result = await get<{ error: { code: string } }>(url);
      expect(result.status, url).toBe(400);
      expect(result.body.error.code).toEqual(expect.any(String));
    }
    for (const body of [
      null,
      { plan_ids: [], rxcuis: [code], year: 2026 },
      { plan_ids: [plan], rxcuis: [990000201], year: 2026 },
      { plan_ids: [plan], rxcuis: [code] },
      { plan_ids: [plan, plan], rxcuis: [code], year: 2026 },
      { plan_ids: [plan], rxcuis: [code, code], year: 2026 },
      { plan_ids: [plan], rxcuis: [code], year: "2026" },
    ])
      expect((await post(body)).status).toBe(400);
    expect(
      (await app.request("/v1/drug-coverage", { method: "POST", body: "{bad" }))
        .status,
    ).toBe(400);
  });
});
