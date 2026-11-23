import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database, SqlSession } from "../../src/db/database.js";
import * as linkOuts from "../../src/domain/link-outs.js";
import { providerParticipation } from "../../src/domain/providers/repository.js";
import { drugCoverage } from "../../src/domain/drugs/repository.js";
import { planCostSharing } from "../../src/api/repository.js";
import type { Plan, PlanVariantRow } from "../../src/api/repository.js";
import { withMutantFile } from "../mutant-file.js";
import { migratedTemplate } from "../pglite.js";
import { replaceSyntax } from "../source-mutation.js";

// Synthetic fixture: invented plan, issuer, network and NPI; URLs on the reserved example.org domain.
const ISSUER = "99901",
  BASE = `${ISSUER}TX0000001`,
  YEAR = 2026,
  NPI = "1234567893",
  RXCUI = "990000001";
const URLS = {
  directory: "https://example.org/directory",
  formulary: "https://example.org/formulary",
  sbc: "https://example.org/sbc",
};
const source = new URL("../../src/domain/link-outs.ts", import.meta.url);
type LinkOutsModule = typeof linkOuts;

async function snapshot(db: SqlSession, id: string) {
  await db.query(
    `INSERT INTO snapshot(snapshot_id,source_id,sha256,retrieved_at,expected_children,fetched_children,validation_state,activated_at)
     VALUES ($1,'synthetic-link-outs',$2,now(),0,0,'ACTIVE',now())`,
    [id, "b".repeat(64)],
  );
}
/** One served plan with a published formulary, summary of benefits, a bad brochure cell and a network. */
async function seed(db: SqlSession) {
  await db.query(
    `INSERT INTO source(source_id,publisher,source_kind) VALUES ('synthetic-link-outs','synthetic fixture','test')`,
  );
  for (const id of ["import", "attributes", "networks", "rx"])
    await snapshot(db, id);
  await db.query(
    `INSERT INTO puf_import(import_id,state,plan_year) VALUES ('import','TX',$1)`,
    [YEAR],
  );
  await db.query(`INSERT INTO puf_import_file(import_id,kind,snapshot_id) VALUES
    ('import','plan-attributes','attributes'),('import','network','networks')`);
  await db.query(`INSERT INTO puf_active_catalog VALUES ('TX',$1,'import')`, [
    YEAR,
  ]);
  const plan = [YEAR, "TX", ISSUER, BASE, "Individual", "Silver", false];
  await db.query(
    `INSERT INTO plan_attribute(snapshot_id,source_row,plan_year,state,issuer_id,base_plan_id,published_plan_id,
       market,metal,dental_only,network_id,service_area_id,plan_name,exchange_status,on_exchange,off_exchange,raw)
     VALUES ('attributes',1,$1,$2,$3,$4,$4||'-01',$5,$6,$7,'TXN001','TXS001','Synthetic Silver','Both',true,true,$8)`,
    [
      ...plan,
      JSON.stringify({
        FormularyURL: ` ${URLS.formulary} `,
        URLForSummaryofBenefitsCoverage: URLS.sbc,
        PlanBrochure: "javascript:alert(1)",
      }),
    ],
  );
  await db.query(
    `INSERT INTO plan(snapshot_id,source_row,plan_year,state,issuer_id,base_plan_id,market,metal,dental_only,
       network_id,service_area_id,plan_name,exchange_status,on_exchange,off_exchange)
     VALUES ('attributes',1,$1,$2,$3,$4,$5,$6,$7,'TXN001','TXS001','Synthetic Silver','Both',true,true)`,
    plan,
  );
  // The first network row has a blank URL; answers use the row that has one.
  await db.query(
    `INSERT INTO network(snapshot_id,source_row,plan_year,state,issuer_id,network_id,network_name,network_url,market,dental_only,raw)
     VALUES ('networks',1,$1,'TX',$2,'TXN001','Synthetic Network','','Individual',false,'{}'),
            ('networks',2,$1,'TX',$2,'TXN001','Synthetic Network',$3,'Individual',false,'{}')`,
    [YEAR, ISSUER, URLS.directory],
  );
  await db.query(
    `INSERT INTO rx_release(snapshot_id,source_version) VALUES ('rx','2026-11-02')`,
  );
  await db.query(
    `INSERT INTO rx_concept(snapshot_id,rxcui,rxaui,name,tty,suppress,source_record)
     VALUES ('rx',$1,'A1','synthetic drug','SCD','N',1)`,
    [RXCUI],
  );
}
const quarantine = (db: SqlSession, id: string) =>
  db.query(
    `UPDATE snapshot SET validation_state='QUARANTINED' WHERE snapshot_id=$1`,
    [id],
  );

/** Statements a call issues, to show the links ride on the plan read. */
function recording(db: SqlSession) {
  const statements: string[] = [];
  const session: SqlSession = {
    ...db,
    query: (sql, parameters) => {
      statements.push(sql);
      return db.query(sql, parameters);
    },
  };
  return { session, statements };
}

/** The plan read as the answers issue it, built from a module's own SQL fragments. */
async function planRead(module: LinkOutsModule, db: SqlSession) {
  const { rows } = await db.query<linkOuts.PlanLinkCells>(
    `SELECT p.snapshot_id,${module.PLAN_LINK_COLUMNS}
     FROM puf_active_catalog a JOIN puf_import_file f ON f.import_id=a.import_id AND f.kind='plan-attributes'
     JOIN plan p ON p.snapshot_id=f.snapshot_id AND p.state=a.state AND p.plan_year=a.plan_year
     ${module.PLAN_LINK_JOINS}
     WHERE p.base_plan_id=$1 AND a.plan_year=$2`,
    [BASE, YEAR],
  );
  return rows[0];
}

/** Every URL a module would serve for the fixture plan, by family. */
async function served(module: LinkOutsModule, db: SqlSession) {
  const row = await planRead(module, db);
  return {
    provider: module.planLinkOuts(row, "provider").map((l) => l.url),
    drug: module.planLinkOuts(row, "drug").map((l) => l.url),
    benefits: module.planLinkOuts(row, "benefits").map((l) => l.url),
  };
}

const sample: linkOuts.LinkOut[] = [
  {
    kind: "link_out",
    rel: "formulary",
    url: URLS.formulary,
    source: "plan_attributes",
    snapshot_id: "attributes",
    source_row: 1,
  },
];
/** The floor, checked through a module's exports: links only on `unknown`. */
function floorHolds(module: LinkOutsModule) {
  for (const status of [
    "listed_covered",
    "explicitly_not_covered",
    "not_listed",
    "conflicting",
    "listed_participating",
  ]) {
    expect(module.withLinkOuts({ status }, sample)).not.toHaveProperty("links");
    // An answer a later source filled keeps no links it carried while unknown.
    expect(
      module.linkOutFloor([{ status, links: sample }])[0],
    ).not.toHaveProperty("links");
  }
  expect(module.benefitLinkOuts("available", sample)).toEqual({});
  expect(
    module.withLinkOuts<{ status: string; links?: linkOuts.LinkOut[] }>(
      { status: "unknown" },
      sample,
    ).links,
  ).toEqual(sample);
  expect(module.benefitLinkOuts("unknown", sample)).toEqual({
    links: sample,
  });
}

describe("link-outs on unknown answers (synthetic fixture)", () => {
  let template: Awaited<ReturnType<typeof migratedTemplate>>;
  let db: Database;
  beforeAll(async () => {
    template = await migratedTemplate();
  }, 120_000);
  afterAll(async () => {
    await template?.close();
  });
  const fresh = async () => {
    db = await template.fresh();
    await seed(db);
    return db;
  };

  it("an unknown provider answer links the network's directory and the NPI registry, read with the plan", async () => {
    const { session, statements } = recording(await fresh());
    const answer = await providerParticipation(session, BASE, NPI, YEAR);
    expect(answer.status).toBe("unknown");
    expect(answer.links).toEqual([
      {
        kind: "link_out",
        rel: "provider_directory",
        url: URLS.directory,
        source: "network",
        snapshot_id: "networks",
        source_row: 2,
      },
      {
        kind: "link_out",
        rel: "npi_registry",
        url: `https://npiregistry.cms.hhs.gov/provider-view/${NPI}`,
        source: "npi_registry",
        snapshot_id: null,
        source_row: null,
      },
    ]);
    // No extra round trip: only the plan statement touches the URL tables.
    const linkReads = statements.filter((sql) =>
      /\b(network|plan_attribute)\b/.test(sql),
    );
    expect(linkReads).toHaveLength(1);
    expect(linkReads[0]).toMatch(/FROM puf_active_catalog/);
  });

  it("an unknown drug answer links the plan's formulary only, trimmed", async () => {
    const answer = await drugCoverage(await fresh(), BASE, RXCUI, YEAR);
    expect(answer.status).toBe("unknown");
    expect(answer.links).toEqual([
      {
        kind: "link_out",
        rel: "formulary",
        url: URLS.formulary,
        source: "plan_attributes",
        snapshot_id: "attributes",
        source_row: 1,
      },
    ]);
  });

  it("a plan outside the catalog gets no plan links; a record ID gets no registry link", async () => {
    const db = await fresh();
    const missing = await providerParticipation(
      db,
      `${ISSUER}TX0000099`,
      NPI,
      YEAR,
    );
    expect(missing.reason).toBe("plan_not_in_catalog");
    expect(missing.links?.map((l) => l.rel)).toEqual(["npi_registry"]);
    const record = await providerParticipation(db, BASE, "record-7", YEAR);
    expect(record.links?.map((l) => l.rel)).toEqual(["provider_directory"]);
  });

  it("serves no URL from a quarantined snapshot", async () => {
    const db = await fresh();
    expect(await served(linkOuts, db)).toEqual({
      provider: [URLS.directory],
      drug: [URLS.formulary],
      benefits: [URLS.sbc],
    });
    await quarantine(db, "networks");
    expect(await served(linkOuts, db)).toMatchObject({
      provider: [],
      drug: [URLS.formulary],
    });
    await quarantine(db, "attributes");
    expect(await served(linkOuts, db)).toEqual({
      provider: [],
      drug: [],
      benefits: [],
    });
    const provider = await providerParticipation(db, BASE, NPI, YEAR);
    expect(provider.links?.map((l) => l.rel)).toEqual(["npi_registry"]);
    const drug = await drugCoverage(db, BASE, RXCUI, YEAR);
    expect(drug.status).toBe("unknown");
    expect(drug).not.toHaveProperty("links");
  });

  it("a benefits answer left unknown links the selected variant's own summary of benefits", async () => {
    const db = await fresh();
    const plan = {
      snapshot_id: "attributes",
      base_plan_id: BASE,
      plan_year: YEAR,
      state: "TX",
      issuer_id: ISSUER,
      market: "Individual",
      state_catalog: false,
    } as unknown as Plan;
    const variant = (state: string): PlanVariantRow => ({
      variant_plan_id: `${BASE}-01`,
      csr_variation_type: "Standard",
      variant_name: "Synthetic Silver",
      exchange_status: "Both",
      source_row: 1,
      raw: {
        URLForSummaryofBenefitsCoverage: URLS.sbc,
        PlanBrochure: "javascript:alert(1)",
      },
      published_attributes: {},
      snapshot_state: state,
    });
    const sharing = (state: string, benefits: unknown[] = []) =>
      planCostSharing(
        db,
        plan,
        {},
        {
          variants: () => Promise.resolve({ rows: [variant(state)] }),
          benefits: () => Promise.resolve({ rows: benefits as never[] }),
        },
      ).then((r) => r.cost_sharing as Record<string, unknown>);
    const unknown = await sharing("ACTIVE");
    expect(unknown.benefits_status).toBe("unknown");
    expect(unknown.links).toEqual([
      {
        kind: "link_out",
        rel: "summary_of_benefits",
        url: URLS.sbc,
        source: "plan_attributes",
        snapshot_id: "attributes",
        source_row: 1,
      },
    ]);
    expect(await sharing("QUARANTINED")).not.toHaveProperty("links");
    const answered = await sharing("ACTIVE", [
      { published_plan_id: `${BASE}-01`, benefit_name: "Synthetic" },
    ]);
    expect(answered.benefits_status).toBe("available");
    expect(answered).not.toHaveProperty("links");
  });

  it("links appear only on unknown answers", () => {
    floorHolds(linkOuts);
    expect(linkOuts.publishedUrl("ftp://example.org/x")).toBeNull();
    expect(linkOuts.publishedUrl("https://user:pw@localhost/")).toBeNull();
    expect(linkOuts.publishedUrl("http://example.org/a b")).toBeNull();
    expect(linkOuts.publishedUrl(" http://example.org/x ")).toBe(
      "http://example.org/x",
    );
  });

  it("kills: a link served as a positive answer", async () => {
    const text = await readFile(source, "utf8");
    await withMutantFile(
      source,
      replaceSyntax(
        text,
        `if (answer.status !== "unknown" || !links.length) return rest as T;`,
        `if (!links.length) return rest as T;`,
      ),
      async (file) => {
        const mutant = (await import(file.href)) as LinkOutsModule;
        expect(() => floorHolds(mutant)).toThrow();
      },
    );
  });

  it("kills: a URL from a quarantined snapshot served", async () => {
    const text = await readFile(source, "utf8");
    const db = await fresh();
    await quarantine(db, "networks");
    await quarantine(db, "attributes");
    await withMutantFile(
      source,
      text.replaceAll(
        "validation_state='${ACTIVE}'",
        "validation_state IS NOT NULL",
      ),
      async (file) => {
        const mutant = (await import(file.href)) as LinkOutsModule;
        const urls = await served(mutant, db);
        expect(() =>
          expect(urls).toEqual({
            provider: [],
            drug: [],
            benefits: [],
          }),
        ).toThrow();
        expect(urls.drug).toEqual([URLS.formulary]);
      },
    );
  });
});
