import { pathToFileURL } from "node:url";

export const requiredJobs = {
  linux: "OpenPlans / Linux",
  macos: "OpenPlans / macOS",
  docker: "OpenPlans / Docker Linux",
};

// The macOS checks run as a matrix of test shards. GitHub reports a matrix job's result in
// `needs` as one value, which is success only when every shard succeeded.
export const macosShardJobs = {
  "macos-shard": "OpenPlans / macOS shards",
};

export const jobGroups = {
  required: requiredJobs,
  macos: macosShardJobs,
};

export function checkRequired(results, jobs = requiredJobs) {
  if (
    !results ||
    Array.isArray(results) ||
    typeof results !== "object" ||
    Object.keys(results).sort().join(",") !== Object.keys(jobs).sort().join(",")
  ) {
    throw new Error("Required job results are missing or unexpected");
  }
  for (const [id, name] of Object.entries(jobs)) {
    if (results[id]?.result !== "success")
      throw new Error(`${name} did not succeed`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const group = process.argv[2] ?? "required";
    if (!Object.hasOwn(jobGroups, group))
      throw new Error(`unknown job group ${group}`);
    checkRequired(
      JSON.parse(process.env.NEEDS_RESULTS ?? "null"),
      jobGroups[group],
    );
    console.log("required-jobs: PASS");
  } catch (error) {
    console.error(`required-jobs: FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}
