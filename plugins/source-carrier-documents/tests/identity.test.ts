// The RxCUI join for formulary-PDF rows (PDF-6): reading printed names, matching RxNorm candidates,
// the paced, resumable ingest-time batch and the coverage answers joined rows give. RxNav answers
// come from the RECORDED fixture tests/fixtures/rxnav/drugs-metformin.json, read through the RxNav
// package's own response mapper, and from SYNTHETIC candidate lists (invented RxCUIs from 9900001,
// invented names marked "synthetic"). An in-memory identity stage stands in for the transport; no
// network.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DRUG_IDENTITY_KIND,
  DRUG_NAME_SEARCH_KIND,
  MAX_CANDIDATES,
} from "@openplans/plugin-sdk";
import type {
  DrugNameCandidate,
  PassThroughAnswer,
  PassThroughApi,
  WorkerContext,
} from "@openplans/plugin-sdk";
import { mapNames } from "@openplans/source-rxnav-identity";
import type { Database } from "../../../src/db/database.js";
import {
  loadForTest,
  plantMutant,
} from "../../../src/plugins/testing/index.js";
import plugin, {
  COVERAGE_UNKNOWN_REASON,
  IDENTITY_CONFIRMATION_MAX_AGE_DAYS,
  IDENTITY_REFRESH_AGE_DAYS,
  RELEASE_IDENTITY_SOURCE,
  formularyDrugCoverage,
  IDENTITY_JOIN_ARGV,
  IDENTITY_UNRESOLVED,
  identityJoinCommand,
  joinArgs,
  joinFormularyIdentities,
  matchCandidates,
  passThroughIdentityLookup,
  readPrintedName,
  readStrengths,
  UNKNOWN_REASON,
} from "../src/index.js";
import type { IdentityLookup, ReadName } from "../src/index.js";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const packageRoot = here("../");
const sourceFile = (name: string) => new URL(`../src/${name}`, import.meta.url);

const recordedMetformin = mapNames(
  JSON.parse(
    readFileSync(
      here("../../../tests/fixtures/rxnav/drugs-metformin.json"),
      "utf8",
    ),
  ),
  [{ identity: "metformin", year: 2026 }],
)[0]!;
const METFORMIN: DrugNameCandidate[] =
  recordedMetformin.outcome === "answer"
    ? recordedMetformin.answer.candidates
    : [];
/**
 * Every current concept in the recorded body, before the name search's `MAX_CANDIDATES` cut. The
 * served list keeps RxNav's order, so the cut drops the clinical drugs listed last.
 */
const METFORMIN_ALL: DrugNameCandidate[] = (
  JSON.parse(
    readFileSync(
      here("../../../tests/fixtures/rxnav/drugs-metformin.json"),
      "utf8",
    ),
  ) as {
    drugGroup: {
      conceptGroup: {
        tty: string;
        conceptProperties?: { rxcui: string; name: string; suppress: string }[];
      }[];
    };
  }
).drugGroup.conceptGroup.flatMap((group) =>
  (group.conceptProperties ?? [])
    .filter((concept) => concept.suppress === "N")
    .map(({ rxcui, name }) => ({ rxcui, name, tty: group.tty })),
);
/** The recorded fixture's RxCUI for metformin hydrochloride 500 MG Oral Tablet. */
const METFORMIN_500 = "861007";

/** SYNTHETIC candidate lists, brand concepts first as RxNav orders them. */
const SYNTHETIC: Record<string, DrugNameCandidate[]> = {
  synthetrol: [
    {
      rxcui: "9900001",
      tty: "SBD",
      name: "synthetrol 10 MG Oral Tablet [Synthbrand]",
    },
    { rxcui: "9900002", tty: "SCD", name: "synthetrol 10 MG Oral Tablet" },
    { rxcui: "9900003", tty: "SCD", name: "synthetrol 20 MG Oral Tablet" },
  ],
  // RxNorm spells this one both with and without its salt: two candidates fit the row.
  synthipril: [
    { rxcui: "9900011", tty: "SCD", name: "synthipril 10 MG Oral Tablet" },
    {
      rxcui: "9900012",
      tty: "SCD",
      name: "synthipril hydrochloride 10 MG Oral Tablet",
    },
  ],
  synthbrand: [
    {
      rxcui: "9900021",
      tty: "SBD",
      name: "synthamine 20 MG / synthetrol 50 MG Oral Capsule [Synthbrand]",
    },
    {
      rxcui: "9900022",
      tty: "SBD",
      name: "synthetrol 10 MG Oral Tablet [Synthbrand]",
    },
  ],
};

describe("reading printed names", () => {
  it("reads generic and brand rows into ingredients, strengths and dose form", () => {
    expect(readPrintedName("metformin hcl tab 500 mg")).toEqual({
      ok: true,
      name: {
        kind: "generic",
        query: "metformin",
        ingredients: [{ base: "metformin", salts: ["hydrochloride"] }],
        brand: null,
        strengths: [{ value: 500, unit: "MG" }],
        doseForm: "Oral Tablet",
      },
    });
    const combo = readPrintedName(
      "lisinopril & hydrochlorothiazide tab 10-12.5 mg",
    );
    expect(combo.ok && combo.name.ingredients.map((i) => i.base)).toEqual([
      "lisinopril",
      "hydrochlorothiazide",
    ]);
    const brand = readPrintedName("SYNTHBRAND CAP 50-20MG");
    expect(brand.ok && brand.name).toMatchObject({
      kind: "brand",
      query: "synthbrand",
      doseForm: "Oral Capsule",
    });
    expect(readStrengths("75 mcg")).toEqual([{ value: 0.075, unit: "MG" }]);
    expect(readStrengths("50 mg/5ml")).toEqual([{ value: 10, unit: "MG/ML" }]);
  });

  it("leaves forms, strengths and names it cannot read unresolved", () => {
    const reason = (name: string) => {
      const read = readPrintedName(name);
      return read.ok ? "ok" : read.reason;
    };
    expect(reason("metformin hcl tab er 24hr 500 mg")).toBe(
      IDENTITY_UNRESOLVED.formNotMapped,
    );
    expect(reason("synthetrol inj 10 mg/2ml")).toBe(
      IDENTITY_UNRESOLVED.formNotMapped,
    );
    expect(reason("SYNTHBRAND TAB")).toBe(IDENTITY_UNRESOLVED.strengthMissing);
    expect(reason("SYNTHBRAND TAB 100-1000")).toBe(
      IDENTITY_UNRESOLVED.strengthUnreadable,
    );
    expect(reason("synthetrol-synthamine tab 10 mg")).toBe(
      IDENTITY_UNRESOLVED.ingredientStrengthCount,
    );
    expect(reason("sps")).toBe(IDENTITY_UNRESOLVED.nameUnreadable);
  });
});

const read = (name: string): ReadName => {
  const reading = readPrintedName(name);
  if (!reading.ok) throw new Error(reading.reason);
  return reading.name;
};

describe("matching candidates", () => {
  it("resolves the one recorded concept with the row's name, strength and form", () => {
    // RxNav lists branded and extended-release concepts first; only the clinical tablet fits.
    expect(METFORMIN_ALL[0]!.tty).not.toBe("SCD");
    expect(METFORMIN_ALL.length).toBeGreaterThan(MAX_CANDIDATES);
    // The recorded clinical drugs alone, under the cut: what a search for them would list.
    const recorded = METFORMIN_ALL.filter((c) => c.tty === "SCD");
    expect(recorded.length).toBeLessThan(MAX_CANDIDATES);
    expect(matchCandidates(read("metformin hcl tab 500 mg"), recorded)).toEqual(
      {
        status: "resolved",
        rxcui: METFORMIN_500,
        concept: "metformin hydrochloride 500 MG Oral Tablet",
      },
    );
    expect(matchCandidates(read("metformin hcl tab 600 mg"), recorded)).toEqual(
      {
        status: "unresolved",
        reason: IDENTITY_UNRESOLVED.noMatch,
        matched: 0,
      },
    );
  });

  it("does not resolve from a list the name search cut at its limit", () => {
    // The served list stops at MAX_CANDIDATES, before RxNav's clinical drugs.
    expect(METFORMIN).toHaveLength(MAX_CANDIDATES);
    expect(
      matchCandidates(read("metformin hcl tab 500 mg"), METFORMIN),
    ).toEqual({
      status: "unresolved",
      reason: IDENTITY_UNRESOLVED.truncated,
      matched: 0,
    });
  });

  it("never picks the first of several matches, and keeps brands and generics apart", () => {
    expect(
      matchCandidates(read("synthipril hcl tab 10 mg"), SYNTHETIC.synthipril!),
    ).toEqual({
      status: "unresolved",
      reason: IDENTITY_UNRESOLVED.ambiguous,
      matched: 2,
    });
    expect(
      matchCandidates(read("synthetrol tab 10 mg"), SYNTHETIC.synthetrol!),
    ).toMatchObject({
      status: "resolved",
      rxcui: "9900002",
    });
    expect(
      matchCandidates(read("SYNTHBRAND CAP 50-20MG"), SYNTHETIC.synthbrand!),
    ).toMatchObject({
      status: "resolved",
      rxcui: "9900021",
    });
    expect(
      matchCandidates(read("SYNTHBRAND CAP 50MG"), SYNTHETIC.synthbrand!)
        .status,
    ).toBe("unresolved");
    expect(matchCandidates(read("synthetrol tab 10 mg"), []).status).toBe(
      "unresolved",
    );
  });

  it("planted mutant: a multi-candidate name is resolved", async () => {
    const mutant = await plantMutant(
      sourceFile("identity.ts"),
      "matches.size === 1",
      "matches.size >= 1",
    );
    try {
      const { matchCandidates: mutated } = (await import(mutant.path)) as {
        matchCandidates: typeof matchCandidates;
      };
      const name = read("synthipril hcl tab 10 mg");
      expect(matchCandidates(name, SYNTHETIC.synthipril!).status).toBe(
        "unresolved",
      );
      expect(mutated(name, SYNTHETIC.synthipril!).status).toBe("resolved");
    } finally {
      await mutant.cleanup();
    }
  });

  it("planted mutant: a strength mismatch is accepted", async () => {
    const mutant = await plantMutant(
      sourceFile("identity.ts"),
      "a.unit === b.unit && Math.abs(a.value - b.value) < 1e-6",
      "a.unit === b.unit",
    );
    try {
      const { matchCandidates: mutated } = (await import(mutant.path)) as {
        matchCandidates: typeof matchCandidates;
      };
      const name = read("synthetrol tab 15 mg");
      const tens = SYNTHETIC.synthetrol!.slice(0, 2);
      expect(matchCandidates(name, tens).status).toBe("unresolved");
      expect(mutated(name, tens)).toMatchObject({
        status: "resolved",
        rxcui: "9900002",
      });
    } finally {
      await mutant.cleanup();
    }
  });
});

/** An identity stage answering from the fixtures, counting what it was asked. */
function fixtureLookup(
  confirmed: ReadonlySet<string> = new Set([
    "9900002",
    "9900021",
    METFORMIN_500,
  ]),
) {
  const asked: string[] = [];
  const evidence = {
    source_id: "rxnav",
    served_from: "live",
    statement: "fixture",
  };
  const lookup: IdentityLookup = {
    sourceId: "rxnav",
    async searchName(query) {
      asked.push(`name:${query}`);
      const candidates =
        query === "metformin" ? METFORMIN : (SYNTHETIC[query] ?? []);
      return { status: "answered", candidates, evidence };
    },
    async confirm(rxcui) {
      asked.push(`rxcui:${rxcui}`);
      return {
        status: confirmed.has(rxcui) ? "confirmed" : "not_confirmed",
        evidence,
      };
    },
  };
  return { lookup, asked };
}

const URL_2026 =
  "https://docs.synthetic.test/plans/formulary/TXSyntheticFormulary2026.pdf";
const PLAN = "10001TX0010006";
/** A SYNTHETIC row: line, printed name, tier, flags, confidence, unknown reason. */
type Row = readonly [
  number,
  string,
  number,
  readonly string[],
  string,
  string | null,
];
const ROWS: readonly Row[] = [
  [1, "metformin hcl tab 500 mg", 1, ["QL"], "high", null],
  [2, "synthetrol tab 10 mg", 2, ["PA", "ST"], "high", null],
  [3, "synthetrol tab 20 mg", 2, [], "high", null],
  [4, "synthipril hcl tab 10 mg", 1, [], "high", null],
  [5, "SYNTHBRAND CAP 50-20MG", 3, ["PA", "QL"], "high", null],
  [6, "synthetrol inj 10 mg/2ml", 4, [], "high", null],
  [7, "synthetrol tab 15 mg", 1, [], "low", null],
  [8, "synthamine tab 5 mg", 0, [], "high", "tier_not_defined_in_document"],
];

async function seeded(snapshot = "synthetic-doc", rows: readonly Row[] = ROWS) {
  const loaded = await loadForTest(plugin, { packageRoot });
  const db = loaded.db as Database;
  await addDocument(db, snapshot, rows);
  return loaded;
}

async function addDocument(
  db: Database,
  snapshot: string,
  rows: readonly Row[],
) {
  await db.query(
    `INSERT INTO source(source_id,publisher,source_kind) VALUES ('carrier-formulary-pdf','Synthetic','feed')
     ON CONFLICT DO NOTHING`,
  );
  await db.query(
    `INSERT INTO snapshot(snapshot_id,source_id,sha256,retrieved_at,expected_children,fetched_children,validation_state,activated_at)
     VALUES ($1,'carrier-formulary-pdf',$2,now(),1,1,'ACTIVE',now())`,
    [snapshot, "c".repeat(64)],
  );
  await db.query(
    `INSERT INTO plg_carrierdoc_document(snapshot_id,document_sha256,url,url_year,plan_year,states,pages,legend_tiers,
       legend_flags,tier_histogram,confidence_counts,ql_flag_rows,ql_text_rows,cover_plan_names)
     VALUES ($1,$2,$3,2026,2026,'{TX}',3,'{"1":"Preferred generic","2":"Generic","3":"Preferred brand","4":"Specialty"}',
       '{}','{}','{}',0,0,'[]')`,
    [snapshot, "c".repeat(64), URL_2026],
  );
  for (const [line, name, tier, flags, confidence, unknown] of rows)
    await db.query(
      `INSERT INTO plg_carrierdoc_formulary_row(snapshot_id,page,line,category,drug_name,name_key,tier,tier_label,
         flags,ql_text,raw_text,confidence,reasons,unknown_reason)
       VALUES ($1,2,$2,NULL,$3,lower($3),$4,NULL,$5::jsonb,$6,$7,$8,'[]',$9)`,
      [
        snapshot,
        line,
        name,
        tier,
        JSON.stringify(flags),
        flags.includes("QL") ? "QL (60 per 30 days)" : "",
        `     ${name}     ${tier}`,
        confidence,
        unknown,
      ],
    );
  await db.query(
    `INSERT INTO plg_carrierdoc_plan_link(snapshot_id,state,issuer_id,plan_year,cover_name,base_plan_id,status,candidates)
     VALUES ($1,'TX','10001',2026,'Synthetic Gold',$2,'attached',1)`,
    [snapshot, PLAN],
  );
}

const noWait = async () => {};
const identities = async (db: Database) =>
  (
    await db.query<{
      line: number;
      status: string;
      reason: string | null;
      rxcui: string | null;
    }>(
      "SELECT line, status, reason, rxcui FROM plg_carrierdoc_row_identity ORDER BY line",
    )
  ).rows;

describe("the ingest-time join", () => {
  it("resolves single confirmed matches, leaves the rest unresolved, and asks once per name", async () => {
    const loaded = await seeded();
    try {
      const db = loaded.db as Database;
      const { lookup, asked } = fixtureLookup();
      let paced = 0;
      const summary = await joinFormularyIdentities(db, lookup, {
        enabled: true,
        pace: async () => {
          paced += 1;
        },
      });
      expect(summary).toMatchObject({
        status: "complete",
        resolved: 2,
        unresolved: 4,
        pending: 0,
      });
      // Low-confidence and undefined-tier rows are never joined.
      expect(await identities(db)).toEqual([
        {
          line: 1,
          status: "unresolved",
          reason: IDENTITY_UNRESOLVED.truncated,
          rxcui: null,
        },
        { line: 2, status: "resolved", reason: null, rxcui: "9900002" },
        {
          line: 3,
          status: "unresolved",
          reason: IDENTITY_UNRESOLVED.notConfirmed,
          rxcui: null,
        },
        {
          line: 4,
          status: "unresolved",
          reason: IDENTITY_UNRESOLVED.ambiguous,
          rxcui: null,
        },
        { line: 5, status: "resolved", reason: null, rxcui: "9900021" },
        {
          line: 6,
          status: "unresolved",
          reason: IDENTITY_UNRESOLVED.formNotMapped,
          rxcui: null,
        },
      ]);
      expect(asked.filter((a) => a.startsWith("name:")).sort()).toEqual([
        "name:metformin",
        "name:synthbrand",
        "name:synthetrol",
        "name:synthipril",
      ]);
      expect(paced).toBe(asked.length);
      expect(summary.lookups).toBe(asked.length);
    } finally {
      await loaded.close();
    }
  });

  it("pauses at the lookup limit and resumes without asking a finished name again", async () => {
    const loaded = await seeded();
    try {
      const db = loaded.db as Database;
      const first = fixtureLookup();
      const paused = await joinFormularyIdentities(db, first.lookup, {
        enabled: true,
        maxLookups: 2,
        pace: noWait,
      });
      expect(paused).toMatchObject({
        status: "paused",
        stopped: "lookup_limit",
        lookups: 2,
      });
      expect(paused.pending).toBeGreaterThan(0);
      const second = fixtureLookup();
      const done = await joinFormularyIdentities(db, second.lookup, {
        enabled: true,
        pace: noWait,
      });
      expect(done).toMatchObject({ status: "complete", pending: 0 });
      // The first run finished metformin; synthetrol stopped before its confirmation.
      expect(first.asked).toEqual(["name:metformin", "name:synthetrol"]);
      expect(second.asked).not.toContain("name:metformin");
      expect((await identities(db)).length).toBe(6);
    } finally {
      await loaded.close();
    }
  });

  it("stops without recording when the identity stage is unavailable", async () => {
    const loaded = await seeded();
    try {
      const db = loaded.db as Database;
      const lookup: IdentityLookup = {
        sourceId: "rxnav",
        searchName: async () => ({
          status: "unavailable",
          reason: "passthrough_budget_exhausted",
        }),
        confirm: async () => ({
          status: "unavailable",
          reason: "passthrough_budget_exhausted",
        }),
      };
      const summary = await joinFormularyIdentities(db, lookup, {
        enabled: true,
        pace: noWait,
      });
      expect(summary).toMatchObject({
        status: "paused",
        stopped: "passthrough_budget_exhausted",
      });
      // Only the unreadable-form row, which needs no lookup, has an entry.
      expect((await identities(db)).map((row) => row.line)).toEqual([6]);
    } finally {
      await loaded.close();
    }
  });

  it("reuses an earlier lookup for the same printed name in a re-staged document", async () => {
    const loaded = await seeded();
    try {
      const db = loaded.db as Database;
      await joinFormularyIdentities(db, fixtureLookup().lookup, {
        enabled: true,
        pace: noWait,
      });
      await addDocument(db, "synthetic-doc-2", [ROWS[0]!, ROWS[1]!]);
      const again = fixtureLookup();
      const summary = await joinFormularyIdentities(db, again.lookup, {
        enabled: true,
        pace: noWait,
      });
      expect(summary).toMatchObject({
        status: "complete",
        reused: 2,
        lookups: 0,
      });
      expect(again.asked).toEqual([]);
    } finally {
      await loaded.close();
    }
  });

  it("does nothing with the switch off", async () => {
    const loaded = await seeded();
    try {
      const db = loaded.db as Database;
      const { lookup, asked } = fixtureLookup();
      expect(
        await joinFormularyIdentities(db, lookup, {
          enabled: false,
          pace: noWait,
        }),
      ).toMatchObject({
        status: "off",
        lookups: 0,
      });
      expect(asked).toEqual([]);
      expect(await identities(db)).toEqual([]);
    } finally {
      await loaded.close();
    }
  });

  it("planted mutant: a join runs with the switch off", async () => {
    const loaded = await seeded();
    const mutant = await plantMutant(
      sourceFile("join.ts"),
      "if (!options.enabled) return summary;",
      "",
    );
    try {
      const db = loaded.db as Database;
      const { joinFormularyIdentities: mutated } = (await import(
        mutant.path
      )) as {
        joinFormularyIdentities: typeof joinFormularyIdentities;
      };
      const { lookup, asked } = fixtureLookup();
      await mutated(db, lookup, { enabled: false, pace: noWait });
      expect(asked.length).toBeGreaterThan(0);
    } finally {
      await mutant.cleanup();
      await loaded.close();
    }
  });
});

describe("coverage from joined rows", () => {
  async function joined() {
    const loaded = await seeded();
    await joinFormularyIdentities(
      loaded.db as Database,
      fixtureLookup().lookup,
      {
        enabled: true,
        pace: noWait,
      },
    );
    return loaded;
  }
  const ask = (
    db: Database,
    rxcui: string,
    identityJoin = true,
    coverage = formularyDrugCoverage,
  ) =>
    coverage(db, { planId: `${PLAN}-01`, planYear: 2026, rxcui, identityJoin });

  it("serves a confirmed row as covered at the printed tier, with flags and evidence", async () => {
    const loaded = await joined();
    try {
      const db = loaded.db as Database;
      expect(await ask(db, "9900002")).toMatchObject({
        status: "covered",
        tier: 2,
        prior_authorization: true,
        step_therapy: true,
        quantity_limit: false,
        evidence: [
          {
            kind: "issuer_formulary_document_row",
            document: {
              url: URL_2026,
              sha256: "c".repeat(64),
              page: 2,
              line: 2,
              raw_text: "     synthetrol tab 10 mg     2",
            },
            identity: {
              source_id: "rxnav",
              rxcui: "9900002",
              concept_name: "synthetrol 10 MG Oral Tablet",
              query: "synthetrol",
            },
          },
        ],
      });
      expect(await ask(db, "9900021")).toMatchObject({
        status: "covered",
        tier: 3,
        prior_authorization: true,
        quantity_limit: true,
        quantity_limit_text: "QL (60 per 30 days)",
      });
    } finally {
      await loaded.close();
    }
  });

  it("answers unknown, never not covered, for ambiguous, unconfirmed and absent drugs", async () => {
    const loaded = await joined();
    try {
      const db = loaded.db as Database;
      for (const rxcui of [
        "9900011",
        "9900012",
        "9900003",
        METFORMIN_500,
        "1234567",
      ])
        expect(await ask(db, rxcui)).toEqual({
          status: "unknown",
          reason: COVERAGE_UNKNOWN_REASON.identityUnresolved,
        });
      expect(await ask(db, "9900002", false)).toEqual({
        status: "unknown",
        reason: COVERAGE_UNKNOWN_REASON.joinOff,
      });
      expect(
        await formularyDrugCoverage(db, {
          planId: "10001TX0010007",
          planYear: 2026,
          rxcui: "9900002",
          identityJoin: true,
        }),
      ).toEqual({ status: "unknown", reason: UNKNOWN_REASON.notOnCover });
    } finally {
      await loaded.close();
    }
  });

  it("answers unknown with every row when joined rows disagree", async () => {
    const loaded = await joined();
    try {
      const db = loaded.db as Database;
      await addDocument(db, "synthetic-doc-2", [
        [2, "synthetrol tab 10 mg", 3, [], "high", null],
      ]);
      await joinFormularyIdentities(db, fixtureLookup().lookup, {
        enabled: true,
        pace: noWait,
      });
      const answer = await ask(db, "9900002");
      expect(answer).toMatchObject({
        status: "unknown",
        reason: COVERAGE_UNKNOWN_REASON.rowsConflict,
      });
      expect(answer.evidence).toHaveLength(2);
    } finally {
      await loaded.close();
    }
  });

  it("planted mutant: an absent drug is answered as not covered", async () => {
    const loaded = await seeded("synthetic-doc", [ROWS[1]!]);
    const mutant = await plantMutant(
      sourceFile("coverage.ts"),
      'status: "unknown", reason: attached[0]!.unresolved',
      'status: "not_covered" as "unknown", reason: attached[0]!.unresolved',
    );
    try {
      const db = loaded.db as Database;
      await joinFormularyIdentities(db, fixtureLookup().lookup, {
        enabled: true,
        pace: noWait,
      });
      const { formularyDrugCoverage: mutated } = (await import(
        mutant.path
      )) as {
        formularyDrugCoverage: typeof formularyDrugCoverage;
      };
      // Every row resolved and the drug is not among them: still unknown.
      expect(await ask(db, "1234567")).toEqual({
        status: "unknown",
        reason: UNKNOWN_REASON.notListed,
      });
      expect((await ask(db, "1234567", true, mutated)).status).toBe(
        "not_covered",
      );
    } finally {
      await mutant.cleanup();
      await loaded.close();
    }
  });
});

describe("the identity stage adapter and the worker command", () => {
  const evidence = {
    source_id: "rxnav",
    served_from: "live",
    statement: "synthetic",
  };
  function fakeApi(
    fill: (kind: string, answer: PassThroughAnswer) => PassThroughAnswer,
  ) {
    const kinds: string[] = [];
    const api: Pick<PassThroughApi, "apply"> = {
      apply: async <T extends PassThroughAnswer>(
        kind: string,
        answers: T[],
      ) => {
        kinds.push(kind);
        return answers.map((answer) => fill(kind, answer) as T);
      },
    };
    return { api, kinds };
  }

  it("maps pass-through answers and treats an unfilled answer as unavailable", async () => {
    const { api, kinds } = fakeApi((kind, answer) =>
      kind === DRUG_NAME_SEARCH_KIND
        ? {
            ...answer,
            status: "passthrough",
            reason: null,
            candidates: SYNTHETIC.synthetrol,
            rxnav: evidence,
          }
        : {
            ...answer,
            status: "unknown",
            reason: "passthrough_identity_not_confirmed",
            rxnav: evidence,
          },
    );
    const lookup = passThroughIdentityLookup(
      api,
      () => ({ reader: {} as Database }),
      2026,
    );
    expect(await lookup.searchName("synthetrol")).toEqual({
      status: "answered",
      candidates: SYNTHETIC.synthetrol,
      evidence,
    });
    expect(await lookup.confirm("9900002")).toEqual({
      status: "not_confirmed",
      evidence,
    });
    expect(kinds).toEqual([DRUG_NAME_SEARCH_KIND, DRUG_IDENTITY_KIND]);
    const unfilled = passThroughIdentityLookup(
      fakeApi((_kind, answer) => answer).api,
      () => ({ reader: {} as Database }),
      2026,
    );
    expect(await unfilled.searchName("synthetrol")).toEqual({
      status: "unavailable",
      reason: "rxnorm_terminology_unavailable",
    });
    expect((await unfilled.confirm("9900002")).status).toBe("unavailable");
  });

  it("registers the command, which asks nothing while the switch is off", async () => {
    expect(joinArgs([])).toEqual({ maxLookups: 1000 });
    expect(joinArgs(["--max-lookups", "20"])).toEqual({ maxLookups: 20 });
    expect(joinArgs(["--max-lookups", "0"])).toBeNull();
    expect(joinArgs(["--max-lookups", "9000"])).toBeNull();
    const { api, kinds } = fakeApi((_kind, answer) => answer);
    const logs: Record<string, unknown>[] = [];
    const ctx = {
      log: (entry: Record<string, unknown>) => logs.push(entry),
    } as unknown as WorkerContext;
    const command = identityJoinCommand(api, false);
    expect(command.argv).toEqual(IDENTITY_JOIN_ARGV);
    expect(await command.run([], ctx)).toBe(0);
    expect(await command.run(["--max-lookups", "x"], ctx)).toBe(2);
    expect(kinds).toEqual([]);
    expect(logs[0]).toEqual({ code: "carrier_formulary_identity_off" });
  });
});

const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY);

describe("identity freshness (NLM caching guidance: refresh stored identities monthly)", () => {
  async function joinedAt(at: Date) {
    const loaded = await seeded();
    await joinFormularyIdentities(
      loaded.db as Database,
      fixtureLookup().lookup,
      { enabled: true, pace: noWait, now: () => at },
    );
    return loaded;
  }
  const ask = (db: Database, rxcui: string, coverage = formularyDrugCoverage) =>
    coverage(db, {
      planId: PLAN,
      planYear: 2026,
      rxcui,
      identityJoin: true,
    });

  it("records when each resolved row was confirmed, and only resolved rows", async () => {
    const at = daysAgo(3);
    const loaded = await joinedAt(at);
    try {
      const rows = (
        await (loaded.db as Database).query<{
          status: string;
          identity_source: string | null;
          confirmed_at: Date | null;
        }>(
          "SELECT status, identity_source, confirmed_at FROM plg_carrierdoc_row_identity",
        )
      ).rows;
      for (const row of rows)
        if (row.status === "resolved") {
          expect(new Date(row.confirmed_at!).toISOString()).toBe(
            at.toISOString(),
          );
          expect(row.identity_source).toBe("rxnav");
        } else expect(row.confirmed_at).toBeNull();
      expect(await ask(loaded.db as Database, "9900002")).toMatchObject({
        status: "covered",
        evidence: [
          {
            snapshot_id: "synthetic-doc",
            identity: { confirmed_at: at.toISOString() },
          },
        ],
      });
    } finally {
      await loaded.close();
    }
  });

  it("a confirmation older than the window answers unknown, never covered", async () => {
    const loaded = await joinedAt(
      daysAgo(IDENTITY_CONFIRMATION_MAX_AGE_DAYS + 1),
    );
    try {
      expect(await ask(loaded.db as Database, "9900002")).toEqual({
        status: "unknown",
        reason: COVERAGE_UNKNOWN_REASON.identityStale,
      });
    } finally {
      await loaded.close();
    }
  });

  it("planted mutant: a stale identity is served", async () => {
    const loaded = await joinedAt(
      daysAgo(IDENTITY_CONFIRMATION_MAX_AGE_DAYS + 1),
    );
    const mutant = await plantMutant(
      sourceFile("coverage.ts"),
      "const rows = matched.filter((row) => row.fresh);",
      "const rows = matched.filter(() => true);",
    );
    try {
      const { formularyDrugCoverage: mutated } = (await import(
        mutant.path
      )) as { formularyDrugCoverage: typeof formularyDrugCoverage };
      const db = loaded.db as Database;
      expect((await ask(db, "9900002")).status).toBe("unknown");
      expect((await ask(db, "9900002", mutated)).status).toBe("covered");
    } finally {
      await mutant.cleanup();
      await loaded.close();
    }
  });

  it("the next run confirms aged rows again, and drops an RxCUI no longer confirmed", async () => {
    const loaded = await joinedAt(daysAgo(IDENTITY_REFRESH_AGE_DAYS + 2));
    try {
      const db = loaded.db as Database;
      // 9900021 is no longer confirmed by the source; the others still are.
      const { lookup, asked } = fixtureLookup(
        new Set(["9900002", METFORMIN_500]),
      );
      const summary = await joinFormularyIdentities(db, lookup, {
        enabled: true,
        pace: noWait,
      });
      expect(asked).toEqual(["rxcui:9900002", "rxcui:9900021"]);
      expect(summary).toMatchObject({
        status: "complete",
        reconfirmed: 1,
        dropped: 1,
      });
      expect(await ask(db, "9900002")).toMatchObject({ status: "covered" });
      expect(await ask(db, "9900021")).toEqual({
        status: "unknown",
        reason: COVERAGE_UNKNOWN_REASON.identityUnresolved,
      });
      const dropped = (await identities(db)).find((row) => row.line === 5);
      expect(dropped).toEqual({
        line: 5,
        status: "unresolved",
        reason: IDENTITY_UNRESOLVED.notConfirmed,
        rxcui: null,
      });
      // A fresh run asks nothing more.
      const again = fixtureLookup();
      await joinFormularyIdentities(db, again.lookup, {
        enabled: true,
        pace: noWait,
      });
      expect(again.asked).toEqual([]);
    } finally {
      await loaded.close();
    }
  });

  it("a reused identity keeps its original confirmation time", async () => {
    const at = daysAgo(10);
    const loaded = await joinedAt(at);
    try {
      const db = loaded.db as Database;
      await addDocument(db, "synthetic-doc-2", [ROWS[1]!]);
      const { lookup, asked } = fixtureLookup();
      await joinFormularyIdentities(db, lookup, {
        enabled: true,
        pace: noWait,
      });
      expect(asked).toEqual([]);
      const reused = (
        await db.query<{ confirmed_at: Date }>(
          "SELECT confirmed_at FROM plg_carrierdoc_row_identity WHERE snapshot_id = 'synthetic-doc-2'",
        )
      ).rows;
      expect(new Date(reused[0]!.confirmed_at).toISOString()).toBe(
        at.toISOString(),
      );
    } finally {
      await loaded.close();
    }
  });
});

describe("a loaded RxNorm release wins over RxNav", () => {
  /** A SYNTHETIC ACTIVE release holding the synthetic concepts. */
  async function release(db: Database, active = true) {
    await db.query(
      `INSERT INTO snapshot(snapshot_id,source_id,sha256,retrieved_at,expected_children,fetched_children,validation_state,activated_at)
       VALUES ('synthetic-rx','carrier-formulary-pdf',$1,now(),0,0,$2,now())`,
      ["d".repeat(64), active ? "ACTIVE" : "QUARANTINED"],
    );
    await db.query(
      `INSERT INTO rx_release(snapshot_id,source_version) VALUES ('synthetic-rx','2026-11-02')`,
    );
    let record = 0;
    for (const candidates of Object.values(SYNTHETIC))
      for (const { rxcui, name, tty } of candidates)
        await db.query(
          `INSERT INTO rx_concept(snapshot_id,rxcui,rxaui,name,tty,suppress,source_record)
           VALUES ('synthetic-rx',$1,$2,$3,$4,'N',$5) ON CONFLICT DO NOTHING`,
          [rxcui, `A${rxcui}`, name, tty, ++record],
        );
  }
  function countingApi() {
    const kinds: string[] = [];
    const api: Pick<PassThroughApi, "apply"> = {
      apply: async <T extends PassThroughAnswer>(
        kind: string,
        answers: T[],
      ) => {
        kinds.push(kind);
        return answers;
      },
    };
    return { api, kinds };
  }
  const context = (db: Database) =>
    ({
      db: { reader: db, writer: db },
      log: () => {},
      signal: new AbortController().signal,
    }) as unknown as WorkerContext;

  it("joins against the ACTIVE release, asking RxNav nothing", async () => {
    const loaded = await seeded();
    try {
      const db = loaded.db as Database;
      await release(db);
      const { api, kinds } = countingApi();
      expect(
        await identityJoinCommand(api, true, { pace: noWait }).run(
          [],
          context(db),
        ),
      ).toBe(0);
      expect(kinds).toEqual([]);
      const rows = (
        await db.query<{
          line: number;
          rxcui: string;
          identity_source: string;
        }>(
          `SELECT line, rxcui, identity_source FROM plg_carrierdoc_row_identity
           WHERE status = 'resolved' ORDER BY line`,
        )
      ).rows;
      expect(rows).toEqual([
        { line: 2, rxcui: "9900002", identity_source: RELEASE_IDENTITY_SOURCE },
        // A current concept of the release, so the release confirms it.
        { line: 3, rxcui: "9900003", identity_source: RELEASE_IDENTITY_SOURCE },
        { line: 5, rxcui: "9900021", identity_source: RELEASE_IDENTITY_SOURCE },
      ]);
      const answer = await formularyDrugCoverage(db, {
        planId: PLAN,
        planYear: 2026,
        rxcui: "9900002",
        identityJoin: true,
      });
      expect(answer).toMatchObject({
        status: "covered",
        evidence: [
          {
            identity: {
              source_id: RELEASE_IDENTITY_SOURCE,
              evidence: {
                confirmation: {
                  source_id: RELEASE_IDENTITY_SOURCE,
                  snapshot_id: "synthetic-rx",
                  source_version: "2026-11-02",
                },
              },
            },
          },
        ],
      });
    } finally {
      await loaded.close();
    }
  });

  it("without an ACTIVE release, the join asks the pass-through identity stage", async () => {
    const loaded = await seeded();
    try {
      const db = loaded.db as Database;
      await release(db, false);
      const { api, kinds } = countingApi();
      await identityJoinCommand(api, true, { pace: noWait }).run(
        [],
        context(db),
      );
      // The stage answered nothing (unavailable): the run stops after the first search.
      expect(kinds).toEqual([DRUG_NAME_SEARCH_KIND]);
    } finally {
      await loaded.close();
    }
  });

  it("planted mutant: the release is ACTIVE but RxNav is used", async () => {
    const loaded = await seeded();
    const mutant = await plantMutant(
      sourceFile("command.ts"),
      "const lookup = release",
      "const lookup = false",
    );
    try {
      const db = loaded.db as Database;
      await release(db);
      const { identityJoinCommand: mutated } = (await import(mutant.path)) as {
        identityJoinCommand: typeof identityJoinCommand;
      };
      const real = countingApi();
      await identityJoinCommand(real.api, true, { pace: noWait }).run(
        [],
        context(db),
      );
      expect(real.kinds).toEqual([]);
      await db.exec("DELETE FROM plg_carrierdoc_row_identity");
      const planted = countingApi();
      await mutated(planted.api, true, { pace: noWait }).run([], context(db));
      expect(planted.kinds).toContain(DRUG_NAME_SEARCH_KIND);
    } finally {
      await mutant.cleanup();
      await loaded.close();
    }
  });
});
