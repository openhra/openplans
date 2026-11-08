#!/usr/bin/env node
// Opt-in assertions for scripts/smoke.sh; no Docker/network work during offline CI.
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

const mode = process.argv[2];
const directory = process.env.OPENPLANS_SMOKE_REPORT_DIR;
const json = async name => JSON.parse(await readFile(join(directory, `${name}.json`), 'utf8'));
const base = `http://127.0.0.1:${process.env.API_PORT}`;
const request = { plan_ids: ['87226TX0100013'], zip: '77002', coverage_start: '2026-01-01',
  members: [{ age: 35, tobacco: false, relationship: 'subscriber' }] };
const premium = headers => fetch(`${base}/v1/premium-estimates`, { method: 'POST',
  headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(request) });
const responseJson = async path => {
  const response = await fetch(`${base}${path}`);
  assert.equal(response.status, 200, path);
  return response.json();
};

switch (mode) {
  case 'cache': {
    const cache = process.env.OPENPLANS_DATA_DIR;
    assert.ok(cache && isAbsolute(cache), 'OPENPLANS_DATA_DIR must be absolute');
    for (const source of ['cms-exchange-puf', 'census-zcta-county-2020', 'census-zcta-gazetteer-2021', 'cms-rating-areas',
      'nlm-rxnorm-files', 'nlm-rxnorm-prescribe', 'cms-nppes-page', 'cms-nppes',
      'qhp-76589-2026-index', 'qhp-76589-2026-plan_urls', 'qhp-76589-2026-formulary_urls',
      'qhp-76589-2026-provider_urls', 'census-geocoder-batch']) {
      const names = await readdir(join(cache, 'raw', source));
      assert.ok(names.some(name => name.endsWith('.meta.json')), `Missing cached ${source}`);
      if (source === 'cms-exchange-puf') assert.ok(names.some(name => /^manifest-.*\.json$/.test(name)), 'Missing acquired PUF manifest');
    }
    if (process.env.OPENPLANS_SMOKE_VERIFY_WRITES === '1') {
      for (const name of ['reports','work']) {
        const probe = await mkdtemp(join(cache,name,'.h2-write-'));
        try { await writeFile(join(probe,'probe'),'smoke write probe'); }
        finally { await rm(probe,{recursive:true,force:true}); }
      }
      console.log('worker reports/work write probes: ok');
    }
    break;
  }
  case 'config': {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    const config = JSON.parse(input);
    for (const service of Object.values(config.services)) {
      assert.equal(service.platform, undefined, 'No emulated platform override');
      for (const port of service.ports ?? []) assert.equal(port.host_ip, '127.0.0.1');
    }
    assert.equal(config.services.api.image, 'openplans:local');
    assert.equal(config.services.worker.image, 'openplans:local');
    assert.equal(config.services.api.environment.OPENPLANS_API_TOKEN, '');
    const volumes = config.services.worker.volumes;
    assert.equal(volumes.find(volume => volume.target === '/data/raw')?.read_only ?? false, process.env.OPENPLANS_RAW_READ_ONLY !== 'false');
    assert.ok(volumes.some(volume => volume.target === '/data/reports' && !volume.read_only));
    assert.ok(volumes.some(volume => volume.target === '/data/work' && !volume.read_only));
    console.log('compose config: native platform; 127.0.0.1 ports; raw mount validated; reports writable');
    break;
  }
  case 'health': {
    assert.deepEqual(await responseJson('/healthz'), { status: 'ok', db: 'ok' });
    console.log('healthz: ok');
    break;
  }
  case 'empty': {
    assert.deepEqual(await json('status'), []);
    assert.deepEqual(await responseJson('/v1/data-availability'), []);
    assert.deepEqual((await json('migrate-repeat')).applied, []);
    console.log('worker status: []; repeat migration: no-op; availability: []');
    break;
  }
  case 'unconfigured-token': {
    const response = await premium({});
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'AUTH_NOT_CONFIGURED');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    console.log('negative control: unconfigured server token refused (503)');
    break;
  }
  case 'import': {
    const report = await json('puf');
    assert.equal(report.passed, true);
    assert.equal(report.status, 'ACTIVE');
    const expected = { 'plan-attributes': 4277, 'service-area': 1954, network: 44,
      'business-rules': 896, rate: 203592, 'benefits-and-cost-sharing': 285465 };
    for (const [kind, count] of Object.entries(expected)) {
      const file = report.files.find(file => file.kind === kind);
      assert.equal(file?.input_rows, count, kind);
      assert.equal(file?.stored_rows, count, kind);
      assert.equal(file?.rejected_rows, 0, kind);
    }
    assert.equal(report.identifiers.base_plans, 896);
    assert.equal(report.identifiers.variants, 4277);
    console.log('PUF counts: attributes=4277 service-area=1954 networks=44 rules=896 rates=203592 benefits=285465 base-plans=896 variants=4277');
    break;
  }
  case 'full': {
    const rx = await json('rxnorm'), rxMetrics = (await json('rxnorm-metrics')).row_counts;
    for (const [field,table] of [['concepts','rx_concept'],['relations','rx_relation'],['ndcs','rx_ndc']]) {
      assert.ok(rx[field]>0); assert.equal(rxMetrics[table],rx[field]);
    }
    const nppes = (await json('nppes')).at(-1), npiMetrics = (await json('nppes-metrics')).row_counts;
    for (const [field,table] of [['providers','npi_provider'],['taxonomies','npi_taxonomy'],['addresses','npi_address']]) {
      assert.ok(nppes[field]>0); assert.equal(npiMetrics[table],nppes[field]);
    }
    const providers = await json('qhp-providers'), providerMetrics = (await json('qhp-providers-metrics')).row_counts;
    assert.equal(providers.status,'ACTIVE');
    for (const [field,table] of [['records','qhp_provider_record'],['addresses','qhp_provider_address'],['edges','qhp_provider_plan']])
      assert.equal(providerMetrics[table],providers[field]);
    const formulary = await json('qhp-formulary');
    assert.equal(formulary.status,'ACTIVE');
    assert.equal((await json('qhp-formulary-metrics')).row_counts.formulary_edge,formulary.edges);
    const geocode = await json('geocode'), geoMetrics = (await json('geocode-metrics')).row_counts;
    assert.equal(geocode.requests,0); assert.equal(geocode.issues,0);
    assert.equal(geoMetrics.address_point,geocode.cache_replay.exact+geocode.cache_replay.nonExact+geocode.cache_replay.centroidFallbacks);
    assert.equal(geoMetrics.geocode_attempt,geocode.selected);
    assert.equal(geocode.reused,geocode.selected);
    const missing = await premium({});
    assert.equal(missing.status, 401);
    assert.equal((await missing.json()).error.code, 'UNAUTHORIZED');
    const wrong = await premium({ authorization: 'Bearer deliberately-wrong-smoke-token' });
    assert.equal(wrong.status, 401);
    const plans = await responseJson('/v1/plans?zip=77002&year=2026');
    assert.equal(plans.status, 'available');
    assert.equal(plans.total, 121);
    assert.equal(plans.location.county, '48201');
    assert.equal(plans.plans.length, 50);
    assert.equal(plans.next_page, 2);
    const ids = new Set(plans.plans.map(plan => plan.base_plan_id));
    for (let page = plans.next_page; page !== null;) {
      const next = await responseJson(`/v1/plans?zip=77002&year=2026&page=${page}`);
      assert.equal(next.total, plans.total);
      for (const plan of next.plans) { assert.ok(!ids.has(plan.base_plan_id)); ids.add(plan.base_plan_id); }
      page = next.next_page;
    }
    assert.equal(ids.size, plans.total);
    assert.ok(ids.has('87226TX0100013'));
    const response = await premium({ authorization: `Bearer ${process.env.OPENPLANS_API_TOKEN}` });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const result = await response.json();
    assert.equal(result.estimates.length, 1);
    const estimate = result.estimates[0];
    assert.equal(estimate.plan_id, '87226TX0100013');
    assert.equal(estimate.status, 'rated');
    assert.equal(estimate.total_cents, 52928);
    const drugsResponse = await fetch(`${base}/v1/drug-coverage`, {method:'POST',
      headers:{'content-type':'application/json'},body:JSON.stringify({plan_ids:['76589TX0010015'],rxcuis:['311354','860975','259255'],year:2026})});
    assert.equal(drugsResponse.status,200);
    const drugs = await drugsResponse.json();
    assert.equal(drugs.results.length,3);
    for (const r of drugs.results) {
      assert.equal(r.status,'listed_covered'); assert.equal(r.patient_price,null); assert.ok(r.evidence.length>0);
    }
    const availability = await responseJson('/v1/data-availability');
    assert.ok(Array.isArray(availability) && availability.length>0);
    assert.ok(availability.some(r=>r.state==='TX' && r.plan_year===2026 && r.issuer_id==='76589'
      && r.provider_status==='available' && r.formulary_status==='available'),'Cigna provider/formulary manifest is available');
    await writeFile(join(directory,'availability.json'),JSON.stringify(availability,null,2)+'\n');
    const report = { drugs, availability_rows:availability.length, plans: { zip: '77002', county: plans.location.county, total: plans.total, pages: 3 },
      premium: { plan_id: estimate.plan_id, age: 35, total_cents: estimate.total_cents,
        rating_area_id: estimate.rating_area_id, rate_rows_used: estimate.rate_rows_used,
        provenance: estimate.provenance },
      negative_controls: { missing_bearer: 401, incorrect_bearer: 401, unconfigured_server_token: 503 } };
    await writeFile(join(directory, 'api.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('API: ZIP 77002 = 121 plans across 3 pages; 87226TX0100013 age 35 = 52928 cents');
    console.log('negative controls: missing/incorrect bearer refused (401); configured bearer succeeds (200)');
    break;
  }
  case 'summary': {
    const times = Object.fromEntries((await readFile(join(directory, 'times.tsv'), 'utf8')).trim().split('\n').map(line => {
      const [key, value] = line.split('\t'); return [key, Number(value)];
    }));
    const size = Number((await readFile(join(directory, 'db-size.txt'), 'utf8')).trim());
    assert.ok(Number.isSafeInteger(size) && size > 0);
    const steps = [];
    for (const [step, seconds] of Object.entries(times)) {
      if (['startup','total_before_teardown'].includes(step)) continue;
      steps.push({step,seconds,...await json(`${step}-metrics`)});
    }
    const report = { steps, database: 'PostgreSQL 16 + PostGIS (Docker, native platform)', times_seconds: times,
      db_size_bytes: size, puf: await json('puf'), geo: await json('geo'), api: await json('api'),
      wrong_db_import: { refused: true, active_snapshots_unchanged: true },
      checks_passed: true, teardown_verified: false, passed: false };
    await writeFile(join(directory, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('| Step | Wall seconds | Rows (all measured tables) | DB MiB |');
    console.log('| --- | ---: | ---: | ---: |');
    for (const step of steps) console.log(`| ${step.step} | ${step.seconds} | ${Object.values(step.row_counts).reduce((a,b)=>a+b,0)} | ${(step.db_size_bytes/1024**2).toFixed(1)} |`);
    console.log(`times (wall seconds): ${JSON.stringify(times)}`);
    console.log(`DB size: ${size} bytes (${(size / 1024 ** 2).toFixed(1)} MiB)`);
    break;
  }
  case 'complete': {
    const report = await json('summary');
    report.teardown_verified = true;
    report.passed = report.checks_passed;
    await writeFile(join(directory, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
    break;
  }
  default: throw new Error('Unknown smoke assertion');
}
