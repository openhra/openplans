// Re-records the RxNav fixtures beside this file and rewrites recorded.json. It reads the public
// RxNorm API, so it is run by hand, never by CI: robots.txt first, then one plain GET per file,
// at least 5 s apart. The only query values are public generic names (drugs.json?name=metformin,
// drugs.json?name=albendazole).
// Usage: node tests/fixtures/rxnav/record.mjs
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const HOST = "https://rxnav.nlm.nih.gov";
const PACE_MS = 5000;
const directory = new URL("./", import.meta.url);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const robots = await fetch(`${HOST}/robots.txt`);
const rules = robots.status === 200 ? await robots.text() : "";
if (/^\s*disallow:\s*\/(rest\/?)?\s*$/im.test(rules))
  throw new Error("robots.txt disallows the RxNorm API; nothing recorded");

const recorded = JSON.parse(
  await readFile(new URL("recorded.json", directory), "utf8"),
);
for (const entry of recorded.files) {
  await sleep(PACE_MS);
  const response = await fetch(entry.url);
  const body = Buffer.from(await response.arrayBuffer());
  if (response.status !== 200)
    throw new Error(`${entry.url} answered ${response.status}`);
  await writeFile(new URL(entry.file, directory), body);
  entry.status = response.status;
  entry.retrieved_at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  entry.sha256 = createHash("sha256").update(body).digest("hex");
}
await writeFile(
  new URL("recorded.json", directory),
  `${JSON.stringify(recorded, null, 2)}\n`,
);
