import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import type { SqlSession } from "../../src/db/database.js";
import { ingestStateRates } from "../../src/ingest/state/index.js";
import { IMPORT_KINDS } from "../../src/ingest/puf/import-source.js";
import { ichraAffordability } from "../../src/services/ichra.js";
import type { IchraRequest } from "../../src/services/ichra.js";
import { dataAvailability } from "../../src/services/availability.js";
import { createApp } from "../../src/api/app.js";
import { callTool } from "../../src/mcp/tools.js";
import { outputSchemas } from "../../src/mcp/schemas.js";
import { coreMigrations, testDatabase } from "../pglite.js";
import { rebaseImports, replaceSyntax } from "../source-mutation.js";

// SYNTHETIC NY rates, identities, employees and SBE envelope. No real premium is asserted here.
type Json = ReturnType<typeof JSON.parse>;
const db = testDatabase(new PGlite());
let directory: string, core: Awaited<ReturnType<typeof coreMigrations>>;
const id = (n: number) => `99999NY001000${n}`;
const request: IchraRequest = {
  planStart: "2026-01-01",
  monthsAvailable: 12,
  dateOfBirth: "1985-10-01",
  eligibleFrom: null,
  residence: { county: "36061" },
  worksite: null,
  hraAnnualCents: 300_000,
  income: [{ measure: "household", annualCents: 4_118_000 }],
  safeHarbors: { location: false, lookBack: false },
  lcspPremiumBasis: null,
};
const run = async (tx: SqlSession = db, extra: Partial<IchraRequest> = {}) =>
  (await ichraAffordability(tx, { ...request, ...extra })) as Json;
async function rollback(test: (tx: SqlSession) => Promise<void>) {
  const marker = new Error("synthetic NY rollback");
  await expect(
    db.transaction(async (tx) => {
      await test(tx);
      throw marker;
    }),
  ).rejects.toBe(marker);
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "openplans-ny-lcsp-"));
  core = await coreMigrations();
  await migrate(db, core.directory);
  const fixture = JSON.parse(
    await readFile(
      new URL("../fixtures/state/ny-2026.json", import.meta.url),
      "utf8",
    ),
  );
  const template = fixture.sources[0].records[0];
  fixture.synthetic = true;
  fixture.sources[0].url =
    "https://myportal.dfs.ny.gov/documents/538523/45010883/Synthetic_IND_ONX_TEST-000000000_ApprRatesTemplate";
  fixture.sources[0].sha256 = createHash("sha256")
    .update("SYNTHETIC publication")
    .digest("hex");
  // The template check follows the synthetic publication it vouches for.
  const check = fixture.template_checks[0];
  const filing = "TEST-000000000";
  Object.assign(check, {
    url: fixture.sources[0].url,
    sha256: fixture.sources[0].sha256,
    filing,
    issuer_ids: ["99999"],
  });
  check.evidence.submission_source = {
    ...check.evidence.submission_source,
    url: `https://myportal.dfs.ny.gov/documents/538523/45010894/Synthetic_IND_ONX_${filing}_FinalExhibits`,
    members: check.evidence.submission_source.members.map((m: string) =>
      m.replace("MPHP-134514244", filing),
    ),
  };
  fixture.sources[0].records = [500, 600, 100, 50, 10].map((price, i) => {
    const region = i === 4 ? "Rating Area 1" : "Rating Area 4";
    const value = `${price}.00`;
    return {
      ...structuredClone(template),
      plan_id: id(i + 1),
      issuer: "99999",
      region,
      metal: i === 2 ? "Gold" : "Silver",
      child_only: i === 3 ? "Yes" : "No",
      source_record: `SYNTHETIC#row=${i + 1}`,
      prices: {
        single: value,
        couple: value,
        adult_children: value,
        family: value,
      },
      raw: {
        ...template.raw,
        "0": id(i + 1),
        "1": region,
        ...Object.fromEntries(
          [4, 6, 7, 8, 9, 10, 11, 12].map((c) => [c, value]),
        ),
      },
    };
  });
  const path = join(directory, "synthetic-ny.json");
  await writeFile(path, JSON.stringify(fixture));
  await ingestStateRates(db, path, "NY", { verifyRaw: false });
  await db.exec(
    `INSERT INTO source(source_id,publisher,source_kind) VALUES('synthetic-ny-sbe','SYNTHETIC CMS envelope','cms_sbe_puf')`,
  );
  for (const kind of ["bundle", ...IMPORT_KINDS]) {
    const snapshot = `synthetic-ny-sbe:${kind}`;
    await db.query(
      `INSERT INTO snapshot(snapshot_id,source_id,validation_state,expected_children,sha256,retrieved_at,activated_at)
      VALUES($1,'synthetic-ny-sbe','ACTIVE',0,$2,now(),now())`,
      [snapshot, createHash("sha256").update(snapshot).digest("hex")],
    );
  }
  await db.exec(`INSERT INTO puf_import(import_id,state,plan_year) VALUES('synthetic-ny-sbe:bundle','NY',2026);
    INSERT INTO sbe_catalog VALUES('synthetic-ny-sbe:bundle','cms_sbe_puf','https://example.test/SYNTHETIC-NY-SBE.zip','${"a".repeat(64)}',false)`);
  for (const kind of IMPORT_KINDS)
    await db.query(
      `INSERT INTO puf_import_file VALUES('synthetic-ny-sbe:bundle',$1,$2,1,1)`,
      [kind, `synthetic-ny-sbe:${kind}`],
    );
  for (let n = 1; n <= 5; n++) {
    await db.query(
      `INSERT INTO plan_attribute VALUES('synthetic-ny-sbe:plan-attributes',$1,2026,'NY','99999',$2,$3,'Individual',$4,false,'N','S','SYNTHETIC plan','On the Exchange',true,false,$5)`,
      [
        n,
        id(n),
        `${id(n)}-01`,
        n === 3 ? "Gold" : "Silver",
        JSON.stringify({
          "Child Only Offering":
            n === 4 ? "Allows Child-Only" : "Allows Adult and Child-Only",
          ChildOnlyOffering:
            n === 4 ? "Allows Child-Only" : "Allows Adult and Child-Only",
          "EHB Percent Premium": n === 2 ? "0.80" : "1.00",
        }),
      ],
    );
  }
});
afterAll(async () => {
  await db.close();
  await core.cleanup();
  await rm(directory, { recursive: true, force: true });
});

it("NY selects the lowest single silver in the DFS region and cites both publications", async () => {
  const result = await run();
  expect(result).toMatchObject({
    status: "calculated",
    quote_method: "state_filed_tier",
    bindable_quote: false,
    lcsp: {
      plan_ids: [id(1)],
      monthly_cents: 50_000,
      age_rating: "none",
      identified_at_age: null,
      priced_at_age: null,
      silver_plan_count: 2,
      location: { rating_area_id: "Rating Area 4" },
      by_basis: { ehb_portion: { plan_ids: [id(2)], monthly_cents: 48_000 } },
    },
    basis_sensitive: true,
  });
  const plan = result.lcsp.provenance.plans.find(
    (p: Json) => p.plan_key === id(1),
  );
  expect(plan).toMatchObject({
    single: { column: "E", value: "500.00", source_record: "SYNTHETIC#row=1" },
    exchange_evidence: {
      source: "cms_sbe_puf_plan_attributes",
      evidence: "exchange_offer",
      hios_id: id(1),
      source_rows: [1],
      bundle_url: "https://example.test/SYNTHETIC-NY-SBE.zip",
      bundle_sha256: "a".repeat(64),
    },
  });
  expect(plan.state_rule.references.length).toBeGreaterThan(0);
  expect(result.lcsp.provenance.geography.references.length).toBeGreaterThan(0);
  const ehb = await run(db, { lcspPremiumBasis: "ehb_portion" });
  expect(ehb.lcsp.monthly_cents).toBe(48_000);
  for (const dateOfBirth of ["2000-01-01", "1966-01-01"]) {
    const changed = await run(db, {
      dateOfBirth,
      income: [{ measure: "rate_of_pay_hourly", hourlyCents: 2000 }],
    });
    expect(changed.employer_lcsp).toMatchObject({
      monthly_cents: 50_000,
      plan_ids: [id(1)],
      identified_at_age: null,
      priced_at_age: null,
    });
  }
});

it("HTTP and MCP availability disclose the answered 2026 NY scope; look-back stays unknown", async () => {
  const check = (r: Json) =>
    expect(r).toMatchObject({
      ichra_status: "available",
      ichra_reason: null,
      ichra_lookback_status: "unknown",
      ichra_lookback_reason: "catalog_not_loaded",
    });
  for (const row of await dataAvailability(db)) check(row);
  const response = await createApp(db).request(
    "/v1/data-availability?state=NY&year=2026",
  );
  expect(response.status).toBe(200);
  for (const row of (await response.json()) as Json[]) check(row);
  const tool = await callTool({ db }, "get_data_status", {
    state: "NY",
    year: 2026,
    limit: 25,
  });
  const output = outputSchemas.get_data_status.parse(tool.structuredContent);
  expect(output.data!.datasets.length).toBeGreaterThan(0);
  for (const row of output.data!.datasets) check(row);
});

it.each([
  [
    "missing silver Exchange evidence",
    `DELETE FROM plan_attribute WHERE base_plan_id='${id(2)}'`,
    "exchange_offering_unverified",
  ],
  [
    "different HIOS identity",
    `UPDATE plan_attribute SET base_plan_id='99999NY0099999' WHERE base_plan_id='${id(2)}'`,
    "exchange_offering_unverified",
  ],
  [
    "missing metal and evidence",
    `DELETE FROM plan_attribute WHERE base_plan_id='${id(2)}'; UPDATE state_community_rate SET raw_record=raw_record-'metal' WHERE plan_key='${id(2)}'`,
    "metal_level_unknown",
  ],
  [
    "conflicting metal",
    `UPDATE plan_attribute SET metal='Gold' WHERE base_plan_id='${id(2)}'`,
    "metal_level_unknown",
  ],
  [
    "unrecognized metal",
    `UPDATE plan_attribute SET metal='unknown' WHERE base_plan_id='${id(2)}'; UPDATE state_community_rate SET raw_record=raw_record-'metal' WHERE plan_key='${id(2)}'`,
    "metal_level_unknown",
  ],
  [
    "unknown family offering",
    `UPDATE plan_attribute SET raw=raw-'ChildOnlyOffering' WHERE base_plan_id='${id(2)}'`,
    "coverage_family_eligibility_unknown",
  ],
  [
    "duplicate rate identity",
    `INSERT INTO state_community_rate SELECT import_id,source_index,record_index+100,publication_snapshot_id,plan_key,region,rate,raw_record FROM state_community_rate WHERE plan_key='${id(2)}'`,
    "conflicting_filed_tier_rows",
  ],
] as const)("fails closed for %s", async (_name, sql, reason) => {
  await rollback(async (tx) => {
    await tx.exec(sql);
    const result = await run(tx);
    expect(result).toMatchObject({
      status: "incomplete_lcsp",
      reason,
      verdicts: [],
    });
    expect(result.lcsp.monthly_cents).toBeNull();
    expect(result.lcsp.provenance.plans.length).toBeGreaterThan(0);
    const rows = await dataAvailability(tx);
    expect(rows.every((r) => r.ichra_status === "incomplete_lcsp")).toBe(true);
  });
});

it("preserves exact-price ties and rejects a missing community rule", async () => {
  await rollback(async (tx) => {
    await tx.exec(
      `UPDATE state_community_rate SET rate=jsonb_set(rate,'{prices,single}','50000') WHERE plan_key='${id(2)}'`,
    );
    expect((await run(tx)).lcsp.plan_ids).toEqual([id(1), id(2)]);
  });
  await rollback(async (tx) => {
    await tx.exec(
      `UPDATE state_rate_import SET rules_document=rules_document #- '{rules,0}' WHERE state='NY'`,
    );
    expect(await run(tx)).toMatchObject({
      status: "requires_state_rules",
      reason: "state_filed_tier_pending",
      verdicts: [],
    });
  });
});

it("inactive or incomplete SBE bundles cannot supply Exchange evidence", async () => {
  for (const sql of [
    "UPDATE snapshot SET validation_state='PARSED' WHERE snapshot_id='synthetic-ny-sbe:plan-attributes'",
    "DELETE FROM puf_import_file WHERE kind='rate'",
  ])
    await rollback(async (tx) => {
      await tx.exec(sql);
      expect(await run(tx)).toMatchObject({
        status: "incomplete_lcsp",
        reason: "exchange_offering_unverified",
      });
    });
});

it("NY EHB quotes accept published percent formats while gross quotes stay unchanged", async () => {
  for (const value of ["80%", "80", "80.0 %"])
    await rollback(async (tx) => {
      await tx.query(
        `UPDATE plan_attribute SET raw=jsonb_set(raw,'{EHB Percent Premium}',to_jsonb($1::text)) WHERE base_plan_id=$2`,
        [value, id(2)],
      );
      const result = await run(tx, { lcspPremiumBasis: "ehb_portion" });
      expect(result).toMatchObject({
        status: "calculated",
        lcsp: {
          monthly_cents: 48_000,
          plan_ids: [id(2)],
          by_basis: { gross: { monthly_cents: 50_000, plan_ids: [id(1)] } },
        },
      });
    });
});

it("unknown EHB fraction preserves gross; future years and look-back never substitute the 2026 rows", async () => {
  await rollback(async (tx) => {
    await tx.exec(
      `UPDATE plan_attribute SET raw=raw-'EHB Percent Premium' WHERE base_plan_id='${id(2)}'`,
    );
    expect(await run(tx)).toMatchObject({
      status: "calculated",
      basis_sensitive: null,
    });
    expect(await run(tx, { lcspPremiumBasis: "ehb_portion" })).toMatchObject({
      status: "incomplete_lcsp",
      reason: "ehb_allocation_unknown",
    });
  });
  expect(await run(db, { planStart: "2027-01-01" })).toMatchObject({
    status: "unknown",
    reason: "catalog_not_loaded",
  });
  expect(
    await run(db, { safeHarbors: { location: false, lookBack: true } }),
  ).toMatchObject({ status: "unknown", reason: "lookback_catalog_not_loaded" });
  expect(await run(db, { planStart: "2026-07-01" })).toMatchObject({
    status: "unknown",
    reason: "month_rate_rows_missing",
  });
});

it("planted source mutants: second/highest silver and silently dropping unverified silver fail the same assertions", async () => {
  const original = new URL("../../dist/services/ichra.js", import.meta.url);
  const source = await readFile(original, "utf8");
  for (const [name, before, after] of [
    ["price", "Math.min(...prices)", "Math.max(...prices)"],
    [
      "exchange",
      'if (!exchange_evidence)\n            return refuse("incomplete_lcsp", "exchange_offering_unverified");',
      "if (!exchange_evidence) continue;",
    ],
  ]) {
    const path = join(directory, `${name}.mjs`);
    await writeFile(
      path,
      rebaseImports(replaceSyntax(source, before!, after!), original),
    );
    const mutant = (await import(pathToFileURL(path).href)) as {
      ichraAffordability: typeof ichraAffordability;
    };
    if (name === "price") {
      const check = (r: Json) => assert.equal(r.lcsp.monthly_cents, 50_000);
      check(await run());
      const bad = await mutant.ichraAffordability(db, request);
      expect(() => check(bad)).toThrow(assert.AssertionError);
    } else
      await rollback(async (tx) => {
        await tx.exec(
          `DELETE FROM plan_attribute WHERE base_plan_id='${id(2)}'`,
        );
        const check = (r: Json) => assert.equal(r.status, "incomplete_lcsp");
        check(await run(tx));
        const bad = await mutant.ichraAffordability(tx, request);
        expect(() => check(bad)).toThrow(assert.AssertionError);
      });
  }
});

it("cited DFS off-Exchange silver is excluded; an unverified cell or conflicting CMS offer still refuses", async () => {
  // SYNTHETIC catalog transaction; these added identity/price facts are the real,
  // regenerated Anthem Exhibit 23 row 37, not an invented filed premium.
  await rollback(async (tx) => {
    const template = (
      await tx.query(`SELECT * FROM state_community_rate WHERE plan_key=$1`, [
        id(1),
      ])
    ).rows[0]!;
    const rate = structuredClone(template.rate) as Json;
    const raw = structuredClone(template.raw_record) as Json;
    rate.planKey = "41046NY0020014";
    rate.prices.single = 108882;
    rate.provenance.sourceUrl =
      "https://myportal.dfs.ny.gov/documents/538523/45010883/Anthem_HP_IND_BOTHX_AWLP-134536531_ApprRatesTemplate";
    rate.provenance.sourceSha256 =
      "b09d3f689c3bd507d2f00f0315c6956ae889a3caf62930cebd93bc954f3d7c62";
    raw.plan_id = rate.planKey;
    raw.issuer = "41046";
    raw.metal = null;
    raw.prices.single = "1088.82";
    raw.raw["0"] = rate.planKey;
    raw.raw["4"] = "1088.82";
    await tx.query(
      `INSERT INTO state_community_rate VALUES($1,0,100,$2,$3,'Rating Area 4',$4,$5)`,
      [
        template.import_id,
        template.publication_snapshot_id,
        rate.planKey,
        JSON.stringify(rate),
        JSON.stringify(raw),
      ],
    );
    const result = await run(tx);
    expect(result.status).toBe("calculated");
    expect(result.lcsp.monthly_cents).toBe(50_000);
    expect(result.lcsp.silver_plan_count).toBe(2);
    expect(
      result.lcsp.provenance.plans.find(
        (p: Json) => p.plan_key === rate.planKey,
      ).filed_identity,
    ).toMatchObject({
      source: "ny_dfs_exhibit_23",
      metal: "Silver",
      off_exchange: true,
      source_rows: [37],
    });
    await tx.exec(
      `UPDATE state_community_rate SET rate=jsonb_set(rate,'{prices,single}','108883') WHERE plan_key='41046NY0020014'`,
    );
    expect(await run(tx)).toMatchObject({
      status: "incomplete_lcsp",
      reason: "metal_level_unknown",
    });
    await tx.exec(`UPDATE state_community_rate SET rate=jsonb_set(rate,'{prices,single}','108882') WHERE plan_key='41046NY0020014';
      INSERT INTO plan_attribute SELECT snapshot_id,100,plan_year,state,'41046','41046NY0020014','41046NY0020014-01',market,metal,dental_only,network_id,service_area_id,plan_name,exchange_status,on_exchange,off_exchange,raw FROM plan_attribute WHERE source_row=1`);
    expect(await run(tx)).toMatchObject({
      status: "incomplete_lcsp",
      reason: "exchange_offering_conflict",
    });
  });
});

// SYNTHETIC refused template for a made-up issuer 88888, recorded the way the importer
// records one: a quarantined receipt plus a quality issue that lists the template's plans.
const refusedPlan = "88888NY0010001";
async function refuse(
  tx: SqlSession,
  listed: { plan_id: string; region: string }[] | null,
  metal: string | null = null,
) {
  const { import_id } = (
    await tx.query<{ import_id: string }>(
      `SELECT import_id FROM state_rate_active WHERE state='NY' AND plan_year=2026`,
    )
  ).rows[0]!;
  const snapshot = `${import_id}:refused:${"e".repeat(64)}`;
  await tx.query(
    `INSERT INTO snapshot(snapshot_id,source_id,retrieved_at,content_type,compressed_bytes,sha256,
    schema_version,parser_version,expected_children,fetched_children,validation_state)
    VALUES($1,'state-rates:NY:2026',now(),'synthetic',1,$2,'state-publication-v1','synthetic',0,0,'QUARANTINED')`,
    [snapshot, "e".repeat(64)],
  );
  await tx.query(
    `INSERT INTO quality_issue(source_id,snapshot_id,source_record,severity,issue_code,explanation)
    VALUES('state-rates:NY:2026',$1,'88888','warning','template_saved_before_submission',$2)`,
    [
      snapshot,
      JSON.stringify({
        status: "unknown",
        url: "https://myportal.dfs.ny.gov/documents/538523/45010883/Synthetic_IND_BOTHX_TEST-000000002_ApprRatesTemplate",
        filing: "TEST-000000002",
        ...(listed ? { listed_plans: listed } : {}),
      }),
    ],
  );
  if (metal)
    await tx.query(
      `INSERT INTO plan_attribute SELECT snapshot_id,200,plan_year,state,'88888',$1,$2,market,$3,dental_only,
      network_id,service_area_id,plan_name,exchange_status,on_exchange,off_exchange,raw FROM plan_attribute WHERE source_row=1`,
      [refusedPlan, `${refusedPlan}-01`, metal],
    );
}
const ratingArea1 = { residence: { county: "36001" } };
const unknownBenchmark = (r: Json) => {
  assert.equal(r.status, "unknown");
  assert.equal(r.reason, "template_saved_before_submission");
  assert.equal(r.lcsp.monthly_cents, null);
  assert.deepEqual(r.verdicts, []);
};

it("a refused issuer's plan that could rank makes the NY benchmark unknown; it is never computed without it", async () => {
  const baseline = {
    area4: JSON.stringify(await run()),
    area1: JSON.stringify(await run(db, ratingArea1)),
  };
  expect(JSON.parse(baseline.area1)).toMatchObject({ status: "calculated" });
  for (const metal of [null, "Silver", "Gold Silver"]) {
    await rollback(async (tx) => {
      await refuse(
        tx,
        [{ plan_id: refusedPlan, region: "Rating Area 4" }],
        metal === "Gold Silver" ? "Gold" : metal,
      );
      if (metal === "Gold Silver")
        await tx.query(
          `INSERT INTO plan_attribute SELECT snapshot_id,201,plan_year,state,issuer_id,base_plan_id,
          published_plan_id||'x',market,'Silver',dental_only,network_id,service_area_id,plan_name,exchange_status,
          on_exchange,off_exchange,raw FROM plan_attribute WHERE source_row=200`,
        );
      const result = await run(tx);
      unknownBenchmark(result);
      expect(result.lcsp).toMatchObject({
        status: "unknown",
        plan_ids: [],
        issues: [`${refusedPlan}: template_saved_before_submission`],
        provenance: {
          refused_templates: [
            {
              issuer: "88888",
              plan_id: refusedPlan,
              region: "Rating Area 4",
              reason: "template_saved_before_submission",
              filing: "TEST-000000002",
            },
          ],
        },
      });
      expect(result.employer_lcsp ?? result.lcsp).toMatchObject({
        monthly_cents: null,
      });
      unknownBenchmark(await run(tx, { lcspPremiumBasis: "ehb_portion" }));
      // Rating Area 1 has no refused plan: its answer is unchanged, byte for byte.
      expect(JSON.stringify(await run(tx, ratingArea1))).toBe(baseline.area1);
      const rows = await dataAvailability(tx);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows)
        expect(row).toMatchObject({
          ichra_status: "unknown",
          ichra_reason: "template_saved_before_submission",
        });
    });
  }
});

it("refused plans that cannot rank leave NY benchmarks byte-identical; an unlisted footprint is unknown everywhere", async () => {
  const baseline = {
    area4: JSON.stringify(await run()),
    area1: JSON.stringify(await run(db, ratingArea1)),
  };
  // CMS shows the only listed plan is Gold, or it is listed in another region.
  for (const [listed, metal] of [
    [[{ plan_id: refusedPlan, region: "Rating Area 4" }], "Gold"],
    [[{ plan_id: refusedPlan, region: "Rating Area 2" }], null],
  ] as const)
    await rollback(async (tx) => {
      await refuse(tx, [...listed], metal);
      expect(JSON.stringify(await run(tx))).toBe(baseline.area4);
      expect(JSON.stringify(await run(tx, ratingArea1))).toBe(baseline.area1);
    });
  await rollback(async (tx) => {
    await refuse(tx, [{ plan_id: refusedPlan, region: "Rating Area 1" }]);
    expect(JSON.stringify(await run(tx))).toBe(baseline.area4);
    unknownBenchmark(await run(tx, ratingArea1));
  });
  await rollback(async (tx) => {
    await refuse(tx, null);
    const result = await run(tx);
    unknownBenchmark(result);
    expect(result.lcsp.provenance.refused_templates).toMatchObject([
      { issuer: "88888", plan_id: null, region: null },
    ]);
    unknownBenchmark(await run(tx, ratingArea1));
  });
});

it("planted source mutants: a benchmark computed without the refused issuer fails", async () => {
  const original = new URL("../../dist/services/ichra.js", import.meta.url);
  const source = await readFile(original, "utf8");
  for (const [name, before, after, metal] of [
    [
      "refusal ignored",
      ".filter(couldRankSilver)",
      ".filter(() => false)",
      null,
    ],
    ["CMS silver ignored", 'metals[0] !== "silver"', "true", "Silver"],
  ] as const) {
    const path = join(directory, `${name.replaceAll(" ", "-")}.mjs`);
    await writeFile(
      path,
      rebaseImports(replaceSyntax(source, before, after), original),
    );
    const mutant = (await import(pathToFileURL(path).href)) as {
      ichraAffordability: typeof ichraAffordability;
    };
    await rollback(async (tx) => {
      await refuse(
        tx,
        [{ plan_id: refusedPlan, region: "Rating Area 4" }],
        metal,
      );
      unknownBenchmark(await run(tx));
      const bad = await mutant.ichraAffordability(tx, request);
      expect(bad.status, name).toBe("calculated");
      expect(() => unknownBenchmark(bad)).toThrow(assert.AssertionError);
    });
  }
});
