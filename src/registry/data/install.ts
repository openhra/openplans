import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  statfs,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  copyPackageFiles,
  normalizePackageModes,
} from "../../plugins/package/files.js";
import {
  verifyDirectory,
  withVerifiedPackage,
} from "../../plugins/package/verify.js";

/** Stores inert original files. Activation has no entry point in the installer. */
export async function installDataPackage(
  input: string,
  dataDir: string,
  origin = "local",
) {
  return withVerifiedPackage(input, async (root, verified) => {
    if (verified.manifest.kind !== "data")
      throw new Error("Expected a data package");
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const directory = join(await realpath(resolve(dataDir)), "data-packages");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (
      (await lstat(directory)).isSymbolicLink() ||
      (await realpath(directory)) !== directory
    )
      throw new Error("Data package destination cannot contain links");
    const required = verified.files.reduce((sum, file) => sum + file.bytes, 0);
    const disk = await statfs(directory);
    if (disk.bavail * disk.bsize < required)
      throw new Error("Insufficient data package staging space");
    const destination = join(directory, verified.manifestSha256);
    const reservation = `${destination}.install-lock`;
    await mkdir(reservation, { mode: 0o700 });
    let temporary: string | undefined;
    try {
      temporary = await mkdtemp(join(directory, ".install-"));
      const packageRoot = join(temporary, "package");
      await mkdir(packageRoot);
      await copyPackageFiles(root, packageRoot, verified.files);
      await normalizePackageModes(packageRoot);
      const staged = await verifyDirectory(packageRoot);
      if (staged.manifestSha256 !== verified.manifestSha256)
        throw new Error("Data package changed during install");
      // rename must never replace an existing installation or its audit record.
      if (
        await lstat(destination).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return false;
            throw error;
          },
        )
      )
        throw new Error("Data package is already installed");
      await writeFile(
        join(temporary, "receipt.json"),
        JSON.stringify({
          schemaVersion: 1,
          name: verified.manifest.name,
          version: verified.manifest.version,
          manifestSha256: verified.manifestSha256,
          origin,
          installedAt: new Date().toISOString(),
          state: "installed",
          activation: "not_requested",
          evidence: staged.evidence,
        }) + "\n",
        { flag: "wx", mode: 0o600 },
      );
      await rename(temporary, destination);
      temporary = undefined;
      return {
        state: "installed" as const,
        activation: "not_requested" as const,
        evidence: staged.evidence,
        directory: join(destination, "package"),
        receipt: join(destination, "receipt.json"),
        manifestSha256: verified.manifestSha256,
        name: staged.manifest.name,
        version: staged.manifest.version,
      };
    } finally {
      if (temporary) await rm(temporary, { recursive: true, force: true });
      await rm(reservation, { recursive: true, force: true });
    }
  });
}
