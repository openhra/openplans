import { mappingFixture as fixture } from "./mapping-fixture.js";
import { PGlite } from "@electric-sql/pglite";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, expect, it } from "vitest";
import { findPlan, planView } from "../../../src/api/repository.js";
import { mapPlan, mapVariantBenefits } from "../../../src/compat/v1/mapping.js";
import { createApp } from "../../../src/api/app.js";
import { migrate } from "../../../src/db/migrate.js";
import { IMPORT_KINDS } from "../../../src/ingest/puf/import-source.js";
import { parseImportRow } from "../../../src/ingest/puf/import-parse.js";
import {
  insertImportRows,
  deriveCatalogRows,
} from "../../../src/ingest/puf/import-repository.js";
import { normalizeSbeRow } from "../../../src/ingest/sbe/normalize.js";
import { ingestStateRates } from "../../../src/ingest/state/index.js";
import { coreMigrations, testDatabase } from "../../pglite.js";
import { replaceSyntax } from "../../source-mutation.js";

const db = testDatabase(new PGlite());
let directory: string, core: Awaited<ReturnType<typeof coreMigrations>>;

// Synthetic six-member import envelope; stored rows are unchanged public cuts.
async function supplement(state: string) {
  const id = `synthetic-mapping-${state}`;
  const sources = fixture.sources.filter((s) => s.base.includes(state!));
  await db.query(
    "INSERT INTO source(source_id,publisher,source_kind) VALUES($1,'CMS public row cut; synthetic envelope','cms_sbe_puf')",
    [id],
  );
  for (const snapshot of [id, ...IMPORT_KINDS.map((k) => `${id}:${k}`)])
    await db.query(
      `INSERT INTO snapshot(snapshot_id,source_id,validation_state,expected_children,sha256,retrieved_at)
      VALUES($1,$2,'PARSED',0,$3,now())`,
      [snapshot, id, createHash("sha256").update(snapshot).digest("hex")],
    );
  await db.query(
    "INSERT INTO puf_import(import_id,state,plan_year) VALUES($1,$2,2026)",
    [id, state],
  );
  await db.query(
    "INSERT INTO sbe_catalog(import_id,bundle_url,bundle_sha256,serving) VALUES($1,$2,$3,false)",
    [id, sources[0]!.url, sources[0]!.sha256],
  );
  for (const kind of IMPORT_KINDS)
    await db.query(
      "INSERT INTO puf_import_file(import_id,kind,snapshot_id) VALUES($1,$2,$3)",
      [id, kind, `${id}:${kind}`],
    );
  for (const source of sources)
    await insertImportRows(
      db,
      source.kind,
      source.rows.map((row) =>
        parseImportRow(
          source.kind,
          normalizeSbeRow(source.kind, {
            rowNumber: row.source_row,
            recordNumber: row.source_row - 1,
            fields: Object.keys(row.values),
            values: row.values,
          }),
          `${id}:${source.kind}`,
        ),
      ),
    );
  await deriveCatalogRows(db, "plan-attributes", `${id}:plan-attributes`);
  await db.query(
    "UPDATE snapshot SET validation_state='ACTIVE',activated_at=now() WHERE source_id=$1",
    [id],
  );
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "openplans-mapping-state-"));
  core = await coreMigrations();
  await migrate(db, core.directory);
  for (const state of ["NY", "VT"] as const) {
    const path = join(directory, state + ".json");
    await writeFile(
      path,
      await readFile(
        new URL(
          `../../fixtures/state/${state.toLowerCase()}-2026.json`,
          import.meta.url,
        ),
      ),
    );
    await ingestStateRates(db, path, state, { verifyRaw: false });
    await supplement(state);
  }
});
afterAll(async () => {
  await db.close();
  await core.cleanup();
  await rm(directory, { recursive: true, force: true });
});

it("enriches NY/VT filed details from the selected supplemental variant with immutable provenance", async () => {
  for (const [key, state, type] of [
    ["11177NY0220001", "NY", "HMO"],
    ["BCBSVT:Gold Plan", "VT", "EPO"],
  ]) {
    const plan = (await findPlan(db, key!, 2026))!;
    const view = await planView(db, plan);
    expect(view.cost_sharing.status).toBe("available");
    expect(view.cost_sharing.selected_variant_id).toBe(plan.hios_id + "-01");
    expect(view.cost_sharing.provenance!.snapshot_id).toBe(
      `synthetic-mapping-${state}:plan-attributes`,
    );
    expect(view.cost_sharing.supplemental_source).toMatchObject({
      bundle_sha256: fixture.sources.find((s) => s.base.includes(state!))!
        .sha256,
    });
    expect(mapPlan(view, key!)).toMatchObject({
      plan_type: type,
      hsa_eligible: false,
      effective_date: "2026-01-01T00:00:00.000Z",
    });
    expect(
      mapVariantBenefits(
        view.cost_sharing.benefits,
        view.cost_sharing.selected_variant_id!,
      ),
    ).toHaveProperty("chiropractic_services", true);
    for (const row of view.cost_sharing.benefits) {
      expect(row.published_plan_id).toBe(view.cost_sharing.selected_variant_id);
      expect(row.snapshot_id).toBe(
        `synthetic-mapping-${state}:benefits-and-cost-sharing`,
      );
    }
    const wrongVariant = await planView(db, plan, { csrVariant: "05" });
    expect(wrongVariant.cost_sharing.status).toBe("unknown");
    expect(wrongVariant.cost_sharing.benefits).toEqual([]);
    expect(mapPlan(wrongVariant, key!).plan_type).toBeNull();
  }
});

it("does not enrich an unresolved state identity or an inactive/incomplete supplemental catalog", async () => {
  const plan = (await findPlan(db, "BCBSVT:Gold Plan", 2026))!;
  expect(
    (await planView(db, { ...plan, hios_id: null })).cost_sharing.status,
  ).toBe("unknown");
  const marker = new Error("rollback synthetic catalog mutations");
  for (const mutation of [
    "UPDATE snapshot SET validation_state='PARSED' WHERE snapshot_id='synthetic-mapping-VT:network'",
    "UPDATE plan_attribute SET market='SHOP (Small Group)' WHERE snapshot_id='synthetic-mapping-VT:plan-attributes'",
    "UPDATE puf_import SET plan_year=2027 WHERE import_id='synthetic-mapping-VT'",
  ]) {
    await expect(
      db.transaction(async (tx) => {
        await tx.exec(mutation);
        expect((await planView(tx, plan)).cost_sharing.status).toBe("unknown");
        throw marker;
      }),
    ).rejects.toBe(marker);
  }
});

it("serves explicit selected state variants over native and compatibility HTTP without changing filed rates", async () => {
  const token = "synthetic-state-mapping-token";
  process.env.OPENPLANS_COMPAT_API_KEY = token;
  const app = createApp(db);
  const before = (
    await db.query(
      "SELECT plan_key,rate,raw_record FROM state_community_rate ORDER BY import_id,source_index,record_index",
    )
  ).rows;
  for (const base of ["11177NY0220001", "13627VT0340003"]) {
    for (const prefix of ["/v1/plans/", "/compat/v1/plans/"]) {
      const response = await app.request(`${prefix}${base}-01?year=2026`, {
        headers: { "X-Api-Key": token },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        plan: { effective_date: string; chiropractic_services: boolean };
        cost_sharing: { selected_variant_id: string; status: string };
      };
      if (prefix.startsWith("/compat")) {
        expect(body.plan.effective_date).toBe("2026-01-01T00:00:00.000Z");
        expect(body.plan.chiropractic_services).toBe(true);
      } else {
        expect(body.cost_sharing.selected_variant_id).toBe(base + "-01");
        expect(body.cost_sharing.status).toBe("available");
      }
      expect(
        (
          await app.request(`${prefix}${base}-05?year=2026`, {
            headers: { "X-Api-Key": token },
          })
        ).status,
      ).toBe(404);
    }
  }
  expect(
    (
      await db.query(
        "SELECT plan_key,rate,raw_record FROM state_community_rate ORDER BY import_id,source_index,record_index",
      )
    ).rows,
  ).toEqual(before);
});

type View = Awaited<ReturnType<typeof planView>>;
type Mapper = { mapPlan: typeof mapPlan };
/** Expected values are the matched CMS state PUF cells: METAL LEVEL Gold, QHP NONQHP TYPE ID Both. */
async function stateFactsContract(m: Mapper) {
  const ny = (await findPlan(db, "11177NY0220001", 2026))!;
  const view = await planView(db, ny);
  // Native filed-tier values stay as filed; the PUF row is additive evidence.
  assert.equal(view.metal, "unknown");
  assert.equal(view.on_exchange, "unknown");
  assert.ok("supplemental_plan" in view && view.supplemental_plan);
  assert.equal(
    view.supplemental_plan.snapshot_id,
    "synthetic-mapping-NY:plan-attributes",
  );
  const nyPlan = m.mapPlan(view, "11177NY0220001");
  assert.equal(nyPlan.level, "gold");
  assert.equal(nyPlan.on_market, true);
  assert.equal(nyPlan.off_market, true);
  assert.equal(nyPlan.plan_market, "both");
  const vt = (await findPlan(db, "BCBSVT:Gold Plan", 2026))!;
  assert.equal(
    m.mapPlan(await planView(db, vt), "BCBSVT:Gold Plan").level,
    "gold",
  );
  // A filed metal wins over the supplemental row.
  assert.equal(
    m.mapPlan({ ...view, metal: "Silver" } as View, "11177NY0220001").level,
    "silver",
  );
  // Without a resolved HIOS identity nothing is borrowed.
  const unresolved = m.mapPlan(
    await planView(db, { ...ny, hios_id: null }),
    "11177NY0220001",
  );
  assert.equal(unresolved.level, "unknown");
  assert.equal(unresolved.on_market, null);
  assert.equal(unresolved.off_market, null);
  assert.equal(unresolved.plan_market, null);
  // Expanded Bronze is its own public metal level.
  const expanded = {
    ...view,
    supplemental_plan: { ...view.supplemental_plan, metal: "Expanded Bronze" },
  } as View;
  assert.equal(m.mapPlan(expanded, "11177NY0220001").level, "expanded_bronze");
}

it("fills NY/VT compatibility metal and market flags from the matched state PUF row", async () => {
  await stateFactsContract({ mapPlan });
  const marker = new Error("rollback synthetic supplemental mutation");
  await expect(
    db.transaction(async (tx) => {
      // Two plan-level rows for one HIOS are ambiguous and supply nothing.
      await tx.exec(`INSERT INTO plan_attribute SELECT snapshot_id,source_row+1000,plan_year,state,
        issuer_id,base_plan_id,published_plan_id,market,'Silver',dental_only,network_id,service_area_id,
        plan_name,exchange_status,on_exchange,off_exchange,raw FROM plan_attribute
        WHERE snapshot_id='synthetic-mapping-NY:plan-attributes'`);
      const ny = (await findPlan(tx, "11177NY0220001", 2026))!;
      const view = await planView(tx, ny);
      expect(view).not.toHaveProperty("supplemental_plan");
      expect(mapPlan(view, "11177NY0220001")).toMatchObject({
        level: "unknown",
        on_market: null,
        plan_market: null,
      });
      throw marker;
    }),
  ).rejects.toBe(marker);
});

it("reads plan-level facts across all published variant rows of the matched plan", async () => {
  const marker = new Error("rollback synthetic variant row");
  await expect(
    db.transaction(async (tx) => {
      // A synthetic off-exchange-only variant row with the same metal joins the plan.
      await tx.exec(`INSERT INTO plan_attribute SELECT snapshot_id,source_row+1000,plan_year,state,
        issuer_id,base_plan_id,base_plan_id||'-99',market,metal,dental_only,network_id,service_area_id,
        plan_name,'Off the Exchange',false,true,raw FROM plan_attribute
        WHERE snapshot_id='synthetic-mapping-NY:plan-attributes'`);
      const ny = (await findPlan(tx, "11177NY0220001", 2026))!;
      const view = await planView(tx, ny);
      expect(view).toHaveProperty("supplemental_plan.metal", "Gold");
      expect(mapPlan(view, "11177NY0220001")).toMatchObject({
        level: "gold",
        on_market: true,
        off_market: true,
      });
      throw marker;
    }),
  ).rejects.toBe(marker);
});

it("negative controls: collapsed metal, overridden filings and dropped PUF flags fail the contract", async () => {
  const source = await readFile(
    new URL("../../../src/compat/v1/mapping.ts", import.meta.url),
    "utf8",
  );
  const directory = await mkdtemp(join(tmpdir(), "openplans-state-facts-"));
  try {
    for (const [name, before, after] of [
      [
        "expanded-bronze",
        'metal.toLowerCase().replaceAll(" ", "_")',
        'metal.toLowerCase().replace("expanded ", "").replaceAll(" ", "_")',
      ],
      [
        "override-filing",
        'view.metal === "unknown" && supplemental',
        "supplemental",
      ],
      ["drop-on", "(supplemental?.on_exchange ?? null)", "null"],
    ] as const) {
      const path = join(directory, name + ".cjs");
      await writeFile(
        path,
        ts.transpileModule(replaceSyntax(source, before, after), {
          compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
          },
        }).outputText,
      );
      const mutant = createRequire(import.meta.url)(path) as Mapper;
      await expect(stateFactsContract(mutant), name).rejects.toThrow();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
