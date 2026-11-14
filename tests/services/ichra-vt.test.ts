import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import type { SqlSession } from "../../src/db/database.js";
import { ingestStateRates } from "../../src/ingest/state/index.js";
import { IMPORT_KINDS } from "../../src/ingest/puf/import-source.js";
import {
  ichraAffordability,
  vtLcspAvailability,
} from "../../src/services/ichra.js";
import type { IchraRequest } from "../../src/services/ichra.js";
import { vtLcspCatalog } from "../../src/ingest/state/catalog.js";
import { dataAvailability } from "../../src/services/availability.js";
import { callTool } from "../../src/mcp/tools.js";
import { coreMigrations, testDatabase } from "../pglite.js";
import cut from "../../data/rating-rules/vt-plan-metals-2026.json" with { type: "json" };
import cms from "../ingest/state/fixtures/vt-hios-2026.json" with { type: "json" };

// Real cited plan facts in a SYNTHETIC import envelope. Employee/income are SYNTHETIC.
const db = testDatabase(new PGlite());
let directory: string, core: Awaited<ReturnType<typeof coreMigrations>>;
const request: IchraRequest = {
  planStart: "2026-01-01",
  monthsAvailable: 12,
  dateOfBirth: "1985-10-01",
  eligibleFrom: null,
  residence: { county: "50007" },
  worksite: null,
  hraAnnualCents: 300_000,
  income: [{ measure: "household", annualCents: 4_118_000 }],
  safeHarbors: { location: false, lookBack: false },
  lcspPremiumBasis: "gross",
};
async function rollback(test: (tx: SqlSession) => Promise<void>) {
  const marker = new Error("SYNTHETIC VT rollback");
  await expect(
    db.transaction(async (tx) => {
      await test(tx);
      throw marker;
    }),
  ).rejects.toBe(marker);
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "openplans-vt-lcsp-"));
  core = await coreMigrations();
  await migrate(db, core.directory);
  const fixture = JSON.parse(
    await readFile(
      new URL("../fixtures/state/vt-2026.json", import.meta.url),
      "utf8",
    ),
  );
  fixture.sources[0].records = cut.plans.map((plan) => {
    const [issuer, name] = plan.plan_key.split(":");
    const prices = Object.fromEntries(
      Object.entries(plan.prices).map(([tier, cents]) => [
        tier,
        (cents / 100).toFixed(2),
      ]),
    );
    return {
      plan_id: null,
      issuer,
      plan_name: name,
      region: "Vermont",
      prices,
      child_only: "No",
      metal: null,
      exchange: "On",
      source_record: plan.source_record,
      raw: prices,
    };
  });
  const path = join(directory, "vt-cited-facts.json");
  await writeFile(path, JSON.stringify(fixture));
  await ingestStateRates(db, path, "VT", { verifyRaw: false });
  await db.exec(
    "INSERT INTO source(source_id,publisher,source_kind) VALUES('synthetic-vt-sbe','SYNTHETIC CMS envelope','cms_sbe_puf')",
  );
  for (const kind of ["bundle", ...IMPORT_KINDS]) {
    const snapshot = `synthetic-vt-sbe:${kind}`;
    await db.query(
      `INSERT INTO snapshot(snapshot_id,source_id,validation_state,expected_children,sha256,retrieved_at,activated_at)
      VALUES($1,'synthetic-vt-sbe','ACTIVE',0,$2,now(),now())`,
      [snapshot, createHash("sha256").update(snapshot).digest("hex")],
    );
  }
  await db.exec(`INSERT INTO puf_import(import_id,state,plan_year) VALUES('synthetic-vt-sbe:bundle','VT',2026);
    INSERT INTO sbe_catalog VALUES('synthetic-vt-sbe:bundle','cms_sbe_puf','${cut.bundle_url}','${cut.bundle_sha256}',false)`);
  for (const kind of IMPORT_KINDS)
    await db.query(
      "INSERT INTO puf_import_file VALUES('synthetic-vt-sbe:bundle',$1,$2,1,1)",
      [kind, `synthetic-vt-sbe:${kind}`],
    );
  for (const plan of cut.plans)
    for (const cell of plan.attributes) {
      const real = cms.rows.find(
        (r) => r.source_row === cell.source_row,
      )!.values;
      const raw = {
        ...real,
        "QHP NONQHP TYPE ID": cell.exchange,
        "EHB PERCENT PREMIUM": cell.ehb_fraction,
        ChildOnlyOffering: cell.child_only_offering,
      };
      await db.query(
        `INSERT INTO plan_attribute VALUES('synthetic-vt-sbe:plan-attributes',$1,2026,'VT',$2,$3,$4,'Individual',$5,false,'N','S',$6,'Both',true,true,$7)`,
        [
          cell.source_row,
          real.IssuerId,
          plan.hios_id,
          cell.plan_id,
          cell.metal,
          real.PlanMarketingName,
          JSON.stringify(raw),
        ],
      );
    }
  await db.exec("SELECT refresh_vt_hios_matches()");
});
afterAll(async () => {
  await db.close();
  await core.cleanup();
  await rm(directory, { recursive: true, force: true });
});

it("uses literal CMS metals for all 26 filed plans and selects the lowest single silver", async () => {
  const catalog = await vtLcspCatalog(db, 2026);
  expect(catalog).toHaveLength(26);
  expect(catalog.every((p) => p.filed_identity)).toBe(true);
  const result = await ichraAffordability(db, request);
  expect(result).toMatchObject({
    status: "calculated",
    quote_method: "state_filed_tier",
    lcsp: {
      plan_ids: ["MVP:MVP VT Silver 3"],
      monthly_cents: 128859,
      silver_plan_count: 8,
      age_rating: "none",
      identified_at_age: null,
      priced_at_age: null,
      location: { rating_area_id: "Vermont" },
    },
  });
  expect(result.lcsp?.provenance).toMatchObject({
    plans: expect.arrayContaining([
      expect.objectContaining({
        plan_key: "MVP:MVP VT Silver 3",
        hios_id: "77566VT0040005",
        filed_identity: expect.objectContaining({
          metal: "Silver",
          member: cut.member,
          source_sha256: cut.bundle_sha256,
        }),
      }),
    ]),
  });
  expect(
    (
      await ichraAffordability(db, {
        ...request,
        lcspPremiumBasis: "ehb_portion",
      })
    ).status,
  ).toBe("calculated");
  expect(await vtLcspAvailability(db, 2026)).toEqual({
    status: "available",
    reason: null,
  });
  const availability = await dataAvailability(db);
  expect(availability.length).toBeGreaterThan(0);
  expect(availability.every((r) => r.ichra_status === "available")).toBe(true);
});

// Found by scripts/oracle/surface-sweep.mjs: the MCP output check required HIOS plan IDs and an
// age, so every Vermont county answered INTERNAL_HONESTY_CHECK.
it("MCP check_ichra_affordability returns the Vermont LCSP by plan key, with no age", async () => {
  const out = (
    await callTool(
      {
        db,
        principal: { id: "synthetic" },
        policy: { canEstimate: () => true },
      } as never,
      "check_ichra_affordability",
      {
        plan_start: "2026-01-01",
        employee: { date_of_birth: "1985-10-01" },
        residence: { county: "50007" },
        hra: { self_only_annual_cents: 300_000 },
        income: [{ measure: "household", annual_cents: 4_118_000 }],
      },
    )
  ).structuredContent as {
    error: unknown;
    data: { status: string; lcsps: unknown[] };
  };
  expect(out.error).toBeNull();
  expect(out.data.status).toBe("calculated");
  expect(out.data.lcsps[0]).toMatchObject({
    plan_ids: ["MVP:MVP VT Silver 3"],
    monthly_cents: 128859,
    identified_at_age: null,
    priced_at_age: null,
  });
});

it("rejects wrong metal, missing silver variants, changed prices and unverified catalog bytes", async () => {
  for (const sql of [
    "UPDATE plan_attribute SET metal='Gold' WHERE metal='Silver'",
    "DELETE FROM plan_attribute WHERE metal='Silver'",
    "UPDATE state_community_rate SET region='missing-area-evidence' WHERE plan_key='MVP:MVP VT Silver 3'",
    "UPDATE plan_attribute SET on_exchange=false WHERE metal='Silver'",
    "UPDATE state_community_rate SET rate=jsonb_set(rate,'{childOnly}','true') WHERE plan_key='MVP:MVP VT Silver 3'",
    "DELETE FROM plan_attribute WHERE source_row=(SELECT min(source_row) FROM plan_attribute WHERE metal='Silver')",
    "UPDATE state_community_rate SET rate=jsonb_set(rate,'{prices,single}','1') WHERE plan_key='MVP:MVP VT Silver 3'",
    "UPDATE sbe_catalog SET bundle_sha256=repeat('b',64)",
    "UPDATE snapshot SET validation_state='QUARANTINED' WHERE snapshot_id='synthetic-vt-sbe:plan-attributes'",
    "UPDATE plan_attribute SET raw=jsonb_set(raw,'{ChildOnlyOffering}','\"Allows Child-Only\"') WHERE metal='Silver'",
  ])
    await rollback(async (tx) => {
      await tx.exec(sql);
      expect(await ichraAffordability(tx, request)).toMatchObject({
        status: "incomplete_lcsp",
        reason: "metal_level_unknown",
      });
    });
});

it("does not substitute another year, month or look-back catalog", async () => {
  expect(
    await ichraAffordability(db, { ...request, planStart: "2027-01-01" }),
  ).toMatchObject({ status: "unknown", reason: "catalog_not_loaded" });
  expect(
    await ichraAffordability(db, { ...request, planStart: "2026-02-01" }),
  ).toMatchObject({ status: "unknown", reason: "month_rate_rows_missing" });
  expect(
    await ichraAffordability(db, {
      ...request,
      income: [{ measure: "rate_of_pay_hourly", hourlyCents: 2000 }],
      safeHarbors: { location: false, lookBack: true },
    }),
  ).toMatchObject({ status: "unknown", reason: "lookback_catalog_not_loaded" });
});

it("rejects a disposable publication byte mutant", () => {
  const result = spawnSync(
    "python3",
    [
      "-B",
      "-c",
      String.raw`
import hashlib, importlib.util, pathlib, sys, tempfile
sys.path.insert(0, sys.argv[1])
spec = importlib.util.spec_from_file_location('vt_metal', pathlib.Path(sys.argv[1]) / 'vt-metal.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as directory:
    path = pathlib.Path(directory) / 'SYNTHETIC-publication'
    path.write_bytes(b'SYNTHETIC source')
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    module.verified(path, digest)
    path.write_bytes(b'SYNTHETIC mutant')
    try: module.verified(path, digest)
    except ValueError: pass
    else: raise AssertionError('Tampered bytes accepted')
print('PASS')
`,
      fileURLToPath(new URL("../../src/ingest/state/", import.meta.url)),
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe("PASS");
});
