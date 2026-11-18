import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import type * as Zod from "zod";
import { loadConfig } from "../../src/config/index.js";
import type * as Config from "../../src/config/index.js";
import { withMutantFile, importMutant } from "../mutant-file.js";
import { replaceSyntax } from "../source-mutation.js";

vi.mock("zod", async (original) => {
  const actual = await original<typeof Zod>();
  return { ...actual, z: { ...actual.z, object: vi.fn(actual.z.object) } };
});

it("reuses the envelope schema while reading and validating each configuration afresh", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openplans-envelope-"));
  const file = join(directory, "config.json");
  // Synthetic settings exercise freshness without storing credentials.
  const environment = {
    OPENPLANS_CONFIG: file,
    OPENPLANS_LOWEST_PREMIUMS: "off",
  };
  try {
    await writeFile(file, JSON.stringify({ version: 1, cache: { maxMb: 1 } }));
    const first = loadConfig(environment);
    expect(first.cache.maxMb).toBe(1);
    expect(first.lowestPremiums).toBe(false);
    await writeFile(file, JSON.stringify({ version: 1, cache: { maxMb: 2 } }));
    environment.OPENPLANS_LOWEST_PREMIUMS = "on";
    const second = loadConfig(environment);
    expect(second.cache.maxMb).toBe(2);
    expect(second.lowestPremiums).toBe(true);
    expect(second).not.toBe(first);
    expect(first.cache.maxMb).toBe(1);
    expect(first.lowestPremiums).toBe(false);
    await writeFile(file, JSON.stringify({ version: 2 }));
    expect(() => loadConfig(environment)).toThrow("must have version 1");
    await writeFile(file, JSON.stringify({ version: 1, cache: { maxMb: -1 } }));
    expect(() => loadConfig(environment)).toThrow();
    await writeFile(file, JSON.stringify({ version: 1 }));

    const assertReuse = (read: typeof loadConfig) => {
      vi.mocked(z.object).mockClear();
      read(environment);
      read(environment);
      expect(z.object).not.toHaveBeenCalled();
    };
    assertReuse(loadConfig);
    const source = new URL("../../src/config/index.ts", import.meta.url);
    await withMutantFile(
      source,
      replaceSyntax(
        await readFile(source, "utf8"),
        "configEnvelope.safeParse(input)",
        "z.object({ version: z.literal(1) }).passthrough().safeParse(input)",
      ),
      async (file) => {
        const mutant = await importMutant<typeof Config>(file, "loadConfig");
        expect(() => assertReuse(mutant.loadConfig)).toThrow();
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
