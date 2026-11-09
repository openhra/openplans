import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/app.js";
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
async function rollback(run: (tx: SqlSession) => Promise<void>) {
  const marker = new Error("synthetic dental rollback");
  try {
    await h.db.transaction(async (tx) => {
      await seed(tx);
      await run(tx);
      throw marker;
    });
  } catch (e) {
    if (e !== marker) throw e;
  }
}
async function benchmark(tx: SqlSession, ages = "40,10") {
  const response = await createApp(tx, { premiumToken: TOKEN }).request(
    `/v1/benchmark?zip=77002&year=2026&ages=${ages}`,
    { headers },
  );
  expect(response.status).toBe(200);
  return (await response.json()) as any;
}
function assertChild(result: any) {
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
        result.pediatric_dental.evidence[0].attribute_rows.length,
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
