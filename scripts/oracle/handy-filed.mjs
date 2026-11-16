import assert from "node:assert/strict";
import { lowestInput } from "../../dist/api/handy.js";
import { lowestPremiums } from "../../dist/services/handy.js";
import { buildLowestPremiums } from "../../dist/worker/handy-build.js";
import { ratePremium } from "../../dist/services/premiums.js";
import { countyPlans, resolveLocation } from "../../dist/api/repository.js";
import { premiumRequest } from "../../dist/api/validation.js";

/** Existing filed-catalog checks provide an independently ranked complete public population. */
export async function checkHandyFiled(db, county, expected) {
  const input = lowestInput({ county, year: 2026, age: 40 });
  await buildLowestPremiums(db, input);
  const fast = await lowestPremiums(db, input);
  assert.equal(
    JSON.stringify(fast),
    JSON.stringify(await lowestPremiums(db, input, { slow: true })),
  );
  if (expected.status !== "calculated") {
    assert.equal(fast.status, "unknown");
    assert.equal(fast.lowest.monthly_cents, null);
    assert.equal(fast.reason, expected.reason);
    return;
  }
  assert.equal(fast.status, "calculated");
  assert.equal(fast.lowest.monthly_cents, expected.lcsp.monthly_cents);
  assert.equal(fast.candidate_count, expected.lcsp.silver_plan_count);
  assert.deepEqual(fast.ties, expected.lcsp.plan_ids);
  const plans = await countyPlans(db, county, 2026);
  const location = await resolveLocation(db, input);
  for (const candidate of fast.provenance.candidates) {
    const plan = plans.find((p) => p.base_plan_id === candidate.plan_id);
    assert(plan, "Missing filed candidate");
    const identity = candidate.plan_id.includes(":")
      ? { plan_keys: [candidate.plan_id] }
      : { plan_ids: [candidate.plan_id] };
    const request = premiumRequest({
      ...identity,
      county,
      coverage_start: "2026-01-01",
      members: [{ age: 40, tobacco: false, relationship: "subscriber" }],
    });
    const { estimate } = await ratePremium(
      db,
      plan,
      candidate.plan_id,
      request,
      location,
    );
    assert.equal(estimate.status, "rated");
    assert.equal(candidate.monthly_cents, estimate.total_cents);
    assert.deepEqual(
      fast.provenance.evidence[candidate.evidence_ref],
      estimate.provenance,
    );
    assert.deepEqual(candidate.rate_rows_used, estimate.rate_rows_used);
    assert.deepEqual(
      fast.provenance.evidence[candidate.rating_area_ref],
      estimate.rating_area_provenance,
    );
  }
}
