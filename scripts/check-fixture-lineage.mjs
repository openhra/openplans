#!/usr/bin/env node
/**
 * Fixture lineage rule for tests/fixtures/qhp.
 *
 * Every data file there must be labelled synthetic, or be a copy from a public
 * host on PUBLIC_HOSTS with a matching hash. No fixture may equal, or cite in
 * its metadata, a SHA-256 on the deny list: the built-in list below plus, when
 * OPENPLANS_FIXTURE_DENYLIST names a file, one SHA-256 per line from it.
 */
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PUBLIC_HOSTS = ["download.cms.gov"];
// Source files that earlier fixtures were cut from and that may not be used.
export const BUILTIN_DENY = [
  "af5f791fa5054825a5218156ebb1441a84851e52dc9a622aeb58d1e424cfde2b",
  "ee77e9179b632bb41f8cd50c581e7a8e7587586516f273a9dbcc9722a7884dfb",
  "dbeeab5b60df5544b06c7d0ae894e1e5471334693a992558d34ae2ac4ce98d00",
  "c742a6c4b2995194aa3479400e08a7c1ad707178bfc80fe9c8cd7afa693ae987",
  "e0c7fbe5c3ad6dab9e9ad6d12d24613acf40108a278dd288d2adce82b43da90b",
];
const CODE = /\.(?:mjs|cjs|js|ts|d\.mts|py)$/;
const META = /(?:^|\.)provenance\.json$/;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function loadDeny(file = process.env.OPENPLANS_FIXTURE_DENYLIST) {
  const deny = new Set(BUILTIN_DENY);
  if (!file) return deny;
  for (const line of (await readFile(file, "utf8")).split(/\r?\n/)) {
    const value = line.trim().toLowerCase();
    if (!value || value.startsWith("#")) continue;
    if (!/^[0-9a-f]{64}$/.test(value))
      throw new Error("Fixture deny list lines must be SHA-256 values");
    deny.add(value);
  }
  return deny;
}

async function walk(directory) {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else out.push(path);
  }
  return out.sort();
}

async function json(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/** Returns a list of failures; empty means the tree passes. */
export async function checkFixtureLineage(root, deny = new Set(BUILTIN_DENY)) {
  const failures = [];
  const manifests = new Map();
  const manifest = async (dir) => {
    if (!manifests.has(dir))
      manifests.set(dir, await json(join(dir, "provenance.json")));
    return manifests.get(dir);
  };
  for (const path of await walk(root)) {
    const name = basename(path),
      label = relative(root, path),
      bytes = await readFile(path),
      digest = sha256(bytes);
    if (deny.has(digest))
      failures.push(`${label}: equals a denied source file`);
    for (const token of bytes.toString("latin1").match(/[0-9a-f]{64}/gi) ?? [])
      if (deny.has(token.toLowerCase()))
        failures.push(`${label}: cites denied source ${token.slice(0, 12)}`);
    if (CODE.test(name) || name === "README.md" || META.test(name)) continue;
    const local = await manifest(dirname(path));
    const entry = local?.files?.[name];
    if (!entry) {
      failures.push(
        `${label}: not listed in ${relative(root, join(dirname(path), "provenance.json"))}`,
      );
      continue;
    }
    if (entry.sha256 !== digest) {
      failures.push(`${label}: SHA-256 differs from its provenance entry`);
      continue;
    }
    if (entry.synthetic === true) {
      if (local.synthetic !== true && local.files[name].synthetic !== true)
        failures.push(`${label}: missing synthetic label`);
      const readme = join(dirname(path), "README.md");
      const text = await readFile(readme, "utf8").catch(() => "");
      if (!/synthetic/i.test(text))
        failures.push(`${label}: directory README does not say synthetic`);
      continue;
    }
    let host = null;
    try {
      host = new URL(entry.source_url).host;
    } catch {
      /* reported below */
    }
    if (entry.synthetic === false && host && PUBLIC_HOSTS.includes(host))
      continue;
    failures.push(
      `${label}: lacks the synthetic label and is not from an admitted public host`,
    );
  }
  return failures;
}

const self = fileURLToPath(import.meta.url);
if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  const root =
    process.argv[2] ?? join(dirname(self), "..", "tests", "fixtures", "qhp");
  await stat(root);
  const failures = await checkFixtureLineage(root, await loadDeny());
  if (failures.length) {
    console.error(`fixture lineage: FAIL\n${failures.join("\n")}`);
    process.exitCode = 1;
  } else console.log("fixture lineage: PASS");
}
