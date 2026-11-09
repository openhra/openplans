import { replaceSyntax } from "../../source-mutation.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { createApp } from "../../../src/api/app.js";
import { importProviders } from "../../../src/ingest/qhp/provider.js";
import { saveResult } from "../../../src/ingest/geocode/repository.js";
import { fixture, scope, setup } from "../../ingest/qhp/provider-helpers.js";
import { credentialMatches } from "../../../src/compat/v1/auth.js";
import { mapProviders } from "../../../src/compat/v1/providers.js";
import { BASE, headers, TOKEN } from "./helpers.js";
import { assertShape } from "./shape.js";

// All associations, names, addresses and identifiers in this harness are synthetic.
let h: Awaited<ReturnType<typeof setup>>,
  app: ReturnType<typeof createApp>,
  plan: string;
const npi = "1000000000";
const post = (body: unknown, route = "/providers/search") =>
  app.request(BASE + route, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
const get = (path: string) => app.request(BASE + path, { headers });
beforeAll(async () => {
  process.env.OPENPLANS_COMPAT_API_KEY = TOKEN;
  h = await setup();
  app = createApp(h.db, { premiumToken: "synthetic-native-token" });
  const source = (await fixture("records"))[0];
  plan = source.plans.find((p: any) =>
    h.catalog.plans.some((c: any) => c.base_plan_id === p.plan_id),
  ).plan_id;
  const record = {
    ...source,
    npi,
    name: { first: "Synthetic", last: "Provider" },
    type: "INDIVIDUAL",
    specialty: ["Synthetic Family Medicine"],
    plans: [source.plans.find((p: any) => p.plan_id === plan)],
    addresses: [
      {
        address: "Synthetic clinic A",
        city: "HOUSTON",
        state: "TX",
        zip: "77030",
      },
    ],
  };
  await h.replace([
    ...Array.from({ length: 51 }, () => structuredClone(record)),
    {
      ...record,
      addresses: [{ ...record.addresses[0], address: "Synthetic clinic B" }],
    },
  ]);
  await importProviders(h.db, scope);
  await h.db
    .exec(`INSERT INTO geo_import(state,plan_year,relationship_snapshot_id,centroid_snapshot_id,rating_snapshot_id)
    VALUES ('TX',2026,'catalog','catalog','catalog');
    INSERT INTO zcta_centroid VALUES ('77030',29.7105,-95.3973,'catalog',2);
    INSERT INTO npi_provider(npi,entity_type,first_name,last_name,in_scope,state_filter,data_date,snapshot_id)
      VALUES ('1000000000','1','Synthetic','Provider',true,'TX','2026-11-07','catalog');
    INSERT INTO npi_taxonomy VALUES ('1000000000',1,'207Q00000X',true,'TX','catalog');
    INSERT INTO npi_address(npi,kind,ordinal,line_1,city,state,zip5,snapshot_id)
      VALUES ('1000000000','practice',0,'Synthetic identity address','HOUSTON','TX','77030','catalog')`);
  const rows = (
    await h.db
      .query<any>(`SELECT r.record_id,r.snapshot_id,a.address FROM qhp_provider_record r
    JOIN qhp_provider_address a USING(record_id,snapshot_id)`)
  ).rows;
  for (const row of rows)
    await saveResult(
      h.db,
      {
        npi,
        kind: "issuer",
        ordinal: 0,
        line_1: row.address,
        line_2: null,
        city: "HOUSTON",
        state: "TX",
        zip5: "77030",
        snapshot_id: row.snapshot_id,
        source_table: "qhp_provider_address",
        source_row: `${row.snapshot_id}:${row.record_id}:0`,
      },
      {
        id: "1",
        status: "Match",
        quality: "Exact",
        latitude: 29.7105,
        longitude: -95.3973,
      },
      "catalog",
    );
  await h.db.query(
    `UPDATE address_point SET method='zcta_centroid',centroid_snapshot_id='catalog' WHERE source_table='qhp_provider_address'`,
  );
  await saveResult(
    h.db,
    {
      npi,
      kind: "practice",
      ordinal: 0,
      line_1: "Synthetic identity address",
      line_2: null,
      city: "HOUSTON",
      state: "TX",
      zip5: "77030",
      snapshot_id: "catalog",
      source_table: "npi_address",
      source_row: `${npi}:practice:0`,
    },
    {
      id: "1",
      status: "Match",
      quality: "Exact",
      latitude: 29.7105,
      longitude: -95.3973,
    },
    "catalog",
  );
});
afterAll(async () => {
  await h?.close();
});

describe("provider facade native integration", () => {
  it("deduplicates across native pages before pagination and retains every source ordinal", async () => {
    const response = await post({
      zip_code: "77030",
      radius: 5,
      plan_id: plan,
      taxonomy: "207Q00000X",
      search_term: "Synthetic",
      per_page: 1,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as any,
      p = body.providers[0];
    expect(body.meta.total).toBe(2);
    expect(body.providers).toHaveLength(1);
    expect(p.npis).toEqual([Number(npi)]);
    expect(p.provenance).toHaveLength(51);
    expect(
      p.provenance
        .map((r: any) => r.source_record)
        .sort((a: number, b: number) => a - b),
    ).toEqual(Array.from({ length: 51 }, (_, i) => i));
    expect(
      p.provenance.every(
        (r: any) =>
          r.evidence.length && r.address.participation === "not_evaluated",
      ),
    ).toBe(true);
    expect(response.headers.get("x-openplans-gaps")).toContain(
      "provider_origin_zip_centroid_approximate",
    );
    expect(response.headers.get("x-openplans-gaps")).toContain(
      "provider_location_zip_centroid_approximate",
    );
    const second = (await (
      await post({ zip_code: "77030", plan_id: plan, per_page: 1, page: 2 })
    ).json()) as any;
    expect(second.providers).toHaveLength(1);
    expect(second.providers[0].street_line_1).not.toBe(p.street_line_1);
    const contract = (value: any) => {
      expect(value.meta.total).toBe(2);
      expect(value.providers[0].provenance).toHaveLength(51);
    };
    contract(body);
    const duplicate = structuredClone(body);
    duplicate.meta.total = 52;
    expect(() => contract(duplicate)).toThrow();
    const lostTrace = structuredClone(body);
    lostTrace.providers[0].provenance.pop();
    expect(() => contract(lostTrace)).toThrow();
  });
  it("filters name, taxonomy, type and specialty; never silently ignores vendor coverage filters", async () => {
    for (const extra of [
      { search_term: "No match" },
      { taxonomy: "363LP0200X" },
      { type: "organization" },
      { network_ids: [1] },
      { carrier_id: "vendor-id" },
    ]) {
      const response = await post({
        zip_code: "77030",
        plan_id: plan,
        ...extra,
      });
      expect(response.status).toBe(200);
      expect(((await response.json()) as any).providers).toEqual([]);
    }
    const missing = await post({
      zip_code: "55401",
      search_term: "Mayo Clinic",
    });
    expect(missing.status).toBe(200);
    expect(((await missing.json()) as any).providers).toEqual([]);
    expect(missing.headers.get("x-openplans-gaps")).toContain(
      "zip_centroid_unavailable",
    );
    expect(
      (await post({ zip_code: "77030", plan_id: plan + "-99" })).status,
    ).toBe(404);
    for (const body of [
      null,
      [],
      {},
      { zip_code: "bad" },
      { zip_code: "77030", radius: -1 },
      { zip_code: "77030", page: 0 },
      { zip_code: "77030", type: "bad" },
      { zip_code: "77030", taxonomy: "bad" },
      { zip_code: "77030", network_ids: "bad" },
    ])
      expect((await post(body)).status).toBe(400);
  });
  it("maps detail with all locations and keeps NPPES identity addresses separate from membership", async () => {
    const response = await get(`/providers/${npi}?year=2026`);
    expect(response.status).toBe(200);
    const { provider } = (await response.json()) as any;
    expect(provider.locations).toHaveLength(3);
    expect(provider.locations[0].provenance).toHaveLength(51);
    const identity = provider.locations.find(
      (p: any) => p.street_line_1 === "Synthetic identity address",
    );
    expect(identity.provenance[0].participation).toBe("not_evaluated");
    expect(identity.provenance[0].evidence).toEqual([]);
    expect(provider.plan_participations[0].status).toBe("listed_participating");
    expect((await get("/providers/1000000099")).status).toBe(404);
    expect((await get("/providers/bad")).status).toBe(400);
  });
  it("exposes explicit unknown network containers without inventing address membership", async () => {
    const response = await get(`/providers/${npi}?year=2026`);
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    // A record/plan edge does not crosswalk external networks or their offices.
    assertShape(
      { provider: { networks: [], network_ids: [], hios_ids: [] } },
      body,
    );
    expect(body).toMatchObject({
      provider: { networks: [], network_ids: [], hios_ids: [] },
    });
    expect(response.headers.get("x-openplans-gaps")).toContain(
      "provider_network_crosswalk_unavailable",
    );
    const wrongNesting = {
      provider: { networks: { addresses: [] }, network_ids: [], hios_ids: [] },
    };
    expect(() =>
      assertShape({ provider: { networks: [] } }, wrongNesting),
    ).toThrow("expected array");
  });
  it("returns NPPES taxonomy codes with explicit unknown descriptions", async () => {
    const response = await get("/specialties");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      meta: { total: 1 },
      specialties: [
        {
          id: "207Q00000X",
          code: "207Q00000X",
          category: null,
          name: null,
          display_name: null,
          taxonomy_source: "nppes_code_only",
          sub_specialty: null,
        },
      ],
    });
    expect(response.headers.get("x-openplans-gaps")).toContain(
      "specialty_descriptions_unavailable",
    );
  });
  it.each(["empty", "absent", "loaded"])(
    "preserves codes and nullable names in the facade with %s taxonomy",
    async (mode) => {
      const rollback = new Error("rollback facade taxonomy fixture");
      await expect(
        h.db.transaction(async (tx) => {
          if (mode === "absent") await tx.exec("DROP TABLE provider_taxonomy");
          if (mode === "loaded")
            await tx.exec(`INSERT INTO provider_taxonomy(code,display_name,classification,version,snapshot_id)
        VALUES ('207Q00000X','Synthetic taxonomy display','Synthetic classification','synthetic','catalog')`);
          const api = createApp(tx, {}),
            display = mode === "loaded" ? "Synthetic taxonomy display" : null;
          const source = mode === "loaded" ? "nucc" : "nppes_code_only";
          const request = (body: unknown) =>
            api.request(BASE + "/providers/search", {
              method: "POST",
              headers,
              body: JSON.stringify(body),
            });
          for (const filter of [
            { taxonomy: "207Q00000X" },
            { specialty: "207Q00000X" },
          ]) {
            const response = await request({ zip_code: "77030", ...filter });
            expect(response.status).toBe(200);
            const body = (await response.json()) as any;
            expect(body.providers).toHaveLength(1);
            expect(body.providers[0]).toMatchObject({
              specialty: display ?? "207Q00000X",
              npi_specialty: {
                taxonomy_code: "207Q00000X",
                name: display,
                display_name: display,
                taxonomy_source: source,
              },
            });
          }
          const detail = (await (
            await api.request(BASE + `/providers/${npi}`, { headers })
          ).json()) as any;
          expect(detail.provider.npi_specialty).toMatchObject({
            taxonomy_code: "207Q00000X",
            display_name: display,
            taxonomy_source: source,
          });
          const specialties = (await (
            await api.request(BASE + "/specialties", { headers })
          ).json()) as any;
          expect(specialties.specialties[0]).toMatchObject({
            code: "207Q00000X",
            name: display,
            display_name: display,
            taxonomy_source: source,
          });
          const byName = await request({
            zip_code: "77030",
            specialty: "Synthetic taxonomy",
          });
          expect(byName.status).toBe(mode === "loaded" ? 200 : 422);
          if (mode !== "loaded")
            expect(await byName.json()).toMatchObject({
              error: { code: "unsupported_without_taxonomy" },
            });
          else expect(((await byName.json()) as any).providers).toHaveLength(1);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    },
  );
  it("delegates statewide TX radius searches outside Harris and retains exact point provenance", async () => {
    const marker = new Error("rollback synthetic Dallas identity");
    await expect(
      h.db.transaction(async (tx) => {
        await tx.exec(`INSERT INTO zcta_centroid VALUES('75201',32.787,-96.799,'catalog',3);
        INSERT INTO npi_provider(npi,entity_type,first_name,last_name,in_scope,state_filter,data_date,snapshot_id)
          VALUES('1000000001','1','Synthetic','Dallas',true,'TX','2026-11-07','catalog');
        INSERT INTO npi_address(npi,kind,ordinal,line_1,city,state,zip5,snapshot_id)
          VALUES('1000000001','practice',0,'Synthetic Dallas clinic','DALLAS','TX','75201','catalog');`);
        await saveResult(
          tx,
          {
            npi: "1000000001",
            kind: "practice",
            ordinal: 0,
            line_1: "Synthetic Dallas clinic",
            line_2: null,
            city: "DALLAS",
            state: "TX",
            zip5: "75201",
            snapshot_id: "catalog",
            source_table: "npi_address",
            source_row: "1000000001:practice:0",
          },
          {
            id: "1",
            status: "Match",
            quality: "Exact",
            latitude: 32.787,
            longitude: -96.799,
          },
          "catalog",
        );
        const response = await createApp(tx).request(
          BASE + "/providers/search",
          {
            method: "POST",
            headers,
            body: JSON.stringify({ zip_code: "75201", radius: 10 }),
          },
        );
        expect(response.status).toBe(200);
        const result = (await response.json()) as any;
        expect(result.meta.total).toBe(1);
        expect(result.providers[0]).toMatchObject({
          id: 1000000001,
          city: "DALLAS",
          distance_miles: 0,
        });
        expect(result.providers[0].provenance[0].address).toMatchObject({
          method: "census_geocoder",
          precision: "exact",
        });
        expect(result.providers[0].provenance[0].participation).toBe(
          "not_evaluated",
        );
        throw marker;
      }),
    ).rejects.toBe(marker);
  });
  it("negative control: vision stays empty; injecting an invented plan fails the same check", async () => {
    const response = await post(
      { fips_code: "48201", applicants: [{ age: 35 }], market: "small_group" },
      "/plans/vision/search",
    );
    const body = await response.json();
    const contract = (r: any) => {
      expect(r).toEqual({ meta: { total: 0 }, plans: [] });
      expect(response.headers.get("x-openplans-gaps")).toBe(
        "vision_unsupported",
      );
    };
    expect(response.status).toBe(200);
    contract(body);
    expect(() =>
      contract({
        meta: { total: 1 },
        plans: [{ id: "synthetic-invented-plan" }],
      }),
    ).toThrow();
    expect((await post({}, "/plans/vision/search")).status).toBe(400);
    const vendorIds = await post(
      {
        fips_code: "48201",
        applicants: [{ age: 35 }],
        ids: ["synthetic-vendor-vision-id"],
      },
      "/plans/vision/search",
    );
    expect(vendorIds.status).toBe(200);
    contract(await vendorIds.json());
  });
  it("requires the facade key across routes, allows preflight/version and leaves native auth unchanged", async () => {
    for (const path of [
      "/specialties",
      "/zip_counties?zip_prefix=77030",
      "/providers/1000000000",
      "/plans/UNKNOWN",
    ]) {
      expect((await app.request(BASE + path)).status).toBe(401);
      expect(
        (
          await app.request(BASE + path, {
            headers: { "X-Api-Key": "synthetic-wrong" },
          })
        ).status,
      ).toBe(401);
    }
    const good = await app.request(BASE + "/specialties", {
      headers: { ...headers, "Accept-Version": "v6" },
    });
    expect(good.status).toBe(200);
    expect(good.headers.get("Access-Control-Allow-Headers")).toBe(
      "Content-Type, X-Api-Key, Accept-Version",
    );
    const preflight = await app.request(BASE + "/providers/search", {
      method: "OPTIONS",
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(
      (await app.request("/v1/premium-estimates", { method: "POST", headers }))
        .status,
    ).toBe(401);
    expect(
      (
        await app.request("/v1/premium-estimates", {
          method: "POST",
          headers: { authorization: "Bearer synthetic-native-token" },
          body: "{}",
        })
      ).status,
    ).toBe(400);
  });
  it("negative control: a temporary compiled auth copy that skips comparison fails the auth truth table", async () => {
    const contract = (match: typeof credentialMatches) => {
      expect(match(undefined, TOKEN)).toBe(false);
      expect(match("synthetic-wrong", TOKEN)).toBe(false);
      expect(match(TOKEN, TOKEN)).toBe(true);
    };
    contract(credentialMatches);
    const source = await readFile(
      new URL("../../../src/compat/v1/auth.ts", import.meta.url),
      "utf8",
    );
    const mutant = replaceSyntax(
      source,
      "timingSafeEqual(digest(header ?? ''), digest(token)) && Boolean(header) && Boolean(token)",
      "true",
    );
    expect(mutant).not.toBe(source);
    const directory = await mkdtemp(join(tmpdir(), "openplans-auth-mutant-"));
    try {
      const file = join(directory, "synthetic-auth-mutant.cjs");
      await writeFile(
        file,
        ts.transpileModule(mutant, {
          compilerOptions: { module: ts.ModuleKind.CommonJS },
        }).outputText,
      );
      expect(() =>
        contract(createRequire(import.meta.url)(file).credentialMatches),
      ).toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it.skipIf(!process.env.OPENPLANS_REFERENCE_CAPTURES_DIR)(
    "derives provider and specialty shapes from optional captures",
    async () => {
      const root = process.env.OPENPLANS_REFERENCE_CAPTURES_DIR!;
      const capture = JSON.parse(
        await readFile(
          join(root, "providers/search/55401/mayo-clinic.json"),
          "utf8",
        ),
      );
      assertShape(
        capture,
        await (await post({ zip_code: "77030", plan_id: plan })).json(),
        "$",
        true,
      );
      const specialties = JSON.parse(
        await readFile(join(root, "specialties/all.json"), "utf8"),
      );
      assertShape(
        specialties,
        await (await get("/specialties")).json(),
        "$",
        true,
      );
    },
  );
  it("never merges different NPIs at one address or missing NPIs from different records", () => {
    const a = {
      record_id: "a",
      snapshot_id: "s",
      npi,
      addresses: [{ line_1: "Synthetic A" }],
    };
    expect(mapProviders([a, { ...a, npi: "1000000001" }])).toHaveLength(2);
    expect(
      mapProviders([{ ...a, type: "FACILITY", entity_type: "1" }])[0]!.type,
    ).toBe("organization");
    expect(
      mapProviders([
        { ...a, npi: null },
        { ...a, record_id: "b", npi: null },
      ]),
    ).toHaveLength(2);
  });
});

// Four provider request cases. Exact MN requests honestly return no loaded public
// evidence; TX equivalents exercise positive shapes.
describe("compatibility provider request list (4 cases)", () => {
  it.each([{}, { type: "individual" }, { per_page: 1, page: 1 }])(
    "search %j",
    async (extra) => {
      const response = await post({
        zip_code: "55401",
        search_term: "Mayo Clinic",
        ...extra,
      });
      expect(response.status).toBe(200);
      expect(((await response.json()) as any).providers).toEqual([]);
      expect(response.headers.get("x-openplans-gaps")).toContain(
        "zip_centroid_unavailable",
      );
      const tx = await post({
        zip_code: "77030",
        search_term: "Synthetic",
        ...extra,
      });
      expect(tx.status).toBe(200);
      const body = (await tx.json()) as any;
      expect(body.providers.length).toBeGreaterThan(0);
      expect(body.providers.every((p: any) => p.type === "individual")).toBe(
        true,
      );
      if ("per_page" in extra) expect(body.providers).toHaveLength(1);
    },
  );
  it("missing ZIP is 400", async () => {
    expect((await post({ search_term: "test" })).status).toBe(400);
  });
});
