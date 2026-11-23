// Terms pages whose bytes change on every request: the visible-text hash ignores the churn and
// still moves on a changed sentence. The pages are synthetic.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  visibleText,
  visibleTextSha256,
} from "../../src/fetch/visible-text.js";
import { importMutant, withMutantFile } from "../mutant-file.js";
import { replaceSyntax } from "../source-mutation.js";

const fixture = (name: string) =>
  readFile(
    fileURLToPath(new URL(`../fixtures/visible-text/${name}`, import.meta.url)),
  );
const source = fileURLToPath(
  new URL("../../src/fetch/visible-text.ts", import.meta.url),
);
type Hash = (input: string | Uint8Array) => string;

async function contract(hash: Hash): Promise<void> {
  const [a, b, changed] = await Promise.all([
    fixture("render-a.html"),
    fixture("render-b.html"),
    fixture("changed.html"),
  ]);
  expect(a.equals(b)).toBe(false);
  expect(hash(a)).toBe(hash(b));
  expect(hash(changed)).not.toBe(hash(b));
}

describe("visible-text terms hash", () => {
  it("gives two renders of one page the same hash and a changed sentence another", async () => {
    await contract(visibleTextSha256);
  });

  it("keeps the wording, drops script, style, template, comments and URL queries", async () => {
    const text = visibleText((await fixture("render-a.html")).toString());
    expect(text).toBe(
      "Synthetic Plan Privacy Policy Privacy Policy Synthetic Health Plan collects only the information you give us. We never sell it. Questions: see https://example.test/contact Automated collection of the public machine-readable files is permitted.",
    );
  });

  it("pins the digest the Python mirror also computes", async () => {
    const expected = JSON.parse(
      (await fixture("expected.json")).toString(),
    ) as Record<string, string>;
    for (const name of ["render-a", "render-b", "changed"])
      expect(visibleTextSha256(await fixture(`${name}.html`))).toBe(
        expected[name],
      );
  });

  it("is not the hash of the raw bytes", async () => {
    const a = await fixture("render-a.html");
    expect(visibleTextSha256(a)).not.toBe(
      createHash("sha256").update(a).digest("hex"),
    );
  });

  it("decodes character references and treats a changed number as a change", () => {
    expect(visibleText("<p>Fees&nbsp;&amp; &#8212; &#x41;</p>")).toBe(
      "Fees & — A",
    );
    expect(visibleTextSha256("<p>Within 30 days</p>")).not.toBe(
      visibleTextSha256("<p>Within 60 days</p>"),
    );
  });

  it("drops an unclosed script to the end of the document", () => {
    expect(visibleText("<p>Keep</p><script>var a = 1;")).toBe("Keep");
  });

  const mutants: [string, string, string][] = [
    ["hashes the raw bytes", "visibleText(source)", "source"],
    [
      "does not remove script",
      '["script", "style", "template", "noscript"]',
      '["style", "template", "noscript"]',
    ],
    ["ignores text changes", "visibleText(source)", '""'],
  ];
  for (const [name, before, after] of mutants)
    it(`fails the contract when the hash ${name}`, async () => {
      await withMutantFile(
        source,
        replaceSyntax((await readFile(source)).toString(), before, after),
        async (file) => {
          const mutant = await importMutant<{ visibleTextSha256: Hash }>(
            file,
            "visibleTextSha256",
          );
          await expect(contract(mutant.visibleTextSha256)).rejects.toThrow();
        },
      );
    });
});
