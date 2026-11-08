import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRequired, requiredJobs } from '../.github/check-required.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const workflow = JSON.parse(await readFile(join(root, '.github/workflows/ci.yml'), 'utf8'));
const installNpm = 'npm install --global "npm@$(cat .github/npm-version)" --no-audit --no-fund';
const verifyVersions = 'test "$(node --version)" = "v$(cat .node-version)"\ntest "$(npm --version)" = "$(cat .github/npm-version)"';
const retiredRunnerLabels = ['macos-13', 'macos-14'];

function commandContract(value) {
  expect(value.on).toEqual({ push: null, pull_request: null, workflow_dispatch: null });
  expect(value.permissions).toEqual({ contents: 'read' });
  expect(value.defaults).toEqual({ run: { shell: 'bash' } });
  expect(Object.keys(value.jobs).sort()).toEqual(['docker', 'linux', 'macos', 'required']);
  for (const [id, name] of Object.entries(requiredJobs)) {
    const job = value.jobs[id];
    expect(job.name).toBe(name);
    expect(job['runs-on']).toBe(id === 'macos' ? 'macos-15' : 'ubuntu-24.04');
    expect(retiredRunnerLabels).not.toContain(job['runs-on']);
    expect(job.if).toBeUndefined();
    expect(job.needs).toBeUndefined();
    expect(job.strategy).toBeUndefined();
  }
  for (const job of Object.values(value.jobs)) {
    expect(job['continue-on-error']).toBeUndefined();
    expect(job['working-directory']).toBeUndefined();
    expect(job.defaults).toBeUndefined();
    expect(job.steps[0].uses).toMatch(/^actions\/checkout@[a-f0-9]{40}$/);
    expect(job.steps[0].with).toEqual({ 'persist-credentials': false });
    for (const step of job.steps) {
      expect(step['continue-on-error']).toBeUndefined();
      expect(step['working-directory']).toBeUndefined();
      if (step.uses) expect(step.uses).toMatch(/^actions\/(checkout|setup-node)@[a-f0-9]{40}$/);
    }
  }
  for (const id of ['linux', 'macos']) {
    const steps = value.jobs[id].steps;
    expect(steps).toHaveLength(6);
    expect(steps[1].uses).toMatch(/^actions\/setup-node@[a-f0-9]{40}$/);
    expect(steps[1].with).toEqual({ 'node-version-file': '.node-version' });
    expect(steps.filter(step => step.run).map(step => step.run)).toEqual([
      installNpm, verifyVersions, 'npm ci --no-audit --no-fund', 'scripts/ci.sh',
    ]);
    expect(steps[5].env).toEqual({ npm_config_offline: 'true' });
    for (const step of steps) expect(step.if).toBeUndefined();
  }
  const docker = value.jobs.docker.steps;
  expect(docker).toHaveLength(4);
  expect(docker[1].run).toBe('docker build --pull --tag openplans-ci:${{ github.sha }} .');
  expect(docker[2].run).toBe('docker run --rm --network none openplans-ci:${{ github.sha }} node --check dist/api/server.js');
  for (const step of docker.slice(0, 3)) expect(step.if).toBeUndefined();
  expect(docker[3].if).toBe('${{ always() }}');
  const required = value.jobs.required;
  expect(required.name).toBe('OpenPlans / required');
  expect(required.if).toBe('${{ always() }}');
  expect(required.needs).toEqual(Object.keys(requiredJobs));
  expect(required.steps).toHaveLength(3);
  expect(required.steps[1].with).toEqual({ 'node-version-file': '.node-version' });
  expect(required.steps[2].run).toBe('node .github/check-required.mjs');
  expect(required.steps[2].env).toEqual({ NEEDS_RESULTS: '${{ toJSON(needs) }}' });
  for (const step of required.steps) expect(step.if).toBeUndefined();
}

it('runs clean extracted-root checks on both platforms and builds the Linux artifact', () => {
  commandContract(workflow);
});

it.each(retiredRunnerLabels)('negative control: rejects retired runner label %s', label => {
  const copy = structuredClone(workflow);
  copy.jobs.macos['runs-on'] = label;
  expect(() => commandContract(copy)).toThrow();
});

it('pins the same Node and npm versions for project and Docker checks', async () => {
  const node = (await readFile(join(root, '.node-version'), 'utf8')).trim();
  const npm = (await readFile(join(root, '.github/npm-version'), 'utf8')).trim();
  expect(node).toBe('22.23.4');
  expect(npm).toBe('10.9.10');
  const docker = await readFile(join(root, 'Dockerfile'), 'utf8');
  expect(docker.match(/^FROM .+$/gm)).toEqual([
    `FROM node:${node} AS build`, `FROM node:${node}-slim AS runtime`,
  ]);
  expect(docker).toContain('COPY .github/npm-version .github/npm-version');
  expect(docker).toContain(installNpm);
  const ci = await readFile(join(root, 'scripts/ci.sh'), 'utf8');
  expect(ci).toContain('export npm_config_offline=true');
});

it.each([
  ['missing platform', copy => { delete copy.jobs.macos; }],
  ['skipped platform', copy => { copy.jobs.linux.if = '${{ false }}'; }],
  ['skipped project command', copy => { copy.jobs.macos.steps[5].if = '${{ false }}'; }],
  ['ignored failure', copy => { copy.jobs.docker['continue-on-error'] = true; }],
  ['unlocked install', copy => { copy.jobs.linux.steps[4].run = 'npm install'; }],
  ['missing prerequisite', copy => { copy.jobs.required.needs.pop(); }],
  ['success-only aggregate', copy => { delete copy.jobs.required.if; }],
  ['parent working directory', copy => { copy.jobs.linux.steps[5]['working-directory'] = 'source-package'; }],
  ['filtered workflow', copy => { copy.on.push = { paths: ['src/**'] }; }],
])('negative control: rejects %s', (_name, mutate) => {
  const copy = structuredClone(workflow);
  mutate(copy);
  expect(() => commandContract(copy)).toThrow();
});

const successful = () => Object.fromEntries(Object.keys(requiredJobs).map(id => [id, { result: 'success', outputs: {} }]));
it('accepts only a complete successful set of required job results', () => {
  expect(() => checkRequired(successful())).not.toThrow();
  for (const id of Object.keys(requiredJobs)) {
    for (const status of ['skipped', 'failure', 'cancelled', 'pending', undefined]) {
      const result = successful();
      result[id].result = status;
      expect(() => checkRequired(result)).toThrow(`${requiredJobs[id]} did not succeed`);
    }
    const missing = successful();
    delete missing[id];
    expect(() => checkRequired(missing)).toThrow('missing or unexpected');
  }
  for (const value of [null, [], {}, { ...successful(), extra: { result: 'success' } }]) {
    expect(() => checkRequired(value)).toThrow('missing or unexpected');
  }
});

it.each([
  [JSON.stringify(successful()), 0],
  [JSON.stringify({ ...successful(), macos: { result: 'skipped' } }), 1],
  ['{', 1],
  ['', 1],
])('the required-results command exits according to its actual input', (input, code) => {
  const result = spawnSync(process.execPath, ['.github/check-required.mjs'], {
    cwd: root, env: { ...process.env, NEEDS_RESULTS: input }, encoding: 'utf8',
  });
  expect(result.status).toBe(code);
  expect(result.stdout.includes('required-jobs: PASS')).toBe(code === 0);
});

it('negative control: a fresh offline npm ci rejects a mismatched lock even with installed modules', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openplans-ci-lock-'));
  try {
    for (const name of ['one', 'two']) {
      await mkdir(join(directory, name));
      await writeFile(join(directory, name, 'package.json'), JSON.stringify({ name: 'synthetic-ci-dependency', version: '1.0.0' }));
    }
    const manifest = { name: 'synthetic-ci-lock', version: '1.0.0', dependencies: { 'synthetic-ci-dependency': 'file:./one' } };
    await writeFile(join(directory, 'package.json'), JSON.stringify(manifest));
    const npm = (command, extra = []) => spawnSync('npm', [command, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', ...extra], {
      cwd: directory, encoding: 'utf8', env: { ...process.env, npm_config_cache: join(directory, 'cache') },
    });
    expect(npm('install', ['--package-lock-only']).status).toBe(0);
    expect(npm('ci').status).toBe(0);
    manifest.dependencies['synthetic-ci-dependency'] = 'file:./two';
    await writeFile(join(directory, 'package.json'), JSON.stringify(manifest));
    const rejected = npm('ci');
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain('EUSAGE');
    expect(rejected.stderr).toContain('Missing: synthetic-ci-dependency');
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 15_000);
