import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createApp } from "../../../src/api/app.js";
import { findPlan, planView } from "../../../src/api/repository.js";
import type { SqlSession } from "../../../src/db/database.js";
import { migrate, migrationsDirectory } from "../../../src/db/migrate.js";
import { ingestStateRates } from "../../../src/ingest/state/index.js";
import { stateCatalog } from "../../../src/ingest/state/catalog.js";
import { IMPORT_KINDS } from "../../../src/ingest/puf/import-source.js";
import { insertImportRows } from "../../../src/ingest/puf/import-repository.js";
import { parseImportRow } from "../../../src/ingest/puf/import-parse.js";
import { coreMigrations, testDatabase } from "../../pglite.js";

const fixture = JSON.parse(
  await readFile(
    new URL("./fixtures/vt-hios-2026.json", import.meta.url),
    "utf8",
  ),
) as {
  url: string;
  sha256: string;
  member: string;
  rows: { source_row: number; values: Record<string, string> }[];
};
const db = testDatabase(new PGlite()),
  token = "synthetic-vt-hios-test-token";
const key = "BCBSVT:Gold Plan",
  id = "13627VT0340003";
let directory: string, core: Awaited<ReturnType<typeof coreMigrations>>;

// SYNTHETIC import envelope around unchanged real identity facts. Only this test
// harness omits the unrelated five members; production realcheck imports all six.
async function attributes(
  tx: SqlSession,
  name: string,
  rows = fixture.rows,
  active = true,
) {
  const importId = `synthetic-vt-hios:${name}`;
  await tx.query(
    `INSERT INTO source(source_id,publisher,source_kind,registry_evidence)
    VALUES($1,'CMS public identity cut; synthetic envelope','cms_sbe_puf',$2)`,
    [
      importId,
      JSON.stringify({
        url: fixture.url,
        sha256: fixture.sha256,
        member: fixture.member,
      }),
    ],
  );
  for (const snapshot of [
    importId,
    ...IMPORT_KINDS.map((kind) => `${importId}:${kind}`),
  ]) {
    await tx.query(
      `INSERT INTO snapshot(snapshot_id,source_id,validation_state,expected_children,
      sha256,retrieved_at,activated_at,schema_version)
      VALUES($1,$2,'PARSED',0,$3,now(),now(),'synthetic-hios-envelope')`,
      [snapshot, importId, createHash("sha256").update(snapshot).digest("hex")],
    );
  }
  await tx.query(
    `INSERT INTO puf_import(import_id,state,plan_year,started_at)
    VALUES($1,'VT',2026,clock_timestamp())`,
    [importId],
  );
  await tx.query(
    `INSERT INTO sbe_catalog(import_id,bundle_url,bundle_sha256,serving) VALUES($1,$2,$3,false)`,
    [importId, fixture.url, fixture.sha256],
  );
  for (const kind of IMPORT_KINDS)
    await tx.query(
      "INSERT INTO puf_import_file(import_id,kind,snapshot_id) VALUES($1,$2,$3)",
      [importId, kind, `${importId}:${kind}`],
    );
  await insertImportRows(
    tx,
    "plan-attributes",
    rows.map((row) =>
      parseImportRow(
        "plan-attributes",
        {
          rowNumber: row.source_row,
          recordNumber: row.source_row - 1,
          fields: Object.values(row.values),
          values: row.values,
        },
        `${importId}:plan-attributes`,
      ),
    ),
  );
  if (active)
    await tx.query(
      `UPDATE snapshot SET validation_state='ACTIVE' WHERE source_id=$1`,
      [importId],
    );
  return importId;
}
async function rollback(run: (tx: SqlSession) => Promise<void>) {
  const marker = new Error("synthetic identity mutation rollback");
  await expect(
    db.transaction(async (tx) => {
      await run(tx);
      throw marker;
    }),
  ).rejects.toBe(marker);
}
async function quote(
  tx: SqlSession,
  lookup: { plan_keys?: string[]; plan_ids?: string[] },
  members: unknown[],
) {
  const response = await createApp(tx, { premiumToken: token }).request(
    "/v1/premium-estimates",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        ...lookup,
        county: "50007",
        coverage_start: "2026-01-01",
        members,
      }),
    },
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as any).estimates[0];
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "openplans-vt-hios-"));
  core = await coreMigrations();
  await migrate(db, core.directory);
  const path = join(directory, "VT.json");
  await writeFile(
    path,
    await readFile(
      new URL("../../fixtures/state/vt-2026.json", import.meta.url),
    ),
  );
  await ingestStateRates(db, path, "VT", { verifyRaw: false });
});
afterAll(async () => {
  await db.close();
  await core.cleanup();
  await rm(directory, { recursive: true, force: true });
});

it("has no HIOS ID without supplemental evidence; joins automatically when a complete SBE set activates", async () => {
  expect(await planView(db, (await findPlan(db, key, 2026))!)).toMatchObject({
    hios_id: null,
    hios_match: "none",
    hios_match_reason: "no_verified_hios_match",
    hios_candidates: [],
    off_exchange: "unknown",
  });
  const before = JSON.stringify(
    (
      await db.query(
        "SELECT * FROM state_community_rate ORDER BY source_index,record_index",
      )
    ).rows,
  );
  await attributes(db, "real-facts");
  const view = await planView(db, (await findPlan(db, key, 2026))!);
  expect(view).toMatchObject({
    hios_id: id,
    base_plan_id: id,
    plan_key: key,
    issuer: { issuer_id: "13627" },
    hios_match: "matched",
    hios_match_rule: "vt-hios-exact-v1",
    hios_match_reason: "unique_exact_tuple",
    hios_candidates: [
      {
        hios_id: id,
        bundle_url: fixture.url,
        bundle_sha256: fixture.sha256,
        attribute_member: fixture.member,
      },
    ],
    hios_match_provenance: {
      filed: {
        plan_name: "Gold Plan",
        source_record: "page=1;issuer=BCBSVT;column=2",
      },
    },
    on_exchange: true,
    off_exchange: true,
    provenance: {
      exchange: {
        snapshot_id: "synthetic-vt-hios:real-facts:plan-attributes",
        source_rows: [13, 14, 15],
      },
    },
  });
  expect(view.hios_candidates).toHaveLength(1); // CSR rows collapse to a base design.
  expect(view.hios_candidates![0]!.attribute_rows).toHaveLength(3);
  expect(
    (await stateCatalog(db, 2026, "VT")).every(
      (row) => row.hios_match === "matched",
    ),
  ).toBe(true);
  expect(
    JSON.stringify(
      (
        await db.query(
          "SELECT * FROM state_community_rate ORDER BY source_index,record_index",
        )
      ).rows,
    ),
  ).toBe(before);
  const listed = await createApp(db).request(
    "/v1/plans?county=50007&year=2026",
  );
  expect(listed.status).toBe(200);
  expect(((await listed.json()) as any).plans).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        hios_id: id,
        on_exchange: true,
        off_exchange: true,
      }),
    ]),
  );
});

it("native HIOS and plan_keys requests select byte-identical premium evidence in every family tier", async () => {
  const subscriber = { age: 40, tobacco: false, relationship: "subscriber" };
  const spouse = { age: 45, tobacco: false, relationship: "spouse" };
  const child = { age: 10, tobacco: false, relationship: "child" };
  for (const [i, members] of [
    [subscriber],
    [subscriber, spouse],
    [subscriber, child],
    [subscriber, spouse, child],
  ].entries()) {
    const byKey = await quote(db, { plan_keys: [key] }, members);
    const byId = await quote(db, { plan_ids: [id] }, members);
    expect(byId).toMatchObject({
      hios_id: id,
      base_plan_id: id,
      plan_key: key,
      hios_match: "matched",
      status: "rated",
      total_cents: [134545, 269090, 259672, 378071][i],
    });
    expect(JSON.stringify({ ...byId, plan_id: key })).toBe(
      JSON.stringify(byKey),
    );
  }
  expect((await findPlan(db, id, 2026))?.plan_key).toBe(key);
  expect(await findPlan(db, id, 2027)).toBeNull();
  const detail = await createApp(db).request(`/v1/plans/${id}?year=2026`);
  expect(detail.status).toBe(200);
  expect(await detail.json()).toMatchObject({ hios_id: id, plan_key: key });
});

it("normalizes only the documented issuer formatting and leaves design qualifiers significant", async () => {
  const normalize = async (name: string, issuer: string) =>
    (
      await db.query<{ name: string }>(
        "SELECT vt_hios_name_v1($1,$2) AS name",
        [name, issuer],
      )
    ).rows[0]!.name;
  expect(await normalize(" \tBCBSVT  Gold Plan\n", "13627")).toBe("gold plan");
  expect(await normalize("[MVP VT Plus HDHP] Silver 2", "77566")).toBe(
    "mvp vt plus silver 2 hdhp",
  );
  expect(await normalize("[MVP VT] Gold 1", "77566")).toBe("mvp vt gold 1");
  expect(await normalize("BCBSVT Gold Plan", "77566")).toBe("bcbsvt gold plan");
  expect(await normalize("[MVP VT Secure] Gold 1", "77566")).toBe(
    "[mvp vt secure] gold 1",
  );
  for (const name of ["Gold", "Gold CDHP Plan", "Gold-Plan", "Gold Plan 2"]) {
    expect(await normalize(name, "13627")).not.toBe("gold plan");
  }
});

it("compatibility key searches and key/HIOS details publish only the evidenced HIOS identifier", async () => {
  const old = process.env.OPENPLANS_COMPAT_API_KEY;
  process.env.OPENPLANS_COMPAT_API_KEY = token;
  try {
    const app = createApp(db),
      headers = { "X-Api-Key": token, "content-type": "application/json" };
    const response = await app.request("/compat/v1/plans/medical/search", {
      method: "POST",
      headers,
      body: JSON.stringify({
        fips_code: "50007",
        ids: [key],
        applicants: [{ age: 40 }],
        enrollment_date: "2026-01-01",
      }),
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as any).plans).toMatchObject([
      {
        id: key,
        hios_id: id,
        hios_issuer_id: "13627",
        identifiers: [{ type: "hios_id", value: id }],
        premium: 1345.45,
        on_market: true,
        off_market: true,
        plan_market: "both",
      },
    ]);
    expect(response.headers.get("x-openplans-gaps")).not.toContain(
      "hios_ids_unavailable",
    );
    for (const lookup of [key, id]) {
      const detail = await app.request(
        `/compat/v1/plans/medical/${encodeURIComponent(lookup)}?year=2026`,
        { headers },
      );
      expect(detail.status).toBe(200);
      expect(((await detail.json()) as any).plan).toMatchObject({
        id: lookup,
        plan_key: key,
        identifiers: [{ type: "hios_id", value: id }],
        hios_match: "matched",
      });
    }
  } finally {
    if (old === undefined) delete process.env.OPENPLANS_COMPAT_API_KEY;
    else process.env.OPENPLANS_COMPAT_API_KEY = old;
  }
});

it("rejects a synthetic stored federal age-rating authorization for VT at the HTTP boundary", async () => {
  await rollback(async (tx) => {
    await tx.query(`UPDATE state_rate_import SET rules_document=jsonb_set(rules_document,
      '{rules,1,method}', '"per_member"'::jsonb) WHERE state='VT'`);
    const result = await quote(tx, { plan_ids: [id] }, [
      { age: 40, tobacco: true, relationship: "subscriber" },
    ]);
    expect(result).toMatchObject({
      status: "unsupported_rating_method",
      reason: "NO_APPLICABLE_COMMUNITY_RULE",
    });
    expect(result).not.toHaveProperty("total_cents");
    expect(() =>
      assert.equal(
        result.status,
        "rated",
        "federal age math must not rate Vermont",
      ),
    ).toThrow();
  });
});

it("negative controls: a renamed design is none and a duplicate normalized name is ambiguous; both reject HIOS lookup", async () => {
  for (const mode of ["renamed", "duplicate"] as const)
    await rollback(async (tx) => {
      const rows = structuredClone(fixture.rows);
      for (const row of rows) {
        if (mode === "renamed" && row.values.StandardComponentId === id)
          row.values.PlanMarketingName += " renamed";
        if (
          mode === "duplicate" &&
          row.values.StandardComponentId === "13627VT0340002"
        ) {
          row.values.PlanMarketingName = "BCBSVT Gold Plan";
          row.values.MetalLevel = "Gold";
        }
      }
      await attributes(tx, mode, rows);
      const row = (await stateCatalog(tx, 2026, "VT", key))[0]!;
      expect(row.hios_id).toBeNull();
      expect(row.hios_match).toBe(mode === "renamed" ? "none" : "ambiguous");
      expect(row.hios_candidates).toHaveLength(mode === "renamed" ? 0 : 2);
      expect(await findPlan(tx, id, 2026)).toBeNull();
      // The positive exact-identity assertion itself must fail for each mutant.
      expect(() =>
        assert.equal(row.hios_id, id, "unique exact identity required"),
      ).toThrow("unique exact identity required");
      const q = await quote(tx, { plan_keys: [key] }, [
        { age: 40, tobacco: false, relationship: "subscriber" },
      ]);
      expect(q).toMatchObject({
        hios_id: null,
        status: "rated",
        total_cents: 134545,
      });
    });
});

it("does not join a wrong metal, SHOP-only, dental-only or off-exchange-only candidate", async () => {
  for (const [field, value] of [
    ["MetalLevel", "Silver"],
    ["MarketCoverage", "SHOP (Small Group)"],
    ["DentalOnlyPlan", "Yes"],
    ["QHPNonQHPTypeId", "Off the Exchange"],
  ])
    await rollback(async (tx) => {
      const rows = structuredClone(fixture.rows);
      for (const row of rows)
        if (row.values.StandardComponentId === id) row.values[field!] = value!;
      await attributes(tx, `wrong-${field}`, rows);
      expect((await stateCatalog(tx, 2026, "VT", key))[0]).toMatchObject({
        hios_id: null,
        hios_match: "none",
      });
    });
});

it("partial/quarantined supplemental imports cannot displace a valid match", async () => {
  await rollback(async (tx) => {
    const before = await stateCatalog(tx, 2026, "VT", key);
    const next = await attributes(tx, "partial", [], false);
    await tx.query(
      `UPDATE snapshot SET validation_state='ACTIVE' WHERE snapshot_id=$1`,
      [next],
    );
    expect(await stateCatalog(tx, 2026, "VT", key)).toEqual(before);
    await tx.query(
      `UPDATE snapshot SET validation_state='QUARANTINED' WHERE source_id=$1`,
      [next],
    );
    expect(await stateCatalog(tx, 2026, "VT", key)).toEqual(before);
  });
});

it("SBE-first import and reverse collisions preserve plan keys and make duplicate filed identities ambiguous", async () => {
  const artifact = JSON.parse(
    await readFile(
      new URL("../../fixtures/state/vt-2026.json", import.meta.url),
      "utf8",
    ),
  );
  // SYNTHETIC extra filed design differing only by the documented normalization.
  const duplicate = structuredClone(artifact.sources[0].records[0]);
  duplicate.plan_name = "gold plan";
  duplicate.source_record += ";synthetic-duplicate";
  artifact.sources[0].records.push(duplicate);
  const path = join(directory, "duplicate-filed.json");
  await writeFile(path, JSON.stringify(artifact));
  await rollback(async (tx) => {
    await tx.query("DELETE FROM state_rate_active WHERE state='VT'");
    await attributes(tx, "sbe-first");
    // ingestStateRates needs a Database; reuse this transaction without nesting it.
    await ingestStateRates(
      { ...db, ...tx, transaction: (run) => run(tx) },
      path,
      "VT",
      { verifyRaw: false },
    );
    const rows = await stateCatalog(tx, 2026, "VT", key);
    expect(rows[0]).toMatchObject({
      hios_id: null,
      hios_match: "ambiguous",
      hios_match_reason: "multiple_filed_designs",
    });
    expect(await findPlan(tx, id, 2026)).toBeNull();
  });
});

it("backfills pre-existing imports when migration 860 is applied", async () => {
  const isolated = testDatabase(new PGlite()),
    previous = await coreMigrations();
  try {
    const name = "860_vt_hios_match.sql";
    await rm(join(previous.directory, name));
    await migrate(isolated, previous.directory);
    await attributes(isolated, "pre-migration");
    await ingestStateRates(isolated, join(directory, "VT.json"), "VT", {
      verifyRaw: false,
    });
    await cp(join(migrationsDirectory, name), join(previous.directory, name));
    expect(await migrate(isolated, previous.directory)).toEqual([name]);
    expect((await stateCatalog(isolated, 2026, "VT", key))[0]).toMatchObject({
      hios_id: id,
      hios_match: "matched",
    });
  } finally {
    await isolated.close();
    await previous.cleanup();
  }
});
