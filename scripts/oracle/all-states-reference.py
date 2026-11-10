#!/usr/bin/env python3
"""Independent raw ZIP/CSV counts and Decimal premiums, never imported TS or stored raw JSON."""
import argparse, csv, hashlib, io, json, zipfile
from collections import Counter
from decimal import Decimal
from pathlib import Path

FAMILY = ['Couple','PrimarySubscriberAndOneDependent','PrimarySubscriberAndTwoDependents',
          'PrimarySubscriberAndThreeOrMoreDependents','CoupleAndOneDependent','CoupleAndTwoDependents','CoupleAndThreeOrMoreDependents']
def cents(value):
    if not value.strip(): return None
    n = Decimal(value) * 100
    if n != n.to_integral_value(): raise ValueError('Non-cent premium')
    return int(n)
def collect(cache, manifest, year, directory):
    directory.mkdir(parents=True, exist_ok=True)
    files = {f['kind']:f for f in json.loads(manifest.read_text())['files'] if f['year']==year}
    states = {}
    for kind in ['plan-attributes','service-area','network','business-rules','rate','benefits-and-cost-sharing']:
        f=files[kind]; path=cache/'raw/cms-exchange-puf'/f['sha256']/'payload'
        digest=hashlib.sha256()
        with path.open('rb') as source:
            for chunk in iter(lambda: source.read(1024*1024),b''): digest.update(chunk)
        if digest.hexdigest()!=f['sha256'] or path.stat().st_size!=f['bytes']: raise ValueError('Archive integrity')
        outputs={}
        try:
            with zipfile.ZipFile(path) as z:
                if len(z.namelist())!=1: raise ValueError('Archive member count')
                reader=csv.DictReader(io.TextIOWrapper(z.open(z.namelist()[0]),encoding='utf-8-sig',newline=''))
                _=reader.fieldnames
                previous=reader.line_num
                for r in reader:
                    start=previous+1;previous=reader.line_num
                    if r['BusinessYear']!=str(year): raise ValueError('Publication year')
                    s=r['StateCode']
                    if kind=='plan-attributes':
                        state=states.setdefault(s,dict(state=s,year=year,counts=Counter(),base_ids=set(),variant_ids=set(),individual_medical=False,family_options=0))
                        state['base_ids'].add(r['StandardComponentId'])
                        if len(r['PlanId'])==17: state['variant_ids'].add(r['PlanId'])
                        if r['MarketCoverage']=='Individual' and r['DentalOnlyPlan']=='No' and r['QHPNonQHPTypeId']!='Off the Exchange': state['individual_medical']=True
                    if s not in states: continue
                    state=states[s];state['counts'][kind]+=1
                    if kind=='rate' and state['individual_medical']:
                        if s not in outputs: outputs[s]=(directory/f'{s}-rates.jsonl').open('w')
                        family=r['Age']=='Family Option' or any(r[k].strip() for k in FAMILY)
                        state['family_options']+=int(r['Age']=='Family Option')
                        outputs[s].write(json.dumps(dict(source_row=start,plan=r['PlanId'],area=r['RatingAreaId'],age=r['Age'],tobacco=r['Tobacco'],effective=r['RateEffectiveDate'],expiration=r['RateExpirationDate'],individual=cents(r['IndividualRate']),tobacco_rate=cents(r['IndividualTobaccoRate']),family=family),separators=(',',':'))+'\n')
        finally:
            for f in outputs.values(): f.close()
        print(f'raw PY{year}: {kind} complete',flush=True)
    result={}
    for s,r in sorted(states.items()):
        if not r['individual_medical']: continue
        r['base_ids']=sorted(r['base_ids']);r['variant_ids']=sorted(r['variant_ids'])
        r['counts']['base_plans']=len(r['base_ids']);r['counts']['variants']=len(r['variant_ids'])
        result[s]=r
    (directory/'summary.json').write_text(json.dumps(result,indent=2)+'\n')
    return result
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--cache',type=Path,required=True);p.add_argument('--manifest',type=Path,required=True);p.add_argument('--year',type=int,choices=[2025,2026,2027],required=True);p.add_argument('--directory',type=Path,required=True)
    a=p.parse_args();collect(a.cache,a.manifest,a.year,a.directory)
