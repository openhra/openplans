import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "../../src/db/database.js";
import { createApp } from "../../src/api/app.js";
import { importProviders } from "../../src/ingest/qhp/provider.js";
import { fixture, scope, setup } from "../ingest/qhp/provider-helpers.js";
import { saveResult } from "../../src/ingest/geocode/repository.js";
import { haversineMiles } from "../../src/domain/geo/index.js";
import type { Address } from "../../src/ingest/geocode/address.js";

// All identifiers, associations, location offsets and names here are synthetic test mutations of a public cut.
describe("provider API: record scope, distance and source evidence", () => {
  let h: Awaited<ReturnType<typeof setup>>,
    app: ReturnType<typeof createApp>,
    plan: string;
  const lat = 29.7105,
    lon = -95.3973;
  const nearNpi = "1000000000",
    farNpi = "1000000001",
    missingNpi = "1000000002",
    approxNpi = "1000000003",
    nonExactNpi = "1000000004";
  let providers: any[];
  const get = async (url: string) => {
    const response = await app.request(url);
    return { status: response.status, body: (await response.json()) as any };
  };
  const post = async (body: unknown) => {
    const response = await app.request("/v1/provider-participation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  beforeAll(async () => {
    h = await setup(
      process.env.P3D_POSTGIS_URL
        ? createDatabase(process.env.P3D_POSTGIS_URL)
        : undefined,
    );
    app = createApp(h.db, {});
    const hasPostgis =
      (
        await h.db.query(
          `SELECT 1 FROM information_schema.columns WHERE table_name='address_point' AND column_name='point'`,
        )
      ).rows.length > 0;
    expect(hasPostgis).toBe(Boolean(process.env.P3D_POSTGIS_URL));
    const source = (await fixture("records"))[0];
    plan = source.plans.find((p: any) =>
      h.catalog.plans.some((c: any) => c.base_plan_id === p.plan_id),
    ).plan_id;
    providers = [nearNpi, farNpi, missingNpi, approxNpi, nonExactNpi].map(
      (npi, i) => ({
        ...structuredClone(source),
        npi,
        name: { first: "Synthetic", last: `Provider ${i}` },
        type: "INDIVIDUAL",
        specialty: ["Synthetic Family Medicine"],
        plans: [
          structuredClone(source.plans.find((p: any) => p.plan_id === plan)),
        ],
        addresses: [
          {
            address: `Synthetic issuer address ${i}`,
            city: "HOUSTON",
            state: "TX",
            zip: "77030",
          },
        ],
      }),
    );
    // Same NPI, separate issuer record B, no association to this plan.
    providers.push({
      ...structuredClone(providers[0]),
      plans: [],
      addresses: [
        {
          address: "Synthetic issuer address B",
          city: "HOUSTON",
          state: "TX",
          zip: "77030",
        },
      ],
    });
    await h.replace(providers);
    await importProviders(h.db, scope);
    await h.db
      .exec(`INSERT INTO geo_import(state,plan_year,relationship_snapshot_id,centroid_snapshot_id,rating_snapshot_id)
      VALUES ('TX',2026,'catalog','catalog','catalog')`);
    await h.db.query(
      `INSERT INTO zcta_centroid VALUES ('77030',$1,$2,'catalog',2)`,
      [lat, lon],
    );
    for (const [i, p] of providers.slice(0, 5).entries()) {
      await h.db.query(
        `INSERT INTO npi_provider(npi,entity_type,first_name,last_name,in_scope,state_filter,data_date,snapshot_id)
        VALUES ($1,'1','Synthetic',$2,true,'TX','2026-11-07','catalog')`,
        [p.npi, `Provider ${i}`],
      );
      await h.db.query(
        `INSERT INTO npi_taxonomy VALUES ($1,1,'207Q00000X',true,'TX','catalog')`,
        [p.npi],
      );
      await h.db.query(
        `INSERT INTO npi_address(npi,kind,ordinal,line_1,city,state,zip5,snapshot_id)
        VALUES ($1,'practice',0,'Synthetic NPPES B','HOUSTON','TX','77030','catalog')`,
        [p.npi],
      );
      const row = (
        await h.db.query<{ record_id: string; snapshot_id: string }>(
          "SELECT record_id,snapshot_id FROM qhp_provider_record WHERE source_record=$1",
          [i],
        )
      ).rows[0]!;
      const a: Address = {
        ...p.addresses[0],
        npi: p.npi,
        kind: "issuer",
        ordinal: 0,
        line_1: p.addresses[0].address,
        line_2: null,
        zip5: "77030",
        snapshot_id: row.snapshot_id,
        source_table: "qhp_provider_address",
        source_row: `${row.snapshot_id}:${row.record_id}:0`,
      };
      if (i !== 2) {
        function latitudeOffset() {
          if (i === 1) {
            return 8 / 69.093;
          } else if (i === 4) {
            return 2 / 69.093;
          } else {
            return 0;
          }
        }
        await saveResult(
          h.db,
          a,
          {
            id: String(i + 1),
            status: "Match",
            quality: i === 4 ? "Non_Exact" : "Exact",
            latitude: lat + latitudeOffset(),
            longitude: lon,
          },
          "catalog",
        );
      }
      // NPPES B is 8 miles away even when issuer A is at the origin.
      await saveResult(
        h.db,
        {
          ...a,
          source_table: "npi_address",
          source_row: `${p.npi}:practice:0`,
          line_1: "Synthetic NPPES B",
          snapshot_id: "catalog",
        },
        {
          id: "1",
          status: "Match",
          quality: "Exact",
          latitude: lat + 8 / 69.093,
          longitude: lon,
        },
        "catalog",
      );
      if (i === 3)
        await h.db.query(
          `UPDATE address_point SET method='zcta_centroid',match_status='No_Match',match_quality=NULL,
        centroid_snapshot_id='catalog' WHERE source_table='qhp_provider_address' AND source_row=$1`,
          [a.source_row],
        );
    }
    await h.db
      .query(`INSERT INTO provider_taxonomy(code,display_name,classification,specialization,version,snapshot_id)
      VALUES ('207Q00000X','Family Medicine Physician','Family Medicine',NULL,'26.1','catalog')`);
    await h.db.query(
      `INSERT INTO npi_taxonomy VALUES ($1,2,'999999999X',false,'TX','catalog')`,
      [missingNpi],
    );
  });
  afterAll(async () => {
    await h?.close();
  });
  it("returns nearest issuer records with source point quality, distance, unresolved tiers and unlocated count", async () => {
    const result = await get(
      `/v1/providers?plan_id=${plan}&year=2026&zip=77030&radius_miles=5&taxonomy=207Q00000X`,
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      total: 3,
      page: 1,
      next_page: null,
      provider_coverage: { status: "complete" },
      meta: { unlocated: 1, origin: { method: "zcta_centroid" } },
    });
    const rows = result.body.providers;
    expect(rows.map((p: any) => p.npi).sort()).toEqual(
      [nearNpi, approxNpi, nonExactNpi].sort(),
    );
    expect(rows.map((p: any) => p.distance_miles)).toEqual(
      [...rows.map((p: any) => p.distance_miles)].sort(
        (a: number, b: number) => a - b,
      ),
    );
    expect(
      rows.every(
        (p: any) =>
          p.participation === "listed_participating" &&
          p.participation_scope === "provider_record",
      ),
    ).toBe(true);
    expect(rows[0].evidence[0]).toMatchObject({
      network_tier: "PREFERRED",
      tier_status: "unresolved",
    });
    expect(rows.find((p: any) => p.npi === nearNpi).addresses[0]).toMatchObject(
      {
        source: "qhp_provider_address",
        method: "census_geocoder",
        precision: "exact",
        participation: "not_evaluated",
      },
    );
    expect(
      rows.find((p: any) => p.npi === approxNpi).addresses[0],
    ).toMatchObject({ method: "zcta_centroid", precision: "approximate" });
    expect(
      rows.find((p: any) => p.npi === nonExactNpi).addresses[0],
    ).toMatchObject({ method: "census_geocoder", precision: "non_exact" });
    expect(
      (
        await get(
          `/v1/providers?plan_id=${plan}&year=2026&name=Synthetic&type=individual&specialty=Family`,
        )
      ).body.total,
    ).toBe(5);
    expect(
      (await get(`/v1/providers?plan_id=${plan}&year=2026&page=2`)).body
        .providers,
    ).toEqual([]);
  });
  it("negative control: five miles excludes an eight-mile provider; a degrees-as-miles mutant fails the contract", async () => {
    expect(haversineMiles(lat, lon, lat + 8 / 69.093, lon)).toBeCloseTo(8, 1);
    const result = await get(
      `/v1/providers?plan_id=${plan}&year=2026&lat=${lat}&lon=${lon}&radius_miles=5`,
    );
    const contract = (rows: { npi: string }[]) =>
      expect(rows.some((p) => p.npi === farNpi)).toBe(false);
    contract(result.body.providers);
    const mutantDistance = Math.abs(lat + 8 / 69.093 - lat);
    expect(mutantDistance).toBeLessThan(5);
    expect(() =>
      contract([...result.body.providers, { npi: farNpi }]),
    ).toThrow();
  });
  it("negative D7: NPPES B and another issuer record B never inherit record A membership", async () => {
    const result = await get(
      `/v1/providers?plan_id=${plan}&year=2026&name=Provider%200`,
    );
    expect(result.body.providers).toHaveLength(1);
    const contract = (addresses: any[]) =>
      expect(
        addresses.every(
          (a) =>
            a.source === "qhp_provider_address" &&
            a.line_1 === "Synthetic issuer address 0" &&
            a.participation === "not_evaluated",
        ),
      ).toBe(true);
    contract(result.body.providers[0].addresses);
    expect(() =>
      contract([
        ...result.body.providers[0].addresses,
        {
          source: "npi_address",
          line_1: "Synthetic NPPES B",
          participation: "listed_participating",
        },
      ]),
    ).toThrow();
    const identity = await get(
      `/v1/providers?name=Provider%200&lat=${lat}&lon=${lon}&radius_miles=5`,
    );
    expect(identity.body).toMatchObject({
      participation: "not_evaluated",
      total: 0,
    });
    const detail = await get(`/v1/providers/${nearNpi}`);
    expect(detail.status).toBe(200);
    expect(detail.body.issuer_records).toHaveLength(2);
    expect(detail.body.identity.addresses[0]).toMatchObject({
      line_1: "Synthetic NPPES B",
      source: "npi_address",
      participation: "not_evaluated",
      latitude: lat + 8 / 69.093,
      longitude: lon,
      method: "census_geocoder",
      geocode_snapshot_id: "catalog",
    });
    expect(detail.body.plan_participations[0]).toMatchObject({
      base_hios_id: plan,
      plan_year: 2026,
      status: "listed_participating",
      participation_scope: "provider_record",
    });
    expect(
      detail.body.issuer_records
        .map((r: any) => r.plan_participations.length)
        .sort(),
    ).toEqual([0, 1]);
  });
  it("NPI detail labels centroids and omits points from an older address snapshot", async () => {
    const sourceRow = `${nearNpi}:practice:0`;
    try {
      await h.db.query(
        `UPDATE address_point SET method='zcta_centroid',match_status='No_Match',match_quality=NULL,
        centroid_snapshot_id='catalog' WHERE source_table='npi_address' AND source_row=$1`,
        [sourceRow],
      );
      const centroid = await get(`/v1/providers/${nearNpi}`);
      expect(centroid.body.identity.addresses[0]).toMatchObject({
        method: "zcta_centroid",
        centroid_snapshot_id: "catalog",
        match_quality: null,
      });
      // Planted stale observation. The address is current; its point no longer is.
      await h.db.query(
        `UPDATE address_point SET source_snapshot_id=$1 WHERE source_table='npi_address' AND source_row=$2`,
        ["registry", sourceRow],
      );
      const stale = await get(`/v1/providers/${nearNpi}`);
      expect(stale.body.identity.addresses[0]).toMatchObject({
        latitude: null,
        longitude: null,
        method: null,
        geocode_snapshot_id: null,
      });
    } finally {
      await h.db.query(
        `UPDATE address_point SET source_snapshot_id='catalog',method='census_geocoder',match_status='Match',
        match_quality='Exact',centroid_snapshot_id=NULL WHERE source_table='npi_address' AND source_row=$1`,
        [sourceRow],
      );
    }
  });
  it("identity searches have no membership claims; batch and variants share five-state classification", async () => {
    const identities = await get(
      "/v1/providers?taxonomy=207Q00000X&name=Synthetic&type=individual",
    );
    expect(identities.status).toBe(200);
    expect(identities.body.total).toBe(5);
    expect(
      identities.body.providers.every(
        (p: any) => p.participation === "not_evaluated",
      ),
    ).toBe(true);
    const family = await get(
      "/v1/providers?specialty=fAmIlY%20mEdIcInE&name=Synthetic",
    );
    expect(family.body.total).toBe(5);
    const named = family.body.providers.find((p: any) => p.npi === nearNpi);
    expect(named.taxonomy[0]).toMatchObject({
      display_name: "Family Medicine Physician",
      taxonomy_source: "nucc",
      taxonomy_display_name: "Family Medicine Physician",
      classification: "Family Medicine",
      specialization: null,
      taxonomy_status: "known",
    });
    const unknown = family.body.providers.find(
      (p: any) => p.npi === missingNpi,
    );
    expect(
      unknown.taxonomy.find((t: any) => t.code === "999999999X"),
    ).toMatchObject({
      taxonomy_display_name: null,
      classification: null,
      specialization: null,
      taxonomy_status: "unknown_code",
    });
    // Negative control: an unmapped code cannot acquire a fabricated display name.
    expect(
      unknown.taxonomy.find((t: any) => t.code === "999999999X")
        .taxonomy_display_name,
    ).not.toBe("Family Medicine Physician");
    const variant = h.catalog.variants.find(
      (v: any) => v.base_plan_id === plan,
    ).variant_plan_id;
    expect(
      (await get(`/v1/plans/${variant}/providers/${nearNpi}?year=2026`)).body,
    ).toMatchObject({
      status: "listed_participating",
      requested_plan_id: variant,
      base_hios_id: plan,
    });
    const result = await post({
      plan_ids: [plan],
      npis: [nearNpi, "1000000099"],
      year: 2026,
    });
    expect(result.status).toBe(200);
    expect(result.body.results.map((r: any) => r.status)).toEqual([
      "listed_participating",
      "not_listed",
    ]);
    expect(
      (await get(`/v1/plans/${plan}/providers/${nearNpi}?year=2027`)).body
        .status,
    ).toBe("unknown");
  });
  it.each(["empty", "absent"])(
    "serves NPPES codes without %s taxonomy and rejects name searches explicitly",
    async (mode) => {
      const rollback = new Error("rollback optional taxonomy fixture");
      await expect(
        h.db.transaction(async (tx) => {
          await tx.exec(
            mode === "empty"
              ? "DELETE FROM provider_taxonomy"
              : "DROP TABLE provider_taxonomy",
          );
          const codeOnly = createApp(tx, {});
          for (const query of [
            "taxonomy=207Q00000X",
            "specialty=207Q00000X",
            `plan_id=${plan}&year=2026&taxonomy=207Q00000X`,
          ]) {
            const response = await codeOnly.request(`/v1/providers?${query}`);
            expect(response.status).toBe(200);
            const body = (await response.json()) as any;
            expect(body.total).toBe(5);
            expect(body.providers[0].taxonomy[0]).toMatchObject({
              code: "207Q00000X",
              display_name: null,
              taxonomy_display_name: null,
              classification: null,
              specialization: null,
              taxonomy_source: "nppes_code_only",
            });
          }
          const detail = (await (
            await codeOnly.request(`/v1/providers/${nearNpi}`)
          ).json()) as any;
          expect(detail.identity.taxonomy[0]).toMatchObject({
            code: "207Q00000X",
            display_name: null,
            taxonomy_source: "nppes_code_only",
          });
          for (const query of [
            "specialty=Family",
            `plan_id=${plan}&year=2026&specialty=Family`,
            "zip=00000&specialty=Family",
          ]) {
            const response = await codeOnly.request(`/v1/providers?${query}`);
            expect(response.status).toBe(422);
            expect(await response.json()).toMatchObject({
              error: {
                code: "unsupported_without_taxonomy",
                field: "specialty",
              },
            });
          }
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    },
  );
  it("requires explicit years and validates location, bounded batches and query combinations", async () => {
    for (const url of [
      `/v1/providers?plan_id=${plan}`,
      `/v1/providers?plan_id=${plan}&year=2101`,
      "/v1/providers?radius_miles=5",
      "/v1/providers?lat=91&lon=0",
      "/v1/providers?lat=2",
      "/v1/providers?zip=77030&lat=2&lon=2",
      "/v1/providers?zip=77030&radius_miles=-1",
      "/v1/providers?lat=&lon=0",
      "/v1/providers?taxonomy=bad",
      "/v1/providers?taxonomy=207Q00000X&specialty=Family",
      "/v1/providers?name=",
      "/v1/providers?type=bad",
      "/v1/providers?page=0",
      "/v1/providers/bad",
      `/v1/plans/${plan}/providers/${nearNpi}`,
    ]) {
      expect((await get(url)).status, url).toBe(400);
    }
    expect((await get("/v1/providers/1000000099")).status).toBe(404);
    expect(
      (await get(`/v1/providers?plan_id=${plan}-99&year=2026`)).status,
    ).toBe(404);
    expect(
      (await get("/v1/providers?zip=77001&radius_miles=5")).body.status,
    ).toBe("unknown");
    for (const body of [
      null,
      { plan_ids: [], npis: [nearNpi], year: 2026 },
      { plan_ids: [plan], npis: [1000000000], year: 2026 },
      { plan_ids: [plan], npis: [nearNpi] },
      { plan_ids: [plan, plan], npis: [nearNpi], year: 2026 },
      { plan_ids: [plan], npis: [nearNpi, nearNpi], year: 2026 },
      { plan_ids: [plan], npis: [nearNpi], year: "2026" },
    ])
      expect((await post(body)).status).toBe(400);
    expect(
      (
        await app.request("/v1/provider-participation", {
          method: "POST",
          body: "{",
        })
      ).status,
    ).toBe(400);
  });
  it("truncated shards and denied discovery cannot manufacture not_listed, and coverage is per issuer/year", async () => {
    const coverage = (
      await get("/v1/data-availability?state=TX&year=2026")
    ).body.find((r: { issuer_id: string }) => r.issuer_id === "00010");
    expect(coverage).toMatchObject({
      provider_status: "available",
      provider_coverage: {
        status: "complete",
        expected_children: 1,
        complete_children: 1,
      },
    });
    await h.replace(null, '[{"type":"INDIVIDUAL"');
    const broken = await importProviders(h.db, scope);
    expect(broken.status).toBe("QUARANTINED");
    expect(
      (await get(`/v1/plans/${plan}/providers/1000000099?year=2026`)).body
        .status,
    ).toBe("unknown");
    await h.db
      .exec(`INSERT INTO qhp_index(qhp_index_id,discovery_id,issuer_id,plan_year,state,registry_snapshot_id,registry_row,status,discovered_at)
      VALUES ('synthetic-denied','synthetic-denied','00010',2026,'TX','registry',1,'access_denied',clock_timestamp())`);
    expect(
      (await get(`/v1/plans/${plan}/providers/${nearNpi}?year=2026`)).body,
    ).toMatchObject({ status: "unknown", reason: "source_access_denied" });
    expect(
      (await get("/v1/data-availability")).body.find(
        (r: { issuer_id: string }) => r.issuer_id === "00010",
      ).provider_coverage.status,
    ).toBe("access_denied");
  });
});

// Synthetic paging fixture covers both storage paths without changing publisher ingestion.
describe("provider search pagination across sparse and grouped evidence", () => {
  let h: Awaited<ReturnType<typeof setup>>, plan: string;
  beforeAll(async () => {
    h = await setup();
    const source = (await fixture("records"))[0];
    plan = source.plans.find((p: any) =>
      h.catalog.plans.some((c: any) => c.base_plan_id === p.plan_id),
    ).plan_id;
    await h.replace(
      Array.from({ length: 65 }, (_, i) => ({
        ...structuredClone(source),
        npi: null,
        name: { first: "Synthetic", last: `Paging ${i}` },
        plans: [
          structuredClone(source.plans.find((p: any) => p.plan_id === plan)),
        ],
        addresses:
          i === 64
            ? []
            : [
                {
                  address: `Synthetic paging address ${i}`,
                  city: "HOUSTON",
                  state: "TX",
                  zip: "77030",
                },
              ],
      })),
    );
    await importProviders(h.db, scope);
    // Identical lists with duplicate positive ordinals, expanded only for the returned page.
    await h.db.exec(`INSERT INTO provider_plan_group VALUES (repeat('b',64));
      INSERT INTO provider_plan_group_edge(group_id,source_plan_index,base_hios_id,plan_year,network_tier,tier_status)
      SELECT repeat('b',64),i,e.base_hios_id,e.plan_year,e.network_tier,e.tier_status
      FROM (SELECT * FROM qhp_provider_plan_legacy LIMIT 1) e CROSS JOIN generate_series(0,1) i;
      INSERT INTO provider_record_plan_group SELECT snapshot_id,record_id,repeat('b',64)
        FROM qhp_provider_record WHERE source_record>=30;
      DELETE FROM qhp_provider_plan_legacy e USING provider_record_plan_group l
        WHERE e.snapshot_id=l.snapshot_id AND e.record_id=l.record_id;
      UPDATE qhp_provider_plan SET evidence_status='explicitly_not_participating'
        WHERE record_id IN (SELECT record_id FROM qhp_provider_record ORDER BY record_id,snapshot_id LIMIT 3);
      DELETE FROM qhp_provider_plan WHERE record_id=(SELECT record_id FROM qhp_provider_record WHERE source_record=40);
      UPDATE qhp_provider_plan SET evidence_status='explicitly_not_participating'
        WHERE record_id=(SELECT record_id FROM qhp_provider_record WHERE source_record=41) AND source_plan_index=1;
      UPDATE qhp_provider_plan SET evidence_status='explicitly_not_participating'
        WHERE record_id=(SELECT record_id FROM qhp_provider_record WHERE source_record=42);
      INSERT INTO npi_provider(npi,entity_type,organization_name,in_scope,state_filter,data_date,snapshot_id)
        VALUES ('1000000098','2','BoundaryTwo',true,'TX','2026-11-07','catalog');
      UPDATE qhp_provider_record SET facility_name='Ångström Aaaaa',group_name='BoundaryOne',npi='1000000098' WHERE source_record=64;`);
  });
  afterAll(async () => {
    await h?.close();
  });
  it("filters participation before paging, counts exactly, and keeps mixed/duplicate evidence and records without addresses", async () => {
    const expected = (
      await h.db.query<{ record_id: string; snapshot_id: string }>(
        `SELECT record_id,snapshot_id
      FROM qhp_provider_plan WHERE base_hios_id=$1 AND plan_year=2026 GROUP BY record_id,snapshot_id
      HAVING bool_or(evidence_status='listed_participating') ORDER BY record_id,snapshot_id`,
        [plan],
      )
    ).rows;
    expect(expected).toHaveLength(60);
    const app = createApp(h.db, {}),
      pages = [];
    for (const page of [1, 2, 3]) {
      const response = await app.request(
        `/v1/providers?plan_id=${plan}&year=2026&page=${page}`,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as any;
      expect(body.total).toBe(expected.length);
      expect(body.next_page).toBe(
        page * 50 < expected.length ? page + 1 : null,
      );
      expect(
        body.providers.map((p: any) => ({
          record_id: p.record_id,
          snapshot_id: p.snapshot_id,
        })),
      ).toEqual(expected.slice((page - 1) * 50, page * 50));
      pages.push(...body.providers);
    }
    const namedResponse = await app.request(
      `/v1/providers?plan_id=${plan}&year=2026&name=Synthetic`,
    );
    const named = (await namedResponse.json()) as any;
    expect(namedResponse.status).toBe(200);
    expect(named.total).toBe(expected.length);
    expect(named.providers.map((p: any) => p.record_id)).toEqual(
      expected.slice(0, 50).map((p) => p.record_id),
    );
    const mixed = pages.find((p) => Number(p.source_record) === 41);
    expect(mixed).toMatchObject({ participation: "conflicting" });
    expect(mixed.evidence.map((e: any) => e.evidence_status)).toEqual([
      "listed_participating",
      "explicitly_not_participating",
    ]);
    expect(
      pages
        .find((p) => Number(p.source_record) === 43)
        .evidence.map((e: any) => e.source_plan_index),
    ).toEqual([0, 1]);
    expect(pages.find((p) => Number(p.source_record) === 64).addresses).toEqual(
      [],
    );
    for (const name of [
      "BoundaryOne BoundaryTwo",
      "BoundaryOne%BoundaryTwo",
      "BoundaryOne_BoundaryTwo",
      "Ångström",
      "aaaa",
      "Boundary",
      "One",
      "ne",
    ]) {
      const response = await app.request(
        `/v1/providers?plan_id=${plan}&year=2026&name=${encodeURIComponent(name)}`,
      );
      const body = (await response.json()) as any;
      expect(response.status).toBe(200);
      expect(body.total, name).toBe(1);
      expect(Number(body.providers[0].source_record), name).toBe(64);
      expect(body.providers[0].organization_name).toBe("BoundaryTwo");
    }
    const count = (body: any) => {
      expect(body.total).toBe(expected.length);
      expect(body.providers.map((p: any) => p.record_id)).toEqual(
        expected.slice(0, 50).map((p) => p.record_id),
      );
    };
    // Executed SQL mutant: all associations reach pagination; positive membership is checked afterwards.
    const mutant = createApp(
      {
        ...h.db,
        query: (sql, args) =>
          h.db.query(
            sql.includes("plan_records AS MATERIALIZED")
              ? sql
                  .replaceAll(
                    "AND e.evidence_status='listed_participating'",
                    "",
                  )
                  .replace("AND evidence_status='listed_participating'", "")
                  .replace(
                    "JOIN active_shards s ON s.snapshot_id=p.snapshot_id",
                    `JOIN active_shards s ON s.snapshot_id=p.snapshot_id
          WHERE EXISTS (SELECT 1 FROM qhp_provider_plan e WHERE e.record_id=p.record_id AND e.snapshot_id=p.snapshot_id
            AND e.base_hios_id=$1 AND e.plan_year=$2 AND e.evidence_status='listed_participating')`,
                  )
              : sql,
            args,
          ),
      },
      {},
    );
    const response = await mutant.request(
      `/v1/providers?plan_id=${plan}&year=2026&name=Synthetic`,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(() => count(body)).toThrow();
  });
});
