import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { PLUGIN_API_VERSION } from "@openplans/plugin-sdk";
import {
  PACKAGE_LIMITS,
  PACKAGE_MANIFEST,
} from "@openplans/plugin-sdk/dist/package-manifest.js";
import type { PackageManifest } from "@openplans/plugin-sdk/dist/package-manifest.js";
import { inventory, sha256 } from "../../src/plugins/package/files.js";
import { coreHostPeers } from "../../src/plugins/package/verify.js";

export async function syntheticPlugin(name = "@synthetic/package") {
  const root = await mkdtemp(join(tmpdir(), "openplans-synthetic-package-"));
  const hostPeers = await coreHostPeers();
  const manifest: PackageManifest = {
    schemaVersion: 1,
    name,
    version: "1.0.0",
    kind: "plugin",
    summary: "Synthetic package fixture",
    licence: "Apache-2.0",
    attribution: "Synthetic test fixture",
    apiVersion: PLUGIN_API_VERSION,
    kinds: ["routes"],
    capabilities: {},
    hostPeers,
    bundledDependencies: [],
    planYears: [],
    entrypoint: "dist/index.js",
    provenance: {
      builtAt: "2026-11-19T00:00:00Z",
      builder: "local",
      sourceCommit: "0".repeat(40),
    },
  };
  await mkdir(join(root, "dist"));
  const runtime = {
    name: manifest.name,
    version: manifest.version,
    apiVersion: manifest.apiVersion,
    kinds: manifest.kinds,
    capabilities: {},
  };
  await writeFile(
    join(root, "dist/index.js"),
    `// Synthetic plugin.\nexport default { manifest: ${JSON.stringify(runtime)}, setup() {} };\n`,
  );
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: manifest.name,
      version: manifest.version,
      main: "dist/index.js",
      type: "module",
      peerDependencies: hostPeers,
      openplansPlugin: {
        apiVersion: manifest.apiVersion,
        kinds: manifest.kinds,
        capabilities: manifest.capabilities,
      },
    }),
  );
  await writeFile(join(root, PACKAGE_MANIFEST), JSON.stringify(manifest));
  return { root, manifest };
}
export async function seal(root: string, manifest: PackageManifest) {
  manifest.files = (
    await inventory(root, PACKAGE_LIMITS.codeExpandedBytes)
  ).filter((file) => file.path !== PACKAGE_MANIFEST);
  await writeFile(join(root, PACKAGE_MANIFEST), JSON.stringify(manifest));
}
export async function changeJson(
  path: string,
  run: (value: Record<string, unknown>) => void,
) {
  const value = JSON.parse(await readFile(path, "utf8")) as Record<
    string,
    unknown
  >;
  run(value);
  await writeFile(path, JSON.stringify(value));
}

export function tarHeader(
  name: string,
  contentBytes: number,
  type = "0",
  link = "",
  mtime = 0,
): Buffer {
  const header = Buffer.alloc(512);
  const text = (start: number, bytes: number, value: string) =>
    header.write(value, start, bytes, "ascii");
  const octal = (start: number, bytes: number, value: number) =>
    text(start, bytes, value.toString(8).padStart(bytes - 1, "0") + "\0");
  text(0, 100, name);
  octal(100, 8, 0o777);
  octal(108, 8, 999);
  octal(116, 8, 999);
  octal(124, 12, contentBytes);
  octal(136, 12, mtime);
  header.fill(32, 148, 156);
  text(156, 1, type);
  text(157, 100, link);
  text(257, 6, "ustar\0");
  text(263, 2, "00");
  text(
    148,
    8,
    header
      .reduce((sum, byte) => sum + byte, 0)
      .toString(8)
      .padStart(6, "0") + "\0 ",
  );
  return header;
}
export async function archiveFixture(
  root: string,
  members: {
    name: string;
    body?: Buffer;
    size?: number;
    type?: string;
    link?: string;
  }[],
) {
  const blocks: Buffer[] = [];
  for (const member of members) {
    const body = member.body ?? Buffer.alloc(0);
    blocks.push(
      tarHeader(
        member.name,
        member.size ?? body.length,
        member.type,
        member.link,
      ),
      body,
      Buffer.alloc((512 - (body.length % 512)) % 512),
    );
  }
  blocks.push(Buffer.alloc(1024));
  const path = join(
    root,
    `synthetic-${sha256(Buffer.concat(blocks)).slice(0, 12)}.tgz`,
  );
  await writeFile(path, gzipSync(Buffer.concat(blocks)));
  return path;
}

export function syntheticDataManifest(): Extract<
  PackageManifest,
  { kind: "data" }
> {
  return {
    schemaVersion: 1,
    kind: "data",
    name: "@synthetic/data",
    version: "1.0.0",
    summary: "Synthetic original-file fixture",
    licence: "Synthetic test licence",
    attribution: "Synthetic test evidence",
    apiVersion: PLUGIN_API_VERSION,
    kinds: [],
    capabilities: {},
    hostPeers: {},
    bundledDependencies: [],
    planYears: [2026, 2027],
    provenance: {
      builtAt: "2026-11-19T00:00:00Z",
      builder: "local",
      sourceCommit: "0".repeat(40),
    },
    data: {
      format: "original-public-files",
      files: [
        {
          path: "original/synthetic.txt",
          sha256: "a".repeat(64),
          bytes: 1,
          expandedBytes: 1,
          origin: {
            url: "https://example.org/synthetic.txt",
            sha256: "a".repeat(64),
            retrievedAt: "2026-11-19T00:00:00Z",
            admission: {
              path: "evidence/admission.json",
              sha256: "b".repeat(64),
            },
          },
          redistribution: {
            status: "allowed",
            termsUrl: "https://example.org/terms",
            evidence: { path: "evidence/rights.txt", sha256: "c".repeat(64) },
          },
          chunks: [{ sha256: "a".repeat(64), bytes: 1 }],
        },
      ],
    },
  };
}
