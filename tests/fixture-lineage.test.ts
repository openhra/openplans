import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUILTIN_DENY,
  checkFixtureLineage,
  loadDeny,
} from "../scripts/check-fixture-lineage.mjs";
import { files } from "./fixtures/qhp/generate-issuer.mjs";

const root = fileURLToPath(new URL("./fixtures/qhp/", import.meta.url));
const sha = (text: string | Buffer) =>
  createHash("sha256").update(text).digest("hex");
const scratch: string[] = [];
async function copy() {
  const dir = await mkdtemp(join(tmpdir(), "openplans-lineage-"));
  scratch.push(dir);
  await cp(root, dir, { recursive: true });
  return dir;
}
afterEach(async () => {
  for (const dir of scratch.splice(0))
    await rm(dir, { recursive: true, force: true });
});

describe("tests/fixtures/qhp lineage", () => {
  it("passes on the committed fixtures, with any configured deny list", async () => {
    expect(await checkFixtureLineage(root, await loadDeny())).toEqual([]);
  });

  it("matches the generator byte for byte", async () => {
    for (const [dir, set] of Object.entries(files()))
      for (const [name, text] of Object.entries(set))
        expect(await readFile(join(root, dir, name), "utf8")).toBe(text);
  });

  it("mutant: an unlisted data file fails", async () => {
    const dir = await copy();
    await writeFile(join(dir, "provider", "extra.json"), "[]\n");
    expect(await checkFixtureLineage(dir)).toEqual([
      "provider/extra.json: not listed in provider/provenance.json",
    ]);
  });

  it("mutant: an edited synthetic file fails on its hash", async () => {
    const dir = await copy();
    await writeFile(join(dir, "formulary", "drugs.json"), "[]\n");
    expect(await checkFixtureLineage(dir)).toEqual([
      "formulary/drugs.json: SHA-256 differs from its provenance entry",
    ]);
  });

  it("mutant: a listed file without the synthetic label fails", async () => {
    const dir = await copy(),
      path = join(dir, "provider", "provenance.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    manifest.synthetic = false;
    manifest.files["records.json"].synthetic = false;
    await writeFile(path, JSON.stringify(manifest));
    expect(await checkFixtureLineage(dir)).toEqual([
      "provider/records.json: lacks the synthetic label and is not from an admitted public host",
    ]);
  });

  it("mutant: a real file from a host that is not admitted fails", async () => {
    const dir = await copy(),
      path = join(dir, "provenance.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    manifest.files["tx-2026-registry.xlsx.hex"].source_url =
      "https://issuer.example/plans.json";
    await writeFile(path, JSON.stringify(manifest));
    expect(await checkFixtureLineage(dir)).toEqual([
      "tx-2026-registry.xlsx.hex: lacks the synthetic label and is not from an admitted public host",
    ]);
  });

  it("mutant: a synthetic directory without a README saying so fails", async () => {
    const dir = await copy();
    await writeFile(join(dir, "provider", "README.md"), "# Provider\n");
    const failures = await checkFixtureLineage(dir);
    expect(failures).toContain(
      "provider/records.json: directory README does not say synthetic",
    );
  });

  it("mutant: a file equal to, or citing, a denied source hash fails", async () => {
    const dir = await copy(),
      denied = "synthetic denied source bytes\n",
      deny = new Set([...BUILTIN_DENY, sha(denied)]);
    await writeFile(join(dir, "formulary", "copied.json"), denied);
    const path = join(dir, "formulary", "provenance.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    manifest.files["copied.json"] = { synthetic: true, sha256: sha(denied) };
    manifest.lineage = { sha256: BUILTIN_DENY[0] };
    await writeFile(path, JSON.stringify(manifest));
    const failures = await checkFixtureLineage(dir, deny);
    expect(failures).toContain(
      "formulary/copied.json: equals a denied source file",
    );
    expect(failures).toContain(
      `formulary/provenance.json: cites denied source ${BUILTIN_DENY[0]!.slice(0, 12)}`,
    );
  });

  it("deny list file: accepts SHA-256 lines and rejects anything else", async () => {
    const dir = await copy(),
      good = join(dir, "deny.txt"),
      bad = join(dir, "bad.txt");
    await writeFile(good, `# comment\n${"b".repeat(64)}\n`);
    await writeFile(bad, "not-a-hash\n");
    expect((await loadDeny(good)).has("b".repeat(64))).toBe(true);
    await expect(loadDeny(bad)).rejects.toThrow(/SHA-256/);
  });
});
