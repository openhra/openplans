#!/usr/bin/env node
/** Cache-only TX PY2026 CSR oracle. Independent Python csv/Decimal -> native HTTP. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { database, portableMigrations } from './negative-controls.mjs';
import { migrate } from '../../dist/db/migrate.js';
import { cachedImportFiles } from '../../dist/ingest/puf/import-source.js';
import { importPufs } from '../../dist/ingest/puf/import.js';
import { createApp } from '../../dist/api/app.js';
import { premiumRequest } from '../../dist/api/validation.js';
import { selectedVariant } from '../../dist/domain/csr/index.js';

const cache = process.env.OPENPLANS_DATA_DIR || join(homedir(), '.local', 'share', 'openplans');
if (!isAbsolute(cache)) throw new Error('Absolute OPENPLANS_DATA_DIR required');
const reports = join(cache, 'reports'); await mkdir(reports, { recursive: true });
const scratch = await mkdtemp(join(reports, '.p5f-csr-'));
const report = { passed: false, generated_at: new Date().toISOString(), state: 'TX', year: 2026,
  silver_plans: 0, variants_compared: 0, benefit_rows_compared: 0, amount_cells_compared: 0,
  missing_variants: 0, mismatches: [], failures: [], negative_controls: [] };
const mismatch = (kind, base, detail) => report.mismatches.push({ kind, base, detail });
const python = String.raw`
import csv, hashlib, io, json, re, sys, zipfile
from decimal import Decimal
from pathlib import Path
cache, manifest_path, output = map(Path, sys.argv[1:])
manifest = json.loads(manifest_path.read_text())
files = {f['kind']: f for f in manifest['files'] if f['year'] == 2026}
sources = {}
def records(kind):
    f = files[kind]; path = cache / 'raw/cms-exchange-puf' / f['snapshot_id'] / 'payload'
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024*1024), b''): h.update(chunk)
    assert h.hexdigest() == f['sha256']
    sources[kind] = {'url': f['url'], 'sha256': f['sha256']}
    with zipfile.ZipFile(path) as archive:
        with io.TextIOWrapper(archive.open(f['members'][0]['name']), encoding='utf-8-sig', newline='') as stream:
            reader = csv.DictReader(stream); reader.fieldnames
            while True:
                start = reader.line_num + 1
                row = next(reader, None)
                if row is None: break
                if row['StateCode'] == 'TX':
                    assert row['BusinessYear'] == '2026'
                    yield start, row

def amount(raw):
    match = re.fullmatch(r'\$(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?:\s+per (?:person|group))?', raw.strip())
    cents = int(Decimal(match[1].replace(',', '') + '.' + (match[2] or '0')) * 100) if match else None
    return {'raw': raw, 'cents': cents, 'status': 'unknown' if cents is None else 'available'}
plans = {}
for start, row in records('plan-attributes'):
    if row['MetalLevel'].lower() != 'silver' or row['DentalOnlyPlan'] != 'No': continue
    base = row['StandardComponentId']; plans.setdefault(base, {'base': base, 'variants': {}})
    variant = row['PlanId']
    plans[base]['variants'][variant] = {'variant': variant, 'csr_variation_type': row['CSRVariationType'], 'source_row': start,
      'deductibles': {k: amount(v) for k, v in row.items() if re.match(r'^[MDT]EHBDed', k) and not k.endswith('Coinsurance')},
      'moop': {k: amount(v) for k, v in row.items() if re.match(r'^[MDT]EHB.*MOOP$', k)},
      'coinsurance_raw': {k: v for k, v in row.items() if re.match(r'^[MDT]EHBDed.*Coinsurance$', k)},
      'medical_drug_deductibles_integrated': row['MedicalDrugDeductiblesIntegrated'],
      'medical_drug_moop_integrated': row['MedicalDrugMaximumOutofPocketIntegrated'], 'benefits': []}
keys = ['CopayInnTier1','CopayInnTier2','CopayOutofNet','CoinsInnTier1','CoinsInnTier2','CoinsOutofNet']
for start, row in records('benefits-and-cost-sharing'):
    p = plans.get(row['StandardComponentId'])
    if not p: continue
    v = p['variants'].get(row['PlanId'])
    if not v: raise ValueError('Orphan silver benefit variant')
    v['benefits'].append({'published_plan_id': row['PlanId'], 'benefit_name': row['BenefitName'],
      'cost_sharing_raw': {k: row[k] for k in keys},
      'cost_sharing_parsed': {k: {'cents': int(Decimal(row[k][1:]) * 100)} if re.fullmatch(r'\$\d+(?:\.\d{1,2})?', row[k]) else None for k in keys},
      'raw': row, 'source_row': start})
rate_rows, variant_rate_rows, silver_rate_rows = 0, 0, 0
rate_bases = set()
for start, row in records('rate'):
    rate_rows += 1
    if not re.fullmatch(r'\d{5}[A-Z]{2}\d{7}', row['PlanId']): variant_rate_rows += 1
    if row['PlanId'] in plans:
        silver_rate_rows += 1; rate_bases.add(row['PlanId'])
with output.open('w') as out:
    for base, plan in sorted(plans.items()): out.write(json.dumps(plan) + '\n')
summary = {'silver_plans': len(plans), 'rate_rows': rate_rows, 'variant_rate_rows': variant_rate_rows,
  'silver_rate_rows': silver_rate_rows, 'silver_bases_with_rates': len(rate_bases), 'sources': sources}
output.with_suffix('.summary.json').write_text(json.dumps(summary))
`;
let db;
try {
  const acquired = await cachedImportFiles(cache, 2026), expectedPath = join(scratch, 'expected.jsonl');
  console.log('CSR oracle: independent raw Plan Attributes, Benefits and Rate CSV parser');
  await new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', python, cache, acquired.manifestPath, expectedPath], { stdio: ['ignore', 'inherit', 'inherit'] });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`CSV parser exited ${code}`)));
  });
  const raw = JSON.parse(await readFile(join(scratch, 'expected.summary.json'), 'utf8'));
  report.sources = raw.sources; report.rate_evidence = raw;
  assert.equal(raw.variant_rate_rows, 0, 'TX Rate PUF IDs must all be base IDs');
  assert.equal(raw.silver_bases_with_rates, raw.silver_plans, 'Every silver base must have filed rate evidence');
  db = database(new PGlite(join(cache, 'puf-pglite-p5f-csr')));
  await migrate(db, await portableMigrations(join(scratch, 'migrations')));
  let active = (await db.query("SELECT import_id FROM puf_active_catalog WHERE state='TX' AND plan_year=2026")).rows[0];
  if (active) {
    const saved = (await db.query('SELECT f.kind,s.sha256 FROM puf_import_file f JOIN snapshot s ON s.snapshot_id=f.snapshot_id WHERE f.import_id=$1', [active.import_id])).rows;
    if (saved.length !== acquired.files.length || acquired.files.some(f => !saved.some(s => s.kind === f.kind && s.sha256 === f.sha256))) active = undefined;
  }
  if (!active) {
    console.log('CSR oracle: importing TX 2026 into isolated P5f database');
    const result = await importPufs(db, { year: 2026, state: 'TX', dataDir: cache, files: acquired.files, manifestPath: acquired.manifestPath });
    assert.equal(result.status, 'ACTIVE', result.report_json); active = { import_id: result.import_id };
  }
  report.import_id = active.import_id;
  const app = createApp(db), fields = ['deductibles', 'moop', 'coinsurance_raw', 'medical_drug_deductibles_integrated', 'medical_drug_moop_integrated'];
  const attributes = `${active.import_id}:plan-attributes`;
  const actualBases = (await db.query("SELECT base_plan_id FROM plan WHERE snapshot_id=$1 AND lower(metal)='silver' AND NOT dental_only ORDER BY base_plan_id", [attributes])).rows.map(p => p.base_plan_id);
  const expectedBases = []; let example;
  const compare = (actual, expected, base, context) => {
    try { assert.deepEqual(actual, expected); } catch { mismatch(context, base, 'served evidence differs from independent raw projection'); }
  };
  for await (const line of createInterface({ input: createReadStream(expectedPath), crlfDelay: Infinity })) {
    const plan = JSON.parse(line); expectedBases.push(plan.base); report.silver_plans++;
    const response = await app.request(`/v1/plans/${plan.base}?year=2026`), detail = await response.json();
    assert.equal(response.status, 200, plan.base);
    compare(detail.variant_ids, Object.keys(plan.variants).sort(), plan.base, 'available_variant_set');
    assert.equal(detail.cost_sharing.selected_variant_id, `${plan.base}-01`);
    assert.equal(detail.premium_varies_by_csr, false);
    for (const suffix of ['04', '05', '06']) {
      const id = `${plan.base}-${suffix}`, expected = plan.variants[id];
      const selectedResponse = await app.request(`/v1/plans/${plan.base}?year=2026&csr_variant=${suffix}`);
      const selected = (await selectedResponse.json()).cost_sharing;
      assert.equal(selectedResponse.status, 200); assert.equal(selected.selected_variant_id, id);
      report.variants_compared++;
      if (!expected) {
        report.missing_variants++;
        compare({ status: selected.status, deductibles: selected.deductibles, moop: selected.moop, benefits: selected.benefits },
          { status: 'unknown', deductibles: {}, moop: {}, benefits: [] }, plan.base, 'missing_variant_unknown');
        continue;
      }
      assert.equal(selected.status, 'available');
      const variant = detail.variants.find(v => v.variant_plan_id === id);
      assert.ok(variant, id);
      compare(variant.csr_variation_type, expected.csr_variation_type, plan.base, 'CSRVariationType');
      compare(variant.source_row, expected.source_row, plan.base, 'attribute_source_row');
      for (const field of fields) {
        compare(variant[field], expected[field], id, `detail_${field}`);
        compare(selected[field], expected[field], id, `selected_${field}`);
      }
      report.amount_cells_compared += Object.keys(expected.deductibles).length + Object.keys(expected.moop).length;
      const project = rows => rows.map(({ published_plan_id, benefit_name, cost_sharing_raw, cost_sharing_parsed, raw, source_row }) =>
        ({ published_plan_id, benefit_name, cost_sharing_raw, cost_sharing_parsed, raw, source_row }));
      compare(project(variant.benefits), expected.benefits, id, 'detail_benefits');
      compare(project(selected.benefits), expected.benefits, id, 'selected_benefits');
      report.benefit_rows_compared += expected.benefits.length;
      if (!example && suffix === '06' && plan.variants[`${plan.base}-01`]) example = plan;
    }
    if (report.silver_plans % 50 === 0) console.log(`CSR oracle: ${report.silver_plans} silver plans checked`);
  }
  compare(actualBases, expectedBases, 'TX', 'silver_base_set');
  assert.equal(report.silver_plans, raw.silver_plans); assert.ok(report.variants_compared > 0);
  assert.ok(example, 'Need real standard and CSR94 variants for missing-evidence control');
  const marker = new Error('rollback synthetic missing variant');
  try {
    await db.transaction(async tx => {
      await tx.query('DELETE FROM plan_variant WHERE snapshot_id=$1 AND variant_plan_id=$2', [attributes, `${example.base}-06`]);
      const response = await createApp(tx).request(`/v1/plans/${example.base}?year=2026&csr_variant=csr94`);
      const result = (await response.json()).cost_sharing;
      const unknown = value => { assert.equal(value.status, 'unknown'); assert.deepEqual(value.deductibles, {}); assert.deepEqual(value.moop, {}); assert.deepEqual(value.benefits, []); };
      unknown(result);
      let detected = false; try { unknown({ ...result, status: 'available', deductibles: example.variants[`${example.base}-01`].deductibles }); } catch { detected = true; }
      report.negative_controls.push({ name: 'missing_variant_never_borrows_standard_values', passed: detected, plan: example.base,
        scope: 'rolled-back variant deletion; orphan benefits remain; copied fallback response rejected' });
      throw marker;
    });
  } catch (error) { if (error !== marker) throw error; }
  // Mutate a compiled validator copy, leaving source and actual catalog evidence untouched.
  const path = new URL('../../dist/api/validation.js', import.meta.url), source = await readFile(path, 'utf8');
  const needle = 'const csr = csrVariant(body.csr_variant);'; assert.equal(source.split(needle).length, 2);
  const absoluteImports = source.replace(/from '(\.\.?\/[^']+)'/g, (_, relative) => `from '${new URL(relative, path).href}'`);
  const mutantPath = join(scratch, 'income-mutant.mjs');
  await writeFile(mutantPath, absoluteImports.replace(needle, "const csr = csrVariant(body.csr_variant ?? (typeof body.household_income_annual === 'number' ? 'csr94' : undefined));"));
  const mutant = (await import(pathToFileURL(mutantPath).href)).premiumRequest;
  const noInference = parser => {
    for (const income of [0, 15650, 31300, 100000]) {
      const request = parser({ plan_ids: [example.base], county: '48201', coverage_start: '2026-01-01',
        members: [{ age: 35, tobacco: false, relationship: 'subscriber' }], household_income_annual: income, household_size: 1, tax_filing: 'single' });
      assert.equal(selectedVariant(example.base, request.csrVariant), `${example.base}-01`);
    }
  };
  noInference(premiumRequest);
  let detected = false; try { noInference(mutant); } catch { detected = true; }
  report.negative_controls.push({ name: 'income_to_variant_source_mutant', passed: detected, scope: 'temporary compiled validator; same no-inference assertion' });
  assert.ok(report.negative_controls.every(c => c.passed), 'Negative control failed');
  assert.equal(report.mismatches.length, 0, 'Independent raw CSV mismatches');
} catch (error) { report.failures.push(error.stack ?? String(error)); }
finally {
  await db?.close(); report.passed = report.failures.length === 0 && report.mismatches.length === 0;
  await writeFile(join(reports, 'p5f-csr.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(join(reports, 'p5f-csr.md'), `# P5f CSR — ${report.passed ? 'PASS' : 'FAIL'}\n\nGenerated ${report.generated_at}. TX PY2026.\n\n` +
    `Silver base plans: ${report.silver_plans}; requested -04/-05/-06 variants: ${report.variants_compared}; absent variants reported unknown: ${report.missing_variants}. ` +
    `Benefit rows compared: ${report.benefit_rows_compared}; deductible/MOOP cells compared: ${report.amount_cells_compared}; mismatches: ${report.mismatches.length}.\n\n` +
    `Every silver base in the raw Plan Attributes CSV is compared with the ACTIVE native HTTP catalog, including the available variant set and every -04/-05/-06 raw attribute accumulator and benefit row. ` +
    `Python csv/Decimal independently parses immutable archive hashes, physical source row numbers, exact-dollar values and publisher conditions; it does not import the application parser. Native detail enumeration and explicit CSR selection are both compared.\n\n` +
    `Rate PUF: ${report.rate_evidence?.rate_rows} TX rows; ${report.rate_evidence?.silver_rate_rows} silver rate rows; ${report.rate_evidence?.variant_rate_rows} variant IDs. ` +
    `All ${report.rate_evidence?.silver_bases_with_rates} silver bases have filed rates. Premiums attach to the base plan, so selecting a cost-sharing variant leaves the gross premium unchanged. ` +
    `Offline HTTP tests separately quote all seven real variants and both alias/suffix selections with identical gross cents. Eligibility is never inferred from income or tribal status.\n\n` +
    `## Negative controls\n\n${report.negative_controls.map(c => `- ${c.name}: ${c.passed ? 'PASS (defect detected)' : 'FAIL'}; ${c.scope}`).join('\n')}\n\n` +
    `## Sources\n\n${Object.entries(report.sources ?? {}).map(([kind, s]) => `- ${kind}: ${s.url}; SHA-256 ${s.sha256}`).join('\n')}\n\n` +
    `CMS data dictionary: https://www.cms.gov/files/document/planattributes-datadictionary-py26.pdf\n\n` +
    `## Failures\n\n${report.failures.length ? report.failures.join('\n') : 'None.'}\n`);
  await rm(scratch, { recursive: true, force: true });
}
console.log(`${report.passed ? 'PASS' : 'FAIL'}: CSR TX 2026 ${report.silver_plans} silver plans; ${report.variants_compared} variants; ${report.benefit_rows_compared} benefit rows; ${report.mismatches.length} mismatches; controls ${report.negative_controls.filter(c => c.passed).length}/${report.negative_controls.length}`);
if (!report.passed) process.exitCode = 1;
