import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PACKAGE_LIMITS,
  PACKAGE_MANIFEST,
} from "@openplans/plugin-sdk/dist/package-manifest.js";
import { unpackArchive } from "../../src/plugins/package/archive.js";
import { withVerifiedPackage } from "../../src/plugins/package/verify.js";
import { runPackageCommand } from "../../src/worker/commands/plugin-package-cli.js";
import { installPlugin } from "../../src/plugins/package/install.js";
import { inventory, sha256 } from "../../src/plugins/package/files.js";
import {
  archiveFixture,
  changeJson,
  seal,
  syntheticPlugin,
} from "./package-fixture.js";

const scratch: string[] = [];
afterEach(async () => {
  for (const root of scratch.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function temporary() {
  const root = await mkdtemp(join(tmpdir(), "openplans-package-attack-"));
  scratch.push(root);
  return root;
}

describe("local package archive boundary", () => {
  it.each([
    { name: "package/../outside" },
    { name: "/absolute" },
    { name: "package//absolute" },
    { name: "package/C:/absolute" },
    { name: "package/dist\\escape" },
    { name: "package/dist/link", type: "2", link: "../../outside" },
    { name: "package/dist/link", type: "1", link: "package/dist/index.js" },
    { name: "package/dist/native.node" },
    { name: "package/.env" },
    { name: "package/pax", type: "x" },
    { name: "package/device", type: "3" },
  ])("refuses synthetic member $name of type $type", async (member) => {
    const root = await temporary();
    const archive = await archiveFixture(root, [member]);
    const destination = join(root, "unpack");
    await mkdir(destination);
    await expect(unpackArchive(archive, destination)).rejects.toThrow();
    await expect(lstat(join(root, "outside"))).rejects.toThrow();
  });
  it("refuses expanded oversize before consuming a member", async () => {
    const root = await temporary();
    const archive = await archiveFixture(root, [
      { name: "package/huge", size: PACKAGE_LIMITS.codeExpandedBytes + 1 },
    ]);
    await expect(unpackArchive(archive, join(root, "unpack"))).rejects.toThrow(
      /expanded size cap/,
    );
  });
  it("refuses compressed oversize before reading a sparse archive", async () => {
    const root = await temporary();
    const archive = join(root, "oversize.tgz");
    const handle = await open(archive, "w");
    await handle.truncate(PACKAGE_LIMITS.codeCompressedBytes + 1);
    await handle.close();
    await expect(unpackArchive(archive, join(root, "unpack"))).rejects.toThrow(
      /Compressed.*size cap/,
    );
  });
  it("refuses too many files and case-colliding paths", async () => {
    const root = await temporary();
    const archive = await archiveFixture(
      root,
      Array.from({ length: PACKAGE_LIMITS.files + 1 }, (_, index) => ({
        name: `package/files/${index}`,
      })),
    );
    await expect(unpackArchive(archive, join(root, "unpack"))).rejects.toThrow(
      /file count/,
    );
    const collision = await archiveFixture(root, [
      { name: "package/FILE" },
      { name: "package/file" },
    ]);
    await expect(
      unpackArchive(collision, join(root, "collision")),
    ).rejects.toThrow(/Duplicate|Case-colliding/);
    const parentCollision = await archiveFixture(root, [
      { name: "package/Dir/a" },
      { name: "package/dir/b" },
    ]);
    await expect(
      unpackArchive(parentCollision, join(root, "parent-collision")),
    ).rejects.toThrow(/Case-colliding/);
  });
  it("rejects corrupted, truncated and trailing archive data", async () => {
    const root = await temporary();
    const archive = await archiveFixture(root, [
      { name: "package/ok", body: Buffer.from("synthetic") },
    ]);
    const bytes = await readFile(archive);
    await writeFile(archive, bytes.subarray(0, bytes.length - 5));
    await expect(
      unpackArchive(archive, join(root, "unpack")),
    ).rejects.toThrow();
  });
  it("refuses directory symlinks, hardlinks and installed-tree tampering", async () => {
    const { root, manifest } = await syntheticPlugin();
    scratch.push(root);
    await seal(root, manifest);
    await symlink("index.js", join(root, "dist/link.js"));
    await expect(withVerifiedPackage(root, async () => true)).rejects.toThrow(
      /links/,
    );
    await rm(join(root, "dist/link.js"));
    await link(join(root, "dist/index.js"), join(root, "dist/hard.js"));
    await expect(withVerifiedPackage(root, async () => true)).rejects.toThrow(
      /links/,
    );
    await rm(join(root, "dist/hard.js"));
    await writeFile(
      join(root, "dist/index.js"),
      "throw new Error('synthetic import sentinel');\n",
    );
    await expect(withVerifiedPackage(root, async () => true)).rejects.toThrow(
      /inventory mismatch/,
    );
  });
  it.each([
    ["dependencies", { zod: "4.6.7" }],
    ["optionalDependencies", {}],
    ["scripts", { postinstall: "synthetic-sentinel" }],
  ])("refuses %s without running the installed module", async (key, value) => {
    const { root, manifest } = await syntheticPlugin();
    scratch.push(root);
    await changeJson(join(root, "package.json"), (pkg) => {
      pkg[key as string] = value;
    });
    await seal(root, manifest);
    await expect(withVerifiedPackage(root, async () => true)).rejects.toThrow(
      /dependencies|scripts/,
    );
  });
  it("checks optional code provenance attestation hashes", async () => {
    const { root, manifest } = await syntheticPlugin();
    scratch.push(root);
    const body = Buffer.from('{"synthetic":"provenance attestation"}\n');
    await mkdir(join(root, "attestations"));
    await writeFile(join(root, "attestations/provenance.json"), body);
    manifest.provenance.attestation = {
      path: "attestations/provenance.json",
      sha256: sha256(body),
    };
    await seal(root, manifest);
    expect(
      (await withVerifiedPackage(root, async (_root, verified) => verified))
        .evidence,
    ).toBe("complete");
    manifest.provenance.attestation.sha256 = "f".repeat(64);
    await writeFile(join(root, PACKAGE_MANIFEST), JSON.stringify(manifest));
    await expect(withVerifiedPackage(root, async () => true)).rejects.toThrow(
      /Provenance evidence hash mismatch/,
    );
  });
  it("refuses conflicting host peer bindings and parent peer shadows", async () => {
    const { root, manifest } = await syntheticPlugin();
    scratch.push(root);
    await seal(root, manifest);
    const output = await temporary();
    const plugins = join(output, "plugins");
    await mkdir(join(plugins, "node_modules"), { recursive: true });
    const wrong = join(output, "wrong-peer");
    await mkdir(wrong);
    await symlink(wrong, join(plugins, "node_modules/zod"), "dir");
    await expect(installPlugin(root, plugins)).rejects.toThrow(
      /binding mismatch/,
    );
    await rm(join(plugins, "node_modules/zod"));
    await mkdir(join(plugins, "synthetic/package/node_modules"), {
      recursive: true,
    });
    await expect(installPlugin(root, plugins)).rejects.toThrow(/shadow/);
    await expect(
      lstat(join(plugins, "synthetic/package/1.0.0")),
    ).rejects.toThrow();
  });
  it("uses the configured data directory without loading configured plugins", async () => {
    const { root, manifest } = await syntheticPlugin();
    scratch.push(root);
    await seal(root, manifest);
    const output = await temporary();
    const dataRoot = join(output, "data");
    const config = join(output, "config.json");
    await writeFile(
      config,
      JSON.stringify({
        version: 1,
        access: { dataDir: dataRoot },
        plugins: { entries: [{ package: "@synthetic/must-never-import" }] },
      }),
    );
    const messages: string[] = [];
    expect(
      await runPackageCommand(
        ["plugin", "install", root],
        {
          out: (message) => messages.push(message),
          error: (message) => messages.push(message),
        },
        { OPENPLANS_CONFIG: config },
      ),
    ).toBe(0);
    await expect(
      lstat(
        join(
          await realpath(dataRoot),
          "plugins/synthetic/package/1.0.0/package.json",
        ),
      ),
    ).resolves.toBeDefined();
    expect(messages.join("\n")).toContain('"state":"installed"');
  });
  it("never imports on verify or directory install and records an unapproved lock entry", async () => {
    const { root, manifest } = await syntheticPlugin();
    scratch.push(root);
    await writeFile(
      join(root, "dist/index.js"),
      "throw new Error('synthetic import sentinel');\n",
    );
    await seal(root, manifest);
    expect(
      (await withVerifiedPackage(root, async (_root, verified) => verified))
        .evidence,
    ).toBe("complete");
    const plugins = join(await temporary(), "plugins");
    const installed = await installPlugin(root, plugins);
    expect(installed.state).toBe("installed");
    expect(installed.approval).toBe("not_granted");
    expect(installed.origin).toBe("local");
    expect(
      await readFile(join(installed.directory, "dist/index.js"), "utf8"),
    ).toContain("sentinel");
    expect(
      (await inventory(installed.directory, PACKAGE_LIMITS.codeExpandedBytes))
        .length,
    ).toBe(3);
    await expect(installPlugin(root, plugins)).rejects.toThrow(
      /already installed/,
    );
    expect(await readFile(installed.lockfile, "utf8")).toContain(
      installed.legacySha256,
    );
    await expect(
      lstat(join(plugins, "plugins.approved.json")),
    ).rejects.toThrow();
    await expect(
      lstat(join(installed.directory, PACKAGE_MANIFEST)),
    ).resolves.toBeDefined();
  });
}, 60_000);
