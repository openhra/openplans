import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { setup } from "../compat/v1/helpers.js";
import { rebaseImports, replaceSyntax } from "../source-mutation.js";
import {
  householdDistributions,
  householdInput,
  householdProfiles,
  HOUSEHOLD_METALS,
} from "../../src/services/handy.js";
import type { HandyMember } from "../../src/services/handy.js";
import {
  countyPlans,
  exchangeAttributeRows,
  resolveLocation,
} from "../../src/api/repository.js";
import { familyOffer } from "../../src/services/coverage-family.js";
import { premiumRequest } from "../../src/api/validation.js";
import { ratePremium, storedRate } from "../../src/services/premiums.js";
import { quotePlans } from "../../src/services/quotes.js";
import type { SqlSession, QueryOptions } from "../../src/db/database.js";
import type { householdPremium } from "../../src/domain/rating/household.js";

let h: Awaited<ReturnType<typeof setup>>;
const scope = { zip: "77002", county: "48201", year: 2026 };
const preset = { ...scope, preset: "family-40-40-10-8-v1" };
const enabled = { enabled: true };
type Result = Awaited<ReturnType<typeof householdDistributions>>;
type Group = Result["profiles"][number]["metals"][number];
beforeAll(async () => {
  h = await setup();
});
afterAll(async () => {
  await h?.close();
});
async function rollback(run: (tx: SqlSession) => Promise<void>) {
  const marker = new Error("SYNTHETIC household mutant rollback");
  await expect(
    h.db.transaction(async (tx) => {
      await run(tx);
      throw marker;
    }),
  ).rejects.toBe(marker);
}
const run = (db: SqlSession = h.db, members?: HandyMember[]) =>
  householdDistributions(db, members ? { ...scope, members } : preset, enabled);

// Independent full quote enumeration, across every page. No handy aggregation or shared reads.
async function oracle(db: SqlSession, members: HandyMember[]) {
  const plans = await countyPlans(db, scope.county, scope.year, scope.zip);
  const prices = new Map<
    string,
    Awaited<ReturnType<typeof quotePlans>>["quotes"][number]
  >();
  let page: number | null = 1;
  while (page !== null) {
    const answer = await quotePlans(db, {
      ...scope,
      members,
      page,
    });
    for (const quote of answer.quotes) prices.set(quote.plan_id, quote);
    page = answer.next_page;
  }
  return Promise.all(
    HOUSEHOLD_METALS.map(async (metal) => {
      const offered = plans.filter(
        (p) => p.on_exchange && p.metal.toLowerCase() === metal,
      );
      const expected = [];
      const excluded: string[] = [];
      for (const plan of offered) {
        const attrs = (
          await exchangeAttributeRows(db, plan.snapshot_id, plan.base_plan_id)
        ).rows;
        const eligible = familyOffer(
          attrs,
          members.some((m) => m.age >= 21),
          members.some((m) => m.age < 21),
        );
        if (eligible === false) {
          excluded.push(plan.base_plan_id);
          continue;
        }
        expect(eligible).toBe(true);
        const quote = prices.get(plan.base_plan_id)!;
        expect(quote.status).toBe("rated");
        if (!("total_cents" in quote))
          throw new Error("Missing complete household quote");
        expected.push({
          id: plan.base_plan_id,
          cents: quote.total_cents!,
          quote,
        });
      }
      expected.sort((a, b) => a.cents - b.cents || a.id.localeCompare(b.id));
      return { metal, expected, excluded };
    }),
  );
}
function assertPopulation(
  group: Group,
  expected: { id: string; cents: number }[],
) {
  const label = `full_household_enumeration:${group.metal}`;
  expect(group.status, label).toBe(expected.length ? "calculated" : "no_plans");
  expect(group.counts.eligible, label).toBe(expected.length);
  expect(group.counts.rated, label).toBe(expected.length);
  expect(group.counts.unknown, label).toBe(0);
  expect(
    group.candidates.map((c) => [c.plan_id, c.monthly_cents]).sort(),
    label,
  ).toEqual(expected.map((c) => [c.id, c.cents]).sort());
  const ranks = [
    1,
    Math.ceil(expected.length * 0.25),
    Math.ceil(expected.length * 0.5),
    Math.ceil(expected.length * 0.75),
    expected.length,
  ];
  for (const [i, point] of Object.values(group.points).entries()) {
    if (!expected.length) {
      expect(point, label).toBeNull();
      continue;
    }
    const selected = expected[ranks[i]! - 1]!;
    const ties = expected
      .filter((p) => p.cents === selected.cents)
      .map((p) => p.id);
    expect(point, label).toMatchObject({
      rank: ranks[i],
      denominator: expected.length,
      monthly_cents: selected.cents,
      plan_id: ties[0],
      tied_plan_count: ties.length,
      tied_plan_ids: ties,
    });
  }
}

it("requires explicit ages, roles and tobacco or the named preset, with no hidden default", async () => {
  for (const patch of [
    {},
    { members: [] },
    { preset: "missing" },
    { preset: preset.preset, members: [] },
    { members: [{ age: 40, relationship: "subscriber" }] },
    { members: [{ age: 121, relationship: "subscriber", tobacco: false }] },
    { members: [{ age: 40, tobacco: false }] },
    { preset: preset.preset, income: 100 },
  ])
    expect(() => householdInput({ ...scope, ...patch })).toThrow();
  await expect(householdDistributions(h.db, preset)).rejects.toThrow(
    "disabled",
  );
  const answer = await run();
  expect(answer.basis).toMatchObject({
    origin: "product_preset",
    preset: preset.preset,
    preset_hash: expect.stringMatching(/^[a-f0-9]{64}$/) as unknown,
  });
  expect(answer.basis.members.map((m) => m.age)).toEqual([40, 40, 10, 8]);
  const explicit = await run(h.db, answer.basis.members);
  expect(explicit.basis).toMatchObject({
    origin: "operator_input",
    preset: null,
    preset_hash: null,
  });
  expect(explicit.profiles).toEqual(answer.profiles);
  expect(() => householdProfiles(answer.basis.members.slice(0, 3))).toThrow();
});

it("equals full household quote enumeration for every metal and all four profiles", async () => {
  const answer = await householdDistributions(h.db, preset, {
    ...enabled,
    fourProfiles: true,
  });
  expect(answer.profiles.map((p) => p.id)).toEqual([
    "employee_only",
    "employee_spouse",
    "employee_spouse_child",
    "employee_spouse_children",
  ]);
  for (const profile of answer.profiles) {
    const expected = await oracle(h.db, profile.members);
    for (const { metal, expected: population } of expected) {
      const group = profile.metals.find((g) => g.metal === metal)!;
      assertPopulation(group, population);
      for (const candidate of group.candidates) {
        const evidence = answer.provenance.evidence[candidate.evidence_ref] as {
          rating: Record<string, unknown>;
          source_refs: Record<string, unknown>[];
        };
        const quote = population.find((p) => p.id === candidate.plan_id)!.quote;
        expect(evidence.rating.total_cents).toEqual(quote.total_cents);
        expect(evidence.rating.rating_rule).toEqual(
          quote.provenance.rating_rule,
        );
        for (const used of quote.rate_rows_used) {
          if (!("provenance" in used))
            throw new Error("Expected a filed per-member rate row");
          const provenance = used.provenance as {
            snapshot_id: string;
            source_row: number;
          };
          expect(evidence.source_refs).toContainEqual({
            snapshot_id: provenance.snapshot_id,
            source_row: provenance.source_row,
          });
        }
      }
    }
    expect(profile.lowest_silver).toEqual(
      profile.metals.find((g) => g.metal === "silver")!.points.minimum,
    );
    expect(profile.median_gold).toEqual(
      profile.metals.find((g) => g.metal === "gold")!.points.median,
    );
  }
});

it("preserves age boundaries, differing spouses, tobacco, and the fourth-child cap", async () => {
  for (const ages of [
    [14, 15],
    [20, 21],
    [63, 64],
  ]) {
    const members: HandyMember[] = [
      { age: ages[0]!, relationship: "subscriber", tobacco: false },
      { age: ages[1]!, relationship: "spouse", tobacco: true },
    ];
    const answer = await run(h.db, members);
    const expected = await oracle(h.db, members);
    for (const group of answer.profiles[0]!.metals)
      assertPopulation(
        group,
        expected.find((e) => e.metal === group.metal)!.expected,
      );
  }
  const members: HandyMember[] = [
    { age: 40, relationship: "subscriber", tobacco: false },
    ...[8, 20, 15, 18, 21].map((age) => ({
      age,
      relationship: "child" as const,
      tobacco: false,
    })),
  ];
  const answer = await run(h.db, members),
    expected = await oracle(h.db, members);
  for (const group of answer.profiles[0]!.metals)
    assertPopulation(
      group,
      expected.find((e) => e.metal === group.metal)!.expected,
    );
  const evidence = answer.provenance.evidence[
    answer.profiles[0]!.metals.flatMap((g) => g.candidates)[0]!.evidence_ref
  ] as { rating: { members: { age: number; charged: boolean }[] } };
  expect(
    evidence.rating.members.filter((m) => m.charged).map((m) => m.age),
  ).toEqual([40, 20, 15, 18, 21]);
});

it("rejects summing_independent_member_minima against one-contract household totals", async () => {
  await rollback(async (tx) => {
    // SYNTHETIC crossing rates on real-cut plans force different individual winners.
    const plans = (
      await countyPlans(tx, scope.county, scope.year, scope.zip)
    ).filter((p) => p.on_exchange && p.metal.toLowerCase() === "silver");
    expect(plans.length).toBeGreaterThan(1);
    for (const [i, plan] of plans.entries())
      await tx.query(
        "UPDATE rate SET individual_rate_cents=CASE WHEN age_band='40' THEN $2::bigint ELSE $3::bigint END WHERE base_plan_id=$1",
        [plan.base_plan_id, i === 0 ? 10000 : 90000, i === 0 ? 90000 : 10000],
      );
    const members: HandyMember[] = [
      { age: 40, relationship: "subscriber", tobacco: false },
      { age: 10, relationship: "child", tobacco: false },
    ];
    const answer = await run(tx, members);
    const group = answer.profiles[0]!.metals.find((g) => g.metal === "silver")!;
    const minimums = await Promise.all(
      members.map((member) => run(tx, [member])),
    );
    const mutant = structuredClone(group);
    mutant.points.minimum!.monthly_cents = minimums.reduce(
      (sum, r) => sum + r.profiles[0]!.lowest_silver!.monthly_cents,
      0,
    );
    const expected = (await oracle(tx, members)).find(
      (e) => e.metal === "silver",
    )!.expected;
    expect(() => assertPopulation(mutant, expected)).toThrow(
      "full_household_enumeration:silver",
    );
  });
});

it.each(["youngest_three_children", "fourth_child_under_21"])(
  "rejects %s source mutant with the full household pricing assertion",
  async (name) => {
    const module = new URL(
      "../../src/domain/rating/household.ts",
      import.meta.url,
    );
    const source = await readFile(module, "utf8");
    const mutant =
      name === "youngest_three_children"
        ? replaceSyntax(source, "b.age - a.age", "a.age - b.age")
        : replaceSyntax(
            source,
            ".slice(0, policy.maximumRatedChildren)",
            ".slice(0, 4)",
          );
    const directory = await mkdtemp(
      join(process.cwd(), "node_modules/.household-control-"),
    );
    try {
      const path = join(directory, "household.ts");
      await writeFile(path, rebaseImports(mutant, module));
      const changed = (await import(pathToFileURL(path).href)) as {
        householdPremium: typeof householdPremium;
      };
      const members: HandyMember[] = [
        { age: 40, relationship: "subscriber", tobacco: false },
        ...[8, 20, 15, 18].map((age) => ({
          age,
          relationship: "child" as const,
          tobacco: false,
        })),
      ];
      const expected = await oracle(h.db, members),
        location = await resolveLocation(h.db, scope);
      const plans = await countyPlans(
        h.db,
        scope.county,
        scope.year,
        scope.zip,
      );
      const answer = await run(h.db, members);
      const group = answer.profiles[0]!.metals.find(
        (g) => g.metal === "silver",
      )!;
      const mutated = structuredClone(group);
      for (const candidate of mutated.candidates) {
        const plan = plans.find((p) => p.base_plan_id === candidate.plan_id)!;
        const request = premiumRequest({
          ...scope,
          coverage_start: "2026-01-01",
          plan_ids: [candidate.plan_id],
          members,
        });
        const { estimate } = await ratePremium(
          h.db,
          plan,
          candidate.plan_id,
          request,
          location,
        );
        if (!("rating_area_id" in estimate))
          throw new Error("Missing rating area");
        const rows = (
          await h.db.query(
            "SELECT *,effective_date::text AS effective_date,expiration_date::text AS expiration_date FROM rate WHERE base_plan_id=$1",
            [candidate.plan_id],
          )
        ).rows.map(storedRate);
        const rated = changed.householdPremium(
          rows,
          candidate.plan_id,
          estimate.rating_area_id,
          {
            ratingMethod: "per_member",
            coverageStartDate: "2026-01-01",
            members: request.members,
          },
        );
        expect(rated.status).toBe("rated");
        candidate.monthly_cents = rated.totalCents;
      }
      expect(() =>
        assertPopulation(
          mutated,
          expected.find((e) => e.metal === "silver")!.expected,
        ),
      ).toThrow("full_household_enumeration:silver");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("rejects dropping_an_unpriced_cheaper_plan and retains independently complete metals", async () => {
  const before = await run();
  await rollback(async (tx) => {
    await tx.query("DELETE FROM rate WHERE base_plan_id=$1", [
      before.profiles[0]!.lowest_silver!.plan_id,
    ]);
    const answer = await run(tx),
      silver = answer.profiles[0]!.metals.find((g) => g.metal === "silver")!;
    const check = (g: Group) => {
      expect(g.status, "unpriced_cheaper_plan").toBe("unknown");
      expect(g.points.minimum, "unpriced_cheaper_plan").toBeNull();
      expect(g.counts.unknown, "unpriced_cheaper_plan").toBeGreaterThan(0);
    };
    check(silver);
    expect(answer.profiles[0]!.median_gold).toEqual(
      before.profiles[0]!.median_gold,
    );
    const mutant = structuredClone(silver);
    mutant.candidates = mutant.candidates.filter((c) => c.status === "rated");
    mutant.counts.unknown = 0;
    mutant.status = "calculated";
    expect(() => check(mutant)).toThrow("unpriced_cheaper_plan");
  });
});

it("rejects merging_CSR_variants, merging_bronze_categories, one_cent, and missing_evidence mutants", async () => {
  const answer = await run(),
    expected = await oracle(h.db, answer.basis.members);
  const silver = answer.profiles[0]!.metals.find((g) => g.metal === "silver")!;
  const population = expected.find((e) => e.metal === "silver")!.expected;
  const csr = structuredClone(silver);
  csr.candidates.push({
    ...csr.candidates[0]!,
    plan_id: csr.candidates[0]!.plan_id + "-06",
  });
  csr.counts.eligible!++;
  expect(() => assertPopulation(csr, population)).toThrow(
    "full_household_enumeration:silver",
  );
  const cent = structuredClone(silver);
  cent.points.minimum!.monthly_cents++;
  expect(() => assertPopulation(cent, population)).toThrow(
    "full_household_enumeration:silver",
  );
  const bronze = structuredClone(
    answer.profiles[0]!.metals.find((g) => g.metal === "bronze")!,
  );
  bronze.candidates.push(
    ...answer.profiles[0]!.metals.find((g) => g.metal === "expanded bronze")!
      .candidates,
  );
  expect(bronze.candidates.length).toBeGreaterThan(0);
  expect(() =>
    assertPopulation(
      bronze,
      expected.find((e) => e.metal === "bronze")!.expected,
    ),
  ).toThrow("full_household_enumeration:bronze");
  const evidence = structuredClone(answer);
  evidence.provenance.evidence = [];
  const checkEvidence = (r: Result) => {
    for (const c of r.profiles.flatMap((p) =>
      p.metals.flatMap((g) => g.candidates),
    ))
      expect(
        r.provenance.evidence[c.evidence_ref],
        "missing_evidence",
      ).toBeDefined();
  };
  checkEvidence(answer);
  expect(() => checkEvidence(evidence)).toThrow("missing_evidence");
});

it("refuses unloaded years, ambiguous ZIPs, unsupported rules and unknown classification", async () => {
  const unloaded = await householdDistributions(
    h.db,
    { ...preset, year: 2099 },
    enabled,
  );
  expect(unloaded.reason).toBe("catalog_not_loaded");
  expect(
    unloaded.profiles[0]!.metals.every(
      (g) => g.counts.catalog === null && g.points.minimum === null,
    ),
  ).toBe(true);
  await rollback(async (tx) => {
    await tx.exec("UPDATE plan SET metal='unknown'");
    const answer = await run(tx);
    expect(
      answer.profiles[0]!.metals.every(
        (g) => g.status === "unknown" && g.counts.catalog === null,
      ),
    ).toBe(true);
  });
  await rollback(async (tx) => {
    await tx.exec(
      "UPDATE state_rating_rule SET method='unsupported' WHERE state='TX'",
    );
    const answer = await run(tx);
    expect(answer.profiles[0]!.lowest_silver).toBeNull();
  });
});

it("retries the whole four-profile result on publication, then refuses repeated changes", async () => {
  for (const always of [false, true]) {
    let changed = 0;
    const publishing: SqlSession = {
      ...h.db,
      query: async <Row extends Record<string, unknown>>(
        sql: string,
        args?: unknown[],
        options?: QueryOptions,
      ) => {
        const result = await h.db.query<Row>(sql, args, options);
        if (
          sql.includes("SELECT s.snapshot_id,p.publisher") &&
          (always || !changed)
        ) {
          changed++;
          await h.db.exec(
            "UPDATE api_data_generation SET revision=revision+1 WHERE table_name='rate'",
          );
        }
        return result;
      },
    };
    if (always) {
      await expect(
        householdDistributions(publishing, preset, {
          ...enabled,
          fourProfiles: true,
        }),
      ).rejects.toThrow("DATA_CHANGED");
      expect(changed).toBe(2);
    } else {
      const result = await householdDistributions(publishing, preset, {
        ...enabled,
        fourProfiles: true,
      });
      expect(changed).toBe(1);
      expect(result).toEqual(
        await householdDistributions(h.db, preset, {
          ...enabled,
          fourProfiles: true,
        }),
      );
    }
  }
  await rollback(async (tx) => {
    await tx.exec("DELETE FROM api_data_generation WHERE table_name='rate'");
    await expect(run(tx)).rejects.toThrow("Data generation unavailable");
  });
});

it("keeps distinct tied base plans and uses the lower middle nearest-rank median", async () => {
  await rollback(async (tx) => {
    // SYNTHETIC equal-price population, retaining each real-cut base-plan identity.
    await tx.exec("UPDATE rate SET individual_rate_cents=50000");
    const result = await run(tx, [
      { age: 40, relationship: "subscriber", tobacco: false },
    ]);
    const population = await oracle(tx, result.basis.members);
    for (const group of result.profiles[0]!.metals) {
      const expected = population.find(
        (p) => p.metal === group.metal,
      )!.expected;
      assertPopulation(group, expected);
      if (expected.length) {
        expect(group.points.median!.rank).toBe(Math.ceil(expected.length / 2));
        expect(group.points.median!.tied_plan_count).toBe(expected.length);
        expect(group.points.median!.plan_id).toBe(expected[0]!.id);
      }
    }
  });
});

it("requires a selected county for a multi-county ZIP and retains ZIP-restricted exclusions", async () => {
  await rollback(async (tx) => {
    // SYNTHETIC additional county on a disposable copy of a Census relationship row.
    await tx.exec(
      `INSERT INTO zcta_county(zcta,county_fips,county_name,arealand_zcta,areawater_zcta,arealand_county,areawater_county,arealand_part,areawater_part,snapshot_id,source_row) SELECT zcta,'48203',county_name,arealand_zcta,areawater_zcta,arealand_county,areawater_county,arealand_part,areawater_part,snapshot_id,source_row FROM zcta_county WHERE zcta='77002' LIMIT 1`,
    );
    const answer = await householdDistributions(
      tx,
      { zip: scope.zip, year: scope.year, preset: preset.preset },
      enabled,
    );
    expect(answer.reason).toBe("location_ambiguous");
    expect(
      answer.profiles[0]!.metals.every((g) => g.points.minimum === null),
    ).toBe(true);
  });
  await rollback(async (tx) => {
    const initial = await run(tx),
      id = initial.profiles[0]!.lowest_silver!.plan_id;
    await tx.query(
      `UPDATE service_area_county SET partial_county=true,zip_codes='77003' WHERE service_area_id IN (SELECT service_area_id FROM plan WHERE base_plan_id=$1)`,
      [id],
    );
    const county = await householdDistributions(
      tx,
      { county: scope.county, year: scope.year, preset: preset.preset },
      enabled,
    );
    expect(county.profiles[0]!.lowest_silver).toBeNull();
    expect(
      county.profiles[0]!.metals.find((g) => g.metal === "silver")!.reasons,
    ).toContain("zip_limited_service_area");
    const answer = await run(tx);
    expect(answer.profiles[0]!.lowest_silver!.plan_id).not.toBe(id);
    const expected = await oracle(tx, answer.basis.members);
    for (const group of answer.profiles[0]!.metals)
      assertPopulation(
        group,
        expected.find((p) => p.metal === group.metal)!.expected,
      );
  });
});

it("returns complete empty populations as no_plans with zero denominators and null money", async () => {
  await rollback(async (tx) => {
    // SYNTHETIC exclusion of every on-exchange plan in this disposable catalog.
    await tx.exec("UPDATE plan SET on_exchange=false");
    const answer = await run(tx);
    expect(answer.status).toBe("no_plans");
    for (const group of answer.profiles[0]!.metals) {
      expect(group.status).toBe("no_plans");
      expect(group.counts.eligible).toBe(0);
      expect(group.counts.rated).toBe(0);
      expect(group.counts.unknown).toBe(0);
      expect(Object.values(group.points).every((p) => p === null)).toBe(true);
    }
  });
});
