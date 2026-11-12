import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalBlobStore } from "../../src/fetch/blob/index.js";
import type { LocalBlobFs } from "../../src/fetch/blob/index.js";
import { fetchToCache } from "../../src/fetch/index.js";
import type { FetchOptions, Transport } from "../../src/fetch/index.js";
import { plantMutant } from "../../src/plugins/testing/index.js";
import type * as LocalModule from "../../src/fetch/blob/local.js";
import type * as CacheModule from "../../src/fetch/cache.js";

const localFile = new URL("../../src/fetch/blob/local.ts", import.meta.url);
const cacheFile = new URL("../../src/fetch/cache.ts", import.meta.url);
const body = Buffer.from('{"synthetic":"atomic publication"}\n');
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Relative paths of every file and directory under the data directory. */
async function listTree(root: string) {
  const entries: { path: string; kind: "dir" | "file"; sha256?: string }[] = [];
  async function walk(relative: string): Promise<void> {
    for (const name of (await fs.readdir(join(root, relative))).sort()) {
      const path = relative ? `${relative}/${name}` : name;
      if ((await fs.lstat(join(root, path))).isDirectory()) {
        entries.push({ path, kind: "dir" });
        await walk(path);
      } else
        entries.push({
          path,
          kind: "file",
          sha256: sha(await fs.readFile(join(root, path))),
        });
    }
  }
  await walk("");
  return entries;
}

class Crash extends Error {}
const mutating = [
  "mkdir",
  "mkdtemp",
  "open",
  "rename",
  "link",
  "rm",
  "cp",
] as const;

/**
 * A filesystem that dies at its `crashAt`-th mutating call. Each call fails at its worst point
 * given its real guarantee: `rename` happens whole or not at all; a copy stops after its first
 * file (or half of a file). After the crash every call fails, so nothing cleans up.
 */
function crashingFs(crashAt: number) {
  let calls = 0;
  let dead = false;
  const state = {
    get calls() {
      return calls;
    },
    get crashed() {
      return dead;
    },
  };
  const table = { ...fs } as unknown as LocalBlobFs;
  for (const name of mutating) {
    const original = (
      fs as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
    )[name]!;
    (table as unknown as Record<string, unknown>)[name] = async (
      ...args: unknown[]
    ) => {
      if (dead) throw new Crash("process is gone");
      if (name === "open" && args[1] === "r") return original(...args);
      if (++calls < crashAt) return original(...args);
      dead = true;
      if (name === "cp") await partialCopy(String(args[0]), String(args[1]));
      throw new Crash(`crash during ${name}`);
    };
  }
  return { fs: table, state };
}
async function partialCopy(from: string, to: string): Promise<void> {
  if ((await fs.stat(from)).isDirectory()) {
    await fs.mkdir(to);
    const [first] = (await fs.readdir(from)).sort();
    if (first) await fs.copyFile(join(from, first), join(to, first));
  } else {
    const bytes = await fs.readFile(from);
    await fs.writeFile(to, bytes.subarray(0, Math.floor(bytes.length / 2)));
  }
}

const transport: Transport = async () => ({
  status: 200,
  headers: { "content-type": "application/json" },
  body: Readable.from([body.subarray(0, 7), body.subarray(7)]),
});
let dataDir: string;
const options = (overrides: Partial<FetchOptions> = {}): FetchOptions => ({
  source: "synthetic",
  allowHosts: ["publisher.test"],
  expectedContent: "json",
  dataDir,
  lookup: async () => [{ address: "93.184.216.34", family: 4 }],
  transport,
  maxAttempts: 1,
  ...overrides,
});
beforeEach(async () => {
  dataDir = await fs.mkdtemp(join(tmpdir(), "openplans-blob-atomic-"));
});
afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

/** Every published snapshot directory is whole: a payload matching its meta.json. */
async function publishedSnapshotsAreWhole(): Promise<string[]> {
  const problems: string[] = [];
  const sourceDir = join(dataDir, "raw", "synthetic");
  let names: string[] = [];
  try {
    names = await fs.readdir(sourceDir);
  } catch {
    return problems;
  }
  for (const name of names) {
    if (name.startsWith(".pending-")) continue;
    const path = join(sourceDir, name);
    if (!(await fs.stat(path)).isDirectory()) continue;
    const entries = (await fs.readdir(path)).sort();
    if (entries.join() !== "meta.json,payload") {
      problems.push(`${name}: ${entries.join() || "empty"}`);
      continue;
    }
    const meta = JSON.parse(await fs.readFile(join(path, "meta.json"), "utf8"));
    const payload = await fs.readFile(join(path, "payload"));
    if (meta.sha256 !== sha(payload) || meta.bytes !== payload.length)
      problems.push(`${name}: payload differs from meta.json`);
  }
  return problems;
}

/** Runs one fetch with a crash at every mutating call in turn; reports what a crash exposed. */
async function crashEverywhere(module: typeof LocalModule) {
  const exposed: string[] = [];
  let points = 0;
  for (let crashAt = 1; ; crashAt++) {
    await fs.rm(join(dataDir, "raw"), { recursive: true, force: true });
    const { fs: table, state } = crashingFs(crashAt);
    const store = new module.LocalBlobStore(dataDir, table);
    const outcome = await fetchToCache(
      "https://publisher.test/file",
      options({ blobStore: store }),
    ).then(
      () => "completed",
      (error: unknown) =>
        error instanceof Crash || state.crashed ? "crashed" : String(error),
    );
    if (outcome === "completed") break;
    expect(outcome).toBe("crashed");
    points++;
    for (const problem of await publishedSnapshotsAreWhole())
      exposed.push(`crash at call ${crashAt}: ${problem}`);
    // Restart: a clean process reaches one whole published snapshot.
    const after = await fetchToCache(
      "https://publisher.test/file",
      options(),
    ).then(
      (result) => result.outcome,
      (error: unknown) =>
        `restart failed: ${(error as { code?: string }).code}`,
    );
    if (!["downloaded", "reused"].includes(after))
      exposed.push(`crash at call ${crashAt}: ${after}`);
    for (const problem of await publishedSnapshotsAreWhole())
      exposed.push(`crash at call ${crashAt}, after restart: ${problem}`);
  }
  return { exposed, points };
}

describe("atomic publication: a crash between put and publish", () => {
  it("never exposes a partial snapshot, at any crash point", async () => {
    const module =
      (await import("../../src/fetch/blob/local.js")) as typeof LocalModule;
    const { exposed, points } = await crashEverywhere(module);
    expect(points).toBeGreaterThanOrEqual(6);
    expect(exposed).toEqual([]);
  });

  it("mutant: publish replaced by a copy exposes a partial snapshot", async () => {
    const mutant = await plantMutant(
      localFile,
      "await this.fs.rename(from, to);",
      "await this.fs.cp(from, to, { recursive: true }); await this.fs.rm(from, { recursive: true, force: true });",
    );
    try {
      const module = (await import(
        /* @vite-ignore */ mutant.path
      )) as typeof LocalModule;
      const { exposed } = await crashEverywhere(module);
      expect(exposed.length).toBeGreaterThan(0);
    } finally {
      await mutant.cleanup();
    }
  });
});

describe("negative controls leave no partial blob", () => {
  const noPartial = async () =>
    (await listTree(dataDir)).filter(
      (entry) =>
        entry.path.includes(".pending-") || entry.path.endsWith(".part"),
    );

  it("too large, truncated and quarantined downloads publish nothing", async () => {
    await expect(
      fetchToCache("https://publisher.test/file", options({ maxBytes: 8 })),
    ).rejects.toMatchObject({ code: "too_large" });
    await expect(
      fetchToCache(
        "https://publisher.test/file",
        options({
          transport: async () => ({
            status: 200,
            headers: { "content-length": String(body.length + 10) },
            body: Readable.from([body]),
          }),
        }),
      ),
    ).rejects.toMatchObject({ code: "truncated" });
    expect(
      (await listTree(dataDir)).filter((entry) => entry.kind === "file"),
    ).toEqual([]);
    expect(await noPartial()).toEqual([]);

    const first = await fetchToCache("https://publisher.test/file", options());
    if (first.outcome === "not_modified")
      throw new Error("Expected a snapshot");
    await fs.writeFile(
      join(dataDir, "raw", "synthetic", "QUARANTINE.json"),
      `${JSON.stringify({ snapshots: [first.snapshotId] })}\n`,
    );
    const before = await listTree(dataDir);
    await expect(
      fetchToCache("https://publisher.test/file", options()),
    ).rejects.toMatchObject({ code: "admission_denied" });
    expect(await listTree(dataDir)).toEqual(before);
  });

  it("mutant: without discarding the staging key a refused download leaves a partial", async () => {
    const mutant = await plantMutant(
      cacheFile,
      "if (staging) await store.discard(staging);",
      "",
    );
    try {
      const module = (await import(
        /* @vite-ignore */ mutant.path
      )) as typeof CacheModule;
      await expect(
        module.fetchToCache(
          "https://publisher.test/file",
          options({ maxBytes: 8 }),
        ),
      ).rejects.toMatchObject({ code: "too_large" });
      expect((await noPartial()).length).toBeGreaterThan(0);
    } finally {
      await mutant.cleanup();
    }
  });
});

describe("a store under test is not the global one", () => {
  it("an injected local store with its own root writes only there", async () => {
    const elsewhere = await fs.mkdtemp(join(tmpdir(), "openplans-blob-root-"));
    try {
      const result = await fetchToCache(
        "https://publisher.test/file",
        options({ blobStore: new LocalBlobStore(elsewhere) }),
      );
      if (result.outcome === "not_modified")
        throw new Error("Expected a snapshot");
      expect(result.path.startsWith(elsewhere)).toBe(true);
      expect(await fs.readdir(dataDir)).toEqual([]);
    } finally {
      await fs.rm(elsewhere, { recursive: true, force: true });
    }
  });
});
