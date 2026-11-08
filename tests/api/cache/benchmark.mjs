// Opt-in HTTP measurement only. Run against a disposable copied catalog, never CI.
// Synthetic household inputs; all response evidence comes from the copied public data.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
const base = new URL(process.env.OPENPLANS_BENCH_BASE_URL ?? 'http://127.0.0.1:30481');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'Benchmark must use a loopback API');
const data = process.env.OPENPLANS_DATA_DIR;
assert.ok(data && isAbsolute(data), 'Set an absolute external OPENPLANS_DATA_DIR');
const label = process.argv[2], selected = process.argv[3];
assert.match(label ?? '', /^[a-z0-9-]+$/);
const applicants = [40, 38, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8].map((age, i) => ({ age, smoker: false, child: i >= 2 }));
const cases = [
  { name: 'provider-radius', path: '/v1/providers?zip=77030&radius_miles=5' },
  { name: 'provider-plan-radius', path: '/v1/providers?plan_id=76589TX0010015&year=2026&zip=77030&radius_miles=5' },
  { name: 'provider-name', path: '/v1/providers?plan_id=76589TX0010015&year=2026&name=Smith' },
  { name: 'plan-search-12-applicants', path: '/compat/v1/plans/medical/search', body: {
    fips_code: '48201', zip_code: '77002', enrollment_date: '2026-01-01', per_page: 10, applicants,
  } },
];
const results = [];
for (const item of cases.filter(item => !selected || item.name === selected)) {
  const runs = [];
  for (let i = 0; i < 4; i++) {
    const start = performance.now();
    const response = await fetch(new URL(item.path, base), { method: item.body ? 'POST' : 'GET',
      headers: item.body ? { 'Content-Type': 'application/json', 'X-Api-Key': process.env.OPENPLANS_COMPAT_API_KEY ?? '' } : {},
      body: item.body ? JSON.stringify(item.body) : undefined, signal: AbortSignal.timeout(180_000) });
    const text = await response.text(), json = JSON.parse(text);
    runs.push({ status: response.status, ms: Math.round((performance.now() - start) * 100) / 100, cache: response.headers.get('X-Cache'),
      bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex'),
      total: json.total ?? json.meta?.total, returned: json.providers?.length ?? json.plans?.length });
  }
  assert.equal(new Set(runs.filter(run => run.status === 200).map(run => run.sha256)).size <= 1, true, `${item.name} response changed between runs`);
  results.push({ name: item.name, runs });
}
assert.ok(results.length, 'Unknown benchmark case');
await mkdir(join(data, 'work/p10a'), { recursive: true });
await writeFile(join(data, `work/p10a/${label}${selected ? '-' + selected : ''}.json`), JSON.stringify({ label,
  note: 'First request after operator-managed restart; subsequent requests warm. OS page cache is not evicted.',
  measured_at: new Date().toISOString(), synthetic_household: true, results }, null, 2) + '\n');
for (const result of results) console.log(result.name, result.runs.map(run => `${run.ms}ms/${run.status}/${run.cache}`).join(', '));
