import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import ts from "typescript";
import { beforeAll, afterAll, expect, it } from "vitest";
import { createApp } from "../../../src/api/app.js";
import type { SqlSession } from "../../../src/db/database.js";
import { migrate } from "../../../src/db/migrate.js";
import { findPlan, planView } from "../../../src/api/repository.js";
import { mapPlan } from "../../../src/compat/v1/mapping.js";
import { matchesMedicalSearchId } from "../../../src/compat/v1/index.js";
import { mapProviders } from "../../../src/compat/v1/providers.js";
import { ingestGeo } from "../../../src/ingest/geo/index.js";
import { importPufs } from "../../../src/ingest/puf/import.js";
import { ingestStateRates } from "../../../src/ingest/state/index.js";
import { importTaxonomy } from "../../../src/plugins/core-plugin.js";
import { coreMigrations, testDatabase } from "../../pglite.js";
import { fixtureFiles as geoFiles } from "../../ingest/geo/helpers.js";
import { fixtureFiles } from "../../api/helpers.js";
import { BASE, headers, searchBody, TOKEN } from "./helpers.js";
import { assertShape } from "./shape.js";

const db = testDatabase(new PGlite()),
  dental = "12846TX0270005",
  vt = "BCBSVT:Gold Plan";
let directory: string, core: Awaited<ReturnType<typeof coreMigrations>>;
beforeAll(async () => {
  process.env.OPENPLANS_COMPAT_API_KEY = TOKEN;
  directory = await mkdtemp(join(tmpdir(), "openplans-facade-refresh-"));
  core = await coreMigrations();
  await migrate(db, core.directory);
  await ingestGeo(db, { files: await geoFiles() });
  expect(
    (
      await importPufs(db, {
        year: 2026,
        state: "TX",
        files: await fixtureFiles(directory),
        dataDir: directory,
      })
    ).status,
  ).toBe("ACTIVE");
  // Labelled synthetic area re-scope of the small dental cut, as in native HTTP tests.
  // The cache-only runner checks unmodified Harris Area 10 prices independently.
  await db.query(
    `UPDATE rate SET rating_area_id='Rating Area 10',raw=raw || '{"RatingAreaId":"Rating Area 10"}'::jsonb WHERE base_plan_id=$1`,
    [dental],
  );
  for (const state of ["NY", "VT"] as const) {
    const path = join(directory, `${state}.json`);
    await writeFile(
      path,
      await readFile(
        new URL(
          `../../fixtures/state/${state.toLowerCase()}-2026.json`,
          import.meta.url,
        ),
      ),
    );
    await ingestStateRates(db, path, state, { verifyRaw: false });
  }
  const geo = JSON.parse(
    await readFile(
      new URL("../../api/state-geography.json", import.meta.url),
      "utf8",
    ),
  );
  await db.exec(`INSERT INTO source(source_id,publisher,source_kind) VALUES('facade-census-cut','US Census Bureau','geography');
    INSERT INTO snapshot(snapshot_id,source_id,validation_state,expected_children,sha256,retrieved_at,activated_at)
      VALUES('facade-census-cut','facade-census-cut','ACTIVE',0,'${geo.source_sha256}',now(),now());
    INSERT INTO geo_import(state,plan_year,relationship_snapshot_id,centroid_snapshot_id,rating_snapshot_id)
      VALUES('NY',2026,'facade-census-cut','facade-census-cut','facade-census-cut'),
      ('VT',2026,'facade-census-cut','facade-census-cut','facade-census-cut');`);
  for (const row of geo.rows) {
    const v = row.values;
    await db.query(
      `INSERT INTO zcta_county VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'facade-census-cut',$10)`,
      [
        v.GEOID_ZCTA5_20,
        v.GEOID_COUNTY_20,
        v.NAMELSAD_COUNTY_20,
        v.AREALAND_ZCTA5_20,
        v.AREAWATER_ZCTA5_20,
        v.AREALAND_COUNTY_20,
        v.AREAWATER_COUNTY_20,
        v.AREALAND_PART,
        v.AREAWATER_PART,
        row.source_row,
      ],
    );
  }
});
afterAll(async () => {
  await db.close();
  await core.cleanup();
  await rm(directory, { recursive: true, force: true });
});
async function search(tx: SqlSession, product: string, extra = {}) {
  const response = await createApp(tx).request(
    `${BASE}/plans/${product}/search`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(searchBody(extra)),
    },
  );
  expect(response.status).toBe(200);
  return {
    response,
    body: (await response.json()) as any,
    gaps: response.headers.get("x-openplans-gaps")!,
  };
}
async function rollback(run: (tx: SqlSession) => Promise<void>) {
  const marker = new Error("synthetic facade mutation rollback");
  await expect(
    db.transaction(async (tx) => {
      await run(tx);
      throw marker;
    }),
  ).rejects.toBe(marker);
}

it("maps native SADP totals, sorts and paginates without retaining a priced-plan unsupported gap", async () => {
  const result = await search(db, "dental", { ids: [dental], sort: "premium" });
  const cents = (
    await db.query<{ individual_rate_cents: number }>(
      `SELECT individual_rate_cents FROM rate
    WHERE base_plan_id=$1 AND age_band='35'`,
      [dental],
    )
  ).rows[0]!.individual_rate_cents;
  expect(result.body.plans[0]).toMatchObject({
    id: dental,
    premium: Number(cents) / 100,
    stand_alone: true,
  });
  expect(result.gaps).not.toContain(
    "dental_premiums_unsupported_by_native_rating",
  );
  expect(result.gaps).not.toContain("premium_unknown");
  expect(result.gaps).toContain("dental_benefits_unmapped");
  const native = await createApp(db, { premiumToken: TOKEN }).request(
    "/v1/premium-quotes",
    {
      method: "POST",
      headers: { ...headers, authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        plan_ids: [dental],
        county: "48201",
        coverage_start: "2026-01-01",
        members: [{ age: 35, tobacco: false, relationship: "subscriber" }],
      }),
    },
  );
  expect(
    ((await native.json()) as ReturnType<typeof JSON.parse>).quotes[0]
      .total_cents,
  ).toBe(Math.round(result.body.plans[0].premium * 100));
  if (process.env.OPENPLANS_REFERENCE_CAPTURES_DIR) {
    const capture = JSON.parse(
      await readFile(
        join(
          process.env.OPENPLANS_REFERENCE_CAPTURES_DIR,
          "plans/dental/search/48201/small_group/23ee8bdcc150.json",
        ),
        "utf8",
      ),
    );
    assertShape(capture, result.body, "$", true);
  }
  const detail = await createApp(db).request(`${BASE}/plans/dental/${dental}`, {
    headers,
  });
  expect(
    ((await detail.json()) as ReturnType<typeof JSON.parse>).plan.premium,
  ).toBeNull();
  expect(detail.headers.get("x-openplans-gaps")).toContain(
    "dental_premium_requires_household",
  );
});

it("keeps per-plan unsupported and unknown SADP reasons; negative control cannot silently drop an unknown gap", async () => {
  await rollback(async (tx) => {
    await tx.query("DELETE FROM business_rule WHERE base_plan_id=$1", [dental]);
    const result = await search(tx, "dental", { ids: [dental] });
    expect(result.body.plans[0].premium).toBeNull();
    expect(result.gaps).toContain(
      `dental_premiums_unsupported_by_native_rating:${dental}`,
    );
    expect(result.gaps).toContain(
      "premium_reason:DENTAL_AGE_DETERMINATION_UNPROVED",
    );
  });
  await rollback(async (tx) => {
    await tx.query(
      `UPDATE rate SET individual_rate_cents=NULL WHERE base_plan_id=$1 AND age_band='35'`,
      [dental],
    );
    const result = await search(tx, "dental", { ids: [dental] });
    const contract = (gaps: string) => {
      assert.equal(result.body.plans[0].premium, null);
      assert.ok(
        gaps.split(/,\s*/).includes("premium_unknown"),
        "native unknown premium requires its gap",
      );
      assert.ok(!gaps.includes("dental_premiums_unsupported_by_native_rating"));
    };
    contract(result.gaps);
    expect(() =>
      contract(result.gaps.replace(/premium_unknown,?\s*/, "")),
    ).toThrow("native unknown premium requires its gap");
  });
});

it("NY 10001 maps four filed tiers and preserves unknown exchange flags, age/tobacco invariance and source trace", async () => {
  const households = [
    [{ age: 35 }],
    [{ age: 35 }, { age: 40 }],
    [{ age: 35 }, { age: 10, child: true }],
    [
      { age: 35 },
      { age: 40 },
      { age: 10, child: true },
      { age: 17, child: true },
    ],
  ];
  for (const [i, premium] of [1270.98, 2541.96, 2160.67, 3622.29].entries()) {
    const extra = {
      fips_code: "36061",
      zip_code: "10001",
      ids: ["11177NY0220001"],
      applicants: households[i],
    };
    const result = await search(db, "medical", extra),
      plan = result.body.plans[0];
    expect(plan).toMatchObject({
      id: "11177NY0220001",
      premium,
      on_market: null,
      off_market: null,
      plan_market: null,
      // State publications have a known source enum, independent of exchange flags.
      source: "state",
      premium_source: "state",
      premiums_by_applicant: households[i]!.map((member) => ({
        age: member.age,
        child: "child" in member && member.child === true,
        smoker: false,
        premium: null,
        composite_rated: false,
        waived_for_total: null,
      })),
      service_area_id: null,
    });
    expect(result.gaps.split(/,\s*/)).toContain("state_filed_tier");
    expect(result.gaps).toContain("exchange_status_unknown");
    expect(result.body.meta.premium_tax_credit).toBeNull();
    const changed = await search(db, "medical", {
      ...extra,
      applicants: households[i]!.map((m) => ({
        ...m,
        age: m.age < 18 ? 25 : 64,
        smoker: true,
      })),
    });
    expect(changed.body.plans[0].premium).toBe(premium);
  }
  const all = await search(db, "medical", {
    fips_code: "36061",
    zip_code: "10001",
    sort: "premium",
  });
  const page = await search(db, "medical", {
    fips_code: "36061",
    zip_code: "10001",
    sort: "premium",
    page: 2,
    per_page: 1,
  });
  expect(all.body.meta.total).toBe(3);
  expect(page.body.plans).toEqual(all.body.plans.slice(1, 2));
  if (process.env.OPENPLANS_REFERENCE_CAPTURES_DIR) {
    const capture = JSON.parse(
      await readFile(
        join(
          process.env.OPENPLANS_REFERENCE_CAPTURES_DIR,
          "plans/search/36061/individual/23ee8bdcc150.json",
        ),
        "utf8",
      ),
    );
    assertShape(capture, all.body, "$", true);
  }
});

it("VT plan_key is an opaque plan.id, never a HIOS identifier; aliases and ids filtering roundtrip", async () => {
  for (const [zip, fips] of [
    ["05401", "50007"],
    ["05602", "50023"],
  ]) {
    const result = await search(db, "medical", {
      zip_code: zip,
      fips_code: fips,
      ids: [vt],
    });
    expect(result.body.plans).toHaveLength(1);
    expect(result.body.plans[0]).toMatchObject({
      id: vt,
      premium: 1345.45,
      identifiers: [],
      // The filed tier total has no per-member price; the requested member stays listed.
      premiums_by_applicant: [
        {
          age: 35,
          child: false,
          smoker: false,
          premium: null,
          composite_rated: false,
          waived_for_total: null,
        },
      ],
    });
    expect(result.gaps).toContain("hios_ids_unavailable");
    expect(result.gaps).toContain("plan_ids_are_native_plan_keys");
  }
  for (const route of ["/plans/", "/plans/medical/"]) {
    const response = await createApp(db).request(
      BASE + route + encodeURIComponent(vt),
      { headers },
    );
    expect(response.status).toBe(200);
    expect(
      ((await response.json()) as { plan: Record<string, unknown> }).plan,
    ).toMatchObject({
      id: vt,
      identifiers: [],
    });
    expect(response.headers.get("x-openplans-gaps")).toContain(
      "state_filed_tier",
    );
  }
  const absent = await search(db, "medical", {
    fips_code: "50007",
    ids: ["BCBSVT:Not a published plan"],
  });
  expect(absent.body.plans).toEqual([]);
  expect(absent.gaps).toContain(
    "public_plan_unavailable:BCBSVT:Not a published plan",
  );
  expect(
    matchesMedicalSearchId(
      { base_plan_id: vt, hios_id: "13627VT0340003" },
      "13627VT0340003",
    ),
  ).toBe(true);
  expect(
    matchesMedicalSearchId({ base_plan_id: vt, hios_id: "13627VT0340003" }, vt),
  ).toBe(true);
  expect(
    matchesMedicalSearchId(
      { base_plan_id: "BCBSVT:Unmatched", hios_id: null },
      "99999VT9999999",
    ),
  ).toBe(false);
  expect(
    matchesMedicalSearchId(
      { base_plan_id: "87226TX0100013" },
      "87226TX0100013",
    ),
  ).toBe(true);
});

it("negative control: dropping HIOS matching rejects an available Vermont HIOS id", () => {
  const mutant = matchesMedicalSearchId
    .toString()
    .replace(" || plan.hios_id === id", "");
  const broken = new Function(
    `return (${mutant})`,
  )() as typeof matchesMedicalSearchId;
  expect(
    broken({ base_plan_id: vt, hios_id: "13627VT0340003" }, "13627VT0340003"),
  ).toBe(false);
  expect(
    matchesMedicalSearchId(
      { base_plan_id: vt, hios_id: "13627VT0340003" },
      "13627VT0340003",
    ),
  ).toBe(true);
});

it("negative control: compiled VT mapper mutant filling a HIOS-shaped id fails the same identity contract", async () => {
  const view = await planView(db, (await findPlan(db, vt, 2026))!);
  const contract = (mapper: typeof mapPlan) => {
    const p = mapper(view, vt);
    assert.equal(p.id, vt, "VT identity must retain the native plan_key");
    assert.deepEqual(p.identifiers, [], "no published HIOS identifier exists");
  };
  contract(mapPlan);
  const source = await readFile(
    new URL("../../../src/compat/v1/mapping.ts", import.meta.url),
    "utf8",
  );
  const mutant = source.replace(
    "id: requestedId,",
    "id: view.base_plan_id === null ? '12345VT0000001' : requestedId,",
  );
  expect(mutant).not.toBe(source);
  const path = join(directory, "synthetic-vt-hios-mutant.cjs");
  await writeFile(
    path,
    ts.transpileModule(mutant, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
  );
  expect(() => contract(createRequire(import.meta.url)(path).mapPlan)).toThrow(
    "VT identity must retain the native plan_key",
  );
});

it("maps NUCC names only when native taxonomy_status is known, and retains gaps for an unknown code", async () => {
  await db.exec(`INSERT INTO npi_provider(npi,entity_type,in_scope,state_filter,data_date,snapshot_id)
    VALUES('1000000000','1',true,'TX','2026-11-07','facade-census-cut');
    INSERT INTO npi_taxonomy VALUES('1000000000',1,'207Q00000X',true,'TX','facade-census-cut');`);
  const path = fileURLToPath(
    new URL("../../fixtures/taxonomy/nucc.csv", import.meta.url),
  );
  const bytes = await readFile(path),
    sha256 = createHash("sha256").update(bytes).digest("hex");
  const url = "https://www.nucc.org/images/stories/CSV/nucc_taxonomy_261.csv";
  await importTaxonomy(db, {
    version: "26.1",
    url,
    path,
    metadata: {
      snapshot_id: sha256,
      source: "nucc-provider-taxonomy",
      url,
      final_url: url,
      redirect_chain: [],
      status: 200,
      content_type: "text/csv",
      etag: null,
      last_modified: null,
      sha256,
      bytes: bytes.length,
      fetched_at: "2026-11-07T00:00:00Z",
    },
  });
  const response = await createApp(db).request(BASE + "/specialties", {
    headers,
  });
  expect(await response.json()).toEqual({
    meta: { total: 1 },
    specialties: [
      {
        id: "207Q00000X",
        code: "207Q00000X",
        name: "Family Medicine Physician",
        display_name: "Family Medicine Physician",
        taxonomy_source: "nucc",
        category: "Family Medicine",
        sub_specialty: null,
      },
    ],
  });
  expect(response.headers.get("x-openplans-gaps")).not.toContain(
    "specialty_descriptions_unavailable",
  );
  const detail = await createApp(db).request(`${BASE}/providers/1000000000`, {
    headers,
  });
  expect(((await detail.json()) as any).provider).toMatchObject({
    specialty: "Family Medicine Physician",
    npi_specialty: { name: "Family Medicine Physician" },
  });
  expect(detail.headers.get("x-openplans-gaps")).not.toContain(
    "specialty_descriptions_unavailable",
  );
  await rollback(async (tx) => {
    await tx.query(
      "INSERT INTO npi_taxonomy VALUES('1000000000',2,'000000000X',false,'TX','facade-census-cut')",
    );
    const response = await createApp(tx).request(BASE + "/specialties", {
      headers,
    });
    const specialties = ((await response.json()) as any).specialties;
    expect(specialties).toHaveLength(2);
    expect(specialties.find((s: any) => s.id === "000000000X").name).toBeNull();
    expect(specialties.find((s: any) => s.id === "207Q00000X").name).toBe(
      "Family Medicine Physician",
    );
    expect(response.headers.get("x-openplans-gaps")).toContain(
      "specialty_descriptions_unavailable",
    );
  });
  // Synthetic contradictory metadata: status is authoritative, not a stray name.
  const rows = [
    {
      npi: "1000000000",
      addresses: [{}],
      taxonomy: [
        {
          code: "207Q00000X",
          taxonomy_status: "unknown_code",
          taxonomy_display_name: "Synthetic unproved name",
        },
      ],
    },
  ];
  expect(mapProviders(rows)[0]!.npi_specialty.name).toBeNull();
});

it("ZIP geography supplies state identities outside TX without vendor live/exchange flags", async () => {
  for (const [zip, state, name] of [
    ["10001", "NY", "New York"],
    ["05401", "VT", "Vermont"],
  ]) {
    const response = await createApp(db).request(
      `${BASE}/zip_counties?zip_prefix=${zip}`,
      { headers },
    );
    expect(response.status).toBe(200);
    const result = (await response.json()) as any;
    expect(result.states[0]).toMatchObject({
      code: state,
      name,
      live_for_consumers: null,
    });
    expect(result.counties.every((c: any) => c.state_code === state)).toBe(
      true,
    );
  }
});
