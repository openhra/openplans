import { pathToFileURL } from 'node:url';

export const requiredJobs = {
  linux: 'OpenPlans / Linux',
  macos: 'OpenPlans / macOS',
  docker: 'OpenPlans / Docker Linux',
};

export function checkRequired(results) {
  if (!results || Array.isArray(results) || typeof results !== 'object'
    || Object.keys(results).sort().join(',') !== Object.keys(requiredJobs).sort().join(',')) {
    throw new Error('Required job results are missing or unexpected');
  }
  for (const [id, name] of Object.entries(requiredJobs)) {
    if (results[id]?.result !== 'success') throw new Error(`${name} did not succeed`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    checkRequired(JSON.parse(process.env.NEEDS_RESULTS ?? 'null'));
    console.log('required-jobs: PASS');
  } catch (error) {
    console.error(`required-jobs: FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}
