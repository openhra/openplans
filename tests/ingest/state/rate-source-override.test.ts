import { PGlite } from "@electric-sql/pglite";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { coreMigrations, testDatabase } from "../../pglite.js";
import { migrate } from "../../../src/db/migrate.js";
import {
  ingestStateRates,
  parseStateArtifact,
  stagedStatePremium,
} from "../../../src/ingest/state/index.js";
import {
  refusedTemplatePlans,
  stateCatalog,
  stateSourceCell,
} from "../../../src/ingest/state/catalog.js";
import { loadConfig } from "../../../src/config/index.js";
import { single } from "../../domain/rating/community-helpers.js";
import { rebaseImports, replaceSyntax } from "../../source-mutation.js";
import type { StateArtifact } from "../../../src/ingest/state/index.js";

type Artifact = StateArtifact;

// Every DFS workbook, filing, CMS bundle, issuer and price in this file is SYNTHETIC. Issuer
// 11111 has an admitted template; issuer 22222's template was last saved before its
// filing's submission date, so the guard refuses it.
const PREPARE = String.raw`
import contextlib, csv, hashlib, io, json, pathlib, sys, types, zipfile
src, root = sys.argv[1], pathlib.Path(sys.argv[2])
sys.path.insert(0, src)
import prepare as real_prepare

ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'
def worksheet(rows):
    cells={'B7':'46023','B8':'46387','B9':'Family-Tier Rates','A12':'Plan ID*','E12':'Individual Rate*',
           'G12':'Couple*','M12':'Couple and Three or More Dependents*'}
    for index,(plan,region,p) in enumerate(rows):
        r=14+index
        cells.update({f'A{r}':plan,f'B{r}':region,f'E{r}':p[0],f'G{r}':p[1],f'H{r}':p[2],f'I{r}':p[2],f'J{r}':p[2],
                      f'K{r}':p[3],f'L{r}':p[3],f'M{r}':p[3]})
    out={}
    for ref,value in cells.items():
        row=int(''.join(c for c in ref if c.isdigit()))
        out.setdefault(row,[]).append(f'<c r="{ref}" t="inlineStr"><is><t>{value}</t></is></c>')
    return '<worksheet xmlns="'+ns+'"><sheetData>'+''.join(f'<row r="{r}">'+''.join(c)+'</row>' for r,c in sorted(out.items()))+'</sheetData></worksheet>'
def xlsx(rows, modified):
    out=io.BytesIO()
    with zipfile.ZipFile(out,'w') as z:
        z.writestr('xl/workbook.xml','<workbook xmlns="'+ns+'" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Rates" sheetId="1" r:id="r1"/></sheets></workbook>')
        z.writestr('xl/_rels/workbook.xml.rels','<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>')
        z.writestr('xl/worksheets/sheet1.xml',worksheet(rows))
        z.writestr('docProps/core.xml','<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dcterms:modified xsi:type="dcterms:W3CDTF">'+modified+'</dcterms:modified></cp:coreProperties>')
    return out.getvalue()
def final_exhibits(tracking):
    out=io.BytesIO()
    with zipfile.ZipFile(out,'w') as z:
        z.writestr(f'Synthetic Issuer_00000_{tracking}_IN_23_20250515_1.xlsm',b'synthetic')
    return out.getvalue()
HEADER=['BUSINESS YEAR','STATE CODE','ISSUER ID','SOURCE NAME','VERSION NUMBER','IMPORT DATE','FEDERAL TIN','RATE EXPIRATION',
        'RATE EFFECTIVE DATE','PLAN ID','RATING AREA ID','TOBACCO','AGE','QHP_NON_QHP_TYPE_ID','INDIVIDUAL RATE',
        'INDIVIDUAL TOBACCO RATE','COUPLE','PRIMARY SUBSCRIBER AND ONE DEPENDENT','PRIMARY SUBSCRIBER AND TWO DEPENDENTS',
        'PRIMARY SUBSCRIBER AND THREE OR MORE DEPENDENTS','COUPLE AND ONE DEPENDENT','COUPLE AND TWO DEPENDENTS',
        'COUPLE AND THREE OR MORE DEPENDENTS']
def sbe_row(plan, region, p, age='', start='2026-01-01', end='2026-12-31'):
    tiers=[p[0],'',p[1],p[2],p[2],p[2],p[3],p[3],p[3]] if not age else [p[0]]+['']*8
    return ['2026','NY',plan[:5],'SYNTHETIC','1','01-01-2026','',end,start,plan,region,'',age,'Both']+tiers
A=[('11111NY0000001','Rating Area 4',('100.00','200.00','170.00','285.00')),
   ('11111NY0000002','Rating Area 1',('110.00','220.00','187.00','313.50'))]
B=[('22222NY0000001','Rating Area 4',('120.00','240.00','204.00','342.00')),
   ('22222NY0000002','Rating Area 1',('130.00','260.00','221.00','370.50'))]
SBE_B=('114.00','228.00','193.80','324.90')
def bundle(couple_a='200.00'):
    lines=[HEADER, sbe_row(*A[0][:2], (A[0][2][0],couple_a)+A[0][2][2:]), sbe_row(*A[1]),
           sbe_row('22222NY0000002','Rating Area 1',SBE_B,age='0-14'),
           sbe_row('22222NY0000002','Rating Area 1',SBE_B,start='2026-01-01',end='2026-03-31'),
           sbe_row('22222NY0000001','Rating Area 4',SBE_B), sbe_row('33333NY0000001','Rating Area 2',SBE_B)]
    text=io.StringIO()
    csv.writer(text, lineterminator='\r\n').writerows(lines)
    out=io.BytesIO()
    with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:
        z.writestr('NYRates01012026.csv', text.getvalue().encode('utf-8'))
        z.writestr('NYPlans01012026.csv', b'synthetic')
    return out.getvalue()
NAMES=['SynthA_IND_BOTHX_TSTA-000000001_FinalExhibits','SynthB_IND_BOTHX_TSTB-000000002_FinalExhibits']
def cache(name, sbe=bundle(), quarantined=False):
    base=root/name
    raw=base/'raw'/'state-rating'
    raw.mkdir(parents=True)
    files={real_prepare.NY_FINAL+NAMES[0]:final_exhibits('TSTA-000000001'),
           real_prepare.NY_FINAL+NAMES[1]:final_exhibits('TSTB-000000002')}
    for name_,rows,saved in [(NAMES[0],A,'2025-08-20T13:16:30Z'),(NAMES[1],B,'2025-05-12T23:32:58Z')]:
        files[(real_prepare.NY_FINAL+name_).replace('/45010894/','/45010883/').replace('_FinalExhibits','_ApprRatesTemplate')]=xlsx(rows,saved)
    for url,data in files.items():
        digest=hashlib.sha256(data).hexdigest()
        (raw/digest).write_bytes(data)
        (raw/(digest+'.meta.json')).write_text(json.dumps(dict(url=url,status=200,content_type='synthetic',sha256=digest,bytes=len(data),retrieved_at='2026-01-01T00:00:00+00:00')))
    if sbe is not None:
        digest=hashlib.sha256(sbe).hexdigest()
        sbe_dir=base/'raw'/'cms-sbe-puf'
        (sbe_dir/digest).mkdir(parents=True)
        (sbe_dir/digest/'payload').write_bytes(sbe)
        (sbe_dir/(digest+'.meta.json')).write_text(json.dumps(dict(snapshot_id=digest,source='cms-sbe-puf',url=real_prepare.SBE_NY_URL,
            sha256=digest,bytes=len(sbe),fetched_at='2026-01-01T00:00:00.000Z',content_type='application/zip')))
        if quarantined:
            (sbe_dir/'QUARANTINE.json').write_text(json.dumps(dict(version=1,snapshots=[digest])))
    return base
def run(m, base, overrides=None, config=True):
    argv=['prepare.py','--state','NY','--cache-only','--data-dir',str(base)]
    if config:
        path=base/'config.json'
        path.write_text(json.dumps(dict(version=1, **({} if overrides is None else dict(ny=dict(rateSourceOverrides=overrides))))))
        argv+=['--config',str(path)]
    saved=m.NY_FILES, sys.argv
    m.NY_FILES, sys.argv = NAMES, argv
    try:
        with contextlib.redirect_stdout(io.StringIO()): m.main()
    finally:
        m.NY_FILES, sys.argv = saved
    return (base/'derived'/'state-rating'/'ny-2026.json').read_bytes()
def refuses(m, base, overrides, message):
    try: run(m, base, overrides)
    except ValueError as error: assert message in str(error), str(error)
    else: raise AssertionError('override accepted: '+message)

def scenarios(m, tag):
    quiet=cache(tag+'off')
    off=run(m, quiet, config=False)
    assert 'rate_source_overrides' not in json.loads(off)
    # Off means byte-identical, however the switch is left off.
    assert run(m, quiet) == off and run(m, quiet, {}) == off
    base=quiet
    on=json.loads(run(m, base, {'22222':'cms-sbe'}))
    before=json.loads(off)
    assert on['sources']==before['sources'] and on['template_checks']==before['template_checks']
    block=on['rate_source_overrides']
    assert block['rule']=='ny-rate-source-override-v1' and block['source']=='cms-sbe'
    pub=block['publication']
    assert pub['url']==m.SBE_NY_URL and pub['member']=='NYRates01012026.csv'
    assert pub['sha256']==hashlib.sha256(pathlib.Path(pub['raw_path']).read_bytes()).hexdigest()
    assert block['cross_check']==dict(rule=m.CROSS_CHECK_RULE, compared_keys=2, compared_cells=16, matched_cells=16, issuers={'11111':2})
    entry,=block['issuers']
    assert entry['issuer']=='22222' and entry['refused_template']['reason']=='template_saved_before_submission'
    assert 'template_saved_before_submission' in entry['quality_note']
    record,=entry['records']
    assert record['plan_id']=='22222NY0000001' and record['region']=='Rating Area 4'
    assert record['prices']==dict(single='114.00',couple='228.00',adult_children='193.80',family='324.90')
    # Provenance names the exact CSV line; the header is line 1.
    assert record['source_record']=='NYRates01012026.csv!row=6'
    assert record['raw']==dict(zip(HEADER, sbe_row('22222NY0000001','Rating Area 4',SBE_B)))
    # Only an age row and a quarterly row exist for the second plan: it stays unknown.
    assert entry['unknown_plans']==[dict(plan_id='22222NY0000002',region='Rating Area 1',reason='sbe_rate_row_missing')]
    # Guards: only a refused issuer, only while the cross-check holds, only from an admitted cache.
    refuses(m, cache(tag+'admitted'), {'11111':'cms-sbe'}, 'was not refused')
    refuses(m, cache(tag+'unknown'), {'44444':'cms-sbe'}, 'was not refused')
    refuses(m, cache(tag+'cent', bundle(couple_a='200.01')), {'22222':'cms-sbe'}, 'do not match')
    refuses(m, cache(tag+'missing', None), {'22222':'cms-sbe'}, 'exactly one admitted')
    refuses(m, cache(tag+'quarantined', quarantined=True), {'22222':'cms-sbe'}, 'exactly one admitted')
    refuses(m, cache(tag+'source'), {'22222':'other'}, 'rateSourceOverrides')
    return base, cache(tag+'cent2', bundle(couple_a='200.01'))

base, cent = scenarios(real_prepare, 'real-')
source=pathlib.Path(real_prepare.__file__).read_text()
mutants={'override applied while the template is not refused':
             ("check is None or check['decision'] != 'refused' or any(r['issuer'] == issuer for s in sources for r in s['records'])", 'check is None'),
         'cross-check skipped':
             ("if mismatches or not cross_check['compared_keys'] or not all(cross_check['issuers'].values()):", 'if False:')}
for index,(label,(before,after)) in enumerate(mutants.items()):
    assert source.count(before)==1, label
    m=types.ModuleType('prepare')
    m.__file__=real_prepare.__file__
    exec(compile(source.replace(before,after), real_prepare.__file__, 'exec'), m.__dict__)
    try: scenarios(m, f'mutant{index}-')
    except AssertionError: pass
    else: raise SystemExit('Mutant survived: '+label)
sbe=json.loads((cent/'raw'/'cms-sbe-puf'/next(p.name for p in (cent/'raw'/'cms-sbe-puf').glob('*.meta.json'))).read_text())
with zipfile.ZipFile(cent/'raw'/'cms-sbe-puf'/sbe['sha256']/'payload') as z:
    member=hashlib.sha256(z.read('NYRates01012026.csv')).hexdigest()
print(json.dumps(dict(artifact=str(base/'derived'/'state-rating'/'ny-2026.json'),
    cent=dict(raw_path=str(cent/'raw'/'cms-sbe-puf'/sbe['sha256']/'payload'), sha256=sbe['sha256'], bytes=sbe['bytes'], member_sha256=member))))
`;

const db = testDatabase(new PGlite());
let directory: string,
  core: Awaited<ReturnType<typeof coreMigrations>>,
  prepared: {
    artifact: string;
    cent: {
      raw_path: string;
      sha256: string;
      bytes: number;
      member_sha256: string;
    };
  };
const on = { "22222": "cms-sbe" } as const;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "openplans-synthetic-override-"));
  core = await coreMigrations();
  await migrate(db, core.directory);
  const result = spawnSync(
    "python3",
    [
      "-B",
      "-c",
      PREPARE,
      fileURLToPath(new URL("../../../src/ingest/state/", import.meta.url)),
      directory,
    ],
    { encoding: "utf8", timeout: 60_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  prepared = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
}, 90_000);
afterAll(async () => {
  await db.close();
  await core.cleanup();
  await rm(directory, { recursive: true, force: true });
});

async function variant(name: string, change: (value: Artifact) => void) {
  const value = JSON.parse(await readFile(prepared.artifact, "utf8"));
  change(value);
  const path = join(directory, `${name}.json`);
  await writeFile(path, JSON.stringify(value));
  return path;
}
// The SBE bytes changed by one cent for an admitted issuer, while the artifact still
// carries the cross-check prepare.py recorded before.
const centChanged = (value: Artifact) =>
  Object.assign(value.rate_source_overrides!.publication, prepared.cent);
// An override for issuer 11111, whose DFS template was admitted and is served.
const admittedIssuer = (value: Artifact) => {
  const check = value.template_checks!.find((c) =>
    c.issuer_ids.includes("11111"),
  )!;
  value.rate_source_overrides!.issuers = [
    {
      issuer: "11111",
      source: "cms-sbe",
      refused_template: {
        url: check.url,
        sha256: check.sha256,
        reason: null as unknown as string,
      },
      quality_note: "SYNTHETIC null",
      records: [],
      unknown_plans: [],
    },
  ];
};

it("config: ny.rateSourceOverrides is off by default and accepts only cms-sbe for an issuer ID", () => {
  expect(loadConfig({}).ny.rateSourceOverrides).toEqual({});
  expect(
    loadConfig({}, { version: 1, ny: { rateSourceOverrides: on } }).ny
      .rateSourceOverrides,
  ).toEqual(on);
  for (const rateSourceOverrides of [{ "22222": "dfs" }, { NYQHC: "cms-sbe" }])
    expect(() =>
      loadConfig({}, { version: 1, ny: { rateSourceOverrides } }),
    ).toThrow("Invalid OpenPlans configuration");
});

it("preparer (synthetic): off is byte-identical; on prices a refused issuer from the SBE file; guards and planted mutants", async () => {
  // The Python half ran in beforeAll, including its two planted mutants.
  const value = parseStateArtifact(await readFile(prepared.artifact, "utf8"));
  expect(value.rate_source_overrides?.issuers[0]?.records).toHaveLength(1);
});

it("import (synthetic): a refused issuer is priced from SBE with provenance; missing rows stay unknown", async () => {
  const staged = await ingestStateRates(db, prepared.artifact, "NY", {
    rateSourceOverrides: on,
  });
  expect(staged).toMatchObject({
    status: "STAGED",
    records: 3,
    unknown_issuers: [],
    rate_source_overrides: [
      { issuer: "22222", source: "cms-sbe", records: 1, unknown_plans: 1 },
    ],
  });
  expect(
    await ingestStateRates(db, prepared.artifact, "NY", {
      rateSourceOverrides: on,
    }),
  ).toEqual(staged);
  expect(
    await stagedStatePremium(
      db,
      "NY",
      "22222NY0000001",
      "Rating Area 4",
      single,
      "2026-01-01",
    ),
  ).toMatchObject({ status: "rated", totalCents: 11_400 });
  expect(
    await stagedStatePremium(
      db,
      "NY",
      "11111NY0000001",
      "Rating Area 4",
      single,
      "2026-01-01",
    ),
  ).toMatchObject({ status: "rated", totalCents: 10_000 });
  expect(
    await stagedStatePremium(
      db,
      "NY",
      "22222NY0000002",
      "Rating Area 1",
      single,
      "2026-01-01",
    ),
  ).toEqual({
    status: "unknown",
    reason: "template_saved_before_submission",
    totalCents: null,
  });
  // The priced plan no longer blocks its region's benchmark; the unpriced one still does.
  expect(await refusedTemplatePlans(db, "NY", 2026, "Rating Area 4")).toEqual(
    [],
  );
  expect(
    (await refusedTemplatePlans(db, "NY", 2026, "Rating Area 1")).map(
      (p) => p.plan_id,
    ),
  ).toEqual(["22222NY0000002"]);
  const [row] = await stateCatalog(
    db,
    2026,
    "NY",
    "22222NY0000001",
    "Rating Area 4",
  );
  expect(stateSourceCell(row!, "single")).toMatchObject({
    source_url: "https://www.cms.gov/files/zip/newyorksbepuf2026.zip",
    source_record: "NYRates01012026.csv!row=6",
    column: "INDIVIDUAL RATE",
    value: "114.00",
  });
  const notes = (
    await db.query<{ severity: string; explanation: string }>(
      `SELECT severity,explanation FROM quality_issue WHERE snapshot_id=$1
      AND source_record='22222' AND issue_code='rate_source_override'`,
      [staged.import_id],
    )
  ).rows;
  expect(notes).toHaveLength(1);
  expect(notes[0]!.severity).toBe("info");
  expect(JSON.parse(notes[0]!.explanation)).toMatchObject({
    source: "cms-sbe",
    refused_template: { reason: "template_saved_before_submission" },
    cross_check: { compared_keys: 2, matched_cells: 16 },
    unknown_plans: [{ plan_id: "22222NY0000002" }],
  });
  expect(JSON.parse(notes[0]!.explanation).note).toContain("operator decision");
});

it("import (synthetic): refuses when the switch is off, unverified, for an admitted issuer, or when the cross-check fails", async () => {
  await expect(
    ingestStateRates(db, prepared.artifact, "NY", { rateSourceOverrides: {} }),
  ).rejects.toThrow("configuration and artifact name different issuers");
  await expect(
    ingestStateRates(db, prepared.artifact, "NY", {
      rateSourceOverrides: on,
      verifyRaw: false,
    }),
  ).rejects.toThrow("original publications must be verified");
  const off = await variant(
    "off",
    (value) => delete value.rate_source_overrides,
  );
  await expect(
    ingestStateRates(db, off, "NY", { rateSourceOverrides: on }),
  ).rejects.toThrow("prepared without it");
  await expect(
    ingestStateRates(db, await variant("admitted", admittedIssuer), "NY", {
      rateSourceOverrides: { "11111": "cms-sbe" },
    }),
  ).rejects.toThrow("has no refused DFS template");
  await expect(
    ingestStateRates(db, await variant("cent", centChanged), "NY", {
      rateSourceOverrides: on,
    }),
  ).rejects.toThrow("cross-check did not match");
  for (const [label, change] of [
    [
      "rate edited",
      (v: Artifact) =>
        (v.rate_source_overrides!.issuers[0]!.records[0]!.prices.single =
          "113.99"),
    ],
    [
      "unknown plan dropped",
      (v: Artifact) =>
        (v.rate_source_overrides!.issuers[0]!.unknown_plans = []),
    ],
    [
      "cross-check count forged",
      (v: Artifact) =>
        (v.rate_source_overrides!.cross_check.matched_cells = 15),
    ],
  ] as const) {
    const value = JSON.parse(await readFile(prepared.artifact, "utf8"));
    change(value);
    expect(() => parseStateArtifact(JSON.stringify(value)), label).toThrow();
  }
  const vt = JSON.parse(
    await readFile(
      new URL("../../fixtures/state/vt-2026.json", import.meta.url),
      "utf8",
    ),
  );
  vt.rate_source_overrides = JSON.parse(
    await readFile(prepared.artifact, "utf8"),
  ).rate_source_overrides;
  expect(() => parseStateArtifact(JSON.stringify(vt))).toThrow(
    "NY publications only",
  );
});

it("planted mutants: an override for a template that was not refused, and a skipped cross-check, fail these checks", async () => {
  const dist = new URL("../../../dist/ingest/state/", import.meta.url);
  async function mutant(name: string, before: string, after: string) {
    const overrideUrl = new URL("rate-source-override.js", dist);
    const overridePath = join(directory, `${name}-override.mjs`);
    await writeFile(
      overridePath,
      rebaseImports(
        replaceSyntax(await readFile(overrideUrl, "utf8"), before, after),
        overrideUrl,
      ),
    );
    const indexUrl = new URL("index.js", dist);
    const indexPath = join(directory, `${name}-index.mjs`);
    await writeFile(
      indexPath,
      // The rules file is found relative to the original module, not the copy.
      rebaseImports(
        (await readFile(indexUrl, "utf8")).replaceAll(
          "import.meta.url",
          JSON.stringify(indexUrl.href),
        ),
        indexUrl,
      ).replace(
        JSON.stringify(overrideUrl.href),
        JSON.stringify(pathToFileURL(overridePath).href),
      ),
    );
    return (await import(pathToFileURL(indexPath).href)) as {
      ingestStateRates: typeof ingestStateRates;
    };
  }
  const real = (await import(new URL("index.js", dist).href)) as {
    ingestStateRates: typeof ingestStateRates;
  };
  const guards = {
    "override applied while the template is not refused": {
      before: 'return check.decision === "refused" && !served.has(issuer);',
      after: "return true;",
      check: async (module: typeof real) =>
        expect(
          module.ingestStateRates(
            db,
            await variant("m-admitted", admittedIssuer),
            "NY",
            { rateSourceOverrides: { "11111": "cms-sbe" } },
          ),
        ).rejects.toThrow("has no refused DFS template"),
    },
    "cross-check skipped": {
      before:
        "mismatches || JSON.stringify(check) !== JSON.stringify(block.cross_check)",
      after: "false",
      check: async (module: typeof real) =>
        expect(
          module.ingestStateRates(
            db,
            await variant("m-cent", centChanged),
            "NY",
            { rateSourceOverrides: on },
          ),
        ).rejects.toThrow("cross-check did not match"),
    },
  };
  for (const [label, { before, after, check }] of Object.entries(guards)) {
    await check(real);
    const planted = await mutant(label.replace(/\W+/g, "-"), before, after);
    await expect(check(planted), `mutant survived: ${label}`).rejects.toThrow();
  }
  // Without the guards the same imports go through: the guards are what refuse them.
  const admitted = await mutant(
    "accepts-admitted",
    guards["override applied while the template is not refused"].before,
    "return true;",
  );
  await expect(
    admitted.ingestStateRates(
      db,
      await variant("m-admitted-2", admittedIssuer),
      "NY",
      { rateSourceOverrides: { "11111": "cms-sbe" } },
    ),
  ).resolves.toMatchObject({ status: "STAGED" });
  const skipped = await mutant(
    "accepts-cent",
    guards["cross-check skipped"].before,
    "false",
  );
  await expect(
    skipped.ingestStateRates(db, await variant("m-cent-2", centChanged), "NY", {
      rateSourceOverrides: on,
    }),
  ).resolves.toMatchObject({ status: "STAGED" });
});
