import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app.js";
import { migrate } from "../../src/db/migrate.js";
import { importPufs } from "../../src/ingest/puf/import.js";
import { IMPORT_KINDS } from "../../src/ingest/puf/import-source.js";
import { readCsv } from "../../src/ingest/csv/index.js";
import { ingestGeo } from "../../src/ingest/geo/index.js";
import { ingestRatingRules } from "../../src/ingest/rating-rules/index.js";
import { coreMigrations, testDatabase } from "../pglite.js";
import { fixtureFiles as geoFiles } from "../ingest/geo/helpers.js";

const PLAN = "11718TX0140019",
  TOKEN = "synthetic-csr-test-token";
const db = testDatabase(new PGlite()),
  app = createApp(db, { premiumToken: TOKEN });
let core: Awaited<ReturnType<typeof coreMigrations>>,
  directory: string,
  snapshot: string;
const sourceRows: Record<string, Record<string, string>[]> = {};
const requestBody = (extra = {}) => ({
  plan_ids: [PLAN],
  county: "48201",
  coverage_start: "2026-01-01",
  members: [{ age: 35, tobacco: false, relationship: "subscriber" }],
  ...extra,
});
async function estimate(extra = {}) {
  const response = await app.request("/v1/premium-quotes", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(requestBody(extra)),
  });
  return {
    response,
    json: (await response.json()) as ReturnType<typeof JSON.parse>,
  };
}
async function detail(query = "", id = PLAN) {
  const response = await app.request(`/v1/plans/${id}?year=2026${query}`);
  return { response, json: (await response.json()) as any };
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "openplans-csr-"));
  core = await coreMigrations();
  await migrate(db, core.directory);
  const root = new URL("../fixtures/puf/csr/", import.meta.url);
  const provenance = JSON.parse(
    await readFile(new URL("provenance.json", root), "utf8"),
  );
  const files = [];
  for (const kind of IMPORT_KINDS) {
    const path = new URL(`${kind}.csv`, root),
      data = await readFile(path),
      f = provenance.files.find((f: any) => f.kind === kind);
    const sha256 = createHash("sha256").update(data).digest("hex");
    expect(sha256).toBe(f.cut_sha256);
    sourceRows[kind] = [];
    for await (const row of readCsv(Readable.from([data])))
      sourceRows[kind]!.push(row.values);
    files.push({
      kind,
      path: path.pathname,
      format: "csv" as const,
      sha256,
      bytes: data.length,
      url: f.url,
      retrievedAt: "2026-11-07T00:00:00Z",
    });
  }
  const imported = await importPufs(db, {
    year: 2026,
    state: "TX",
    files,
    dataDir: directory,
  });
  expect(imported.status).toBe("ACTIVE");
  snapshot = `${imported.import_id}:plan-attributes`;
  await ingestGeo(db, { files: await geoFiles() });
  await ingestRatingRules(db);
  process.env.OPENPLANS_COMPAT_API_KEY = TOKEN;
});
afterAll(async () => {
  await db.close();
  await core.cleanup();
  await rm(directory, { recursive: true, force: true });
});

describe("real TX 2026 silver CSR variants over HTTP", () => {
  it("defaults to 01 and details every variant with its own raw evidence", async () => {
    const { json } = await detail();
    expect(json.variant_ids).toEqual(
      ["00", "01", "02", "03", "04", "05", "06"].map((s) => `${PLAN}-${s}`),
    );
    expect(json.cost_sharing).toMatchObject({
      status: "available",
      selected_variant_id: `${PLAN}-01`,
      selection: "standard_on_exchange_default",
    });
    expect(json.csr_eligibility_status).toBe("not_evaluated");
    for (const variant of json.variants) {
      const raw = sourceRows["plan-attributes"]!.find(
        (row) => row.PlanId === variant.variant_plan_id,
      )!;
      expect(variant.deductibles.TEHBDedInnTier1Individual.raw).toBe(
        raw.TEHBDedInnTier1Individual,
      );
      expect(variant.moop.TEHBInnTier1IndividualMOOP.raw).toBe(
        raw.TEHBInnTier1IndividualMOOP,
      );
      expect(variant.benefits.map((b: any) => b.raw)).toEqual(
        sourceRows["benefits-and-cost-sharing"]!.filter(
          (row) => row.PlanId === variant.variant_plan_id,
        ),
      );
    }
    expect(json.cost_sharing.deductibles.TEHBDedInnTier1Individual.cents).toBe(
      450000,
    );
    expect(
      (await detail("&csr_variant=csr94")).json.cost_sharing,
    ).toMatchObject({
      selected_variant_id: `${PLAN}-06`,
      deductibles: { TEHBDedInnTier1Individual: { cents: 0 } },
      moop: { TEHBInnTier1IndividualMOOP: { cents: 160000 } },
    });
    expect(
      (await detail("", `${PLAN}-03`)).json.cost_sharing.selected_variant_id,
    ).toBe(`${PLAN}-03`);
  });
  it("search and premium requests select the same evidence; all seven gross premiums are equal", async () => {
    const baseline = (await estimate()).json.quotes[0];
    expect(baseline.status).toBe("rated");
    for (const csr of [
      "00",
      "01",
      "02",
      "03",
      "04",
      "05",
      "06",
      "csr73",
      "csr87",
      "csr94",
    ]) {
      const result = await estimate({ csr_variant: csr });
      const quoted = result.json.quotes[0],
        selected = (await detail(`&csr_variant=${csr}`)).json.cost_sharing;
      expect(quoted).toMatchObject({
        status: "rated",
        total_cents: baseline.total_cents,
        cost_sharing: selected,
        premium_varies_by_csr: false,
        premium_basis: "base_plan_rate_puf",
        csr_eligibility_status: "not_evaluated",
      });
      const search = await app.request(
        `/v1/plans?county=48201&year=2026&csr_variant=${csr}`,
      );
      expect(
        ((await search.json()) as ReturnType<typeof JSON.parse>).plans[0]
          .cost_sharing,
      ).toEqual(selected);
    }
    for (const income of [0, 20000, 100000]) {
      const result = (
        await estimate({
          household_income_annual: income,
          household_size: 1,
          tax_filing: "single",
        })
      ).json.quotes[0];
      expect(result.cost_sharing.selected_variant_id).toBe(`${PLAN}-01`);
    }
  });
  it("rejects malformed and conflicting explicit selections", async () => {
    expect(
      (await detail("&csr_variant=csr94", `${PLAN}-03`)).response.status,
    ).toBe(400);
    expect(
      (await estimate({ csr_variant: "csr94", plan_ids: [`${PLAN}-03`] }))
        .response.status,
    ).toBe(400);
    for (const csr of ["94", "99", "income", "constructor"]) {
      expect((await estimate({ csr_variant: csr })).response.status).toBe(400);
      expect(
        (
          await app.request(
            `/v1/plans?county=48201&year=2026&csr_variant=${csr}`,
          )
        ).status,
      ).toBe(400);
    }
  });
  it("negative control: absent variant stays unknown while base premiums remain rated; fallback mutant fails", async () => {
    const baseline = (await detail()).json.cost_sharing;
    const marker = new Error("rollback synthetic missing-variant mutation");
    await expect(
      db.transaction(async (tx) => {
        await tx.query(
          "DELETE FROM plan_variant WHERE snapshot_id=$1 AND variant_plan_id=$2",
          [snapshot, `${PLAN}-06`],
        );
        const scoped = createApp(tx, { premiumToken: TOKEN });
        const response = await scoped.request("/v1/premium-quotes", {
          method: "POST",
          headers: { authorization: `Bearer ${TOKEN}` },
          body: JSON.stringify(requestBody({ csr_variant: "csr94" })),
        });
        const result = (
          (await response.json()) as ReturnType<typeof JSON.parse>
        ).quotes[0];
        const unknown = (value: ReturnType<typeof JSON.parse>) => {
          assert.equal(
            value.status,
            "unknown",
            "missing variant cannot borrow base evidence",
          );
          assert.deepEqual(value.deductibles, {});
          assert.deepEqual(value.moop, {});
          assert.deepEqual(value.benefits, []);
        };
        expect(result.status).toBe("rated");
        unknown(result.cost_sharing);
        const facade = await scoped.request(
          `/compat/v1/plans/${PLAN}?year=2026&csr_variant=csr94`,
          { headers: { "X-Api-Key": TOKEN } },
        );
        expect(facade.headers.get("x-openplans-gaps")).toContain(
          "variant_cost_sharing_unknown",
        );
        expect(
          ((await facade.json()) as ReturnType<typeof JSON.parse>).plan,
        ).toMatchObject({
          individual_medical_deductible: null,
          individual_medical_moop: null,
          primary_care_physician: null,
        });
        const mutant = structuredClone(result.cost_sharing);
        mutant.status = "available";
        mutant.deductibles = baseline.deductibles;
        expect(() => unknown(mutant)).toThrow(
          "missing variant cannot borrow base evidence",
        );
        throw marker;
      }),
    ).rejects.toBe(marker);
  });
  it("keeps variant accumulators when its benefit evidence is absent, without filling standard rows", async () => {
    const marker = new Error("rollback synthetic missing benefit evidence");
    await expect(
      db.transaction(async (tx) => {
        await tx.query(`DELETE FROM plan_benefit WHERE published_plan_id=$1`, [
          `${PLAN}-06`,
        ]);
        const scoped = createApp(tx);
        const response = await scoped.request(
          `/v1/plans/${PLAN}?year=2026&csr_variant=csr94`,
        );
        const result = (await response.json()) as any;
        expect(result.cost_sharing).toMatchObject({
          status: "available",
          benefits_status: "unknown",
          benefits: [],
          deductibles: { TEHBDedInnTier1Individual: { cents: 0 } },
        });
        expect(
          result.variants.find((v: any) => v.variant_plan_id === `${PLAN}-06`)
            .benefits_status,
        ).toBe("unknown");
        const facade = await scoped.request(
          `/compat/v1/plans/${PLAN}?year=2026&csr_variant=csr94`,
          { headers: { "X-Api-Key": TOKEN } },
        );
        expect(facade.headers.get("x-openplans-gaps")).toContain(
          "variant_cost_sharing_unknown",
        );
        expect(
          ((await facade.json()) as any).plan.primary_care_physician,
        ).toBeNull();
        throw marker;
      }),
    ).rejects.toBe(marker);
  });
  it("maps selected costs into existing compatibility fields without adding keys", async () => {
    const headers = { "X-Api-Key": TOKEN };
    const get = async (query = "") =>
      (
        (await (
          await app.request(`/compat/v1/plans/${PLAN}?year=2026${query}`, {
            headers,
          })
        ).json()) as any
      ).plan;
    const standard = await get(),
      csr = await get("&csr_variant=csr94");
    expect(standard.individual_medical_deductible).toContain("$4,500");
    expect(csr.individual_medical_deductible).toContain("$0");
    expect(csr.individual_medical_moop).toContain("$1,600");
    expect(csr.primary_care_physician).not.toBe(
      standard.primary_care_physician,
    );
    expect(Object.keys(csr)).toEqual(Object.keys(standard));
    const response = await app.request("/compat/v1/plans/medical/search", {
      method: "POST",
      headers,
      body: JSON.stringify({
        fips_code: "48201",
        applicants: [{ age: 35 }],
        enrollment_date: "2026-01-01",
        csr_variant: "csr94",
      }),
    });
    const result = ((await response.json()) as ReturnType<typeof JSON.parse>)
      .plans[0];
    expect(result.individual_medical_deductible).toBe(
      csr.individual_medical_deductible,
    );
    expect(result.primary_care_physician).toBe(csr.primary_care_physician);
    expect(result.premium).toBe(
      (await estimate()).json.quotes[0].total_cents / 100,
    );
  });
});
