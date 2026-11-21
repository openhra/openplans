import {
  servingPolicy,
  withDataPolicy,
} from "../../src/services/data-window.js";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rebaseImports, replaceSyntax } from "../source-mutation.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { setup } from "../compat/v1/helpers.js";
import { enumerateHouseholdOffers } from "../../src/services/offer-cohort.js";
import { assertOutputFits } from "../../src/mcp/bounded.js";
import { messageBytes } from "../../src/mcp/tools.js";
import type { ToolName, ToolOutput } from "../../src/mcp/schemas.js";
import { marketCosts } from "../../plugins/compare/src/service.js";
import { createCalculationHost } from "../../src/plugins/calculation-host.js";
import { offerCohortInputSchema } from "@openplans/plugin-sdk";
import {
  lowestPremiums,
  householdDistributions,
} from "../../src/services/handy.js";
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
function expandedCandidate(
  cell: OfferCohort,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const source = cell.evidence.sources[Number(row.evidence_ref)] as {
    rating: {
      members: { rate_row_refs: number[] }[];
      rate_rows_used: unknown[];
    };
  };
  const rating = source.rating;
  return {
    ...row,
    ...rating,
    members: rating.members.map(({ rate_row_refs, ...member }) => ({
      ...member,
      rate_rows: rate_row_refs.map((ref) => rating.rate_rows_used[ref]),
    })),
  };
}
async function allEvidence(db: SqlSession, age: number) {
  const first = await enumerateHouseholdOffers(db, { ...input, age });
  const rows = first.evidence.candidates.map((row) =>
    expandedCandidate(first, row),
  );
  let next = first.evidence.next_page;
  while (next) {
    const page = await enumerateHouseholdOffers(db, {
      ...input,
      age,
      evidence_page: next,
      data_generation: first.data_generation,
    });
    expect(page.statistics).toEqual(first.statistics);
    rows.push(
      ...page.evidence.candidates.map((row) => expandedCandidate(page, row)),
    );
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
    expect(
      await enumerateHouseholdOffers(h.db, {
        ...input,
        age: undefined,
        members: [{ age, relationship: "subscriber" }],
      }),
    ).toEqual(first);
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
      reason: "premium_not_rated",
      statistics: null,
    });
    expect(cell.denominator.unknown_count).toBe(1);
    expect(cell.evidence.unknown).toMatchObject([
      { plan_id: id, reason: "premium_not_rated" },
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
  const absent = await enumerateHouseholdOffers(h.db, { ...input, year: 2025 });
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
      before.startsWith("for (const plan") ||
      before.startsWith("group.counts.unknown");
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
    ["for (const plan of all.sort", "for (const plan of all.slice(1).sort"],
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

it("kills unknown_into_zero with completeness assertions", async () => {
  await mutatedCohort(
    "group.counts.catalog === null ? null : candidates.length + excluded.length",
    "group.counts.catalog === null ? 0 : candidates.length + excluded.length",
    async (consumer) => {
      const mutant = await consumer(h.db, { ...input, year: 2025 });
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

it.each([false, true])(
  "kills an omitted unpriced offer for either input shape: household=%s",
  async (explicit) => {
    const household = {
      ...input,
      age: undefined,
      members: [{ age: 40, relationship: "subscriber" }],
    };
    const request = explicit ? household : input;
    const complete = await enumerateHouseholdOffers(h.db, request);
    await rollback(async (tx) => {
      await tx.query("DELETE FROM rate WHERE base_plan_id=$1", [
        complete.evidence.candidates[0]!.plan_id,
      ]);
      const unknown = await enumerateHouseholdOffers(tx, request);
      expect(unknown.statistics).toBeNull();
      expect(unknown.denominator.unknown_count).toBe(1);
      await mutatedCohort(
        "group.counts.unknown = group.candidates.length - rated.length;",
        "group.candidates = rated; group.counts.unknown = 0; group.reasons = [];",
        async (consumer) => {
          const mutant = await consumer(tx, request);
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
  },
);

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
    await withDataPolicy({ historyYears: 3 }, async () => {
      // Keep the scan's publication checks separate from policy revalidation.
      await servingPolicy(db);
      generations = 0;
      if (repeated)
        await expect(enumerateHouseholdOffers(db, input)).rejects.toThrow(
          "generation_changed",
        );
      else requireComplete(await enumerateHouseholdOffers(db, input));
      expect(generations).toBe(4);
    });
  }
});

function requireHouseholdPage(cell: OfferCohort) {
  const { candidates, excluded, unknown, sources } = cell.evidence;
  const refs = new Set<number>();
  for (const candidate of [...candidates, ...excluded, ...unknown]) {
    const ref = Number(candidate.evidence_ref);
    expect(Number.isInteger(ref)).toBe(true);
    expect(ref).toBeGreaterThanOrEqual(0);
    expect(ref).toBeLessThan(sources.length);
    refs.add(ref);
    expect(sources[ref]).toMatchObject({
      catalog: { plan_id: candidate.plan_id },
    });
  }
  expect(refs.size).toBe(sources.length);
}

const householdInput = {
  zip: "77002",
  county: "48201",
  year: 2026,
  members: [
    { age: 40, relationship: "subscriber" },
    { age: 40, relationship: "spouse" },
    { age: 10, relationship: "child" },
    { age: 8, relationship: "child" },
  ],
};

it("pages compact household evidence with exact references and stable cohort statistics", async () => {
  const first = await enumerateHouseholdOffers(h.db, householdInput);
  requireComplete(first);
  const original = await householdDistributions(
    h.db,
    {
      ...householdInput,
      members: householdInput.members.map((member) => ({
        ...member,
        tobacco: false,
      })),
    },
    { enabled: true },
  );
  const ids: unknown[] = [];
  let cell: OfferCohort | null = first;
  while (cell) {
    requireHouseholdPage(cell);
    expect(cell.statistics).toEqual(first.statistics);
    ids.push(...cell.evidence.candidates.map((row) => row.plan_id));
    for (const source of cell.evidence.sources) {
      const evidence = source as {
        catalog: { plan_id: string };
        attributes: { raw: Record<string, string> }[];
        rating: {
          members: { rate_rows?: unknown[]; rate_row_refs: number[] }[];
          rate_rows_used: unknown[];
        };
      };
      const full = (original.provenance.evidence as (typeof evidence)[]).find(
        (row) => row.catalog.plan_id === evidence.catalog.plan_id,
      )!;
      expect(evidence.attributes).toEqual(
        full.attributes.map((attribute) => ({
          ...attribute,
          raw: Object.fromEntries(
            Object.entries(attribute.raw).filter(([field]) =>
              [
                "ChildOnlyOffering",
                "MetalLevel",
                "QHPNonQHPTypeId",
                "StandardComponentId",
                "PlanId",
              ].includes(field),
            ),
          ),
        })),
      );
      const expandedRating = {
        ...evidence.rating,
        members: evidence.rating.members.map(
          ({ rate_row_refs, ...member }) => ({
            ...member,
            rate_rows: rate_row_refs.map(
              (ref) => evidence.rating.rate_rows_used[ref],
            ),
          }),
        ),
      };
      expect(expandedRating).toEqual(full.rating);
      for (const member of evidence.rating.members) {
        expect(member.rate_rows).toBeUndefined();
        expect(member.rate_row_refs.length).toBeGreaterThan(0);
        for (const ref of member.rate_row_refs)
          expect(evidence.rating.rate_rows_used[ref]).toBeDefined();
      }
    }
    if (!cell.evidence.next_page) break;
    cell = await enumerateHouseholdOffers(h.db, {
      ...householdInput,
      evidence_page: cell.evidence.next_page,
      data_generation: first.data_generation,
    });
  }
  expect(ids.length).toBe(first.denominator.rated_count);
  expect(new Set(ids).size).toBe(ids.length);
  await expect(
    enumerateHouseholdOffers(h.db, {
      ...householdInput,
      evidence_page: 2,
      data_generation: "stale",
    }),
  ).rejects.toThrow("generation_changed");
  const empty = await enumerateHouseholdOffers(h.db, {
    ...householdInput,
    evidence_page: 100000,
    data_generation: first.data_generation,
  });
  requireHouseholdPage(empty);
  expect(empty.evidence.sources).toEqual([]);
  expect(empty.evidence.next_page).toBeNull();
});

it("detects dangling and orphaned household evidence and keeps unknown and excluded pages linked", async () => {
  const first = await enumerateHouseholdOffers(h.db, householdInput);
  const dangling = structuredClone(first);
  dangling.evidence.candidates[0]!.evidence_ref =
    dangling.evidence.sources.length;
  expect(() => requireHouseholdPage(dangling)).toThrow();
  const orphan = structuredClone(first);
  orphan.evidence.candidates.pop();
  expect(() => requireHouseholdPage(orphan)).toThrow();
  await rollback(async (tx) => {
    await tx.query("DELETE FROM rate WHERE base_plan_id=$1", [
      first.evidence.candidates[0]!.plan_id,
    ]);
    await tx.query(
      `UPDATE plan_attribute SET raw=raw || '{"ChildOnlyOffering":"Allows Child-Only"}'::jsonb WHERE base_plan_id=$1`,
      [first.evidence.candidates[1]!.plan_id],
    );
    const cell = await enumerateHouseholdOffers(tx, householdInput);
    expect(cell.evidence.unknown.length).toBeGreaterThan(0);
    expect(cell.evidence.excluded.length).toBeGreaterThan(0);
    requireHouseholdPage(cell);
  });
});

it("bounds the complete four-member tool frame through the shared output helper and rejects oversized evidence", async () => {
  const answer = await marketCosts(
    createCalculationHost({
      public: { quoting: true, household: false, compat: false },
    }),
    offerCohortInputSchema.parse(householdInput),
    { db: h.db, signal: new AbortController().signal },
  );
  const framedBytes = (value: typeof answer) =>
    messageBytes(
      value as unknown as ToolOutput<ToolName>,
      "household-evidence",
    );
  expect(() =>
    assertOutputFits(answer, { measure: framedBytes }),
  ).not.toThrow();
  const oversized = structuredClone(answer);
  oversized.data.comparison.evidence.sources.push({
    synthetic: "x".repeat(65536),
  });
  expect(() => assertOutputFits(oversized, { measure: framedBytes })).toThrow(
    "RESULT_TOO_LARGE",
  );
});

it("rejects a dangling source index in the household reader", async () => {
  await mutatedCohort(
    "entries.map((entry) => Number(entry.evidence_ref))",
    "entries.map(() => 1000000)",
    async (consumer) => {
      await expect(consumer(h.db, householdInput)).rejects.toThrow(
        "household_evidence_unavailable",
      );
    },
  );
});
