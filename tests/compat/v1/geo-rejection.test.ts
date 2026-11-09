import { afterAll, beforeAll, expect, it } from "vitest";
import { createApp } from "../../../src/api/app.js";
import { resolveLocation } from "../../../src/api/repository.js";
import { geoSetup } from "../../api/geo-helpers.js";
import { BASE, headers, TOKEN } from "./helpers.js";

let h: Awaited<ReturnType<typeof geoSetup>>;
beforeAll(async () => {
  h = await geoSetup();
  process.env.OPENPLANS_COMPAT_API_KEY = TOKEN;
});
afterAll(async () => {
  await h?.close();
});
const search = (zip: string, county: string, page = 1) =>
  createApp(h.db).request(BASE + "/plans/medical/search", {
    method: "POST",
    headers,
    body: JSON.stringify({
      zip_code: zip,
      fips_code: county,
      page,
      per_page: 50,
      sort: "premium",
      market: "individual",
      enrollment_date: "2026-01-01",
      applicants: [{ age: 35, smoker: false }],
    }),
  });

it("accepts all seven FL pages at their exact source-verified intersection, preserving Lake County", async () => {
  expect(
    await resolveLocation(h.db, { zip: "34787", county: "12069" }),
  ).toMatchObject({ county: "12069" });
  for (let page = 1; page <= 7; page++) {
    const response = await search("34787", "12069", page);
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body).toHaveProperty("plans");
    expect(body).not.toHaveProperty("error");
    // This geography-only seed has no FL catalog; acceptance must not borrow Orange plans.
    expect(body.plans).toEqual([]);
    expect(response.headers.get("x-openplans-gaps")).toContain(
      "no_public_plans_for_location_and_year",
    );
  }
});

it("ZIP lookup and search agree on every sourced multi-county intersection", async () => {
  const response = await createApp(h.db).request(
    BASE + "/zip_counties?zip_prefix=34787",
    { headers },
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as any;
  expect(body.counties.map((c: any) => c.fips_code)).toEqual([
    "12069",
    "12095",
  ]);
  expect(body.zip_counties.map((c: any) => c.source)).toEqual(["zcta", "zcta"]);
  expect(response.headers.get("Link")).toContain("/v1/zip-counties?zip=34787");
  for (const county of body.counties)
    expect((await search("34787", county.fips_code)).status).toBe(200);
});

it("negative controls: invalid county and single-county ZIP mismatch remain HTTP 400", async () => {
  for (const [zip, county] of [
    ["34787", "12999"],
    ["34786", "12069"],
  ]) {
    const response = await search(zip!, county!);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "ZIP_COUNTY_MISMATCH", field: "county" },
    });
  }
});
