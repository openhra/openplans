#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve, sep } from 'node:path';
import { parameterErrors } from '../../dist/domain/subsidy/parameters.js';
import { generatedFile, readParameterFiles, registrySource } from './registry.mjs';
try {
  // Optional directory is useful for quarantine and negative controls; canonical files also check registry freshness.
  const directory = process.argv[2] ? pathToFileURL(resolve(process.argv[2]) + sep) : undefined;
  const files = await readParameterFiles(directory);
  const errors = files.flatMap(({ name, value }) => [
    ...parameterErrors(value).map(error => `${name}: ${error}`),
    ...(value?.year?.value !== Number(name.slice(0, 4)) ? [`${name}: filename/year mismatch`] : []),
  ]);
  if (!directory && await readFile(generatedFile, 'utf8') !== registrySource(files)) errors.push('generated.ts is stale; run node scripts/subsidy/build.mjs');
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(`subsidy parameters: PASS (${files.map(({ name, value }) => `${name}: ${value.status}`).join(', ')})`);
} catch (error) {
  console.error(`subsidy parameters: FAIL: ${error instanceof Error ? error.message : 'invalid parameter data'}`);
  process.exitCode = 1;
}
