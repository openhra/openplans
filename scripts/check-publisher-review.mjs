#!/usr/bin/env node
// Release check for the publisher manifests shipped in data/access/. Maintainers re-review every
// shipped host at each release. The check fails when any review or observation is older than the
// previous release, older than the policy's maximum age, or when a cleared host lacks its reviewer,
// quoted terms basis, robots evidence, pacing or caps. Policy: data/access/review-policy.json.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dayMs = 24 * 60 * 60 * 1000;
const minimumPacingMs = 5000;

/** Returns a list of problems; an empty list passes. Inputs are parsed JSON. */
export function reviewProblems(manifest, policy, now = new Date()) {
  const problems = [];
  const previous = Date.parse(policy?.previousRelease?.publishedAt ?? "");
  const maxAgeDays = policy?.maxAgeDays;
  if (!Number.isFinite(previous))
    problems.push("review policy needs previousRelease.publishedAt");
  if (!Number.isInteger(maxAgeDays) || maxAgeDays < 1)
    problems.push("review policy needs a positive integer maxAgeDays");
  if (manifest?.version !== 1 || !Array.isArray(manifest.publishers))
    return [...problems, "manifest is not a version 1 publisher manifest"];
  const oldest = now.getTime() - maxAgeDays * dayMs;
  const checkDate = (host, label, value) => {
    const time = Date.parse(value ?? "");
    if (!Number.isFinite(time)) problems.push(`${host}: ${label} is missing`);
    else if (time < previous)
      problems.push(
        `${host}: ${label} ${value} is older than the previous release (${policy.previousRelease.version})`,
      );
    else if (time < oldest)
      problems.push(
        `${host}: ${label} ${value} is older than ${maxAgeDays} days`,
      );
    else if (time > now.getTime())
      problems.push(`${host}: ${label} ${value} is in the future`);
  };
  for (const publisher of manifest.publishers) {
    const host = publisher?.host ?? "(unnamed)";
    if (!Array.isArray(publisher?.evidence) || !publisher.evidence.length)
      problems.push(`${host}: evidence is missing`);
    else
      for (const observation of publisher.evidence)
        checkDate(host, `evidence ${observation.url}`, observation.observedAt);
    if (publisher?.state !== "allowed") continue;
    const terms = publisher.terms ?? {};
    checkDate(host, "terms review", terms.reviewedAt);
    checkDate(host, "robots check", publisher.robots?.checkedAt);
    if (terms.reviewer !== policy?.reviewer)
      problems.push(`${host}: terms reviewer must be ${policy?.reviewer}`);
    if (typeof terms.basis !== "string" || !terms.basis.includes('"'))
      problems.push(`${host}: terms basis must quote the publisher text`);
    if (!(Date.parse(terms.expiresAt) > now.getTime()))
      problems.push(`${host}: terms review has expired`);
    if (!(publisher.delayMs >= minimumPacingMs))
      problems.push(`${host}: pacing must be at least ${minimumPacingMs} ms`);
    if (
      !Number.isSafeInteger(publisher.jobCaps?.maxRequests) ||
      !Number.isSafeInteger(publisher.jobCaps?.maxTransferBytes)
    )
      problems.push(`${host}: per-session caps are missing`);
    if (
      !Array.isArray(publisher.permittedPaths) ||
      !publisher.permittedPaths.length
    )
      problems.push(`${host}: permitted paths are missing`);
  }
  return problems;
}

function argument(name) {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const manifestPath =
    argument("--manifest") ??
    join(root, "data", "access", "federal-publishers.json");
  const policyPath =
    argument("--policy") ?? join(root, "data", "access", "review-policy.json");
  const policy = JSON.parse(readFileSync(policyPath, "utf8"));
  const previous = argument("--previous-release-date");
  if (previous)
    policy.previousRelease = {
      version: "given on the command line",
      publishedAt: previous,
    };
  const now = argument("--now") ? new Date(argument("--now")) : new Date();
  const problems = reviewProblems(
    JSON.parse(readFileSync(manifestPath, "utf8")),
    policy,
    now,
  );
  for (const problem of problems) console.error(`publisher review: ${problem}`);
  if (problems.length) {
    console.error(
      "FAIL: re-review the shipped publisher manifests (data/access/README.md)",
    );
    process.exit(1);
  }
  console.log("publisher review: shipped manifests are current");
}
