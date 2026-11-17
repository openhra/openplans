import { QUOTE_PAGE_SIZE, quotePlans } from "../../../dist/services/quotes.js";
/** Offline equality proof on a disposable copy of the cached full TX public catalog. */
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import {
  database,
  portableMigrations,
} from "../../../scripts/oracle/negative-controls.mjs";
import { migrate } from "../../../dist/db/migrate.js";
import { lowestInput } from "../../../dist/api/handy.js";
import {
  enumerateSilverOffers,
  enumerateHouseholdOffers,
} from "../../../dist/services/offer-cohort.js";
import { handyManifest } from "../../../dist/db/handy-repository.js";
import { lowestPremiums } from "../../../dist/services/handy.js";
import { countyPlans, resolveLocation } from "../../../dist/api/repository.js";
import { premiumRequest } from "../../../dist/api/validation.js";
import { ratePremium } from "../../../dist/services/premiums.js";
import { familyOffer } from "../../../dist/services/coverage-family.js";
import { requestReads } from "../../../dist/services/request-reads.js";
import { importDataDirectory } from "../../../dist/ingest/puf/import-source.js";

const root = importDataDirectory();
const reports = resolve(
  process.env.OPENPLANS_COMPARE_REALDATA_REPORT_DIR ??
    join(root, "work", "gvi1"),
);
await mkdir(reports, { recursive: true });
const scratch = await mkdtemp(join(reports, "disposable-tx-"));
let db;
const report = {
  passed: false,
  source: "puf-pglite-p6d-2026-TX",
  cases: [],
  snapshots: [],
};
try {
  const path = join(scratch, "database");
  await cp(join(root, report.source), path, {
    recursive: true,
    dereference: true,
    mode: constants.COPYFILE_FICLONE,
  });
  db = database(new PGlite(path));
  await migrate(db, await portableMigrations(join(scratch, "migrations")));
  report.snapshots = (
    await db.query(
      "SELECT snapshot_id,sha256 FROM snapshot WHERE validation_state='ACTIVE' ORDER BY snapshot_id",
    )
  ).rows;
  for (const age of [21, 40, 64]) {
    const input = lowestInput({
      zip: "77002",
      county: "48201",
      year: 2026,
      age,
    });
    const complete = await enumerateSilverOffers(
      db,
      input,
      await handyManifest(db),
      { unknown: [], consumeOffer() {} },
    );
    assert.equal(complete.status, "calculated");
    const distribution = await enumerateHouseholdOffers(db, {
      zip: input.zip,
      county: input.county,
      year: input.year,
      age,
    });
    assert.equal(distribution.status, "calculated");
    const location = await resolveLocation(db, input);
    const plans = (
      await countyPlans(db, input.county, input.year, input.zip)
    ).filter(
      (plan) => plan.on_exchange && plan.metal.toLowerCase() === "silver",
    );
    const reads = requestReads(db);
    reads.plan(plans);
    const expected = [];
    let excluded = 0;
    for (const plan of plans) {
      const attributes = (await reads.exchangeAttributes(plan)).rows;
      const eligible = familyOffer(attributes, age >= 21, age < 21);
      if (eligible === false) {
        excluded++;
        continue;
      }
      assert.equal(eligible, true);
      const request = premiumRequest({
        ...input,
        plan_ids: [plan.base_plan_id],
        members: [{ age, tobacco: false, relationship: "subscriber" }],
      });
      const { estimate } = await ratePremium(
        db,
        plan,
        plan.base_plan_id,
        request,
        location,
        reads,
      );
      assert.equal(estimate.status, "rated");
      const actual = complete.provenance.candidates.find(
        (candidate) => candidate.plan_id === plan.base_plan_id,
      );
      assert(actual);
      assert.equal(actual.monthly_cents, estimate.total_cents);
      assert.deepEqual(actual.members, estimate.members);
      assert.equal(actual.status, estimate.status);
      assert.deepEqual(actual.rate_rows_used, estimate.rate_rows_used);
      assert.deepEqual(
        complete.provenance.evidence[actual.evidence_ref],
        estimate.provenance,
      );
      assert.deepEqual(
        complete.provenance.evidence[actual.rating_area_ref],
        estimate.rating_area_provenance,
      );
      expected.push({
        plan_id: plan.base_plan_id,
        cents: estimate.total_cents,
      });
    }
    assert.equal(expected.length, complete.provenance.candidates.length);
    assert(
      expected.length > QUOTE_PAGE_SIZE,
      "Full catalog must exercise offers beyond page one",
    );
    const paged = [];
    let quotePage = 1;
    do {
      const page = await quotePlans(db, {
        zip: input.zip,
        county: input.county,
        year: input.year,
        metal: "silver",
        members: [{ age, relationship: "subscriber", tobacco: false }],
        page: quotePage,
      });
      paged.push(...page.quotes);
      quotePage = page.next_page;
    } while (quotePage);
    assert(
      paged
        .slice(QUOTE_PAGE_SIZE)
        .some((row) => expected.some((offer) => offer.plan_id === row.plan_id)),
      "No included offer beyond public quote page one",
    );
    for (const expectedOffer of expected) {
      const quote = paged.find((row) => row.plan_id === expectedOffer.plan_id);
      assert(quote, "Public quote pages omitted an offer");
      assert.equal(quote.total_cents, expectedOffer.cents);
      assert.equal(quote.status, "rated");
      assert.deepEqual(
        quote.members,
        complete.provenance.candidates.find(
          (row) => row.plan_id === expectedOffer.plan_id,
        ).members,
      );
    }
    assert.deepEqual(distribution.denominator, {
      unit: "distinct_base_plan",
      candidate_count: plans.length,
      rated_count: expected.length,
      excluded_count: excluded,
      unknown_count: 0,
    });
    const values = expected.map((row) => row.cents).sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    const medianNumerator =
      BigInt(values[middle]) +
      (values.length % 2 ? 0n : BigInt(values[middle - 1]));
    const medianDenominator = values.length % 2 ? 1n : 2n;
    const stats = distribution.statistics;
    assert.equal(
      BigInt(stats.median.numerator) * medianDenominator,
      medianNumerator * BigInt(stats.median.denominator),
    );
    assert.equal(
      BigInt(stats.mean.numerator) * BigInt(values.length),
      values.reduce((sum, value) => sum + BigInt(value), 0n) *
        BigInt(stats.mean.denominator),
    );
    assert.equal(
      stats.lowest_cents,
      (await lowestPremiums(db, input, { slow: true })).lowest.monthly_cents,
    );
    const lastPage = Math.ceil(
      expected.length / distribution.evidence.page_size,
    );
    const last = await enumerateHouseholdOffers(db, {
      zip: input.zip,
      county: input.county,
      year: input.year,
      age,
      evidence_page: lastPage,
      data_generation: distribution.data_generation,
    });
    assert.deepEqual(last.statistics, stats);
    assert.deepEqual(
      last.evidence.candidates.map((row) => row.plan_id),
      complete.provenance.candidates
        .slice((lastPage - 1) * distribution.evidence.page_size)
        .map((row) => row.plan_id),
    );
    const changed = structuredClone(complete.provenance.candidates);
    changed[0].monthly_cents++;
    assert.throws(() =>
      assert.deepEqual(changed, complete.provenance.candidates),
    );
    report.cases.push({
      age,
      candidate_count: plans.length,
      rated_count: expected.length,
      excluded_count: excluded,
      statistics: stats,
      data_generation: distribution.data_generation,
      checks: [
        "all direct premiums, statuses, member rate rows and source evidence exact",
        "minimum exact",
        "rational mean and median exact",
        "last evidence page exact",
        "one_cent_quote_mutant rejected",
      ],
    });
  }
  report.passed = true;
} finally {
  await db?.close();
  await rm(scratch, { recursive: true, force: true });
  await writeFile(
    join(reports, "realdata.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
}
console.log(
  `PASS: full TX Silver distribution, ${report.cases.length} ages, ${report.cases.map((row) => row.rated_count).join("/")} offers`,
);
