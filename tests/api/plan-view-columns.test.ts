import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/app.js";
import { findPlan, planView } from "../../src/api/repository.js";
import type { Plan } from "../../src/api/repository.js";
import {
  FEDERAL_PLAN_ATTRIBUTES,
  PLAN_COLUMN_KEYS,
} from "../../src/api/plan-view.js";
import { mapPlan } from "../../src/compat/v1/mapping.js";
import type { SqlSession } from "../../src/db/database.js";
import { migrate } from "../../src/db/migrate.js";
import { readCsv } from "../../src/ingest/csv/index.js";
import { importPufs } from "../../src/ingest/puf/import.js";
import { ingestGeo } from "../../src/ingest/geo/index.js";
import { ingestRatingRules } from "../../src/ingest/rating-rules/index.js";
import { fixtureFiles as geoFiles } from "../ingest/geo/helpers.js";
import { publishAnnualData } from "../../src/db/data-window.js";
import type { ImportFile } from "../../src/ingest/puf/import.js";
import { IMPORT_KINDS } from "../../src/ingest/puf/import-source.js";
import { coreMigrations, testDatabase } from "../pglite.js";

const BASE = "11718TX0140019",
  TOKEN = "synthetic-plan-columns-token";
const db = testDatabase(new PGlite());
const sourceRows = new Map<
  string,
  { raw: Record<string, string>; line: number }
>();
type CatalogPlan = Record<string, unknown> & {
  id?: string;
  base_plan_id?: string;
};
type CatalogResponse = CatalogPlan & {
  plan?: CatalogPlan;
  plans?: CatalogPlan[];
};
let core: Awaited<ReturnType<typeof coreMigrations>>,
  directory: string,
  plan: Plan;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "openplans-plan-columns-"));
  core = await coreMigrations();
  await migrate(db, core.directory);
  await ingestGeo(db, { files: await geoFiles() });
  await ingestRatingRules(db);
  const root = new URL("../fixtures/puf/csr/", import.meta.url);
  const provenance = JSON.parse(
    await readFile(new URL("provenance.json", root), "utf8"),
  ) as { files: { kind: string; cut_sha256: string; url: string }[] };
  const files: ImportFile[] = [];
  for (const kind of IMPORT_KINDS) {
    const path = new URL(`${kind}.csv`, root),
      bytes = await readFile(path);
    const source = provenance.files.find(
      (f: { kind: string }) => f.kind === kind,
    )!;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    expect(sha256).toBe(source.cut_sha256);
    if (kind === "plan-attributes")
      for await (const row of readCsv(Readable.from([bytes])))
        sourceRows.set(row.values.PlanId!, {
          raw: row.values,
          line: row.rowNumber,
        });
    files.push({
      kind,
      path: path.pathname,
      format: "csv",
      sha256,
      bytes: bytes.length,
      url: source.url,
      retrievedAt: "2026-11-07T00:00:00Z",
    });
  }
  expect(
    (
      await importPufs(db, {
        year: 2026,
        state: "TX",
        files,
        dataDir: directory,
      })
    ).status,
  ).toBe("ACTIVE");
  plan = (await findPlan(db, BASE, 2026))!;
  expect(plan).not.toBeNull();
  vi.stubEnv("OPENPLANS_COMPAT_API_KEY", TOKEN);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await db.close();
  await core.cleanup();
  await rm(directory, { recursive: true, force: true });
});
async function rollback(run: (tx: SqlSession) => Promise<void>) {
  const marker = new Error("rollback disposable column mutation");
  await expect(
    db.transaction(async (tx) => {
      await run(tx);
      throw marker;
    }),
  ).rejects.toBe(marker);
}
async function replaceRaw(
  tx: SqlSession,
  variant: string,
  patch: Record<string, string>,
) {
  await tx.query(
    `UPDATE plan_variant SET raw=raw || $3::jsonb WHERE snapshot_id=$1 AND variant_plan_id=$2`,
    [plan.snapshot_id, `${BASE}-${variant}`, JSON.stringify(patch)],
  );
}
function unknown(mapped: Record<string, unknown>) {
  for (const key of [
    "plan_type",
    "hsa_eligible",
    "effective_date",
    "expiration_date",
    "drug_formulary_url",
  ])
    assert.equal(mapped[key], null, `${key} requires the selected public row`);
}
it("projects exactly the selected federal columns with snapshot and row provenance", async () => {
  for (const variant of ["01", "03", "06"]) {
    const view = await planView(db, plan, {
      requestedVariant: variant,
      allBenefits: true,
    });
    const source = sourceRows.get(`${BASE}-${variant}`)!;
    expect(view.cost_sharing[FEDERAL_PLAN_ATTRIBUTES]).toEqual(
      Object.fromEntries(PLAN_COLUMN_KEYS.map((key) => [key, source.raw[key]])),
    );
    expect(view.cost_sharing.provenance).toEqual({
      snapshot_id: plan.snapshot_id,
      source_row: source.line,
    });
    expect(view.catalog_metadata).toEqual({
      status: "available",
      variant_plan_id: `${BASE}-${variant}`,
      attributes: Object.fromEntries(
        PLAN_COLUMN_KEYS.map((key) => [
          key,
          source.raw[key]?.trim() ? source.raw[key] : null,
        ]),
      ),
      provenance: { snapshot_id: plan.snapshot_id, source_row: source.line },
    });
    expect(mapPlan(view, BASE).catalog_metadata).toEqual(view.catalog_metadata);
    expect(view.provenance.snapshot_ids).toHaveProperty(
      "plan-attributes",
      plan.snapshot_id,
    );
    expect(JSON.parse(JSON.stringify(view.cost_sharing))).not.toHaveProperty(
      "published_attributes",
    );
    for (const row of view.variants)
      expect(row).not.toHaveProperty("published_attributes");
    expect(mapPlan(view, BASE)).toMatchObject({
      plan_type: "HMO",
      hsa_eligible: false,
      effective_date: "2026-01-01T00:00:00.000Z",
      drug_formulary_url: source.raw.FormularyURL,
    });
  }
  const response = await createApp(db).request(
    `/compat/v1/plans/${BASE}?year=2026`,
    { headers: { "X-Api-Key": TOKEN } },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    plan: {
      plan_type: "HMO",
      hsa_eligible: false,
      effective_date: "2026-01-01T00:00:00.000Z",
    },
  });
});
it("negative control: rejects wrong-year columns and rows even inside the same snapshot", async () => {
  await rollback(async (tx) => {
    await replaceRaw(tx, "01", { BusinessYear: "2027" });
    const mapped = mapPlan(await planView(tx, plan), BASE);
    unknown(mapped);
    expect(mapped.catalog_metadata).toMatchObject({
      status: "unknown",
      attributes: null,
      provenance: null,
    });
    expect(mapped.estimated_actuarial_value).toBeNull();
    expect(() =>
      unknown({ ...mapped, effective_date: "2027-01-01T00:00:00.000Z" }),
    ).toThrow("requires the selected public row");
  });
  await rollback(async (tx) => {
    await tx.query(
      "UPDATE plan_variant SET plan_year=2027 WHERE snapshot_id=$1 AND variant_plan_id=$2",
      [plan.snapshot_id, `${BASE}-01`],
    );
    const view = await planView(tx, plan);
    expect(view.cost_sharing.status).toBe("unknown");
    expect(view.cost_sharing[FEDERAL_PLAN_ATTRIBUTES]).toBeUndefined();
    expect(view.catalog_metadata).toMatchObject({
      status: "unknown",
      attributes: null,
      provenance: null,
    });
    unknown(mapPlan(view, BASE));
  });
});
it("negative control: never substitutes another variant's columns", async () => {
  await rollback(async (tx) => {
    // Synthetic sentinels distinguish variants whose published URLs are identical.
    await replaceRaw(tx, "05", {
      FormularyURL: "https://example.com/synthetic-variant-05",
    });
    const selected = await planView(tx, plan, { csrVariant: "05" });
    expect(mapPlan(selected, BASE).drug_formulary_url).toBe(
      "https://example.com/synthetic-variant-05",
    );
    expect(mapPlan(await planView(tx, plan), BASE).drug_formulary_url).toBe(
      sourceRows.get(`${BASE}-01`)!.raw.FormularyURL,
    );
    await replaceRaw(tx, "01", { PlanId: `${BASE}-05` });
    const mapped = mapPlan(await planView(tx, plan), BASE);
    unknown(mapped);
    expect(mapped.catalog_metadata).toMatchObject({
      status: "unknown",
      attributes: null,
      provenance: null,
    });
    expect(() =>
      unknown({
        ...mapped,
        drug_formulary_url: mapPlan(selected, BASE).drug_formulary_url,
      }),
    ).toThrow("requires the selected public row");
    await tx.query(
      "DELETE FROM plan_variant WHERE snapshot_id=$1 AND variant_plan_id=$2",
      [plan.snapshot_id, `${BASE}-01`],
    );
    const missing = await planView(tx, plan);
    expect(missing.cost_sharing[FEDERAL_PLAN_ATTRIBUTES]).toBeUndefined();
    unknown(mapPlan(missing, BASE));
  });
});
it("negative control: empty columns remain unknown instead of false, a date, or a URL", async () => {
  await rollback(async (tx) => {
    await replaceRaw(tx, "01", {
      PlanType: "",
      IsHSAEligible: "",
      PlanEffectiveDate: "",
      PlanExpirationDate: "",
      FormularyURL: "   ",
    });
    const view = await planView(tx, plan);
    expect(view.cost_sharing.status).toBe("available");
    const mapped = mapPlan(view, BASE);
    unknown(mapped);
    for (const [key, value] of Object.entries({
      plan_type: "HMO",
      hsa_eligible: false,
      effective_date: "2026-01-01T00:00:00.000Z",
      expiration_date: "2026-12-31T00:00:00.000Z",
      drug_formulary_url: "https://example.com/synthetic",
    }))
      expect(() => unknown({ ...mapped, [key]: value })).toThrow(
        "requires the selected public row",
      );
  });
});
it("projects CA spaced plan headers from the selected state row", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL("../compat/v1/plan-columns-public.json", import.meta.url),
      "utf8",
    ),
  ) as {
    rows: {
      label: string;
      source_row: number;
      values: Record<string, string>;
    }[];
  };
  const row = fixture.rows.find((r) => r.label === "ca-av-referral-yes-hsa")!;
  const variant = row.values["PLAN ID"]!,
    base = variant.slice(0, 14);
  await rollback(async (tx) => {
    // The real CA row keeps its spaced headers; only this disposable snapshot holds it.
    await tx.query(
      `INSERT INTO plan_variant (snapshot_id,source_row,plan_year,state,issuer_id,variant_plan_id,
        base_plan_id,csr_suffix,csr_variation_type,variant_name,exchange_status,raw)
      VALUES ($1,$2,2026,'CA',$3,$4,$5,'01',$6,$7,'On Exchange',$8::jsonb)`,
      [
        plan.snapshot_id,
        row.source_row,
        base.slice(0, 5),
        variant,
        base,
        row.values["CSR VARIATION TYPE"],
        row.values["PLAN VARIANT MARKETING NAME"],
        JSON.stringify(row.values),
      ],
    );
    const view = await planView(tx, {
      ...plan,
      state: "CA",
      base_plan_id: base,
      issuer_id: base.slice(0, 5),
    });
    expect(view.cost_sharing.status).toBe("available");
    expect(mapPlan(view, base)).toMatchObject({
      plan_type: "HMO",
      hsa_eligible: true,
      gated: true,
      sbc_name: "Bronze 60 HMO",
      actuarial_value: 63.7,
      estimated_actuarial_value: 63.4676422,
      effective_date: "2026-01-01T00:00:00.000Z",
      drug_formulary_url: null,
    });
    expect(view.catalog_metadata).toMatchObject({
      status: "available",
      variant_plan_id: variant,
      attributes: {
        AVCalculatorOutputNumber: row.values["AV CALCULATOR OUTPUT NUMBER"],
        IssuerActuarialValue: row.values["ISSUER ACTUARIAL VALUE"],
      },
      provenance: { snapshot_id: plan.snapshot_id, source_row: row.source_row },
    });
  });
});

it("serves the raw CMS year/plan/county/ZIP oracle and stable replays through both APIs", async () => {
  const root = new URL("../fixtures/puf/csr/", import.meta.url);
  const serviceRows = [];
  for await (const row of readCsv(
    Readable.from([await readFile(new URL("service-area.csv", root))]),
  ))
    serviceRows.push(row.values);
  // These source rows name the plan's service area and cover the whole county.
  expect(serviceRows).toContainEqual(
    expect.objectContaining({
      BusinessYear: "2026",
      StateCode: "TX",
      ServiceAreaId: sourceRows.get(`${BASE}-01`)!.raw.ServiceAreaId,
      County: "48201",
      PartialCounty: "No",
    }),
  );
  const app = createApp(db);
  const headers = { "X-Api-Key": TOKEN, "content-type": "application/json" };
  const paths = [
    `/v1/plans/${BASE}-05?year=2026`,
    `/v1/plans?year=2026&county=48201&zip=77002&csr_variant=05`,
    `/compat/v1/plans/${BASE}-05?year=2026`,
  ];
  for (const path of paths) {
    const first = await app.request(path, { headers });
    expect(first.status, path).toBe(200);
    const text = await first.text();
    const again = await app.request(path, { headers });
    expect(again.status).toBe(first.status);
    expect(await again.text()).toBe(text);
    const body = JSON.parse(text) as CatalogResponse;
    const served =
      body.plan ?? body.plans?.find((p) => p.base_plan_id === BASE) ?? body;
    const source = sourceRows.get(`${BASE}-05`)!;
    expect(served.catalog_metadata).toMatchObject({
      status: "available",
      variant_plan_id: `${BASE}-05`,
      attributes: {
        BusinessYear: "2026",
        StateCode: "TX",
        StandardComponentId: BASE,
        PlanId: `${BASE}-05`,
        AVCalculatorOutputNumber: source.raw.AVCalculatorOutputNumber,
        IssuerActuarialValue: null,
      },
      provenance: { snapshot_id: plan.snapshot_id, source_row: source.line },
    });
    if (body.plan) {
      expect(served.estimated_actuarial_value).toBe(87.09755432424809);
      expect(served.actuarial_value).toBeNull();
    }
  }
  const search = {
    fips_code: "48201",
    zip_code: "77002",
    year: "2026",
    csr_variant: "05",
    market: "individual",
    applicants: [{ age: 35, smoker: false, child: false }],
    enrollment_date: "2026-01-01",
    per_page: 100,
  };
  const request = { method: "POST", headers, body: JSON.stringify(search) };
  const first = await app.request("/compat/v1/plans/medical/search", request);
  expect(first.status).toBe(200);
  const text = await first.text();
  expect(
    await (
      await app.request("/compat/v1/plans/medical/search", request)
    ).text(),
  ).toBe(text);
  expect(
    (JSON.parse(text) as CatalogResponse).plans?.find((p) => p.id === BASE),
  ).toMatchObject({
    estimated_actuarial_value: 87.09755432424809,
    catalog_metadata: { variant_plan_id: `${BASE}-05` },
  });
  const wrongCounty = await app.request(
    "/v1/plans?year=2026&county=48085&zip=75024&csr_variant=05",
  );
  expect(wrongCounty.status).toBe(200);
  expect(await wrongCounty.json()).toMatchObject({ plans: [] });
});

it("keeps calculator and issuer evidence separate, without rounding or borrowing another variant", async () => {
  for (const [variant, expected] of [
    ["01", 70.1239428],
    ["02", 100],
    ["05", 87.09755432424809],
    ["06", 94.8309887],
  ] as const) {
    const mapped = mapPlan(
      await planView(db, plan, { requestedVariant: variant }),
      `${BASE}-${variant}`,
    );
    expect(mapped.estimated_actuarial_value).toBe(expected);
    expect(mapped.actuarial_value).toBeNull();
  }
  await rollback(async (tx) => {
    for (const value of [
      "",
      "   ",
      "Not Applicable",
      "1.01",
      "1.000000000000000001",
      "-0.1",
      "70%",
      "NaN",
    ]) {
      await replaceRaw(tx, "01", { AVCalculatorOutputNumber: value });
      const view = await planView(tx, plan);
      const mapped = mapPlan(view, BASE);
      expect(mapped.estimated_actuarial_value).toBeNull();
      expect(view.catalog_metadata.attributes?.AVCalculatorOutputNumber).toBe(
        value.trim() ? value : null,
      );
      expect(() =>
        assert.equal(
          { ...mapped, estimated_actuarial_value: 70.1239428 }
            .estimated_actuarial_value,
          null,
          "missing calculator evidence",
        ),
      ).toThrow("missing calculator evidence");
    }
    await replaceRaw(tx, "01", { AVCalculatorOutputNumber: "0" });
    expect(
      mapPlan(await planView(tx, plan), BASE).estimated_actuarial_value,
    ).toBe(0);
  });
});

it("applies the annual serving window and explicit next-year admission to catalog metadata", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const path = `/v1/plans/${BASE}-01?year=2026`;
    for (const date of ["2026-06-01", "2027-06-01"]) {
      vi.setSystemTime(new Date(date));
      const response = await createApp(db).request(path);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        catalog_metadata: { status: "available" },
      });
    }
    for (const date of ["2025-06-01", "2028-06-01"]) {
      vi.setSystemTime(new Date(date));
      for (const route of [path, `/compat/v1/plans/${BASE}-01?year=2026`]) {
        const response = await createApp(db).request(route, {
          headers: { "X-Api-Key": TOKEN },
        });
        expect(response.status).toBe(404);
        const body: unknown = await response.json();
        expect(body).toMatchObject({
          error: { reason: "outside_serving_window" },
        });
        expect(body).not.toHaveProperty("catalog_metadata");
      }
    }
    vi.setSystemTime(new Date("2025-06-01"));
    await rollback(async (tx) => {
      const active = (
        await tx.query<{ import_id: string }>(
          "SELECT import_id FROM puf_active_catalog WHERE plan_year=2026 AND state='TX'",
        )
      ).rows[0]!;
      await publishAnnualData(tx, [
        {
          domain: "individual",
          coverage_year: 2026,
          manifest: {
            schema_version: 1,
            releases: [
              {
                kind: "puf",
                snapshot_id: active.import_id,
                contract_year: 2026,
              },
            ],
          },
        },
      ]);
      const response = await createApp(tx).request(path);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        catalog_metadata: { status: "available" },
      });
    });
  } finally {
    vi.useRealTimers();
  }
});
