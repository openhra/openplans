import { Readable } from "node:stream";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createApp } from "../../src/api/app.js";
import {
  acquireSpuf,
  cachedSpuf,
  importSpuf,
  parseSpufUrl,
} from "../../src/ingest/medicare/spuf.js";
import {
  loadedDatabase,
  lookup,
  spufArchive,
  spufUrl,
} from "../ingest/medicare/helpers.js";

const code = "990000401";
const name = "Synthetic Part D drug";
const snapshot = "synthetic-med3-current";

describe("Part D drug names (synthetic RxNorm and formulary mappings)", () => {
  let loaded: Awaited<ReturnType<typeof loadedDatabase>>;
  let app: ReturnType<typeof createApp>;
  const get = async (rxcui = code) => {
    const response = await app.request(
      `/v1/medicare/plans/H0028-042-0/drugs?year=2026&rxcui=${rxcui}`,
    );
    expect(response.status).toBe(200);
    return response.json();
  };

  beforeAll(async () => {
    loaded = await loadedDatabase();
    const bytes = await spufArchive();
    await acquireSpuf(parseSpufUrl(spufUrl)!, {
      dataDir: loaded.dataDir,
      dependencies: {
        lookup,
        transport: async () => ({
          status: 200,
          headers: { "content-type": "application/zip" },
          body: Readable.from([bytes]),
        }),
      },
    });
    await importSpuf(
      loaded.db,
      (await cachedSpuf("quarterly", loaded.dataDir))[0]!,
    );
    // Synthetic mapping, not a claim about the published RxCUI or proxy NDC.
    await loaded.db.query(
      "UPDATE partd_formulary_drug SET rxcui=$1 WHERE rxcui='860975'",
      [code],
    );
    await loaded.db.exec(`INSERT INTO source(source_id,publisher,source_kind)
      VALUES ('synthetic-med3','Synthetic test publisher','rxnorm')`);
    app = createApp(loaded.db, {});
  }, 180_000);

  beforeEach(async () => {
    vi.stubEnv("OPENPLANS_MEDICARE_PART_D", "on");
    await loaded.db.exec(`DELETE FROM rx_concept; DELETE FROM rx_ndc;
      DELETE FROM rx_release; DELETE FROM snapshot WHERE source_id='synthetic-med3'`);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await loaded?.cleanup();
  });

  async function seed() {
    for (const [id, version, state, label] of [
      ["synthetic-med3-old", "2025-11-01", "ACTIVE", "Synthetic old name"],
      [snapshot, "2026-11-01", "ACTIVE", name],
      [
        "synthetic-med3-quarantined",
        "2027-11-01",
        "QUARANTINED",
        "Synthetic quarantined name",
      ],
    ]) {
      await loaded.db.query(
        `INSERT INTO snapshot(snapshot_id,source_id,sha256,retrieved_at,expected_children,
           fetched_children,validation_state,activated_at)
         VALUES ($1,'synthetic-med3',$2,now(),0,0,$3,now())`,
        [id, "a".repeat(64), state],
      );
      await loaded.db.query(
        "INSERT INTO rx_release(snapshot_id,source_version) VALUES ($1,$2)",
        [id, version],
      );
      await loaded.db.query(
        `INSERT INTO rx_concept(snapshot_id,rxcui,rxaui,name,tty,suppress,source_record)
         VALUES ($1,$2,'990000001',$3,'SCD','N',1)`,
        [id, code, label],
      );
    }
    // Several published atoms can share a name and RxCUI.
    await loaded.db.query(
      `INSERT INTO rx_concept VALUES ($1,$2,'990000002',$3,'SCD','N',2),
        ($1,'990000402','990000003','Synthetic other drug','SCD','N',3)`,
      [snapshot, code, name],
    );
    await loaded.db.query(
      "INSERT INTO rx_ndc VALUES ($1,'990000402','70010049105','N',4)",
      [snapshot],
    );
  }

  async function checkName() {
    expect(await get()).toMatchObject({
      status: "listed",
      name,
      name_tty: "SCD",
      name_reason: null,
      name_snapshot_id: snapshot,
    });
  }

  it("joins the exact formulary RxCUI to the newest active RxNorm release", async () => {
    await seed();
    await checkName();
  });

  it("leaves the name null when RxNorm has not been loaded", async () => {
    expect(await get()).toMatchObject({
      status: "listed",
      name: null,
      name_tty: null,
      name_reason: "rxnorm_not_loaded",
      name_snapshot_id: null,
    });
  });

  it("does not use inactive releases", async () => {
    await seed();
    await loaded.db.exec(
      "UPDATE snapshot SET validation_state='QUARANTINED' WHERE source_id='synthetic-med3'",
    );
    expect(await get()).toMatchObject({
      name: null,
      name_reason: "rxnorm_not_loaded",
      name_snapshot_id: null,
    });
  });

  it("leaves an unmatched RxCUI null even when a proxy NDC matches another concept", async () => {
    await seed();
    await loaded.db.query(
      "DELETE FROM rx_concept WHERE snapshot_id=$1 AND rxcui=$2",
      [snapshot, code],
    );
    expect(await get()).toMatchObject({
      status: "listed",
      name: null,
      name_reason: "rxcui_not_in_loaded_rxnorm",
      name_snapshot_id: snapshot,
    });
  });

  it("prefers a clinical name over synonyms sharing the same RxCUI", async () => {
    await seed();
    await loaded.db.query(
      `INSERT INTO rx_concept VALUES ($1,$2,'990000004','Synthetic patient name','PSN','N',5),
        ($1,$2,'990000005','Synthetic synonym','SY','N',6)`,
      [snapshot, code],
    );
    await checkName();
  });

  it("uses a published term when no SCD or SBD atom exists", async () => {
    await seed();
    await loaded.db.query(
      "UPDATE rx_concept SET tty='PSN' WHERE snapshot_id=$1 AND rxcui=$2",
      [snapshot, code],
    );
    expect(await get()).toMatchObject({
      name,
      name_tty: "PSN",
      name_reason: null,
      name_snapshot_id: snapshot,
    });
  });

  it("requires a formulary row before naming a drug", async () => {
    await seed();
    expect(await get("990000402")).toMatchObject({
      status: "not_listed",
      name: null,
      name_reason: "rxcui_not_in_plan_formulary",
      name_snapshot_id: null,
    });
  });

  it("keeps the flag-off response unchanged with RxNorm loaded", async () => {
    await seed();
    vi.stubEnv("OPENPLANS_MEDICARE_PART_D", "");
    expect(await get()).toEqual({
      plan_key: "H0028-042-0",
      contract_year: 2026,
      rxcui: code,
      status: "unknown",
      reason: "pending_terms_review",
    });
  });

  it("catches a planted mutant that moves the name onto a different RxCUI", async () => {
    await seed();
    await checkName();
    await loaded.db.query(
      "UPDATE rx_concept SET rxcui='990000499' WHERE snapshot_id=$1 AND rxcui=$2",
      [snapshot, code],
    );
    await expect(checkName()).rejects.toThrow();
    expect(await get()).toMatchObject({
      name: null,
      name_reason: "rxcui_not_in_loaded_rxnorm",
    });
  });
});
