#!/usr/bin/env node
// Cache-only equality check. Cached databases are copied before opening; sources are never acquired.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { database, portableMigrations } from "./negative-controls.mjs";
import { migrate } from "../../dist/db/migrate.js";
import {
  householdHandy,
  householdDistributions,
  HOUSEHOLD_METALS,
} from "../../dist/services/handy.js";
import { allowanceEvidence } from "../../dist/services/allowance-evidence.js";
import { benchmarkSilver } from "../../dist/services/catalog.js";
import { callBenchmarkTool } from "../../dist/mcp/handy.js";
import { quotePlans } from "../../dist/services/quotes.js";
import {
  countyPlans,
  countyState,
  activeCatalog,
  exchangeAttributeRows,
} from "../../dist/api/repository.js";
import { familyOffer } from "../../dist/services/coverage-family.js";
import {
  nyLcspCatalog,
  vtLcspCatalog,
  stateRatingArea,
  refusedTemplatePlans,
} from "../../dist/ingest/state/catalog.js";
import {
  plansForCounty,
  backfillRatePlanCounts,
} from "../../dist/ingest/puf/import-repository.js";
import { importDataDirectory } from "../../dist/ingest/puf/import-source.js";
import { cachedSbe } from "../../dist/ingest/sbe/source.js";
import { importSbe } from "../../dist/ingest/sbe/import.js";
import { ingestStateRates } from "../../dist/ingest/state/index.js";

/** Oracle uses the existing quote service across every page, then independently sorts totals. */
export async function checkHouseholdEnumeration(
  db,
  input,
  fourProfiles = true,
) {
  const actual = await householdDistributions(db, input, {
    enabled: true,
    fourProfiles,
  });
  if (
    !(await activeCatalog(db, input.year, countyState(input.county))).rows
      .length
  ) {
    assert.equal(actual.status, "unknown");
    assert.equal(actual.reason, "catalog_not_loaded");
    for (const profile of actual.profiles) {
      const quoted = await quotePlans(db, {
        county: input.county,
        year: input.year,
        members: profile.members,
      });
      assert.equal(quoted.total, 0);
      assert.equal(quoted.data_availability.catalog, "unknown");
      for (const group of profile.metals) {
        assert.equal(group.status, "unknown");
        assert.equal(group.counts.catalog, null);
        assert(Object.values(group.points).every((point) => point === null));
      }
    }
    return {
      input,
      status: actual.status,
      reason: actual.reason,
      generation: actual.data_generation,
      manifest: actual.provenance.input_manifest,
      algorithm: actual.algorithm_version,
      results: actual.profiles.flatMap((profile) =>
        profile.metals.map((group) => ({
          profile: profile.id,
          members: profile.members,
          metal: group.metal,
          status: group.status,
          counts: group.counts,
          points: group.points,
          reasons: [actual.reason],
        })),
      ),
    };
  }
  const plans = await countyPlans(db, input.county, input.year, input.zip);
  const state = plans[0]?.state;
  const area = stateRatingArea(state, input.year, input.county);
  let entries;
  if (state === "NY")
    entries = await nyLcspCatalog(db, input.year, area.rating_area_id);
  if (state === "VT")
    entries = await vtLcspCatalog(db, input.year, area.rating_area_id);
  const refused = entries
    ? await refusedTemplatePlans(db, state, input.year, area.rating_area_id)
    : [];
  const countyScope = entries
    ? []
    : await plansForCounty(db, input.county, input.year, "Individual");
  const knownMetals = new Set([...HOUSEHOLD_METALS, "catastrophic"]);
  const metalOf = (plan) => {
    const entry = entries?.find((e) => e.row.plan_key === plan.base_plan_id);
    return (
      entry?.filed_identity?.metal ??
      entry?.attributes[0]?.metal ??
      plan.metal
    )
      ?.trim()
      .toLowerCase();
  };
  const unknownClassification = plans.some((plan) => {
    const entry = entries?.find((e) => e.row.plan_key === plan.base_plan_id);
    const possible = entries
      ? !entry?.filed_identity?.off_exchange && !entry?.off_exchange
      : plan.on_exchange;
    return possible && !knownMetals.has(metalOf(plan));
  });
  const results = [];
  for (const profile of actual.profiles) {
    // The sheet keeps source coordinates; inspect full household evidence as well.
    const full = fourProfiles
      ? await householdDistributions(
          db,
          {
            county: input.county,
            ...(input.zip ? { zip: input.zip } : {}),
            year: input.year,
            coverage_start: actual.coverage_start,
            members: profile.members,
          },
          { enabled: true },
        )
      : actual;
    const evidenceFor = (candidate, metal) => {
      const detailed = full.profiles[0].metals
        .find((group) => group.metal === metal)
        .candidates.find((row) => row.plan_id === candidate.plan_id);
      assert(detailed, "Missing full household candidate");
      const evidence = full.provenance.evidence[detailed.evidence_ref];
      assert.deepEqual(
        actual.provenance.evidence[candidate.evidence_ref],
        fourProfiles ? allowanceEvidence(evidence) : evidence,
      );
      return evidence;
    };
    const quotes = [];
    let page = 1;
    do {
      const result = await quotePlans(db, {
        county: input.county,
        ...(input.zip ? { zip: input.zip } : {}),
        year: input.year,
        members: profile.members,
        page,
      });
      quotes.push(...result.quotes);
      page = result.next_page;
    } while (page !== null);
    for (const metal of HOUSEHOLD_METALS) {
      const expected = [],
        exclusions = [],
        unknown = [];
      let catalog = 0;
      const blocking =
        unknownClassification ||
        refused.some((r) => !r.metals.length || r.metals.includes(metal)) ||
        (!input.zip &&
          countyScope.some(
            (p) =>
              !p.dental_only &&
              p.on_exchange &&
              p.zip_restricted &&
              (!knownMetals.has(p.metal?.toLowerCase()) ||
                p.metal?.toLowerCase() === metal),
          ));
      for (const plan of plans) {
        const entry = entries?.find(
          (e) => e.row.plan_key === plan.base_plan_id,
        );
        if (metalOf(plan) !== metal) continue;
        catalog++;
        const off = entries
          ? entry?.filed_identity?.off_exchange || entry?.off_exchange
          : !plan.on_exchange;
        if (off) {
          exclusions.push(plan.base_plan_id);
          continue;
        }
        const attrs =
          entry?.attributes ??
          (await exchangeAttributeRows(db, plan.snapshot_id, plan.base_plan_id))
            .rows;
        const eligible = familyOffer(
          attrs,
          profile.members.some((m) => m.age >= 21),
          profile.members.some((m) => m.age < 21),
        );
        if (eligible === false) {
          exclusions.push(plan.base_plan_id);
          continue;
        }
        const quote = quotes.find((q) => q.plan_id === plan.base_plan_id);
        if (
          eligible === null ||
          (entries && !entry?.exchange_evidence) ||
          quote?.status !== "rated"
        ) {
          unknown.push(plan.base_plan_id);
          continue;
        }
        assert(Number.isSafeInteger(quote.total_cents));
        expected.push({
          id: plan.base_plan_id,
          cents: quote.total_cents,
          quote,
        });
      }
      expected.sort((a, b) => a.cents - b.cents || a.id.localeCompare(b.id));
      const group = profile.metals.find((g) => g.metal === metal);
      assert.deepEqual(
        group.candidates.map((c) => c.plan_id).sort(),
        [...expected.map((c) => c.id), ...unknown].sort(),
      );
      assert.deepEqual(
        group.excluded.map((c) => c.plan_id).sort(),
        exclusions.sort(),
      );
      assert.equal(group.counts.rated, expected.length);
      if (!blocking)
        assert.equal(
          group.counts.unknown,
          unknown.length,
          `${state}/${metal}: ${group.reasons.join(",")}`,
        );
      for (const candidate of group.candidates.filter(
        (c) => c.status === "unknown",
      )) {
        const evidence = evidenceFor(candidate, metal);
        assert(evidence, "Missing unknown-candidate evidence");
        if (evidence.rating) {
          const quoted = quotes.find((q) => q.plan_id === candidate.plan_id);
          assert.equal(evidence.rating.status, quoted.status);
          assert.deepEqual(
            evidence.rating.rate_rows_used,
            quoted.rate_rows_used,
          );
          assert.deepEqual(evidence.rating.provenance, quoted.provenance);
        }
      }
      if (blocking || unknown.length) {
        assert.equal(
          group.status,
          "unknown",
          `${state}/${metal}: incomplete population`,
        );
        assert(Object.values(group.points).every((p) => p === null));
      } else {
        assert.equal(
          group.status,
          expected.length ? "calculated" : "no_plans",
          `${state}/${metal}: complete population`,
        );
        assert.equal(group.counts.catalog, catalog);
        assert.equal(group.counts.eligible, expected.length);
        assert.equal(group.counts.rated, expected.length);
        assert.equal(group.counts.unknown, 0);
        assert.equal(group.counts.excluded, exclusions.length);
        assert.deepEqual(
          group.excluded.map((c) => c.plan_id).sort(),
          exclusions.sort(),
        );
        assert.deepEqual(
          group.candidates.map((c) => [c.plan_id, c.monthly_cents]).sort(),
          expected.map((c) => [c.id, c.cents]).sort(),
        );
        // Deliberately independent rank calculation, using fractions and one-based positions.
        for (const [name, fraction] of [
          ["minimum", 0],
          ["p25", 0.25],
          ["median", 0.5],
          ["p75", 0.75],
          ["maximum", 1],
        ]) {
          const point = group.points[name];
          if (!expected.length) {
            assert.equal(point, null);
            continue;
          }
          const rank = Math.max(1, Math.ceil(fraction * expected.length));
          const selected = expected[rank - 1];
          const ties = expected.filter((e) => e.cents === selected.cents);
          assert.equal(point.rank, rank);
          assert.equal(point.denominator, expected.length);
          assert.equal(point.monthly_cents, selected.cents);
          assert.equal(point.plan_id, ties[0].id);
          assert.deepEqual(
            point.tied_plan_ids,
            ties.map((e) => e.id),
          );
          assert.equal(point.tied_plan_count, ties.length);
        }
      }
      for (const candidate of group.candidates.filter(
        (c) => c.status === "rated",
      )) {
        const quoted = expected.find((c) => c.id === candidate.plan_id)?.quote;
        assert(quoted, "Quoted candidate evidence");
        const evidence = evidenceFor(candidate, metal);
        assert(evidence, "Missing evidence reference");
        assert.equal(candidate.monthly_cents, quoted.total_cents);
        assert.deepEqual(evidence.rating.provenance, quoted.provenance);
        assert.deepEqual(evidence.rating.rate_rows_used, quoted.rate_rows_used);
        assert.deepEqual(
          evidence.rating.rating_area_provenance,
          quoted.rating_area_provenance,
        );
      }
      if (process.argv.includes("--adapters") && metal !== "platinum") {
        const request = {
          county: input.county,
          ...(input.zip ? { zip: input.zip } : {}),
          year: input.year,
          members: profile.members,
          metal,
        };
        const minimum = await householdHandy(db, request);
        assert.equal(
          minimum.lowest.monthly_cents,
          group.points.minimum?.monthly_cents ?? null,
        );
        assert.equal(
          minimum.lowest.plan_id,
          group.points.minimum?.plan_id ?? null,
        );
        assert.equal(
          minimum.lowest.tied_plan_count,
          group.points.minimum?.tied_plan_count ?? null,
        );
        assert.deepEqual(
          minimum.ties,
          group.points.minimum?.tied_plan_ids.slice(0, 50) ?? [],
        );
        assert.equal(minimum.candidate_count, group.counts.eligible);
        for (const row of minimum.provenance.candidates)
          assert(minimum.provenance.evidence[row.evidence_ref]);
        const summary = await householdHandy(db, request, true);
        assert.equal(
          summary.by_metal[0].minimum_monthly_cents,
          group.points.minimum?.monthly_cents ?? null,
        );
        assert.equal(
          summary.by_metal[0].maximum_monthly_cents,
          group.points.maximum?.monthly_cents ?? null,
        );
        assert.equal(summary.by_metal[0].plan_count, group.counts.eligible);
        const basis = {
          year: input.year,
          location: {
            county: input.county,
            ...(input.zip ? { zip: input.zip } : {}),
          },
          ages: profile.members.map((m) => m.age),
        };
        const expectedBenchmark = await benchmarkSilver(db, {
          ...basis.location,
          year: String(input.year),
          ages: basis.ages.join(","),
        });
        const projected = await callBenchmarkTool(
          {
            db,
            lowestPremiums: true,
            principal: { id: "offline-check" },
            policy: { canEstimate: () => true },
          },
          basis,
        );
        assert(!projected.isError, JSON.stringify(projected.structuredContent));
        const { basis: _basis, ...native } = projected.structuredContent;
        assert.equal(JSON.stringify(native), JSON.stringify(expectedBenchmark));
      }
      results.push({
        profile: profile.id,
        members: profile.members,
        metal,
        status: group.status,
        counts: group.counts,
        points: group.points,
        reasons: group.reasons,
      });
    }
    assert.deepEqual(
      profile.lowest_silver,
      profile.metals.find((g) => g.metal === "silver").points.minimum,
    );
    assert.deepEqual(
      profile.median_gold,
      profile.metals.find((g) => g.metal === "gold").points.median,
    );
  }
  return {
    input,
    status: actual.status,
    reason: actual.reason,
    generation: actual.data_generation,
    manifest: actual.provenance.input_manifest,
    algorithm: actual.algorithm_version,
    results,
  };
}

async function main() {
  const root = importDataDirectory(),
    destination = process.argv.includes("--report-dir")
      ? process.argv[process.argv.indexOf("--report-dir") + 1]
      : join(root, "work/stip1");
  assert(destination, "--report-dir requires a path");
  const scopeIndex = process.argv.indexOf("--scope");
  const only = scopeIndex < 0 ? undefined : process.argv[scopeIndex + 1];
  if (scopeIndex >= 0) assert(only, "--scope requires a cached scope name");
  await mkdir(destination, { recursive: true });
  const scratch = await mkdtemp(join(destination, "disposable-"));
  const report = {
    schema_version: 1,
    algorithm: "household-nearest-rank-v1",
    sources: [],
    cases: [],
    failures: [],
    controls: [],
    passed: false,
  };
  const names = await readdir(root);
  const sources = [
    ...[2025, 2026, 2027].flatMap((year) =>
      ["TX", "FL"].map((state) => `puf-pglite-p6d-${year}-${state}`),
    ),
    "puf-pglite-p6d-2026-AK",
    "sbe-pglite-2026-GA",
    "sbe-pglite-2027-GA",
  ].filter((name) => names.includes(name));
  try {
    const migrations = await portableMigrations(join(scratch, "migrations"));
    const selected = [...sources, "NY", "VT"].filter(
      (source) => !only || source === only,
    );
    assert(selected.length, "Unknown cached scope");
    for (const source of selected) {
      let db;
      const directory = join(scratch, "database");
      try {
        const filed = source.length === 2;
        if (!filed)
          await cp(join(root, source), directory, {
            recursive: true,
            mode: constants.COPYFILE_FICLONE,
          });
        db = database(new PGlite(directory));
        // Existing imported caches may retain a retired development journal. This reader
        // adds no schema, so cloned caches are read as-is; fresh filed-source DBs migrate.
        if (filed) await migrate(db, migrations);
        const schemaPreparation = [];
        if (
          !filed &&
          !(await db.query("SELECT to_regclass('rate_plan_count') AS present"))
            .rows[0].present
        ) {
          // This empty lookup falls back to counting the imported rate rows. Apply the
          // checked-in additive table only to this disposable clone, without changing its journal.
          const name = "993_rate_plan_count.sql";
          const sql = await readFile(
            new URL(`../../migrations/${name}`, import.meta.url),
            "utf8",
          );
          await db.exec(sql);
          await backfillRatePlanCounts(db);
          schemaPreparation.push({
            name,
            sha256: createHash("sha256").update(sql).digest("hex"),
          });
        }
        let state, year, county, zip;
        if (filed) {
          state = source;
          year = 2026;
          county = state === "NY" ? "36061" : "50007";
          const files = await cachedSbe(
            {
              state,
              year,
              url: `https://www.cms.gov/files/zip/${state === "NY" ? "newyork" : "vermont"}sbepuf2026.zip`,
            },
            root,
          );
          assert(
            (
              await importSbe(db, {
                state,
                year,
                dataDir: root,
                files,
                acquire: false,
              })
            ).passed,
          );
          await ingestStateRates(
            db,
            join(root, `derived/state-rating/${state.toLowerCase()}-2026.json`),
            state,
          );
        } else {
          [year, state] = source.match(/(202[567])-([A-Z]{2})$/).slice(1);
          year = Number(year);
          const counties = (
            await db.query(
              "SELECT DISTINCT county_fips FROM service_area_county WHERE state=$1 AND plan_year=$2 AND market='Individual' AND NOT dental_only AND county_fips IS NOT NULL ORDER BY county_fips",
              [state, year],
            )
          ).rows;
          county = counties[0]?.county_fips;
          if (state === "TX") county = "48201";
          if (state === "FL") county = "12086";
          assert(county, "No loaded county");
          zip = (
            await db.query(
              "SELECT zcta FROM zcta_county WHERE county_fips=$1 ORDER BY zcta LIMIT 1",
              [county],
            )
          ).rows[0]?.zcta;
        }
        const snapshots = (
          await db.query(
            "SELECT snapshot_id,sha256,validation_state FROM snapshot ORDER BY snapshot_id",
          )
        ).rows;
        report.sources.push({
          source,
          state,
          year,
          snapshots,
          schema: filed ? "fresh_migrated" : "cached_clone",
          schema_preparation: schemaPreparation,
        });
        const input = {
          county,
          ...(zip ? { zip } : {}),
          year,
          preset: "family-40-40-10-8-v1",
        };
        report.cases.push(await checkHouseholdEnumeration(db, input));
        if (state === "NY")
          report.cases.push(
            await checkHouseholdEnumeration(db, {
              county: "36001",
              year,
              preset: "family-40-40-10-8-v1",
            }),
          );
        if (filed) {
          report.cases.push(
            await checkHouseholdEnumeration(
              db,
              {
                county,
                year,
                members: [
                  { age: 40, relationship: "subscriber", tobacco: false },
                  { age: 30, relationship: "child", tobacco: false },
                ],
              },
              false,
            ),
          );
        }
        if (state === "TX" && year === 2026) {
          for (const [a, b] of [
            [14, 15],
            [20, 21],
            [63, 64],
          ])
            report.cases.push(
              await checkHouseholdEnumeration(
                db,
                {
                  county,
                  zip,
                  year,
                  members: [
                    { age: a, relationship: "subscriber", tobacco: false },
                    { age: b, relationship: "spouse", tobacco: true },
                  ],
                },
                false,
              ),
            );
          report.cases.push(
            await checkHouseholdEnumeration(
              db,
              {
                county,
                zip,
                year,
                members: [
                  { age: 40, relationship: "subscriber", tobacco: false },
                  ...[8, 20, 15, 18, 21].map((age) => ({
                    age,
                    relationship: "child",
                    tobacco: false,
                  })),
                ],
              },
              false,
            ),
          );
          const unloaded = await householdDistributions(
            db,
            { ...input, year: 2099 },
            { enabled: true },
          );
          assert.equal(unloaded.reason, "catalog_not_loaded");
          report.controls.push({
            name: "unloaded_year",
            input: { county, zip, year: 2099 },
            status: unloaded.status,
            reason: unloaded.reason,
            generation: unloaded.data_generation,
          });
          const multi = (
            await db.query(
              "SELECT zcta FROM zcta_county GROUP BY zcta HAVING count(DISTINCT county_fips)>1 ORDER BY zcta LIMIT 1",
            )
          ).rows[0]?.zcta;
          if (multi) {
            const ambiguous = await householdDistributions(
              db,
              { zip: multi, year, preset: "family-40-40-10-8-v1" },
              { enabled: true, fourProfiles: true },
            );
            assert.equal(ambiguous.reason, "location_ambiguous");
            assert(
              ambiguous.profiles.every((p) =>
                p.metals.every((g) => g.points.minimum === null),
              ),
            );
            report.controls.push({
              name: "real_multi_county_zip",
              input: { zip: multi, year },
              status: ambiguous.status,
              reason: ambiguous.reason,
              generation: ambiguous.data_generation,
            });
          } else
            report.controls.push({
              name: "real_multi_county_zip",
              gap: "No multi-county ZIP in this cached geography",
            });
        }
        console.log(`${state} ${year}: household distributions PASS`);
      } catch (error) {
        report.failures.push({ source, message: error.stack });
        console.error(`${source}: FAIL ${error.message}`);
      } finally {
        await db?.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
    assert(
      only ||
        (sources.some((s) => s.includes("TX")) &&
          sources.some((s) => s.includes("FL"))),
      "TX and FL cache required",
    );
    report.passed = report.failures.length === 0;
  } finally {
    await rm(scratch, { recursive: true, force: true });
    await writeFile(
      join(destination, only ? `realdata-${only}.json` : "realdata.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
  }
  console.log(
    `household real data: ${report.passed ? "PASS" : "FAIL"}; scopes=${report.sources.length} cases=${report.cases.length} failures=${report.failures.length}`,
  );
  if (!report.passed) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
