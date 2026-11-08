// Run after building/installing dev dependencies. Mutates a temporary source tree, never real sources.
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const temporary=await mkdtemp(join(tmpdir(),'openplans-geonames-first-mutant-'));
try {
  for (const name of ['src','tests']) await cp(join(root,name),join(temporary,name),{recursive:true});
  for (const name of ['package.json','tsconfig.json','vitest.config.ts']) await cp(join(root,name),join(temporary,name));
  for (const name of ['node_modules','migrations','data']) await symlink(join(root,name),join(temporary,name));
  const path=join(temporary,'src/ingest/geo/repository.ts');
  const source=await readFile(path,'utf8'), marker='// This early return is the hard source boundary:';
  if(!source.includes(marker)) throw new Error('Mutation site changed');
  await writeFile(path,source.replace(marker,`const mutant = await fallbackCounties(db,zip,'geonames');
      if (mutant.length) return { zip,status:'available',geography:'postal_zip',source:'geonames',counties:mutant };
      ${marker}`));
  const result=spawnSync(process.execPath,[join(root,'node_modules/vitest/vitest.mjs'),'run','tests/ingest/geo/fallback.test.ts','-t','never reads a fallback row'],
    {cwd:temporary,encoding:'utf8',env:{...process.env,CMS_API_KEY:''}});
  const output=result.stdout+result.stderr;
  if(result.status===0 || !output.includes('ZCTA consulted fallback')) throw new Error('GeoNames-first mutant did not fail the intended test: '+output);
  console.log('PASS negative control: GeoNames-before-ZCTA mutant rejected by the no-fallback-read test');
} finally { await rm(temporary,{recursive:true,force:true}); }
