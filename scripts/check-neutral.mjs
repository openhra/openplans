#!/usr/bin/env node
/** Audit current tracked bytes, including archived plans and lane briefs. */
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDenylist, matchesDenylist } from './denylist.mjs';

const root = resolve(process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)));
const forbidden = await loadDenylist();
if (!forbidden) {
  console.log('neutrality: SKIP (no denylist)');
  process.exit(0);
}
async function standaloneFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'dist', 'coverage', '.claude-plan'].includes(entry.name)
      || (entry.name.startsWith('.env') && entry.name !== '.env.example')) continue;
    const file = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await standaloneFiles(join(directory, entry.name), file));
    else if (entry.isFile()) files.push(file);
  }
  return files;
}
let files;
try {
  files = execFileSync('git', ['ls-files', '-z', '--', '.'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).split('\0').filter(Boolean);
} catch {
  // Release tarballs have no Git index. Audit their source files directly.
  files = await standaloneFiles(root);
}
let failed = false;
for (const file of files) {
  let content;
  try { content = await readFile(resolve(root, file), 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') continue; // Tracked deletions have no bytes to publish.
    throw error;
  }
  if (!matchesDenylist(`${file}\n${content}`, forbidden)) continue;
  let reported = false;
  for (const [index, line] of content.split('\n').entries()) {
    if (!matchesDenylist(line, forbidden)) continue;
    console.error(`${file}:${index + 1}: forbidden reference name`);
    reported = true;
  }
  // Filenames and multiline literal encodings may have no individual matching line.
  if (!reported) console.error(`${file}:1: forbidden reference name`);
  failed = true;
}
if (failed) {
  console.error('neutrality: FAIL');
  process.exitCode = 1;
} else console.log('neutrality: PASS');
