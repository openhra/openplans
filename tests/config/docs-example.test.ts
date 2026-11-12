import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/index.js";

// The config files in the operator docs must load through the real loader.
const docs = resolve(dirname(fileURLToPath(import.meta.url)), "../../docs");

/** Every `json` block that is a config file, not an access manifest or an approved list. */
function configBlocks(name: string): unknown[] {
  const markdown = readFileSync(join(docs, name), "utf8");
  return [...markdown.matchAll(/^\s*```json\n([\s\S]*?)^\s*```$/gm)]
    .map((match) => JSON.parse(match[1] ?? "") as unknown)
    .filter(
      (block) =>
        typeof block === "object" &&
        block !== null &&
        !Array.isArray(block) &&
        "version" in block &&
        !("publishers" in block),
    );
}

describe("config examples in the docs", () => {
  for (const name of [
    "plugins-operations.md",
    "configuration.md",
    "plugins.md",
  ]) {
    it(`${name} loads through loadConfig`, () => {
      const blocks = configBlocks(name);
      expect(blocks.length).toBeGreaterThan(0);
      for (const block of blocks)
        expect(() => loadConfig({}, block)).not.toThrow();
    });
  }

  it("the full example enables the three plugins and tightens one source", () => {
    const [full] = configBlocks("plugins-operations.md");
    const config = loadConfig({}, full);
    expect(config.plugins.map((plugin) => plugin.package)).toEqual([
      "@openplans/plugin-status",
      "@openplans/plugin-slack",
      "@openplans/plugin-webhook",
    ]);
    expect(config.plugins[0]?.sources["cms-marketplace-api"]?.cacheLevel).toBe(
      "memory",
    );
  });

  it("rejects an example with a core section the schema does not know", () => {
    expect(() => loadConfig({}, { version: 1, listn: {} })).toThrow();
  });
});
