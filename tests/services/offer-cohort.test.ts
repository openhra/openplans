import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rebaseImports, replaceSyntax } from "../source-mutation.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { setup } from "../compat/v1/helpers.js";
import { enumerateHouseholdOffers } from "../../src/services/offer-cohort.js";
import { lowestPremiums } from "../../src/services/handy.js";
import {
  countyPlans,
  resolveLocation,
  exchangeAttributeRows,
} from "../../src/api/repository.js";
import { premiumRequest } from "../../src/api/validation.js";
import { familyOffer } from "../../src/services/coverage-family.js";
import { ratePremium } from "../../src/services/premiums.js";
import type { SqlSession } from "../../src/db/database.js";
import type { OfferCohort } from "@openplans/plugin-sdk";

let h: Awaited<ReturnType<typeof setup>>;
const input = { zip: "77002", county: "48201", year: 2026, age: 40 };
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => {
  await h?.close();
});
async function rollback(run: (tx: SqlSession) => Promise<void>) {
  const marker = new Error("SYNTHETIC cohort rollback");
  await expect(
    h.db.transaction(async (tx) => {
      await run(tx);
      throw marker;
    }),
  ).rejects.toBe(marker);
}
async function allEvidence(db: SqlSession, age: number) {
  const first = await enumerateHouseholdOffers(db, { ...input, age });
  const rows = [...first.evidence.candidates];
  let next = first.evidence.next_page;
  while (next) {
    const page = await enumerateHouseholdOffers(db, {
      ...input,
      age,
      evidence_page: next,
      data_generation: first.data_generation,
    });
    expect(page.statistics).toEqual(first.statistics);
    rows.push(...page.evidence.candidates);
    next = page.evidence.next_page;
  }
  return { first, rows };
}
function requireComplete(cell: OfferCohort) {
  expect(cell.status).toBe("calculated");
  expect(cell.denominator.unknown_count).toBe(0);
  expect(cell.denominator.candidate_count).toBe(
    cell.denominator.rated_count! + cell.denominator.excluded_count!,
  );
  expect(cell.statistics).not.toBeNull();
  expect(cell.statistics?.median).toBeDefined();
}

it("rates every eligible real TX Silver offer at boundary ages and equals the existing minimum", async () => {
  for (const age of [0, 14, 15, 20, 21, 40, 64, 120]) {
    const { first, rows } = await allEvidence(h.db, age);
    requireComplete(first);
    const location = await resolveLocation(h.db, input);
    const plans = (
      await countyPlans(h.db, input.county, input.year, input.zip)
    ).filter((p) => p.on_exchange && p.metal.toLowerCase() === "silver");
    const expected: { plan_id: string; monthly_cents: number }[] = [];
    for (const plan of plans) {
      const attributes = (
        await exchangeAttributeRows(h.db, plan.snapshot_id, plan.base_plan_id)
      ).rows;
      if (familyOffer(attributes, age >= 21, age < 21) === false) continue;
      const request = premiumRequest({
        ...input,
        coverage_start: "2026-01-01",
        plan_ids: [plan.base_plan_id],
        members: [{ age, tobacco: false, relationship: "subscriber" }],
      });
      const { estimate } = await ratePremium(
        h.db,
        plan,
        plan.base_plan_id,
        request,
        location,
      );
      expect(estimate.status).toBe("rated");
      if (!("total_cents" in estimate)) throw new Error("Missing direct price");
      const row = rows.find((r) => r.plan_id === plan.base_plan_id);
      expect(row).toMatchObject({
        monthly_cents: estimate.total_cents,
        rate_rows_used: estimate.rate_rows_used,
        status: estimate.status,
        members: estimate.members,
      });
      expected.push({
        plan_id: plan.base_plan_id,
        monthly_cents: estimate.total_cents!,
      });
    }
    expect(rows).toHaveLength(expected.length);
    expect(first.statistics?.lowest_cents).toBe(
      (await lowestPremiums(h.db, { ...input, age }, { slow: true })).lowest
        .monthly_cents,
    );
    const sorted = expected.map((p) => p.monthly_cents).sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const median =
      sorted.length % 2
        ? sorted[middle]!
        : (sorted[middle - 1]! + sorted[middle]!) / 2;
    expect(
      first.statistics!.median!.numerator /
        first.statistics!.median!.denominator,
    ).toBe(median);
    expect(
      first.statistics!.mean!.numerator / first.statistics!.mean!.denominator,
    ).toBe(sorted.reduce((a, b) => a + b, 0) / sorted.length);
  }
});

it("counts ineligible and all unrated candidates and refuses an incomplete headline", async () => {
  const { rows } = await allEvidence(h.db, 40);
  const id = String(rows[0]!.plan_id);
  await rollback(async (tx) => {
    await tx.query("DELETE FROM rate WHERE base_plan_id=$1", [id]);
    const cell = await enumerateHouseholdOffers(tx, input);
    expect(cell).toMatchObject({
      status: "unknown",
      reason: "incomplete_offer_cohort",
      statistics: null,
    });
    expect(cell.denominator.unknown_count).toBe(1);
    expect(cell.evidence.unknown).toMatchObject([
      { plan_id: id, reason: "rate_rows_missing" },
    ]);
    expect(() => requireComplete(cell)).toThrow();
    // Omitting the unresolved candidate would falsely allow a complete headline.
    const omitted = structuredClone(cell);
    omitted.status = "calculated";
    omitted.denominator.unknown_count = 0;
    expect(() => requireComplete(omitted)).toThrow();
  });
  await rollback(async (tx) => {
    await tx.query(
      `UPDATE plan_attribute SET raw=raw || '{"ChildOnlyOffering":"Allows Child-Only"}'::jsonb WHERE base_plan_id=$1`,
      [id],
    );
    const cell = await enumerateHouseholdOffers(tx, input);
    expect(cell.denominator.excluded_count).toBeGreaterThan(0);
    expect(cell.exclusions).toContainEqual({
      reason: "coverage_family_ineligible",
      count: cell.denominator.excluded_count,
    });
  });
});

it("keeps missing evidence counts unknown, complete empty counts zero, and requires a pinned next page", async () => {
  const absent = await enumerateHouseholdOffers(h.db, { ...input, year: 2040 });
  expect(absent.denominator.candidate_count).toBeNull();
  expect(absent.statistics).toBeNull();
  expect(() => expect(absent.denominator.candidate_count).toBe(0)).toThrow();
  await rollback(async (tx) => {
    await tx.exec("UPDATE plan SET metal='Gold'");
    const empty = await enumerateHouseholdOffers(tx, input);
    expect(empty).toMatchObject({
      status: "no_plans",
      denominator: { candidate_count: 0, rated_count: 0, unknown_count: 0 },
      statistics: { median: null, mean: null },
    });
  });
  await expect(
    enumerateHouseholdOffers(h.db, { ...input, evidence_page: 2 }),
  ).rejects.toThrow();
  await expect(
    enumerateHouseholdOffers(h.db, {
      ...input,
      evidence_page: 2,
      data_generation: "stale",
    }),
  ).rejects.toThrow("generation_changed");
});

it("refuses unresolved ZIP restrictions and ambiguous county selection", async () => {
  await rollback(async (tx) => {
    await tx.exec(
      "UPDATE service_area_county SET partial_county=true,zip_codes='77002' WHERE county_fips='48201'",
    );
    const cell = await enumerateHouseholdOffers(tx, {
      county: "48201",
      year: 2026,
      age: 40,
    });
    expect(cell.status).toBe("location_requires_zip");
    expect(cell.statistics).toBeNull();
  });
  await rollback(async (tx) => {
    await tx.exec(`INSERT INTO zcta_county(zcta,county_fips,county_name,arealand_zcta,areawater_zcta,arealand_county,areawater_county,arealand_part,areawater_part,snapshot_id,source_row)
      SELECT zcta,'48157','SYNTHETIC second county',arealand_zcta,areawater_zcta,arealand_county,areawater_county,arealand_part,areawater_part,snapshot_id,source_row
      FROM zcta_county WHERE zcta='77002' LIMIT 1`);
    const ambiguous = await enumerateHouseholdOffers(tx, {
      zip: "77002",
      year: 2026,
      age: 40,
    });
    expect(ambiguous.status).toBe("ambiguous");
    expect(ambiguous.statistics).toBeNull();
    expect(ambiguous.denominator.candidate_count).toBeNull();
    requireComplete(await enumerateHouseholdOffers(tx, input));
  });
  const location = await enumerateHouseholdOffers(h.db, {
    zip: "12345",
    year: 2026,
    age: 40,
  });
  expect(location.statistics).toBeNull();
});

async function mutatedCohort(
  before: string,
  after: string,
  run: (consumer: typeof enumerateHouseholdOffers) => Promise<void>,
) {
  const original = new URL(
    "../../dist/services/offer-cohort.js",
    import.meta.url,
  );
  const directory = await mkdtemp(
    fileURLToPath(new URL("../../dist/.compare-mutant-", import.meta.url)),
  );
  try {
    const shared =
      before.startsWith("const offered") ||
      before.startsWith("if (scan") ||
      before.startsWith("group.counts");
    let source = rebaseImports(await readFile(original, "utf8"), original);
    if (shared) {
      const handy = new URL("./handy.js", original);
      const path = join(directory, "handy.mjs");
      await writeFile(
        path,
        rebaseImports(
          replaceSyntax(await readFile(handy, "utf8"), before, after),
          handy,
        ),
      );
      source = source.replace(handy.href, pathToFileURL(path).href);
    } else source = replaceSyntax(source, before, after);
    const path = join(directory, "cohort.mjs");
    await writeFile(path, source);
    const module = (await import(pathToFileURL(path).href)) as {
      enumerateHouseholdOffers: typeof enumerateHouseholdOffers;
    };
    await run(module.enumerateHouseholdOffers);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

it("kills page_one and operator_shortlist mutants with full-cohort equality", async () => {
  const positive = await enumerateHouseholdOffers(h.db, input);
  for (const [before, after] of [
    ["offerStatistics(prices)", "offerStatistics(prices.slice(0, 1))"],
    [
      "const offered = all.filter(selectedMetal)",
      "const offered = all.filter(selectedMetal).filter((plan) => plan.base_plan_id !== all.filter(selectedMetal)[0]?.base_plan_id)",
    ],
  ])
    await mutatedCohort(before!, after!, async (consumer) => {
      const mutant = await consumer(h.db, input);
      expect(() =>
        expect({
          statistics: mutant.statistics,
          denominator: mutant.denominator,
        }).toEqual({
          statistics: positive.statistics,
          denominator: positive.denominator,
        }),
      ).toThrow();
    });
});

it("kills omit_unrated_candidate and unknown_into_zero mutants with completeness assertions", async () => {
  const positive = await enumerateHouseholdOffers(h.db, input);
  await rollback(async (tx) => {
    await tx.query("DELETE FROM rate WHERE base_plan_id=$1", [
      positive.evidence.candidates[0]!.plan_id,
    ]);
    await mutatedCohort(
      "if (scan?.unknown.length)",
      "if (false)",
      async (consumer) => {
        const mutant = await consumer(tx, input);
        expect(() => expect(mutant.statistics).toBeNull()).toThrow();
      },
    );
  });
  await mutatedCohort(
    "candidate_count: counted ? cell.provenance.offered_plan_count : null",
    "candidate_count: counted ? cell.provenance.offered_plan_count : 0",
    async (consumer) => {
      const mutant = await consumer(h.db, { ...input, year: 2040 });
      expect(() =>
        expect(mutant.denominator.candidate_count).toBeNull(),
      ).toThrow();
    },
  );
});

it("kills duplicate_csr_variant before publishing a distribution", async () => {
  await mutatedCohort(
    "const statistics = offerStatistics(prices);",
    'prices.push({ ...prices[0], plan_id: prices[0].plan_id + "-04" }); const statistics = offerStatistics(prices);',
    async (consumer) => {
      await expect(consumer(h.db, input)).rejects.toThrow(
        "distinct_base_plans_required",
      );
    },
  );
});

it("counts family exclusions identically for an age and a one-member household", async () => {
  const household = {
    ...input,
    age: undefined,
    members: [{ age: 40, relationship: "subscriber" }],
  };
  const first = await enumerateHouseholdOffers(h.db, input);
  await rollback(async (tx) => {
    await tx.query(
      `UPDATE plan_attribute SET raw=raw || '{"ChildOnlyOffering":"Allows Child-Only"}'::jsonb WHERE base_plan_id=$1`,
      [first.evidence.candidates[0]!.plan_id],
    );
    const single = await enumerateHouseholdOffers(tx, input);
    const family = await enumerateHouseholdOffers(tx, household);
    requireComplete(single);
    requireComplete(family);
    expect(family.denominator.excluded_count).toBeGreaterThan(0);
    expect(family.denominator).toEqual(single.denominator);
    expect({ ...family.statistics, evidence_refs: [] }).toEqual({
      ...single.statistics,
      evidence_refs: [],
    });
  });
});

it("kills an omitted unpriced household offer instead of publishing partial statistics", async () => {
  const household = {
    ...input,
    age: undefined,
    members: [{ age: 40, relationship: "subscriber" }],
  };
  const complete = await enumerateHouseholdOffers(h.db, household);
  await rollback(async (tx) => {
    await tx.query("DELETE FROM rate WHERE base_plan_id=$1", [
      complete.evidence.candidates[0]!.plan_id,
    ]);
    const unknown = await enumerateHouseholdOffers(tx, household);
    expect(unknown.statistics).toBeNull();
    expect(unknown.denominator.unknown_count).toBe(1);
    await mutatedCohort(
      "group.counts.unknown = group.candidates.length - rated.length;",
      "group.candidates = rated; group.counts.unknown = 0; group.reasons = [];",
      async (consumer) => {
        const mutant = await consumer(tx, household);
        expect(mutant.status).toBe("calculated");
        expect(() => expect(mutant.statistics).toBeNull()).toThrow();
        expect(() =>
          expect(mutant.denominator.candidate_count).toBe(
            complete.denominator.candidate_count,
          ),
        ).toThrow();
      },
    );
  });
});

it("retries the whole scan once and refuses repeated generation churn", async () => {
  for (const repeated of [false, true]) {
    let generations = 0;
    const db: SqlSession = {
      exec: h.db.exec,
      query: async <Row extends Record<string, unknown>>(
        sql: string,
        parameters?: unknown[],
      ) => {
        const result = await h.db.query<Row>(sql, parameters);
        if (sql.includes("AS generation")) {
          generations++;
          if (repeated || generations === 2) {
            const row: Record<string, unknown> = result.rows[0]!;
            row.generation = `${String(row.generation)}:${generations}`;
          }
        }
        return result;
      },
    };
    if (repeated)
      await expect(enumerateHouseholdOffers(db, input)).rejects.toThrow(
        "generation_changed",
      );
    else requireComplete(await enumerateHouseholdOffers(db, input));
    expect(generations).toBe(4);
  }
});
