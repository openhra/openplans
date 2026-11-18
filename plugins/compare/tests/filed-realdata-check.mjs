import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { dataDirectory } from "../../../dist/config/access.js";
import { enumerateHouseholdOffers } from "../../../dist/services/offer-cohort.js";
import { lowestInput } from "../../../dist/api/handy.js";
import { householdDistributions } from "../../../dist/services/handy.js";
import { checkHandyFiled as checkMinimum } from "../../../scripts/oracle/handy-filed.mjs";
import { countyPlans, resolveLocation } from "../../../dist/api/repository.js";
import { premiumRequest } from "../../../dist/api/validation.js";
import { ratePremium } from "../../../dist/services/premiums.js";

/** Called by the existing independent cached-source audits, using their disposable DBs. */
export async function checkHandyFiled(db, county, expected) {
  await checkMinimum(db, county, expected);
  const cases = [];
  for (const age of [21, 40, 64]) {
    const input = lowestInput({ county, year: 2026, age });
    const request = { county, year: 2026, age };
    const cell = await enumerateHouseholdOffers(db, request);
    if (expected.status !== "calculated") {
      assert.equal(cell.statistics, null);
      assert.notEqual(cell.status, "calculated");
      cases.push({ age, status: cell.status, reason: cell.reason });
      continue;
    }
    assert.equal(cell.status, "calculated");
    assert.equal(cell.statistics.lowest_cents, expected.lcsp.monthly_cents);
    assert.equal(cell.denominator.rated_count, expected.lcsp.silver_plan_count);
    const scan = await householdDistributions(
      db,
      {
        county,
        year: 2026,
        members: [{ age, tobacco: false, relationship: "subscriber" }],
      },
      { enabled: true, metals: ["silver"] },
    );
    const plans = await countyPlans(db, county, 2026);
    const location = await resolveLocation(db, input);
    for (const offer of scan.profiles[0].metals[0].candidates) {
      const rating = scan.provenance.evidence[offer.evidence_ref].rating;
      const plan = plans.find((row) => row.base_plan_id === offer.plan_id);
      assert(plan);
      const identity = offer.plan_id.includes(":")
        ? { plan_keys: [offer.plan_id] }
        : { plan_ids: [offer.plan_id] };
      const quote = premiumRequest({
        ...identity,
        county,
        coverage_start: "2026-01-01",
        members: [{ age, tobacco: false, relationship: "subscriber" }],
      });
      const { estimate } = await ratePremium(
        db,
        plan,
        offer.plan_id,
        quote,
        location,
      );
      assert.equal(estimate.status, "rated");
      assert.equal(estimate.total_cents, offer.monthly_cents);
      assert.deepEqual(rating.members, estimate.members);
      assert.equal(offer.status, estimate.status);
      assert.deepEqual(estimate.rate_rows_used, rating.rate_rows_used);
      assert.deepEqual(estimate.provenance, rating.provenance);
    }
    cases.push({
      age,
      status: cell.status,
      denominator: cell.denominator,
      statistics: cell.statistics,
      generation: cell.data_generation,
    });
  }
  const reportDir = resolve(
    process.env.OPENPLANS_COMPARE_REALDATA_REPORT_DIR ??
      join(dataDirectory(), "work/gvi1"),
  );
  await mkdir(reportDir, { recursive: true });
  await appendFile(
    join(reportDir, "filed-realdata.jsonl"),
    JSON.stringify({ county, cases }) + "\n",
  );
  console.log(`PASS: comparison filed ${county}, ${cases.length} ages`);
}
