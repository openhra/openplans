import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coreMigrations, testDatabase } from "../../pglite.js";
import { migrate } from "../../../src/db/migrate.js";
import {
  communityRulesFile,
  ingestStateRates,
  parseCommunityRules,
  parseStateArtifact,
  stagedStatePremium,
} from "../../../src/ingest/state/index.js";
import { runWorker } from "../../../src/worker/commands.js";
import { refusedTemplatePlans } from "../../../src/ingest/state/catalog.js";
import {
  couple,
  family,
  parent,
  single,
} from "../../domain/rating/community-helpers.js";

const db = testDatabase(new PGlite());
const fixture = (state: string) =>
  new URL(
    `../../fixtures/state/${state.toLowerCase()}-2026.json`,
    import.meta.url,
  );
let directory: string, core: Awaited<ReturnType<typeof coreMigrations>>;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "openplans-state-"));
  core = await coreMigrations();
  await migrate(db, core.directory);
});
afterAll(async () => {
  await db.close();
  await core.cleanup();
  await rm(directory, { recursive: true, force: true });
});
async function artifact(state: string) {
  const value = JSON.parse(await readFile(fixture(state), "utf8"));
  const path = join(directory, `${state}.json`);
  await writeFile(path, JSON.stringify(value));
  return { path, value };
}

it("stages reproducible real NY and VT cuts idempotently, with immutable rule and source provenance", async () => {
  const ny = await artifact("NY"),
    vt = await artifact("VT");
  const a = await ingestStateRates(db, ny.path, "NY", { verifyRaw: false });
  expect(
    await ingestStateRates(db, ny.path, "NY", { verifyRaw: false }),
  ).toEqual(a);
  expect(a).toMatchObject({
    status: "STAGED",
    records: 3,
    native_api_status: "unsupported_rating_method",
  });
  expect(
    await ingestStateRates(db, vt.path, "VT", { verifyRaw: false }),
  ).toMatchObject({ status: "STAGED", records: 2 });
  const nyCases = [
    [single, 127_098],
    [couple, 254_196],
    [parent, 216_067],
    [family, 362_229],
  ] as const;
  for (const [members, totalCents] of nyCases) {
    expect(
      await stagedStatePremium(
        db,
        "NY",
        "11177NY0220001",
        "Rating Area 4",
        members,
        "2026-01-01",
      ),
    ).toMatchObject({ status: "rated", totalCents });
  }
  expect(
    await stagedStatePremium(
      db,
      "VT",
      "BCBSVT:Gold Plan",
      "Vermont",
      family,
      "2026-01-01",
    ),
  ).toMatchObject({
    status: "rated",
    totalCents: 378_071,
    rate: { provenance: { sourceRecord: "page=1;issuer=BCBSVT;column=2" } },
  });
  expect(
    await stagedStatePremium(
      db,
      "VT",
      "MVP:MVP VT Gold 1",
      "Vermont",
      family,
      "2026-01-01",
    ),
  ).toMatchObject({ status: "rated", totalCents: 321_638 });
  expect(
    await stagedStatePremium(
      db,
      "NY",
      "11177NY0220001",
      "Rating Area 2",
      single,
      "2026-01-01",
    ),
  ).toEqual({ status: "missing", totalCents: null });
  expect(
    await stagedStatePremium(
      db,
      "NY",
      "11177NY0220001",
      "Rating Area 4",
      single,
      "2027-01-01",
    ),
  ).toEqual({ status: "missing", totalCents: null });
  const stored = (
    await db.query(
      "SELECT rules_document FROM state_rate_import WHERE import_id=$1",
      [a.import_id],
    )
  ).rows[0]!.rules_document;
  expect(stored).toEqual(
    JSON.parse(await readFile(communityRulesFile, "utf8")),
  );
  // Staging cannot accidentally grant unsupported API rating or invent a PUF catalog.
  expect((await db.query("SELECT * FROM state_rating_rule")).rows).toHaveLength(
    0,
  );
  expect(
    (await db.query("SELECT * FROM puf_active_catalog")).rows,
  ).toHaveLength(0);
});

it("negative controls: invalid rule authorization, corrupt original bytes and wrong state preserve the active import", async () => {
  const before = (
    await db.query("SELECT * FROM state_rate_active ORDER BY state")
  ).rows;
  const vt = await artifact("VT");
  const rules = JSON.parse(await readFile(communityRulesFile, "utf8"));
  rules.rules.find((r: { state: string }) => r.state === "VT").method =
    "per_member";
  const rulePath = join(directory, "synthetic-wrong-ratio.json");
  await writeFile(rulePath, JSON.stringify(rules));
  await expect(
    ingestStateRates(db, vt.path, "VT", {
      verifyRaw: false,
      rulesPath: rulePath,
    }),
  ).rejects.toThrow("Invalid cited community rule");
  await expect(
    ingestStateRates(db, vt.path, "NY", { verifyRaw: false }),
  ).rejects.toThrow("State scope");
  // SYNTHETIC corrupt source file; the real cache is never changed.
  const raw = join(directory, "synthetic-corrupt-publication");
  await writeFile(raw, "corrupt");
  vt.value.sources[0].raw_path = raw;
  await writeFile(vt.path, JSON.stringify(vt.value));
  await expect(ingestStateRates(db, vt.path, "VT")).rejects.toThrow(
    "hash mismatch",
  );
  expect(
    (await db.query("SELECT * FROM state_rate_active ORDER BY state")).rows,
  ).toEqual(before);
});

it("rejects malformed records, missing tiers and per-member rules before staging", async () => {
  const { value } = await artifact("VT");
  const bad = structuredClone(value);
  delete bad.sources[0].records[0].prices.adult_children;
  expect(() => parseStateArtifact(JSON.stringify(bad))).toThrow();
  const wrongTier = structuredClone(value);
  wrongTier.sources[0].records[0].prices.adult_children =
    wrongTier.sources[0].records[0].prices.couple;
  expect(() => parseStateArtifact(JSON.stringify(wrongTier))).toThrow(
    "differs from raw price cells",
  );
  const duplicate = structuredClone(value);
  duplicate.sources[0].records.push(duplicate.sources[0].records[0]);
  expect(() => parseStateArtifact(JSON.stringify(duplicate))).toThrow();
  const hidden = structuredClone(value);
  hidden.sources[0].url = "https://login.serff.com/private";
  expect(() => parseStateArtifact(JSON.stringify(hidden))).toThrow();
  const rules = JSON.parse(await readFile(communityRulesFile, "utf8"));
  rules.rules[0].method = "per_member";
  expect(() => parseCommunityRules(JSON.stringify(rules))).toThrow();
});

it("conflicting plan/name records stay ambiguous instead of choosing the first price", async () => {
  const vt = await artifact("VT");
  // SYNTHETIC contradictory normalized record, sharing the same internal plan key.
  const extra = structuredClone(vt.value.sources[0].records[0]);
  extra.source_record += ";synthetic-conflict";
  vt.value.sources[0].records.push(extra);
  await writeFile(vt.path, JSON.stringify(vt.value));
  await ingestStateRates(db, vt.path, "VT", { verifyRaw: false });
  expect(
    await stagedStatePremium(
      db,
      "VT",
      "BCBSVT:Gold Plan",
      "Vermont",
      family,
      "2026-01-01",
    ),
  ).toEqual({ status: "ambiguous", totalCents: null });
});

it("worker ingest state validates flags without opening a database, and never skips original hash verification", async () => {
  const open = vi.fn(() => db),
    messages: string[] = [];
  const output = {
    out: (s: string) => messages.push(s),
    error: (s: string) => messages.push(s),
  };
  expect(
    await runWorker(
      ["ingest", "state", "--state", "TX"],
      open,
      output,
      core.directory,
    ),
  ).toBe(1);
  expect(open).not.toHaveBeenCalled();
  const ny = await artifact("NY");
  const close = vi.fn(async () => {});
  expect(
    await runWorker(
      ["ingest", "state", "--state", "NY", "--file", ny.path],
      () => ({ ...db, close }),
      output,
      core.directory,
    ),
  ).toBe(1);
  expect(close).toHaveBeenCalledOnce();
  expect(messages.at(-1)).toContain("Prior staged import preserved");
});

// SYNTHETIC refused template for a made-up issuer 99999: its workbook was last saved three
// days before its filing's submission date.
function refusedCheck() {
  const filing = "TEST-000000001";
  return {
    url: `https://myportal.dfs.ny.gov/documents/538523/45010883/Synthetic_IND_BOTHX_${filing}_ApprRatesTemplate`,
    sha256: "e".repeat(64),
    bytes: 1024,
    retrieved_at: "2026-01-01T00:00:00+00:00",
    content_type: "synthetic",
    filing,
    issuer_ids: ["99999"],
    decision: "refused",
    status: "unknown",
    reason: "template_saved_before_submission",
    evidence: {
      rule: "ny-approved-template-saved-on-or-after-submission-v1",
      workbooks: [{ member: "publication", saved_at: "2025-05-12T23:32:58Z" }],
      submission_date: "2025-05-15",
      submission_source: {
        url: `https://myportal.dfs.ny.gov/documents/538523/45010894/Synthetic_IND_BOTHX_${filing}_FinalExhibits`,
        sha256: "f".repeat(64),
        members: [`Synthetic Issuer_00000_${filing}_IN_23_20250515_1.xlsm`],
        dates: ["20250515"],
      },
    },
    listed_plans: [
      { plan_id: "99999NY0010001", region: "Rating Area 4" },
      { plan_id: "99999NY0010002", region: "Rating Area 1" },
    ],
  };
}

it("NY template guard: every served source needs an admitted check; skipped or forged guards are rejected", async () => {
  const { value } = await artifact("NY");
  expect(() => parseStateArtifact(JSON.stringify(value))).not.toThrow();
  const mutants: [string, (v: typeof value) => void][] = [
    ["guard output missing", (v) => delete v.template_checks],
    ["source without check", (v) => (v.template_checks = [refusedCheck()])],
    [
      "refused template still served",
      (v) => {
        const check = refusedCheck();
        check.url = v.sources[0].url;
        check.sha256 = v.sources[0].sha256;
        check.filing = "MPHP-134514244";
        check.issuer_ids = ["11177"];
        check.evidence.submission_source = v.template_checks[0].evidence
          .submission_source as typeof check.evidence.submission_source;
        v.template_checks = [check];
      },
    ],
    [
      "guard skipped: stale template marked admitted",
      (v) => {
        v.template_checks[0].evidence.workbooks[0].saved_at =
          "2025-05-12T23:32:58Z";
      },
    ],
    [
      "undated template marked admitted",
      (v) => (v.template_checks[0].evidence.workbooks[0].saved_at = null),
    ],
    [
      "submission date not named by the exhibits",
      (v) => (v.template_checks[0].evidence.submission_date = "2025-01-01"),
    ],
    [
      "check for other bytes",
      (v) => (v.template_checks[0].sha256 = "0".repeat(64)),
    ],
    [
      "refusal without its listed plans",
      (v) => {
        const check: Partial<ReturnType<typeof refusedCheck>> = refusedCheck();
        delete check.listed_plans;
        v.template_checks.push(check);
      },
    ],
    [
      "refusal listing another issuer's plan",
      (v) => {
        const check = refusedCheck();
        check.listed_plans.push({
          plan_id: "11177NY0010001",
          region: "Rating Area 4",
        });
        v.template_checks.push(check);
      },
    ],
    [
      "refusal listing a region outside NY",
      (v) => {
        const check = refusedCheck();
        check.listed_plans[0]!.region = "Rating Area 9";
        v.template_checks.push(check);
      },
    ],
    [
      "admitted check carrying listed plans",
      (v) =>
        Object.assign(v.template_checks[0], {
          listed_plans: refusedCheck().listed_plans.map((p) => ({
            ...p,
            plan_id: "11177NY0010001",
          })),
        }),
    ],
    [
      "refusal relabelled not covered",
      (v) => {
        const check = { ...refusedCheck(), status: "not_covered" };
        v.template_checks.push(check);
      },
    ],
  ];
  for (const [label, mutate] of mutants) {
    const mutant = structuredClone(value);
    mutate(mutant);
    expect(() => parseStateArtifact(JSON.stringify(mutant)), label).toThrow();
  }
  const vt = (await artifact("VT")).value;
  vt.template_checks = value.template_checks;
  expect(() => parseStateArtifact(JSON.stringify(vt))).toThrow(
    "NY publications only",
  );
});

it("NY template guard: a refused issuer stays unknown with its reason and evidence in provenance", async () => {
  const ny = await artifact("NY");
  ny.value.synthetic_refusal = true;
  ny.value.template_checks.push(refusedCheck());
  await writeFile(ny.path, JSON.stringify(ny.value));
  const staged = await ingestStateRates(db, ny.path, "NY", {
    verifyRaw: false,
  });
  expect(staged).toMatchObject({
    records: 3,
    publications: 1,
    unknown_issuers: [
      { issuer: "99999", reason: "template_saved_before_submission" },
    ],
  });
  expect(
    await ingestStateRates(db, ny.path, "NY", { verifyRaw: false }),
  ).toEqual(staged);
  expect(
    await stagedStatePremium(
      db,
      "NY",
      "99999NY0010001",
      "Rating Area 4",
      single,
      "2026-01-01",
    ),
  ).toEqual({
    status: "unknown",
    reason: "template_saved_before_submission",
    totalCents: null,
  });
  expect(
    await stagedStatePremium(
      db,
      "NY",
      "11177NY0220001",
      "Rating Area 4",
      single,
      "2026-01-01",
    ),
  ).toMatchObject({ status: "rated", totalCents: 127_098 });
  const issues = (
    await db.query<{
      validation_state: string;
      issue_code: string;
      explanation: string;
    }>(
      `SELECT s.validation_state,q.issue_code,q.explanation FROM quality_issue q
      JOIN snapshot s ON s.snapshot_id=q.snapshot_id
      WHERE q.snapshot_id=$1 AND q.source_record='99999'`,
      [`${staged.import_id}:refused:${"e".repeat(64)}`],
    )
  ).rows;
  expect(issues).toHaveLength(1);
  expect(issues[0]).toMatchObject({
    validation_state: "QUARANTINED",
    issue_code: "template_saved_before_submission",
  });
  expect(JSON.parse(issues[0]!.explanation)).toMatchObject({
    status: "unknown",
    filing: "TEST-000000001",
    evidence: {
      workbooks: [{ saved_at: "2025-05-12T23:32:58Z" }],
      submission_date: "2025-05-15",
    },
    listed_plans: refusedCheck().listed_plans,
  });
  // Benchmarks read the listed plans back by region, with no CMS metal evidence here.
  expect(await refusedTemplatePlans(db, "NY", 2026, "Rating Area 4")).toEqual([
    expect.objectContaining({
      issuer: "99999",
      plan_id: "99999NY0010001",
      region: "Rating Area 4",
      reason: "template_saved_before_submission",
      filing: "TEST-000000001",
      metals: [],
    }),
  ]);
  expect(await refusedTemplatePlans(db, "NY", 2026, "Rating Area 2")).toEqual(
    [],
  );
  expect(await refusedTemplatePlans(db, "VT", 2026, "Vermont")).toEqual([]);
});
