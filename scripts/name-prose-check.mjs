#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = 'open' + 'plans';
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: packageRoot, encoding: 'utf8' }).trim();
const pathspec = packageRoot === gitRoot ? '.' : project;
const diff = execFileSync('git', ['diff', '--no-ext-diff', '--unified=0', 'HEAD', '--', pathspec], { cwd: gitRoot, encoding: 'utf8' });
let file = '(unknown file)';
const changed = [];
for (const line of diff.split('\n')) {
  if (line.startsWith('+++ b/')) file = line.slice(6);
  if ((line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---') && line.toLowerCase().includes(project)) {
    changed.push({ file, line });
  }
}

console.log(`Changed lines containing ${project}:`);
for (const item of changed) console.log(`${item.file}: ${item.line}`);

const tokenPattern = new RegExp([
  'OPEN' + project.toUpperCase().slice(4) + '_[A-Z0-9_]+',
  'x-' + project + '-gaps',
  project + '(?:[/:-][A-Za-z0-9_./-]+|:)',
  '`' + project + '`',
  '"name"\\s*:\\s*"' + project + '"',
  '\\.' + project + '\\b',
].join('|'), 'gi');
const before = changed.filter(({ line }) => line.startsWith('-')).flatMap(({ line }) => line.match(tokenPattern) ?? []).sort();
const after = changed.filter(({ line }) => line.startsWith('+')).flatMap(({ line }) => line.match(tokenPattern) ?? []).sort();
if (JSON.stringify(before) !== JSON.stringify(after)) {
  console.error('FAIL: technical identifier tokens differ across changed lines.');
  process.exitCode = 1;
} else {
  console.log('PASS: technical identifier tokens are unchanged.');
}
