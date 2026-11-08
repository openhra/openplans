import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('source preparer: synthetic CFB/BIFF, continuation strings and OOXML; corrupt chains, truncated strings and wrong family columns fail', () => {
  const result = spawnSync('python3', ['-B', '-c', String.raw`
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
`, fileURLToPath(new URL('../../../src/ingest/state/', import.meta.url))], { encoding: 'utf8', timeout: 15_000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe('PASS: state preparer positive + negative controls');
});
