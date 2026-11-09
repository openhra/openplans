import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";

it("reproduces year-over-year counts and age-40 medians from real cuts, and rejects a hash mutant", () => {
  const script = String.raw`
import csv, hashlib, importlib.util, io, json, sys, tempfile, zipfile
from decimal import Decimal
from pathlib import Path
from statistics import median
sys.path.insert(0, 'scripts/oracle')
spec=importlib.util.spec_from_file_location('yoy', 'scripts/oracle/year-over-year.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as d:
 cache=Path(d);root=cache/'raw/cms-exchange-puf';root.mkdir(parents=True)
 files=[];expected={}
 for year in [2026,2027]:
  directory=Path('tests/fixtures/puf')/('import' if year==2026 else 'import-2027')
  expected[year]={}
  for kind in ['plan-attributes','rate']:
   content=(directory/(kind+'.csv')).read_bytes()
   buffer=io.BytesIO()
   with zipfile.ZipFile(buffer,'w') as z: z.writestr(kind+'.csv',content)
   payload=buffer.getvalue();sha=hashlib.sha256(payload).hexdigest()
   (root/sha).mkdir();(root/sha/'payload').write_bytes(payload)
   files.append({'year':year,'kind':kind,'status':'ok','snapshot_id':sha,'sha256':sha})
  rows=list(csv.DictReader((directory/'rate.csv').open()))
  for row in rows:
   if row['StateCode']=='TX' and row['Age']=='40' and row['IssuerId'] in ['11718','66252']:
    expected[year].setdefault(row['RatingAreaId'],[]).append(Decimal(row['IndividualRate'])*100)
 report=m.comparison(cache, {'files':files})
 assert report['years'][2026]['catalog_base_plans']==3
 assert report['years'][2027]['catalog_base_plans']==3
 assert report['years'][2026]['medical_base_plans']==2
 assert report['years'][2027]['medical_base_plans']==2
 for year in [2026,2027]:
  for area,values in expected[year].items():
   assert report['years'][year]['areas'][area]['median_cents']==median(values)
 assert 'Change (%)' in m.markdown(report)
 # Synthetic acquisition-hash mutant of an untouched real CSV cut.
 files[-1]['sha256']='0'*64
 try: m.comparison(cache, {'files':files})
 except ValueError as e: assert 'hash mismatch' in str(e)
 else: raise AssertionError('Hash mutant did not fail')
`;
  const result = spawnSync("python3", ["-B", "-c", script], {
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
});
