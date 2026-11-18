import { appendFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

// Every run starts with this job. It decides whether the run tests the commit itself or
// relies on an earlier passing run of the same commit (see findSameCommitRun).
export const sameCommitJob = {
  dedupe: "OpenPlans / same-commit check",
};

export const requiredJobs = {
  linux: "OpenPlans / Linux",
  docker: "OpenPlans / Docker Linux",
  postgis: "OpenPlans / PostGIS",
};

// macOS cancellation is advisory, but test failures still fail the required aggregate.
// The summary job reports its result and stays in the same-commit proof.
export const advisoryJobs = {
  macos: "OpenPlans / macOS",
};

export const aggregateJob = "OpenPlans / required";

// The macOS checks run as a matrix of test shards. GitHub reports a matrix job's result in
// `needs` as one value, which is success only when every shard succeeded.
export const macosShardJobs = {
  "macos-shard": "OpenPlans / macOS shards",
};

export const jobGroups = {
  required: { ...requiredJobs, macos: advisoryJobs.macos },
  macos: macosShardJobs,
};

const runUrl = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/;

export function checkRequired(results, jobs = jobGroups.required) {
  const expected = [...Object.keys(sameCommitJob), ...Object.keys(jobs)];
  if (
    !results ||
    Array.isArray(results) ||
    typeof results !== "object" ||
    Object.keys(results).sort().join(",") !== expected.sort().join(",")
  ) {
    throw new Error("Required job results are missing or unexpected");
  }
  const proof = results.dedupe;
  if (proof?.result !== "success")
    throw new Error(`${sameCommitJob.dedupe} did not succeed`);
  const full = proof.outputs?.full;
  if (full === "true") {
    if (jobs === macosShardJobs) {
      const shardResult = results["macos-shard"]?.result;
      if (["cancelled", "skipped"].includes(shardResult)) {
        const note = `macOS shards were ${shardResult}; advisory checks were unavailable.\n`;
        if (process.env.GITHUB_STEP_SUMMARY)
          appendFileSync(process.env.GITHUB_STEP_SUMMARY, note);
        console.log(note.trim());
        return "advisory-unavailable";
      }
      if (shardResult !== "success")
        throw new Error(`${macosShardJobs["macos-shard"]} did not succeed`);
      const note = "macOS shards passed.\n";
      if (process.env.GITHUB_STEP_SUMMARY)
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, note);
      console.log(note.trim());
      return "macos";
    }
    for (const [id, name] of Object.entries(jobs)) {
      const result = results[id]?.result;
      if (id === "macos" && ["cancelled", "skipped"].includes(result)) continue;
      if (result !== "success") throw new Error(`${name} did not succeed`);
    }
    const macosResult = results.macos.result;
    const macosNote = ["cancelled", "skipped"].includes(macosResult)
      ? `macOS checks were ${macosResult}; advisory checks were unavailable.\n`
      : "macOS checks passed.\n";
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, macosNote);
    console.log(macosNote.trim());
    return "full";
  }
  if (full === "false") {
    // The checks were skipped only because a passing run of this commit already exists.
    if (!runUrl.test(proof.outputs?.source_run ?? ""))
      throw new Error("Skipped checks need the URL of a passing run");
    for (const [id, name] of Object.entries(jobs)) {
      if (results[id]?.result !== "skipped")
        throw new Error(`${name} ran or failed in a same-commit run`);
    }
    return "same-commit";
  }
  throw new Error(`${sameCommitJob.dedupe} gave no decision`);
}

// Only a push to main repeats a commit: main fast-forwards to a develop commit, and a release
// pushes develop and main together. Every other event and ref runs the full checks.
export function runDecision(env) {
  return env.GITHUB_EVENT_NAME === "push" &&
    env.GITHUB_REF === "refs/heads/main"
    ? "look"
    : "full";
}

// The develop run must be a full, passing push run of ci.yml for exactly this commit.
export function checkSourceRun(run, jobs, sha) {
  if (
    run?.head_sha !== sha ||
    run.head_branch !== "develop" ||
    run.event !== "push" ||
    run.path !== ".github/workflows/ci.yml" ||
    !runUrl.test(run.html_url ?? "")
  )
    throw new Error("The develop run is not a push run of this commit");
  if (
    run.status !== "completed" ||
    !["success", "failure"].includes(run.conclusion)
  )
    throw new Error(
      `The develop run of this commit did not finish: ${run.html_url}`,
    );
  for (const name of [
    sameCommitJob.dedupe,
    ...Object.values(requiredJobs),
    advisoryJobs.macos,
    aggregateJob,
  ]) {
    const matching = (Array.isArray(jobs) ? jobs : []).filter(
      (job) => job?.name === name,
    );
    if (
      matching.length !== 1 ||
      matching[0].head_sha !== sha ||
      matching[0].status !== "completed" ||
      matching[0].conclusion !== "success"
    )
      throw new Error(`The develop run has no passing ${name} job`);
  }
  return run.html_url;
}

export const sameCommitTiming = {
  // A release pushes develop and main at once; give the develop run time to appear.
  appearSeconds: 180,
  // Below the job's 60-minute limit, above the longest check job's 45 minutes.
  waitSeconds: 3300,
  pollSeconds: 30,
};

export async function findSameCommitRun({
  env,
  get,
  sleep,
  now,
  timing = sameCommitTiming,
}) {
  if (runDecision(env) === "full") return { full: "true", source_run: "" };
  const sha = env.GITHUB_SHA ?? "";
  const repository = env.GITHUB_REPOSITORY ?? "";
  if (!/^[0-9a-f]{40}$/.test(sha) || !/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new Error("GITHUB_SHA or GITHUB_REPOSITORY is missing");
  const start = now();
  for (;;) {
    const page = await get(
      `repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${sha}&branch=develop&event=push&per_page=100`,
    );
    const runs = (page?.workflow_runs ?? []).filter(
      (run) =>
        run.head_sha === sha &&
        run.head_branch === "develop" &&
        run.event === "push",
    );
    const elapsed = (now() - start) / 1000;
    if (runs.length === 0) {
      // No develop push of this commit: main tests it itself.
      if (elapsed >= timing.appearSeconds)
        return { full: "true", source_run: "" };
    } else {
      const latest = runs.reduce((a, b) =>
        Number(b.id) > Number(a.id) ? b : a,
      );
      if (latest.status === "completed") {
        const jobs = await get(
          `repos/${repository}/actions/runs/${Number(latest.id)}/attempts/${Number(latest.run_attempt)}/jobs?per_page=100`,
        );
        return {
          full: "false",
          source_run: checkSourceRun(latest, jobs?.jobs, sha),
        };
      }
      if (elapsed >= timing.waitSeconds)
        throw new Error(
          `The develop run of this commit did not finish in time: ${latest.html_url}`,
        );
    }
    await sleep(timing.pollSeconds);
  }
}

async function githubGet(endpoint) {
  const api = process.env.GITHUB_API_URL ?? "https://api.github.com";
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(`${api}/${endpoint}`, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${process.env.GH_TOKEN ?? ""}`,
          "x-github-api-version": "2022-11-28",
        },
      });
      if (!response.ok) throw new Error(`GitHub API ${response.status}`);
      return await response.json();
    } catch (error) {
      if (attempt >= 3) throw error;
      await delay(10_000);
    }
  }
}

async function sameCommitCommand() {
  const result = await findSameCommitRun({
    env: process.env,
    get: githubGet,
    sleep: (seconds) => delay(seconds * 1000),
    now: Date.now,
  });
  const lines = `full=${result.full}\nsource_run=${result.source_run}\n`;
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, lines);
  const note =
    result.full === "true"
      ? "This run tests the commit itself.\n"
      : `This commit already passed in ${result.source_run}; the checks are skipped here.\n`;
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, note);
  console.log(note.trim());
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const group = process.argv[2] ?? "required";
    if (group === "same-commit") {
      await sameCommitCommand();
    } else {
      if (!Object.hasOwn(jobGroups, group))
        throw new Error(`unknown job group ${group}`);
      checkRequired(
        JSON.parse(process.env.NEEDS_RESULTS ?? "null"),
        jobGroups[group],
      );
      console.log("required-jobs: PASS");
    }
  } catch (error) {
    console.error(`required-jobs: FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}
