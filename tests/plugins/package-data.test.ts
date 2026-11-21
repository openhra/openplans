import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PACKAGE_MANIFEST } from "@openplans/plugin-sdk/dist/package-manifest.js";
import { sha256 } from "../../src/plugins/package/files.js";
import { verifyDirectory } from "../../src/plugins/package/verify.js";
import { runPackageCommand } from "../../src/worker/commands/plugin-package-cli.js";
import { installPlugin } from "../../src/plugins/package/install.js";
import { seal, syntheticDataManifest } from "./package-fixture.js";

const scratch: string[] = [];
afterEach(async () => {
  for (const root of scratch.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function syntheticData() {
  const root = await mkdtemp(
    join(tmpdir(), "openplans-synthetic-data-package-"),
  );
  scratch.push(root);
  const manifest = syntheticDataManifest();
  const body = Buffer.from(
    "Synthetic original public-file fixture. No health-plan data.\n",
  );
  const admission = Buffer.from('{"synthetic":true,"result":"allowed"}\n');
  const rights = Buffer.from("Synthetic redistribution evidence fixture.\n");
  const file = manifest.data.files[0]!;
  file.bytes = body.length;
  file.expandedBytes = body.length;
  file.sha256 = sha256(body);
  file.origin.sha256 = file.sha256;
  file.origin.admission.sha256 = sha256(admission);
  file.redistribution.evidence.sha256 = sha256(rights);
  file.chunks = [{ sha256: file.sha256, bytes: body.length }];
  await mkdir(join(root, "chunks"));
  await mkdir(join(root, "evidence"));
  await writeFile(join(root, "chunks", file.sha256), body);
  await writeFile(join(root, file.origin.admission.path), admission);
  await writeFile(join(root, file.redistribution.evidence.path), rights);
  await seal(root, manifest);
  return { root, manifest };
}

describe("original-file data package verification", () => {
  it("checks content-addressed chunks, reassembled hashes and evidence without activating data", async () => {
    const { root } = await syntheticData();
    expect((await verifyDirectory(root)).evidence).toBe("complete");
    await expect(installPlugin(root, join(root, "installed"))).rejects.toThrow(
      /source admission/,
    );
  });
  it("keeps a missing upstream hash unknown and returns a non-success author verification", async () => {
    const { root, manifest } = await syntheticData();
    delete manifest.data.files[0]!.origin.sha256;
    await writeFile(join(root, PACKAGE_MANIFEST), JSON.stringify(manifest));
    expect((await verifyDirectory(root)).evidence).toBe("unknown");
    const output: string[] = [];
    expect(
      await runPackageCommand(
        ["plugin", "verify", "--local", root],
        {
          out: (message) => output.push(message),
          error: (message) => output.push(message),
        },
        {},
      ),
    ).toBe(1);
    expect(output.join("\n")).toContain('"evidence":"unknown"');
  });
  it("refuses missing redistribution evidence and a changed upstream hash", async () => {
    const { root, manifest } = await syntheticData();
    manifest.data.files[0]!.origin.sha256 = "f".repeat(64);
    await writeFile(join(root, PACKAGE_MANIFEST), JSON.stringify(manifest));
    await expect(verifyDirectory(root)).rejects.toThrow(/Upstream/);
    manifest.data.files[0]!.origin.sha256 = manifest.data.files[0]!.sha256;
    await rm(join(root, manifest.data.files[0]!.redistribution.evidence.path));
    await seal(root, manifest);
    expect((await verifyDirectory(root)).evidence).toBe("unknown");
  });
  it("refuses a poisoned chunk even when the package payload inventory is refreshed", async () => {
    const { root, manifest } = await syntheticData();
    await writeFile(
      join(root, "chunks", manifest.data.files[0]!.sha256),
      "Synthetic altered original\n",
    );
    await seal(root, manifest);
    await expect(verifyDirectory(root)).rejects.toThrow(/chunk mismatch/);
  });
});
