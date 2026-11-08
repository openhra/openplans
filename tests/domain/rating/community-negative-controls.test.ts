import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { communityFamilyPremium } from '../../../src/domain/rating/index.js';
import { assertNyParent, assertNyUnsupported, nyRate, nyRule, parent, single } from './community-helpers.js';
import { syntheticRow } from './helpers.js';

it('negative control: wrong adult + children multiplier fails the identical hand-computed assertion', () => {
  // SYNTHETIC mutant fixture: calculate the parent tier using the couple multiplier.
  const wrongPrice = Math.round(nyRate.prices.single * nyRule.tiers.couple / nyRule.denominator) as typeof nyRate.prices.single;
  const mutant = { ...nyRate, prices: { ...nyRate.prices, adult_children: wrongPrice } };
  const result = communityFamilyPremium(nyRule, mutant, parent, '2026-01-01');
  expect(result.status).toBe('rated');
  expect(result.totalCents).toBe(254_196);
  expect(() => assertNyParent(result)).toThrow(/216067/);
});

it('negative control: compiled source mutant applying the federal per-age rows to NY fails the guard assertion', () => {
  const directory = mkdtempSync(join(tmpdir(), 'openplans-ny-mutant-'));
  try {
    writeFileSync(join(directory, 'package.json'), '{"type":"module"}\n');
    for (const name of ['types', 'rate-row', 'household']) {
      let source = readFileSync(new URL(`../../../src/domain/rating/${name}.ts`, import.meta.url), 'utf8');
      if (name === 'rate-row') {
        const needle = "['NY', 'VT'].includes(row.stateCode) || ";
        expect(source.split(needle)).toHaveLength(2);
        source = source.replace(needle, '');
      }
      writeFileSync(join(directory, `${name}.js`), ts.transpileModule(source, { compilerOptions: {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022,
      } }).outputText);
    }
    writeFileSync(join(directory, 'run.mjs'), `
import { readFileSync } from 'node:fs';
import { householdPremium } from './household.js';
const input = JSON.parse(readFileSync(0,'utf8'));
process.stdout.write(JSON.stringify(householdPremium(input.rows,input.plan,input.area,input.household)));
`);
    // SYNTHETIC NY-labelled federal row. It must be rejected even with numeric prices.
    const row = syntheticRow({ StateCode: 'NY' });
    const child = spawnSync(process.execPath, [join(directory, 'run.mjs')], {
      input: JSON.stringify({ rows: [row], plan: row.planId, area: row.ratingAreaId,
        household: { ratingMethod: 'per_member', coverageStartDate: '2026-01-01', members: single.map(m => ({ ...m, age: 35 })) } }),
      encoding: 'utf8', timeout: 10_000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    const mutant = JSON.parse(child.stdout);
    expect(mutant.status).toBe('rated');
    expect(() => assertNyUnsupported(mutant)).toThrow(/unsupported_rating_method/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it('negative control: compiled family = 2.85 times rounded single mutant fails MetroPlus filed-cell equality', async () => {
  const { publishedRate, family } = await import('./community-helpers.js');
  const directory = mkdtempSync(join(tmpdir(), 'openplans-family-cell-mutant-'));
  try {
    writeFileSync(join(directory, 'package.json'), '{"type":"module"}\n');
    for (const name of ['types', 'rate-row', 'household', 'community-family']) {
      let source = readFileSync(new URL(`../../../src/domain/rating/${name}.ts`, import.meta.url), 'utf8');
      if (name === 'community-family') {
        const needle = 'const price = rate.prices[tier];';
        expect(source.split(needle)).toHaveLength(2);
        source = source.replace(needle, 'const price = Math.round(rate.prices.single * rule.tiers[tier] / rule.denominator);');
      }
      writeFileSync(join(directory, `${name}.js`), ts.transpileModule(source, { compilerOptions: {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022,
      } }).outputText);
    }
    writeFileSync(join(directory, 'run.mjs'), `
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { communityFamilyPremium } from './community-family.js';
const { rule, rate, members } = JSON.parse(readFileSync(0,'utf8'));
const result = communityFamilyPremium(rule,rate,members,'2026-01-01');
assert.equal(result.status,'rated');
assert.equal(result.totalCents,223584,'MetroPlus approved family cell');
`);
    const bronze = publishedRate('NY', '11177NY0010001');
    expect(communityFamilyPremium(nyRule, bronze, family, '2026-01-01')).toMatchObject({ status: 'rated', totalCents: 223584 });
    const mutant = spawnSync(process.execPath, [join(directory, 'run.mjs')], {
      input: JSON.stringify({ rule: nyRule, rate: bronze, members: family }), encoding: 'utf8', timeout: 10_000,
    });
    expect(mutant.error).toBeUndefined();
    expect(mutant.status).not.toBe(0);
    expect(mutant.stderr).toContain('MetroPlus approved family cell');
    expect(mutant.stderr).toContain('223585');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
