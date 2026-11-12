import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("source preparer: synthetic CFB/BIFF, continuation strings and OOXML; corrupt chains, truncated strings and wrong family columns fail", () => {
  const result = spawnSync(
    "python3",
    [
      "-B",
      "-c",
      String.raw`
import io, pathlib, struct, sys, tempfile, zipfile
sys.path.insert(0, sys.argv[1])
from biff import biff_sheets, Strings, rk_value
from prepare import ny_records

# Every workbook in this test is SYNTHETIC, constructed in memory.
def record(kind, payload): return struct.pack('<HH',kind,len(payload))+payload
text=b'synthetic'
sst=record(0xfc,struct.pack('<II',1,1)+struct.pack('<HB',len(text),0)+text)
name=b'Data'
bound_size=4+8+len(name)
offset=len(sst)+bound_size+4
bound=record(0x85,struct.pack('<IBBBB',offset,0,0,len(name),0)+name)
global_data=sst+bound+record(0x0a,b'')
sheet=record(0xfd,struct.pack('<HHHI',0,0,0,0))+record(0x27e,struct.pack('<HHHI',0,1,0,(12345<<2)|3))+record(0x0a,b'')
def cfb(payload, cycle=False):
    payload=payload.ljust(4096,b'\0')
    assert len(payload)==4096
    header=bytearray(512)
    header[:8]=bytes.fromhex('d0cf11e0a1b11ae1')
    struct.pack_into('<H',header,30,9)
    struct.pack_into('<I',header,44,1)
    struct.pack_into('<I',header,48,0)
    struct.pack_into('<I',header,56,4096)
    struct.pack_into('<I',header,60,0xfffffffe)
    struct.pack_into('<I',header,68,0xfffffffe)
    struct.pack_into('<109I',header,76,1,*([0xffffffff]*108))
    directory=bytearray(512)
    n='Workbook\0'.encode('utf-16le')
    directory[:len(n)]=n
    struct.pack_into('<H',directory,64,len(n))
    directory[66]=2
    struct.pack_into('<IQ',directory,116,2,len(payload))
    fat=[0xfffffffe,0xfffffffd]+list(range(3,10))+[0xfffffffe]+[0xffffffff]*118
    if cycle: fat[2]=2
    return bytes(header)+bytes(directory)+struct.pack('<128I',*fat)+payload

sheets=biff_sheets(cfb(global_data+sheet))
assert sheets['Data'][1]=={0:'synthetic',1:'123.45'}
assert Strings([struct.pack('<HB',4,0)+b'AB',b'\x00CD']).string()=='ABCD'
assert Strings([struct.pack('<HB',4,1)+'AB'.encode('utf-16le'),b'\x01'+'CD'.encode('utf-16le')]).string()=='ABCD'
assert rk_value(struct.pack('<I',((-12345<<2)|3)&0xffffffff))==-123.45
for mutation in [lambda: biff_sheets(cfb(global_data+sheet,True)),
                 lambda: biff_sheets(cfb(record(0x2f,b'encrypted'))),
                 lambda: Strings([struct.pack('<HB',8,0)+b'AB']).string()]:
    try: mutation()
    except ValueError: pass
    else: raise AssertionError('Corrupt BIFF mutant was accepted')

ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'
def worksheet(wrong=False):
    cells={'B7':'46023','B8':'46387','B9':'Family-Tier Rates','A12':'Plan ID*','E12':'Individual Rate*',
           'G12':'Couple*','M12':'Couple and Three or More Dependents*',
           'A14':'11111NY0000001','B14':'Rating Area 4','E14':'100.00','G14':'200.00',
           'H14':'170.00','I14':'999.00' if wrong else '170.00','J14':'170.00',
           'K14':'285.00','L14':'285.00','M14':'285.00'}
    rows={}
    for ref,value in cells.items():
        import re
        row=int(re.search(r'\d+',ref).group())
        rows.setdefault(row,[]).append(f'<c r="{ref}" t="inlineStr"><is><t>{value}</t></is></c>')
    return '<worksheet xmlns="'+ns+'"><sheetData>'+''.join(f'<row r="{r}">'+''.join(c)+'</row>' for r,c in rows.items())+'</sheetData></worksheet>'
def xlsx(path,wrong=False):
    with zipfile.ZipFile(path,'w') as z:
        z.writestr('xl/workbook.xml','<workbook xmlns="'+ns+'" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Rates" sheetId="1" r:id="r1"/></sheets></workbook>')
        z.writestr('xl/_rels/workbook.xml.rels','<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>')
        z.writestr('xl/worksheets/sheet1.xml',worksheet(wrong))
with tempfile.TemporaryDirectory(prefix='openplans-synthetic-state-') as directory:
    path=pathlib.Path(directory)/'synthetic.xlsx'
    xlsx(path)
    rows=ny_records(path)
    assert len(rows)==1 and rows[0]['prices']==dict(single='100.00',couple='200.00',adult_children='170.00',family='285.00')
    xlsx(path,True)
    try: ny_records(path)
    except ValueError as error: assert 'Non-uniform' in str(error)
    else: raise AssertionError('Wrong dependent-count tier was accepted')
print('PASS: state preparer positive + negative controls')
`,
      fileURLToPath(new URL("../../../src/ingest/state/", import.meta.url)),
    ],
    { encoding: "utf8", timeout: 15_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe(
    "PASS: state preparer positive + negative controls",
  );
});

it("template guard: stale or undated approved templates are refused as unknown; a skipped guard fails", () => {
  const result = spawnSync(
    "python3",
    [
      "-B",
      "-c",
      String.raw`
import contextlib, datetime, hashlib, io, json, pathlib, struct, sys, tempfile, zipfile
sys.path.insert(0, sys.argv[1])
import prepare

# Every workbook, filing and archive in this test is SYNTHETIC, constructed in memory.
ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'
def worksheet(plan):
    cells={'B7':'46023','B8':'46387','B9':'Family-Tier Rates','A12':'Plan ID*','E12':'Individual Rate*',
           'G12':'Couple*','M12':'Couple and Three or More Dependents*',
           'A14':plan,'B14':'Rating Area 4','E14':'100.00','G14':'200.00',
           'H14':'170.00','I14':'170.00','J14':'170.00','K14':'285.00','L14':'285.00','M14':'285.00'}
    rows={}
    for ref,value in cells.items():
        row=int(''.join(c for c in ref if c.isdigit()))
        rows.setdefault(row,[]).append(f'<c r="{ref}" t="inlineStr"><is><t>{value}</t></is></c>')
    return '<worksheet xmlns="'+ns+'"><sheetData>'+''.join(f'<row r="{r}">'+''.join(c)+'</row>' for r,c in rows.items())+'</sheetData></worksheet>'
def xlsx(plan, modified):
    out=io.BytesIO()
    with zipfile.ZipFile(out,'w') as z:
        z.writestr('xl/workbook.xml','<workbook xmlns="'+ns+'" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Rates" sheetId="1" r:id="r1"/></sheets></workbook>')
        z.writestr('xl/_rels/workbook.xml.rels','<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>')
        z.writestr('xl/worksheets/sheet1.xml',worksheet(plan))
        if modified:
            z.writestr('docProps/core.xml','<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dcterms:modified xsi:type="dcterms:W3CDTF">'+modified+'</dcterms:modified></cp:coreProperties>')
    return out.getvalue()
def summary_information(saved):
    ticks=int((saved-datetime.datetime(1601,1,1,tzinfo=datetime.timezone.utc)).total_seconds())*10_000_000
    section=struct.pack('<II',8+8+12,1)+struct.pack('<II',prepare.PID_LAST_SAVED,16)+struct.pack('<IQ',prepare.VT_FILETIME,ticks)
    header=struct.pack('<HHI',0xfffe,0,0)+bytes(16)+struct.pack('<I',1)+prepare.SUMMARY_FMTID+struct.pack('<I',48)
    return header+section
def cfb(streams):
    # One-sector FAT; every stream padded to 4096 bytes so no mini stream is needed.
    payloads=[(name,data.ljust(4096,b'\0')) for name,data in streams]
    header=bytearray(512)
    header[:8]=bytes.fromhex('d0cf11e0a1b11ae1')
    struct.pack_into('<H',header,30,9)
    struct.pack_into('<I',header,44,1)
    struct.pack_into('<I',header,48,1)
    struct.pack_into('<I',header,56,4096)
    struct.pack_into('<I',header,60,0xfffffffe)
    struct.pack_into('<I',header,68,0xfffffffe)
    struct.pack_into('<109I',header,76,0,*([0xffffffff]*108))
    fat=[0xfffffffd,0xfffffffe]
    directory=bytearray(512)
    root='Root Entry\0'.encode('utf-16le')
    directory[:len(root)]=root
    struct.pack_into('<H',directory,64,len(root))
    directory[66]=5
    struct.pack_into('<IQ',directory,116,0xfffffffe,0)
    body=b''
    for index,(name,data) in enumerate(payloads):
        entry=bytearray(128)
        encoded=(name+'\0').encode('utf-16le')
        entry[:len(encoded)]=encoded
        struct.pack_into('<H',entry,64,len(encoded))
        entry[66]=2
        first=len(fat)
        fat.extend(range(first+1,first+8))
        fat.append(0xfffffffe)
        struct.pack_into('<IQ',entry,116,first,len(data))
        directory[128*(index+1):128*(index+2)]=entry
        body+=data
    fat+= [0xffffffff]*(128-len(fat))
    return bytes(header)+struct.pack('<128I',*fat)+bytes(directory)+body
def final_exhibits(tracking, dates):
    out=io.BytesIO()
    with zipfile.ZipFile(out,'w') as z:
        for exhibit,day in zip(['13C','23'],dates):
            z.writestr(f'Synthetic Issuer_00000_{tracking}_IN_{exhibit}_{day}_1.xlsm',b'synthetic')
    return out.getvalue()
utc=lambda *a: datetime.datetime(*a,tzinfo=datetime.timezone.utc)

assert prepare.ole_saved_at(cfb([('Workbook',b'x'),('\x05SummaryInformation',summary_information(utc(2025,5,12,23,32,58)))]))=='2025-05-12T23:32:58Z'
assert prepare.ole_saved_at(cfb([('Workbook',b'x')])) is None
assert prepare.ooxml_saved_at(xlsx('11111NY0000001','2025-08-20T13:16:30Z'))=='2025-08-20T13:16:30Z'
assert prepare.ooxml_saved_at(xlsx('11111NY0000001',None)) is None

def check(data, final, tracking='TSTA-000000001'):
    with tempfile.TemporaryDirectory(prefix='openplans-synthetic-guard-') as directory:
        template=pathlib.Path(directory)/'template'
        template.write_bytes(data)
        exhibits=None
        if final is not None:
            exhibits=pathlib.Path(directory)/'final'
            exhibits.write_bytes(final)
            exhibits=(exhibits, dict(url='https://myportal.dfs.ny.gov/documents/538523/45010894/Synthetic_IND_BOTHX_'+tracking+'_FinalExhibits', sha256='0'*64))
        url='https://myportal.dfs.ny.gov/documents/538523/45010883/Synthetic_IND_BOTHX_'+tracking+'_ApprRatesTemplate'
        meta=dict(sha256=hashlib.sha256(data).hexdigest(), bytes=len(data), retrieved_at='2026-01-01T00:00:00Z', content_type='synthetic')
        return prepare.template_check(url, template, meta, exhibits, [dict(issuer='11111', plan_id='11111NY0000001', region='Rating Area 4')]*2)

def guard_cases():
    late=xlsx('11111NY0000001','2025-08-20T13:16:30Z')
    early=xlsx('11111NY0000001','2025-05-12T23:32:58Z')
    on_day=xlsx('11111NY0000001','2025-05-15T00:00:00Z')
    stale_ole=cfb([('Workbook',b'x'),('\x05SummaryInformation',summary_information(utc(2025,5,12,23,32,58)))])
    filed=final_exhibits('TSTA-000000001',['20250515','20250515'])
    cases=[(late,filed,None),(on_day,filed,None),(early,filed,'template_saved_before_submission'),
           (stale_ole,filed,'template_saved_before_submission'),
           (cfb([('Workbook',b'x')]),filed,'template_saved_date_unavailable'),
           (xlsx('11111NY0000001',None),filed,'template_saved_date_unavailable'),
           (late,None,'submission_date_unavailable'),
           (late,final_exhibits('TSTB-000000002',['20250515','20250515']),'submission_date_unavailable'),
           (late,final_exhibits('TSTA-000000001',['20250515','20250601']),'submission_date_ambiguous')]
    for data,final,reason in cases:
        result=check(data,final)
        assert result['reason']==reason, (result['reason'], reason)
        assert result['decision']==('refused' if reason else 'admitted')
        assert result['status']==('unknown' if reason else 'filed')
        assert result['evidence']['rule']==prepare.TEMPLATE_GUARD_RULE and result['issuer_ids']==['11111']
        # A refusal lists where its plans are (never their rates); an admitted check does not.
        assert result.get('listed_plans')==([dict(plan_id='11111NY0000001', region='Rating Area 4')] if reason else None)

def end_to_end():
    # Two synthetic filings through main(), cache-only: one stale template, one current.
    with tempfile.TemporaryDirectory(prefix='openplans-synthetic-guard-') as directory:
        cache=pathlib.Path(directory)
        raw=cache/'raw'/'state-rating'
        raw.mkdir(parents=True)
        names=['SynthA_IND_BOTHX_TSTA-000000001_FinalExhibits','SynthB_IND_BOTHX_TSTB-000000002_FinalExhibits']
        files={prepare.NY_FINAL+names[0]:final_exhibits('TSTA-000000001',['20250515','20250515']),
               prepare.NY_FINAL+names[1]:final_exhibits('TSTB-000000002',['20250515','20250515'])}
        for name,plan,saved in [(names[0],'11111NY0000001','2025-08-20T13:16:30Z'),(names[1],'22222NY0000001','2025-05-12T23:32:58Z')]:
            files[(prepare.NY_FINAL+name).replace('/45010894/','/45010883/').replace('_FinalExhibits','_ApprRatesTemplate')]=xlsx(plan,saved)
        for url,data in files.items():
            digest=hashlib.sha256(data).hexdigest()
            (raw/digest).write_bytes(data)
            (raw/(digest+'.meta.json')).write_text(json.dumps(dict(url=url,status=200,content_type='synthetic',sha256=digest,bytes=len(data),retrieved_at='2026-01-01T00:00:00+00:00')))
        saved_names, saved_argv = prepare.NY_FILES, sys.argv
        prepare.NY_FILES, sys.argv = names, ['prepare.py','--state','NY','--cache-only','--data-dir',str(cache)]
        try:
            with contextlib.redirect_stdout(io.StringIO()): prepare.main()
        finally:
            prepare.NY_FILES, sys.argv = saved_names, saved_argv
        value=json.loads((cache/'derived'/'state-rating'/'ny-2026.json').read_text())
        assert [r['issuer'] for s in value['sources'] for r in s['records']]==['11111'], 'stale template was served'
        checks={c['issuer_ids'][0]:c for c in value['template_checks']}
        assert checks['11111']['decision']=='admitted'
        assert checks['22222']=={**checks['22222'],'decision':'refused','status':'unknown','reason':'template_saved_before_submission'}
        assert checks['22222']['evidence']['workbooks']==[dict(member='publication',saved_at='2025-05-12T23:32:58Z')]
        assert checks['22222']['evidence']['submission_date']=='2025-05-15'
        assert checks['22222']['listed_plans']==[dict(plan_id='22222NY0000001', region='Rating Area 4')]
        assert 'listed_plans' not in checks['11111']

guard_cases()
end_to_end()
# Planted mutants: a guard that is skipped, or that invents date evidence, must be caught.
real_decision, real_ole, real_ooxml = prepare.template_decision, prepare.ole_saved_at, prepare.ooxml_saved_at
mutants={'guard skipped':dict(template_decision=lambda *a: None),
         'saved date invented':dict(ole_saved_at=lambda d: '2025-09-01T00:00:00Z', ooxml_saved_at=lambda d: '2025-09-01T00:00:00Z')}
for label,patch in mutants.items():
    for case in (guard_cases, end_to_end):
        for name,value in patch.items(): setattr(prepare,name,value)
        try: case()
        except AssertionError: pass
        else: raise SystemExit('Mutant survived: '+label+' in '+case.__name__)
        finally:
            prepare.template_decision, prepare.ole_saved_at, prepare.ooxml_saved_at = real_decision, real_ole, real_ooxml
print('PASS: template guard + planted mutants')
`,
      fileURLToPath(new URL("../../../src/ingest/state/", import.meta.url)),
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe("PASS: template guard + planted mutants");
});
