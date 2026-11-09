// Regenerate from a full immutable landing-page snapshot obtained with src/fetch/fetchToCache.
// node tests/fixtures/puf/acquire/generate.mjs /absolute/cache/snapshot/payload
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const path = process.argv[2];
if (!path) throw new Error("Pass the cached CMS landing-page payload path");
const bytes = await readFile(path);
const html = bytes.toString("utf8");
const sections = [
  ...html.matchAll(
    /<h3\b[^>]*>20(?:26|27) Exchange PUF Datasets<\/h3>[\s\S]*?(?=<h3\b)/g,
  ),
];
if (sections.length !== 2)
  throw new Error("Expected the real PY2026 and PY2027 sections");
const provenance = `<!-- Trimmed real CMS landing page. Source: https://www.cms.gov/marketplace/resources/data/public-use-files\nFull snapshot SHA-256: ${createHash("sha256").update(bytes).digest("hex")}\nRegenerate with generate.mjs and the cached snapshot; only the two year sections are retained. -->\n`;
const fixture =
  provenance + sections.map((match) => match[0]).join("\n") + "\n";
if (Buffer.byteLength(fixture) >= 200_000 || /[\w.+-]+@[\w.-]+/.test(fixture))
  throw new Error("Fixture exceeds policy");
await writeFile(new URL("landing.real.html", import.meta.url), fixture);
const synthetic =
  "<!-- SYNTHETIC MUTANT: PY2027 removed and PY2026 Rate link label renamed. -->\n" +
  sections
    .find((match) => match[0].startsWith("<h3>2026"))[0]
    .replace(
      /(<a\b[^>]*rate-puf\.zip[^>]*>)[\s\S]*?(<\/a>)/,
      "$1Updated premium download$2",
    ) +
  "\n";
await writeFile(new URL("landing.synthetic.html", import.meta.url), synthetic);
