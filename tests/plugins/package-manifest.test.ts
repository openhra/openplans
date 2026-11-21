import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  DATA_CHUNK_BYTES,
  PACKAGE_LIMITS,
  packageManifestJsonSchema,
  validatePackageManifest,
} from "@openplans/plugin-sdk/dist/package-manifest.js";
import { syntheticDataManifest } from "./package-fixture.js";
import { parsePackageJson } from "../../src/plugins/package/files.js";

describe("package manifest schema", () => {
  it("keeps the shipped JSON Schema derived from the TypeScript validator", async () => {
    const schema: unknown = JSON.parse(
      await readFile(
        new URL(
          "../../plugins/sdk/openplans-package.schema.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(schema).toEqual(packageManifestJsonSchema());
    expect(validatePackageManifest(syntheticDataManifest()).kind).toBe("data");
  });
  it("limits UI add-ons to routes", async () => {
    const template: unknown = JSON.parse(
      await readFile(
        new URL(
          "../../plugins/template/openplans-package.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const plugin = validatePackageManifest(template);
    expect(
      validatePackageManifest({
        ...plugin,
        kind: "ui-addon",
        kinds: ["routes"],
      }).kind,
    ).toBe("ui-addon");
    expect(() =>
      validatePackageManifest({
        ...plugin,
        kind: "ui-addon",
        kinds: ["routes", "workerCommands"],
      }),
    ).toThrow();
  });
  it("refuses missing redistribution evidence and row payloads", () => {
    const manifest = syntheticDataManifest();
    const missing = structuredClone(manifest) as unknown as {
      data: { files: Record<string, unknown>[] };
    };
    delete missing.data.files[0]!.redistribution;
    expect(() => validatePackageManifest(missing)).toThrow();
    expect(() => validatePackageManifest({ ...manifest, rows: [] })).toThrow();
    expect(() =>
      validatePackageManifest({ ...manifest, dependencies: {} }),
    ).toThrow();
  });
  it("refuses executable declarations on data packages", () => {
    const manifest = syntheticDataManifest();
    expect(() =>
      validatePackageManifest({
        ...manifest,
        capabilities: { network: ["example.org"] },
      }),
    ).toThrow();
    expect(() =>
      validatePackageManifest({ ...manifest, kinds: ["sources"] }),
    ).toThrow();
    expect(() =>
      validatePackageManifest({ ...manifest, hostPeers: { zod: "4.6.7" } }),
    ).toThrow();
  });
  it("allows an absent upstream hash without inventing one", () => {
    const manifest = syntheticDataManifest();
    delete manifest.data.files[0]!.origin.sha256;
    expect(validatePackageManifest(manifest)).toEqual(manifest);
  });
  it("enforces chunk boundaries and compressed and expanded data caps", () => {
    const manifest = syntheticDataManifest();
    manifest.data.files[0]!.chunks = [
      { sha256: "a".repeat(64), bytes: 1 },
      { sha256: "a".repeat(64), bytes: 1 },
    ];
    manifest.data.files[0]!.bytes = 2;
    expect(() => validatePackageManifest(manifest)).toThrow(/64 MiB/);
    const oversized = syntheticDataManifest();
    oversized.data.files[0]!.expandedBytes =
      PACKAGE_LIMITS.dataExpandedBytes + 1;
    expect(() => validatePackageManifest(oversized)).toThrow(/size cap/);
    const file = oversized.data.files[0]!;
    file.expandedBytes = 1;
    file.chunks = Array.from({ length: 321 }, () => ({
      sha256: "a".repeat(64),
      bytes: DATA_CHUNK_BYTES,
    }));
    file.bytes = DATA_CHUNK_BYTES * 321;
    expect(() => validatePackageManifest(oversized)).toThrow(/size cap/);
  });
  it("refuses duplicate keys, invalid UTF-8 and unsafe paths", () => {
    expect(() =>
      parsePackageJson(Buffer.from('{"dependencies":{},"dependencies":null}')),
    ).toThrow(/Duplicate/);
    expect(() => parsePackageJson(Buffer.from([0xc0, 0xaf]))).toThrow();
    const manifest = syntheticDataManifest();
    manifest.data.files[0]!.path = "../outside";
    expect(() => validatePackageManifest(manifest)).toThrow();
  });
});
