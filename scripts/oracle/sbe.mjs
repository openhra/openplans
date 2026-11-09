#!/usr/bin/env node
/** Cache-only SBE oracle. Python csv/Decimal/zipfile is independent of the importer. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../../dist/db/migrate.js";
import { importDataDirectory } from "../../dist/ingest/puf/import-source.js";
import { cachedSbe, sbePublications } from "../../dist/ingest/sbe/source.js";
import { importSbe } from "../../dist/ingest/sbe/import.js";
import { householdPremium } from "../../dist/domain/rating/index.js";
import { storedRate } from "../../dist/api/premiums.js";

const rawPython = String.raw`
import csv, io, json, zipfile, sys, hashlib, decimal, datetime
path, expected_sha = sys.argv[1:]
assert hashlib.sha256(open(path,'rb').read()).hexdigest() == expected_sha
out={'counts':{},'base_ids':[],'rates':[],'members':{},'plan_scope':{}}
kind={'Plans':'plan-attributes','Rates':'rate','Benefits':'benefits-and-cost-sharing','ServiceAreas':'service-area','Networks':'network','BusinessRules':'business-rules'}
family=['COUPLE','PRIMARY SUBSCRIBER AND ONE DEPENDENT','PRIMARY SUBSCRIBER AND TWO DEPENDENTS','PRIMARY SUBSCRIBER AND THREE OR MORE DEPENDENTS','COUPLE AND ONE DEPENDENT','COUPLE AND TWO DEPENDENTS','COUPLE AND THREE OR MORE DEPENDENTS']
def date(s):
 s=s.strip()
 return datetime.datetime.strptime(s,'%m/%d/%Y').strftime('%Y-%m-%d') if '/' in s else s
def cents(s):
 if not s.strip(): return None
 n=decimal.Decimal(s.strip())*100
 assert n==n.to_integral_value() and n>=0
 return int(n)
with zipfile.ZipFile(path) as z:
 for member in z.namelist():
  name=member.split('/')[-1]; k=next((v for p,v in kind.items() if p in name),None)
  if k is None: continue
  reader=csv.DictReader(io.TextIOWrapper(z.open(member),encoding='utf-8-sig'))
  count=0; bases=set()
  for row in reader:
   count+=1
   if k=='plan-attributes':
    base=row['STANDARD COMPONENT ID'].strip(); bases.add(base)
    scope=[row['MARKET COVERAGE'].strip(),row['DENTAL ONLY PLAN'].strip()]
    assert base not in out['plan_scope'] or out['plan_scope'][base]==scope
    out['plan_scope'][base]=scope
   if k=='rate':
    amounts=[cents(row[f]) for f in ['INDIVIDUAL RATE','INDIVIDUAL TOBACCO RATE']+family]
    age=row['AGE'].strip() or ('Family Option' if any(v is not None for v in amounts[2:]) else '')
    out['rates'].append([count+1,row['PLAN ID'].strip(),row['RATING AREA ID'].strip(),date(row['RATE EFFECTIVE DATE']),date(row['RATE EXPIRATION']),row['TOBACCO'].strip(),age,'family_tier' if age=='Family Option' or any(v is not None for v in amounts[2:]) else 'per_member']+amounts)
  out['counts'][k]=count; out['members'][k]=member
  if k=='plan-attributes': out['base_ids']=sorted(bases)
print(json.dumps(out,separators=(',',':')))
`;
const columns = [
  "source_row",
  "base_plan_id",
  "rating_area_id",
  "effective_date",
  "expiration_date",
  "tobacco",
  "age_band",
  "rating_method",
  "individual_rate_cents",
  "individual_tobacco_rate_cents",
  "couple_cents",
  "primary_subscriber_and_one_dependent_cents",
  "primary_subscriber_and_two_dependents_cents",
  "primary_subscriber_and_three_or_more_dependents_cents",
  "couple_and_one_dependent_cents",
  "couple_and_two_dependents_cents",
  "couple_and_three_or_more_dependents_cents",
];
const table = {
  "plan-attributes": "plan_attribute",
  rate: "rate",
  "service-area": "service_area_county",
  network: "network",
  "business-rules": "business_rule",
  "benefits-and-cost-sharing": "plan_benefit",
};
const project = fileURLToPath(new URL("../../", import.meta.url));
const dataDir = importDataDirectory();
const args = process.argv.slice(2);
const year = Number(args[args.indexOf("--year") + 1] ?? 2026);
if (![2026, 2027].includes(year)) throw new Error("Expected --year 2026|2027");
const mutant = args.includes("--mutate-rate");
const suffix = mutant ? "-synthetic-mutant" : "";
const selected = args.includes("--states")
  ? args[args.indexOf("--states") + 1].split(",")
  : null;
const rules = new Set([
  "CA",
  "CO",
  "CT",
  "DC",
  "GA",
  "ID",
  "IL",
  "KY",
  "ME",
  "MD",
  "MA",
  "MN",
  "NV",
  "NJ",
  "NM",
  "PA",
  "RI",
  "VA",
  "WA",
]);
const wrap = (tx) => ({
  query: (sql, parameters) => tx.query(sql, parameters),
  exec: async (sql) => {
    await tx.exec(sql);
  },
});
const directory = await mkdtemp("/tmp/openplans-sbe-oracle-");
let failed = false;
const reports = [];
try {
  await mkdir(join(dataDir, "reports"), { recursive: true });
  for (const n of await readdir(join(project, "migrations")))
    if (n.endsWith(".sql") && n !== "002_postgis.sql")
      await cp(join(project, "migrations", n), join(directory, n));
  const links = (await sbePublications(dataDir, false)).filter(
    (l) => l.year === year && (!selected || selected.includes(l.state)),
  );
  if (!links.length && year === 2026)
    throw new Error("No published SBE states selected");
  for (const link of links) {
    const report = {
      state: link.state,
      year,
      source: "cms_sbe_puf",
      status: "FAIL",
      mismatches: 0,
    };
    let pg;
    try {
      const files = await cachedSbe(link, dataDir);
      const raw = spawnSync(
        "python3",
        ["-c", rawPython, files[0].path, files[0].sha256],
        { encoding: "utf8", maxBuffer: 200 * 1024 ** 2 },
      );
      assert.equal(raw.status, 0, raw.stderr);
      const expected = JSON.parse(raw.stdout);
      if (mutant) expected.rates[0][8] = (expected.rates[0][8] ?? 0) + 1;
      pg = new PGlite(join(dataDir, `sbe-pglite-${year}-${link.state}`));
      const db = {
        ...wrap(pg),
        transaction: (run) => pg.transaction((tx) => run(wrap(tx))),
        close: () => pg.close(),
      };
      await migrate(db, directory);
      let catalog = (
        await db.query(
          `SELECT c.import_id FROM sbe_catalog c JOIN puf_import p USING(import_id) JOIN snapshot s ON s.snapshot_id=c.import_id
        WHERE p.state=$1 AND p.plan_year=$2 AND c.bundle_sha256=$3 AND s.validation_state='ACTIVE' AND NOT EXISTS (SELECT 1 FROM issuer i WHERE i.snapshot_id=c.import_id||':plan-attributes' AND NOT EXISTS (SELECT 1 FROM sbe_issuer_status u WHERE u.import_id=c.import_id AND u.issuer_id=i.issuer_id)) ORDER BY p.started_at DESC LIMIT 1`,
          [link.state, year, files[0].sha256],
        )
      ).rows[0];
      if (!catalog || args.includes("--reload")) {
        const imported = await importSbe(db, { ...link, dataDir, files });
        assert.equal(
          imported.passed,
          true,
          JSON.stringify(imported.checks.filter((c) => c.count)),
        );
        catalog = { import_id: imported.import_id };
      }
      const id = catalog.import_id;
      const issuerCount = Number(
        (
          await db.query("SELECT count(*) n FROM issuer WHERE snapshot_id=$1", [
            id + ":plan-attributes",
          ])
        ).rows[0].n,
      );
      assert.equal(
        Number(
          (
            await db.query(
              "SELECT count(*) n FROM sbe_issuer_status WHERE import_id=$1 AND reason='sbe_no_index_registry' AND drug_status='unknown' AND provider_status='unknown'",
              [id],
            )
          ).rows[0].n,
        ),
        issuerCount,
        "issuer feed gaps recorded",
      );
      report.issuers = issuerCount;
      const importFiles = (
        await db.query(
          "SELECT kind,snapshot_id FROM puf_import_file WHERE import_id=$1",
          [id],
        )
      ).rows;
      const snapshots = Object.fromEntries(
        importFiles.map((f) => [f.kind, f.snapshot_id]),
      );
      for (const [kind, count] of Object.entries(expected.counts)) {
        assert.equal(
          Number(
            (
              await db.query(
                `SELECT count(*) n FROM ${table[kind]} WHERE snapshot_id=$1`,
                [snapshots[kind]],
              )
            ).rows[0].n,
          ),
          count,
          `${kind} count`,
        );
      }
      assert.deepEqual(
        (
          await db.query(
            "SELECT base_plan_id FROM plan WHERE snapshot_id=$1 ORDER BY base_plan_id",
            [snapshots["plan-attributes"]],
          )
        ).rows.map((r) => r.base_plan_id),
        expected.base_ids,
        "exact base plan set",
      );
      const stored = (
        await db.query(
          `SELECT *,effective_date::text effective_date,expiration_date::text expiration_date FROM rate WHERE snapshot_id=$1 ORDER BY source_row`,
          [snapshots.rate],
        )
      ).rows;
      assert.equal(stored.length, expected.rates.length);
      const view = (row) =>
        columns.map((key, index) =>
          index >= 8 && row[key] !== null ? Number(row[key]) : row[key],
        );
      for (let i = 0; i < stored.length; i++)
        assert.deepEqual(
          view(stored[i]),
          expected.rates[i],
          `rate row ${i + 2}`,
        );
      // Mutate one raw expectation by a cent. The exact same comparator must fail.
      const mutatedRate = [...expected.rates[0]];
      mutatedRate[8] = (mutatedRate[8] ?? 0) + 1;
      assert.throws(() => assert.deepEqual(view(stored[0]), mutatedRate));
      report.negative_control = "mutated_raw_rate_detected";
      let singles = 0,
        households = 0,
        unsupportedGroups = 0,
        separateScopeGroups = 0;
      const groups = new Map();
      for (const row of stored) {
        const key = JSON.stringify([
          row.base_plan_id,
          row.rating_area_id,
          row.effective_date,
          row.expiration_date,
          row.tobacco,
        ]);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
      }
      for (const rows of groups.values()) {
        const scope = expected.plan_scope[rows[0].base_plan_id];
        if (scope[0] !== "Individual" || scope[1] === "Yes") {
          separateScopeGroups++;
          continue;
        }
        if (
          rows.some((r) => r.rating_method !== "per_member") ||
          !rules.has(link.state)
        ) {
          const result = householdPremium(
            rows.map(storedRate),
            rows[0].base_plan_id,
            rows[0].rating_area_id,
            {
              coverageStartDate: rows[0].effective_date,
              ratingMethod: "unsupported",
              members: [
                {
                  id: "subscriber",
                  age: 40,
                  relationship: "subscriber",
                  tobaccoUse: false,
                },
              ],
            },
          );
          assert.equal(result.status, "unsupported_rating_method");
          assert.equal(result.totalCents, null);
          unsupportedGroups++;
          continue;
        }
        const parsed = rows.map(storedRate),
          source = new Map(
            rows.map((r) => [r.age_band, expected.rates[r.source_row - 2]]),
          );
        const first = rows[0];
        for (const r of rows)
          for (const tobaccoUse of [false, true]) {
            let age;
            if (r.age_band === "0-14") {
              age = 0;
            } else if (r.age_band === "64 and over") {
              age = 64;
            } else {
              age = Number(r.age_band);
            }
            const result = householdPremium(
              parsed,
              r.base_plan_id,
              r.rating_area_id,
              {
                coverageStartDate: r.effective_date,
                ratingMethod: "per_member",
                members: [
                  {
                    id: "subscriber",
                    age,
                    relationship: "subscriber",
                    tobaccoUse,
                  },
                ],
              },
            );
            const price = source.get(r.age_band)[tobaccoUse ? 9 : 8];
            assert.equal(result.status, price === null ? "unknown" : "rated");
            assert.equal(result.totalCents, price);
            singles++;
          }
        const ages = [40, 38, 20, 17, 12, 8];
        const result = householdPremium(
          parsed,
          first.base_plan_id,
          first.rating_area_id,
          {
            coverageStartDate: first.effective_date,
            ratingMethod: "per_member",
            members: ages.map((age, at) => {
              function householdRelationship() {
                if (at === 0) {
                  return "subscriber";
                } else if (at === 1) {
                  return "spouse";
                } else {
                  return "child";
                }
              }
              return {
                id: String(at),
                age,
                relationship: householdRelationship(),
                tobaccoUse: false,
              };
            }),
          },
        );
        const prices = ages
          .slice(0, 5)
          .map(
            (age) => source.get(age <= 14 ? "0-14" : String(age))?.[8] ?? null,
          );
        assert.equal(
          result.status,
          prices.some((p) => p === null) ? "unknown" : "rated",
        );
        assert.equal(
          result.totalCents,
          prices.some((p) => p === null)
            ? null
            : prices.reduce((a, b) => a + b, 0),
        );
        households++;
      }
      if (
        link.state === "GA" &&
        (await stat(join(dataDir, "reference", "cms.sqlite")).catch(() => null))
      ) {
        const referencePath = join(dataDir, "reference", "cms.sqlite");
        const reference = spawnSync(
          "python3",
          [
            "-c",
            String.raw`
import sqlite3,json,sys,os
p=sys.argv[1]; before=os.stat(p); db=sqlite3.connect('file:'+p+'?immutable=1',uri=True); db.execute('PRAGMA query_only=ON')
ids=[r[0] for r in db.execute("SELECT DISTINCT substr(plan_id,1,14) FROM plan WHERE state_code='GA' AND business_year=2026 ORDER BY 1")]
db.close(); after=os.stat(p)
assert (before.st_size,before.st_mtime_ns)==(after.st_size,after.st_mtime_ns)
print(json.dumps(ids))
`,
            referencePath,
          ],
          { encoding: "utf8" },
        );
        assert.equal(reference.status, 0, reference.stderr);
        assert.deepEqual(
          expected.base_ids,
          JSON.parse(reference.stdout),
          "immutable GA reference plan set",
        );
        assert.equal(expected.base_ids.length, 249);
        report.immutable_reference = {
          plans: 249,
          exact: true,
          query_only: true,
          unchanged: true,
        };
      }
      Object.assign(report, {
        status: "PASS",
        import_id: id,
        sha256: files[0].sha256,
        counts: expected.counts,
        base_plans: expected.base_ids.length,
        rates_checked: stored.length,
        single_member_comparisons: singles,
        household_comparisons: households,
        unsupported_medical_groups: unsupportedGroups,
        dental_or_shop_groups_separate_scope: separateScopeGroups,
      });
    } catch (e) {
      failed = true;
      report.error = String(e.message).slice(0, 2500);
      report.mismatches++;
    } finally {
      await pg?.close();
    }
    reports.push(report);
    console.log(JSON.stringify(report));
    await writeFile(
      join(dataDir, "reports", `p1g-sbe-${year}-${link.state}${suffix}.json`),
      JSON.stringify(report, null, 2) + "\n",
    );
  }
  function stateCheckStatus() {
    if (failed) {
      return "FAIL";
    } else if (links.length) {
      return "PASS";
    } else {
      return "not_published";
    }
  }
  const aggregate = {
    status: stateCheckStatus(),
    year,
    states: reports,
    negative_controls: {
      passed: reports.filter(
        (report) => report.negative_control === "mutated_raw_rate_detected",
      ).length,
      expected: links.length,
    },
  };
  await writeFile(
    join(dataDir, "reports", `p1g-sbe-${year}${suffix}.json`),
    JSON.stringify(aggregate, null, 2) + "\n",
  );
  console.log(
    `${failed ? "FAIL" : "PASS"}: CMS SBE PY${year}: ${reports.length} states; ${reports.reduce((n, r) => n + r.mismatches, 0)} mismatches; controls ${aggregate.negative_controls.passed}/${aggregate.negative_controls.expected}${links.length ? "" : "; not published"}`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
