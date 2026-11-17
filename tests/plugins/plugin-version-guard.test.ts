import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { packageSha256 } from "../../src/plugins/package-hash.js";

type Release = {
  directory: string;
  name: string;
  version: string;
  sha256: string;
};

const pluginRoot = fileURLToPath(new URL("../../plugins/", import.meta.url));
const releasesPath = fileURLToPath(
  new URL("../fixtures/plugins/released-versions.json", import.meta.url),
);
const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function versionParts(version: string): number[] {
  const parts = version.split(".").map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part)))
    throw new Error(`Invalid plugin version: ${version}`);
  return parts;
}

function compareVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < 3; index++) {
    const difference = a[index]! - b[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

async function assertVersionMatchesRelease(
  root: string,
  release: Pick<Release, "name" | "version" | "sha256">,
  expectedName: string,
  expectedVersion: string,
): Promise<void> {
  if (release.name !== expectedName || release.version !== expectedVersion)
    throw new Error(
      "Plugin identity or version differs from the released record",
    );
  const actual = await packageSha256(root);
  if (actual !== release.sha256)
    throw new Error(
      `Plugin ${release.name}@${release.version} package hash changed`,
    );
}

describe("released plugin version guard", () => {
  it("matches every current plugin version that has a released record", async () => {
    const releases = JSON.parse(
      await readFile(releasesPath, "utf8"),
    ) as Release[];
    const expectedDirectories = new Set(
      releases.map((release) => release.directory),
    );
    const currentDirectories = [
      "blob-s3",
      "msot",
      "source-cms-marketplace-api",
      "source-nucc-taxonomy",
      "status",
      "tpa",
      "webhook",
    ];
    expect(new Set(currentDirectories)).toEqual(expectedDirectories);

    for (const directory of currentDirectories) {
      const root = join(pluginRoot, directory);
      const manifest = JSON.parse(
        await readFile(join(root, "package.json"), "utf8"),
      ) as {
        name: string;
        version: string;
      };
      const history = releases.filter(
        (release) => release.directory === directory,
      );
      expect(
        history.length,
        `${directory} needs a committed release record`,
      ).toBeGreaterThan(0);
      const currentRelease = history.find(
        (release) => release.version === manifest.version,
      );
      if (currentRelease) {
        await assertVersionMatchesRelease(
          root,
          currentRelease,
          manifest.name,
          manifest.version,
        );
      } else {
        const newest = history.reduce((a, b) =>
          compareVersions(a.version, b.version) >= 0 ? a : b,
        );
        expect(
          compareVersions(manifest.version, newest.version),
          `${manifest.name} must bump its version before package files change`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("rejects a one-byte package change when the version is unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "openplans-plugin-version-"));
    tempDirs.push(root);
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "package.json"),
      '{"name":"@openplans/test-plugin","version":"1.0.0"}\n',
    );
    const sourcePath = join(root, "src/index.js");
    await writeFile(sourcePath, "export const value = 1;\n");
    const sha256 = await packageSha256(root);
    expect(sha256).toBeDefined();
    const release = {
      name: "@openplans/test-plugin",
      version: "1.0.0",
      sha256: sha256!,
    };

    await writeFile(sourcePath, "export const value = 2;\n");
    await expect(
      assertVersionMatchesRelease(
        root,
        release,
        "@openplans/test-plugin",
        "1.0.0",
      ),
    ).rejects.toThrow("package hash changed");
  });
});
