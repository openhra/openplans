import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/app.js";
import { resolveLocation } from "../../src/api/repository.js";
import { premiumRequest } from "../../src/api/validation.js";
import {
  benchmark as benchmarkService,
  householdSubsidy,
} from "../../src/services/subsidies.js";
import { replaceSyntax, rebaseImports } from "../source-mutation.js";
import * as domain from "../../src/domain/subsidy/index.js";
import type { SqlSession } from "../../src/db/database.js";
import { setup, TOKEN } from "../compat/v1/helpers.js";

let h: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => {
  await h?.close();
});
const headers = {
  "content-type": "application/json",
  authorization: `Bearer ${TOKEN}`,
};
const silver = ["87226TX0140004", "87226TX0100011", "20069TX0100025"];
const dental = ["87226TX0990001", "87226TX0990002"];

// SYNTHETIC edits/inserts in a rolled-back fixture database only. No filed plan rows are claimed.
// 26 CFR 1.36B-3(f)(9) Example 3: medical EHB [650,620,590]; dental allocations [20,15].
async function seed(tx: SqlSession) {
  await tx.query(
    `UPDATE plan SET metal='Gold' WHERE NOT (base_plan_id = ANY($1::text[]))`,
    [silver],
  );
  for (const [i, id] of silver.entries()) {
    await tx.query(
      `UPDATE plan_attribute SET raw=raw || '{"EHBPercentTotalPremium":"1","ChildOnlyOffering":"Allows Adult and Child-Only"}'::jsonb WHERE base_plan_id=$1`,
      [id],
    );
    await tx.query(
      `UPDATE rate SET individual_rate_cents=CASE WHEN age_band='0-14' THEN $2::bigint ELSE 40000 END WHERE base_plan_id=$1`,
      [id, [25000, 22000, 19000][i]],
    );
    await tx.query(
      `DELETE FROM plan_benefit WHERE base_plan_id=$1 AND benefit_name = ANY($2::text[])`,
      [
        id,
        [
          "Dental Check-Up for Children",
          "Basic Dental Care - Child",
          "Major Dental Care - Child",
          "Orthodontia - Child",
        ],
      ],
    );
    for (const [j, name] of [
      "Dental Check-Up for Children",
      "Basic Dental Care - Child",
      "Major Dental Care - Child",
      "Orthodontia - Child",
    ].entries()) {
      await tx.query(
        `INSERT INTO plan_benefit SELECT (jsonb_populate_record(NULL::plan_benefit, to_jsonb(b) ||
        jsonb_build_object('source_row',$1::int,'base_plan_id',$2::text,'published_plan_id',$2::text || '-01',
          'benefit_name',$3::text,'raw',jsonb_build_object('IsEHB','Yes','IsCovered',$4::text)))).*
        FROM plan_benefit b LIMIT 1`,
        [9000000 + i * 10 + j, id, name, i ? "Not Covered" : "Covered"],
      );
    }
  }
  // Same synthetic issuer and service area as S1. The only pediatric rates are $50 and $40.
  await tx.exec(`INSERT INTO service_area_county SELECT (jsonb_populate_record(NULL::service_area_county,
    to_jsonb(s) || '{"source_row":9100000,"dental_only":true}'::jsonb)).*
    FROM service_area_county s WHERE issuer_id='87226' AND county_fips='48201' AND NOT dental_only LIMIT 1`);
  const area = (
    await tx.query<{ service_area_id: string }>(
      `SELECT service_area_id FROM service_area_county WHERE source_row=9100000`,
    )
  ).rows[0]!.service_area_id;
  for (const [i, id] of dental.entries()) {
    await tx.query(
      `INSERT INTO plan SELECT (jsonb_populate_record(NULL::plan,to_jsonb(p) ||
      jsonb_build_object('source_row',$1::int,'base_plan_id',$2::text,'dental_only',true,'metal','High','service_area_id',$3::text))).*
      FROM plan p WHERE base_plan_id='87226TX0100011' LIMIT 1`,
      [9100010 + i, id, area],
    );
    await tx.query(
      `INSERT INTO plan_attribute SELECT (jsonb_populate_record(NULL::plan_attribute,to_jsonb(p) ||
      jsonb_build_object('source_row',$1::int,'base_plan_id',$2::text,'published_plan_id',$2::text || '-01','dental_only',true,
        'raw',p.raw || jsonb_build_object('DentalOnlyPlan','Yes','StandardComponentId',$2::text,'PlanId',$2::text || '-01',
          'ChildOnlyOffering','Allows Adult and Child-Only','EHBPediatricDentalApportionmentQuantity',$3::text)))).*
      FROM plan_attribute p WHERE base_plan_id='87226TX0100011' LIMIT 1`,
      [9100020 + i, id, i ? "0.375" : "0.4"],
    );
    await tx.query(
      `INSERT INTO rate SELECT (jsonb_populate_record(NULL::rate,to_jsonb(r) ||
      jsonb_build_object('source_row',$1::int,'base_plan_id',$2::text,'individual_rate_cents',$3::bigint,
        'raw',r.raw || jsonb_build_object('PlanId',$2::text,'IndividualRate',$4::text)))).*
      FROM rate r WHERE base_plan_id='87226TX0100011' AND age_band='0-14' LIMIT 1`,
      [9100030 + i, id, i ? 4000 : 5000, i ? "40.00" : "50.00"],
    );
  }
}
// SYNTHETIC: move the $50 dental plan to its own service area that covers only ZIP 77002.
async function zipLimitedDental(tx: SqlSession) {
  await tx.exec(`INSERT INTO service_area_county SELECT (jsonb_populate_record(NULL::service_area_county,
    to_jsonb(s) || '{"source_row":9100001,"service_area_id":"TXS9DZ","cover_entire_state":false,
      "partial_county":true,"zip_codes":"77002"}'::jsonb)).*
    FROM service_area_county s WHERE source_row=9100000`);
  await tx.query(
    `UPDATE plan SET service_area_id='TXS9DZ' WHERE base_plan_id=$1`,
    [dental[0]],
  );
}
async function rollback(
  run: (tx: SqlSession) => Promise<void>,
  edit?: (tx: SqlSession) => Promise<void>,
) {
  const marker = new Error("synthetic dental rollback");
  try {
    await h.db.transaction(async (tx) => {
      await seed(tx);
      await edit?.(tx);
      await run(tx);
      throw marker;
    });
  } catch (e) {
    if (e !== marker) throw e;
  }
}
interface DentalBenchmark {
  status: string;
  slcsp_monthly_cents: number | null;
  benchmark_plan_ids: string[];
  lowest_silver_plans: unknown[];
  issues: string[];
  pediatric_dental: { evidence: { attribute_rows: unknown[] }[] } | null;
}
async function benchmark(tx: SqlSession, ages = "40,10") {
  const response = await createApp(tx, { premiumToken: TOKEN }).request(
    `/v1/benchmark?zip=77002&year=2026&ages=${ages}`,
    { headers },
  );
  expect(response.status).toBe(200);
  return (await response.json()) as DentalBenchmark;
}
function assertChild(result: DentalBenchmark) {
  expect(result.status).toBe("calculated");
  expect(result.slcsp_monthly_cents).toBe(64000);
  expect(result.benchmark_plan_ids).toEqual([silver[1]]);
}

describe("pediatric dental HTTP adapter on PGlite", () => {
  it("adds second-lowest pediatric EHB premium before ranking and supplies source evidence", async () =>
    rollback(async (tx) => {
      const result = await benchmark(tx);
      assertChild(result);
      expect(result.pediatric_dental).toMatchObject({
        monthlyCents: 2000,
        planIds: [dental[0]],
      });
      expect(result.lowest_silver_plans).toMatchObject([
        {
          plan_id: silver[2],
          ehb_monthly_cents: 59000,
          benchmark_monthly_cents: 61000,
          pediatric_dental_adjustment_cents: 2000,
        },
        {
          plan_id: silver[1],
          ehb_monthly_cents: 62000,
          benchmark_monthly_cents: 64000,
          pediatric_dental_adjustment_cents: 2000,
        },
      ]);
      expect(
        result.pediatric_dental!.evidence[0]!.attribute_rows.length,
      ).toBeGreaterThan(0);
    }));
  it("negative control: omit dental via a mutant calculation; the same child assertion fails", async () =>
    rollback(async (tx) => {
      const original = domain.pediatricDentalBenchmark;
      const spy = vi
        .spyOn(domain, "pediatricDentalBenchmark")
        .mockImplementation((...args) => ({
          ...original(...args),
          monthlyCents: 0,
        }));
      try {
        const result = await benchmark(tx);
        expect(result.slcsp_monthly_cents).toBe(62000);
        expect(() => assertChild(result)).toThrow();
      } finally {
        spy.mockRestore();
      }
    }));
  it("missing dental allocation names the exact PUF field and never assumes zero", async () =>
    rollback(async (tx) => {
      await tx.query(
        `UPDATE plan_attribute SET raw=raw-'EHBPediatricDentalApportionmentQuantity' WHERE base_plan_id=$1`,
        [dental[0]],
      );
      const result = await benchmark(tx);
      expect(result).toMatchObject({
        status: "requires_benchmark_adjustments",
        slcsp_monthly_cents: null,
      });
      expect(result.issues[0]).toContain(
        "EHBPediatricDentalApportionmentQuantity",
      );
    }));
  it("missing pediatric coverage evidence cannot be mistaken for no dental EHB", async () =>
    rollback(async (tx) => {
      await tx.query(
        `DELETE FROM plan_benefit WHERE base_plan_id=$1 AND benefit_name='Dental Check-Up for Children'`,
        [silver[0]],
      );
      expect(await benchmark(tx)).toMatchObject({
        status: "requires_benchmark_adjustments",
        slcsp_monthly_cents: null,
      });
    }));
  it("partial pediatric coverage remains unresolved instead of adding a full dental premium", async () =>
    rollback(async (tx) => {
      await tx.query(
        `UPDATE plan_benefit SET raw=raw || '{"IsCovered":"Covered"}'::jsonb
      WHERE base_plan_id=$1 AND benefit_name='Orthodontia - Child'`,
        [silver[1]],
      );
      expect(await benchmark(tx)).toMatchObject({
        status: "requires_benchmark_adjustments",
        slcsp_monthly_cents: null,
      });
    }));
  it("19- and 20-year-olds no longer trigger a pediatric dental adapter", async () =>
    rollback(async (tx) => {
      for (const age of [19, 20])
        expect((await benchmark(tx, `40,${age}`)).status).toBe("calculated");
    }));
});

type ServiceBenchmark = Awaited<ReturnType<typeof benchmarkService>>;
async function countyBenchmark(tx: SqlSession, ages: string) {
  const response = await createApp(tx, { premiumToken: TOKEN }).request(
    `/v1/benchmark?county=48201&year=2026&ages=${ages}`,
    { headers },
  );
  expect(response.status).toBe(200);
  return (await response.json()) as DentalBenchmark;
}
describe("county-only benchmark where a dental plan serves part of the county", () => {
  const answers = (edit?: (tx: SqlSession) => Promise<void>) => {
    let out = {} as Record<
      "countyChild" | "zipChild" | "countyAdult",
      DentalBenchmark
    >;
    return rollback(async (tx) => {
      out = {
        countyChild: await countyBenchmark(tx, "40,10"),
        zipChild: await benchmark(tx),
        countyAdult: await countyBenchmark(tx, "40"),
      };
    }, edit).then(() => out);
  };
  it("leaves the benchmark unknown with location_requires_zip; ZIP and adult-only answers unchanged", async () => {
    const plain = await answers();
    const edited = await answers(zipLimitedDental);
    expect(plain.countyChild.status).toBe("calculated");
    expect(edited.countyChild).toMatchObject({
      status: "location_requires_zip",
      issues: ["zip_limited_service_area"],
      slcsp_monthly_cents: null,
      benchmark_plan_ids: [],
      lowest_silver_plans: [],
    });
    // ZIP 77002 is inside the narrowed area, so every dental plan is still offered there.
    expect(edited.zipChild).toEqual(plain.zipChild);
    assertChild(edited.zipChild);
    // No child, no dental adjustment: the dental plan's service area does not matter.
    expect(edited.countyAdult).toEqual(plain.countyAdult);
    expect(edited.countyAdult.status).toBe("calculated");
  });
  it("the household credit carries the same status and reason", async () =>
    rollback(async (tx) => {
      const request = premiumRequest({
        plan_ids: [silver[1]],
        county: "48201",
        coverage_start: "2026-01-01",
        members: [
          { age: 40, tobacco: false, relationship: "subscriber" },
          { age: 10, tobacco: false, relationship: "child" },
        ],
        household_income_annual: 40_000,
        household_size: 2,
        tax_filing: "single",
      });
      const location = await resolveLocation(tx, request.location);
      expect(await householdSubsidy(tx, request, location)).toMatchObject({
        status: "location_requires_zip",
        reason: "zip_limited_service_area",
        slcsp_monthly_cents: null,
        estimated_monthly_tax_credit_cents: null,
      });
    }, zipLimitedDental));
  it("a planted benchmark that drops the part-county dental plan fails these checks", async () => {
    const original = new URL(
      "../../dist/services/subsidies.js",
      import.meta.url,
    );
    const directory = await mkdtemp(join(tmpdir(), "openplans-dental-mutant-"));
    try {
      const path = join(directory, "subsidies.mjs");
      await writeFile(
        path,
        rebaseImports(
          replaceSyntax(
            await readFile(original, "utf8"),
            "!location.zip && inCounty.some",
            "false && inCounty.some",
          ),
          original,
        ),
      );
      const mutant = (await import(pathToFileURL(path).href)) as {
        benchmark: typeof benchmarkService;
      };
      let real!: ServiceBenchmark, planted!: ServiceBenchmark;
      await rollback(async (tx) => {
        const request = premiumRequest({
          plan_ids: [silver[1]],
          county: "48201",
          coverage_start: "2026-01-01",
          members: [
            { age: 40, tobacco: false, relationship: "subscriber" },
            { age: 10, tobacco: false, relationship: "child" },
          ],
        });
        const location = await resolveLocation(tx, request.location);
        real = await benchmarkService(tx, request, location);
        planted = await mutant.benchmark(tx, request, location);
      }, zipLimitedDental);
      expect(real.status).toBe("location_requires_zip");
      // The mutant prices dental from the $40 plan alone and claims a lower benchmark.
      expect(planted.status).toBe("calculated");
      expect(planted.pediatric_dental!.planIds).toEqual([dental[1]]);
      expect(planted.slcsp_monthly_cents).toBeLessThan(64_000);
      expect(() =>
        expect(planted.status).toBe("location_requires_zip"),
      ).toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
