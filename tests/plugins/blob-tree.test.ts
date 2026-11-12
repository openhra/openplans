import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchToCache } from "../../src/fetch/index.js";
import type {
  FetchOptions,
  FetchResponse,
  Lookup,
  Transport,
} from "../../src/fetch/index.js";
import { fixtures } from "../fixtures/fetch/generate.mjs";
import { plantMutant } from "../../src/plugins/testing/index.js";
import type * as CacheModule from "../../src/fetch/cache.js";

/**
 * Design 5.7: the `local` blob store keeps the fetch cache tree byte for byte. `RECORDED` is the
 * tree the fetch cache wrote before it used a blob store, listed by the same synthetic run below
 * (no network: an in-process transport answers every request).
 */
const FIXED_TIME = "2026-11-11T00:00:00.000Z";
const json = Buffer.from('{"synthetic":true}\n');
// gzip of '{"synthetic":"compressed","rows":[1,2,3]}\n', kept as bytes so a zlib upgrade cannot move it.
const gzipped = Buffer.from(
  "1f8b0800000000000013ab562aaecc2bc9482dc94c56b2524acecf2d284a2d2e4e4d51d2512aca2f2f56b28a36d431d2318eade50200b4b14f582a000000",
  "hex",
);
const changed = Buffer.from('{"synthetic":"fixed id"}\n');
const redirected = Buffer.from('{"synthetic":"redirected"}\n');
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

const lookup: Lookup = async () => [{ address: "93.184.216.34", family: 4 }];
function reply(
  status: number,
  headers: Record<string, string>,
  body: Buffer = Buffer.alloc(0),
): FetchResponse {
  // Two chunks, so every write path sees more than one piece.
  const half = Math.floor(body.length / 2);
  return {
    status,
    headers,
    body: Readable.from([body.subarray(0, half), body.subarray(half)]),
  };
}
const transport: Transport = async (url) => {
  switch (url.pathname) {
    case "/plain":
      return reply(
        200,
        {
          "content-type": "application/json",
          etag: '"synthetic-v1"',
          "last-modified": "Wed, 01 Jan 2025 00:00:00 GMT",
          "content-length": String(json.length),
        },
        json,
      );
    case "/compressed":
      return reply(
        200,
        { "content-type": "application/json", "content-encoding": "gzip" },
        gzipped,
      );
    case "/fixed":
      return reply(200, { "content-type": "application/json" }, changed);
    case "/start":
      return reply(302, { location: "https://delegate.test/final" });
    case "/final":
      return reply(200, { "content-type": "application/json" }, redirected);
    case "/archive":
      return reply(
        200,
        { "content-type": "application/zip" },
        fixtures.valid(),
      );
    case "/unchanged":
      return reply(304, {});
    case "/large":
      return reply(
        200,
        { "content-type": "application/json" },
        Buffer.alloc(64, 0x20),
      );
    default:
      return reply(404, {});
  }
};

interface TreeEntry {
  path: string;
  kind: "dir" | "file";
  size?: number;
  sha256?: string;
  links?: number;
}
/** Every path under `root`, sorted, with sizes, hashes and hard-link counts of files. */
async function listTree(root: string): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = [];
  async function walk(relative: string): Promise<void> {
    for (const name of (await readdir(join(root, relative))).sort()) {
      const path = relative ? `${relative}/${name}` : name;
      const info = await lstat(join(root, path));
      if (info.isDirectory()) {
        entries.push({ path, kind: "dir" });
        await walk(path);
      } else {
        entries.push({
          path,
          kind: "file",
          size: info.size,
          sha256: sha(await readFile(join(root, path))),
          links: info.nlink,
        });
      }
    }
  }
  await walk("");
  return entries;
}

/** The synthetic run: downloads, a reuse, a hash hit, a 304, refusals and a quarantine. */
async function syntheticRun(
  dataDir: string,
  fetch: typeof fetchToCache = fetchToCache,
): Promise<{ outcomes: unknown[]; tree: TreeEntry[] }> {
  const base: FetchOptions = {
    source: "synthetic",
    allowHosts: ["publisher.test", "delegate.test"],
    expectedContent: "json",
    dataDir,
    lookup,
    transport,
    maxAttempts: 1,
  };
  const outcomes: unknown[] = [];
  const run = async (url: string, overrides: Partial<FetchOptions> = {}) => {
    try {
      const result = await fetch(url, { ...base, ...overrides });
      outcomes.push(
        result.outcome === "not_modified"
          ? result
          : {
              outcome: result.outcome,
              snapshotId: result.snapshotId,
              path: result.path.slice(dataDir.length),
              metadataPath: result.metadataPath.slice(dataDir.length),
              metadata: result.metadata,
            },
      );
    } catch (error) {
      outcomes.push({ error: (error as { code?: string }).code });
    }
  };
  await run("https://publisher.test/plain");
  await run("https://publisher.test/plain");
  await run("https://publisher.test/compressed");
  await run("https://publisher.test/fixed", { snapshotId: "fixed-id" });
  await run("https://publisher.test/start");
  await run("https://publisher.test/archive", { expectedContent: "zip" });
  await run("https://publisher.test/plain", { expectedSha256: sha(json) });
  await run("https://publisher.test/unchanged", {
    conditional: { etag: '"synthetic-v1"' },
  });
  await run("https://publisher.test/large", { maxBytes: 16 });
  await run("https://publisher.test/missing");
  const compressed = sha(
    Buffer.from('{"synthetic":"compressed","rows":[1,2,3]}\n'),
  );
  await writeFile(
    join(dataDir, "raw", "synthetic", "QUARANTINE.json"),
    `${JSON.stringify({ snapshots: [compressed] }, null, 2)}\n`,
  );
  await run("https://publisher.test/compressed");
  await run("https://publisher.test/plain", { snapshotId: "second-id" });
  return { outcomes, tree: await listTree(dataDir) };
}

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "openplans-blob-tree-"));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(FIXED_TIME));
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(dataDir, { recursive: true, force: true });
});

// Recorded from develop 7287b07, before the blob store, with OPENPLANS_RECORD_BLOB_TREE set.
const RECORDED: { outcomes: unknown[]; tree: TreeEntry[] } | null = {
  outcomes: [
    {
      outcome: "downloaded",
      snapshotId:
        "cb8daed7b30399a1c3c8b83b3b7bee4b774a30fc389afc1d375e4c23a3cc4ae8",
      path: "/raw/synthetic/cb8daed7b30399a1c3c8b83b3b7bee4b774a30fc389afc1d375e4c23a3cc4ae8/payload",
      metadataPath:
        "/raw/synthetic/cb8daed7b30399a1c3c8b83b3b7bee4b774a30fc389afc1d375e4c23a3cc4ae8.meta.json",
      metadata: {
        snapshot_id:
          "cb8daed7b30399a1c3c8b83b3b7bee4b774a30fc389afc1d375e4c23a3cc4ae8",
        source: "synthetic",
        url: "https://publisher.test/plain",
        final_url: "https://publisher.test/plain",
        redirect_chain: [],
        status: 200,
        content_type: "application/json",
        etag: '"synthetic-v1"',
        last_modified: "Wed, 01 Jan 2025 00:00:00 GMT",
        sha256:
          "cb8daed7b30399a1c3c8b83b3b7bee4b774a30fc389afc1d375e4c23a3cc4ae8",
        bytes: 19,
        fetched_at: "2026-11-11T00:00:00.000Z",
      },
    },
    {
      outcome: "reused",
      snapshotId:
        "cb8daed7b30399a1c3c8b83b3b7bee4b774a30fc389afc1d375e4c23a3cc4ae8",
      path: "/raw/synthetic/cb8daed7b30399a1c3c8b83b3b7bee4b774a30fc389afc1d375e4c23a3cc4ae8/payload",
      metadataPath:
        "/raw/synthetic/cb8daed7b30399a1c3c8b83b3b7bee4b774a30fc389afc1d375e4c23a3cc4ae8.meta.json",
      metadata: {
        snapshot_id:
          "cb8daed7b30399a1c3c8b83b3b7bee4b774a30fc389afc1d375e4c23a3cc4ae8",
        source: "synthetic",
        url: "https://publisher.test/plain",
        final_url: "https://publisher.test/plain",
        redirect_chain: [],
        status: 200,
        content_type: "application/json",
        etag: '"synthetic-v1"',
        last_modified: "Wed, 01 Jan 2025 00:00:00 GMT",
        sha256:
          "cb8daed7b30399a1c3c8b83b3b7bee4b774a30fc389afc1d375e4c23a3cc4ae8",
        bytes: 19,
        fetched_at: "2026-11-11T00:00:00.000Z",
      },
    },
    {
      outcome: "downloaded",
      snapshotId:
        "341b80ef0e82a2e6253e1a240c9841ea2dcf0f9b76cf8320b0a3f208eefdb5a4",
      path: "/raw/synthetic/341b80ef0e82a2e6253e1a240c9841ea2dcf0f9b76cf8320b0a3f208eefdb5a4/payload",
      metadataPath:
        "/raw/synthetic/341b80ef0e82a2e6253e1a240c9841ea2dcf0f9b76cf8320b0a3f208eefdb5a4.meta.json",
      metadata: {
        snapshot_id:
          "341b80ef0e82a2e6253e1a240c9841ea2dcf0f9b76cf8320b0a3f208eefdb5a4",
        source: "synthetic",
        url: "https://publisher.test/compressed",
        final_url: "https://publisher.test/compressed",
        redirect_chain: [],
        status: 200,
        content_type: "application/json",
        etag: null,
        last_modified: null,
        sha256:
          "341b80ef0e82a2e6253e1a240c9841ea2dcf0f9b76cf8320b0a3f208eefdb5a4",
        bytes: 42,
        fetched_at: "2026-11-11T00:00:00.000Z",
        content_encoding: "gzip",
        transferred_bytes: 62,
      },
    },
    {
      outcome: "downloaded",
      snapshotId: "fixed-id",
      path: "/raw/synthetic/fixed-id/payload",
      metadataPath: "/raw/synthetic/fixed-id.meta.json",
      metadata: {
        snapshot_id: "fixed-id",
        source: "synthetic",
        url: "https://publisher.test/fixed",
        final_url: "https://publisher.test/fixed",
        redirect_chain: [],
        status: 200,
        content_type: "application/json",
        etag: null,
        last_modified: null,
        sha256:
          "75b72539b888b0127e2c69b516a4a3c9d2fbbe7e45ae94203d7339d0fc61b4d5",
        bytes: 25,
        fetched_at: "2026-11-11T00:00:00.000Z",
      },
    },
    {
      outcome: "downloaded",
      snapshotId:
        "1f738431b43442a38a87ccd22362454502e692d798cf5aba7e5b44bcc3b164f9",
      path: "/raw/synthetic/1f738431b43442a38a87ccd22362454502e692d798cf5aba7e5b44bcc3b164f9/payload",
      metadataPath:
        "/raw/synthetic/1f738431b43442a38a87ccd22362454502e692d798cf5aba7e5b44bcc3b164f9.meta.json",
      metadata: {
        snapshot_id:
          "1f738431b43442a38a87ccd22362454502e692d798cf5aba7e5b44bcc3b164f9",
        source: "synthetic",
        url: "https://publisher.test/start",
        final_url: "https://delegate.test/final",
        redirect_chain: ["https://delegate.test/final"],
        status: 200,
        content_type: "application/json",
        etag: null,
        last_modified: null,
        sha256:
          "1f738431b43442a38a87ccd22362454502e692d798cf5aba7e5b44bcc3b164f9",
        bytes: 27,
        fetched_at: "2026-11-11T00:00:00.000Z",
      },
    },
    {
      outcome: "downloaded",
      snapshotId:
        "910de9a4f17d55fefae07bcbe3b599d032852878e2fb20d87f6c4ceb696accac",
      path: "/raw/synthetic/910de9a4f17d55fefae07bcbe3b599d032852878e2fb20d87f6c4ceb696accac/payload",
      metadataPath:
        "/raw/synthetic/910de9a4f17d55fefae07bcbe3b599d032852878e2fb20d87f6c4ceb696accac.meta.json",
      metadata: {
        snapshot_id:
          "910de9a4f17d55fefae07bcbe3b599d032852878e2fb20d87f6c4ceb696accac",
        source: "synthetic",
        url: "https://publisher.test/archive",
        final_url: "https://publisher.test/archive",
        redirect_chain: [],
        status: 200,
        content_type: "application/zip",
        etag: null,
        last_modified: null,
        sha256:
          "910de9a4f17d55fefae07bcbe3b599d032852878e2fb20d87f6c4ceb696accac",
        bytes: 154,
        fetched_at: "2026-11-11T00:00:00.000Z",
      },
    },
    {
      outcome: "reused",
      snapshotId:
        "cb8daed7b30399a1c3c8b83b3b7bee4b774a30fc389afc1d375e4c23a3cc4ae8",
      path: "/raw/synthetic/cb8daed7b30399a1c3c8b83b3b7bee4b774a30fc389afc1d375e4c23a3cc4ae8/payload",
      metadataPath:
        "/raw/synthetic/cb8daed7b30399a1c3c8b83b3b7bee4b774a30fc389afc1d375e4c23a3cc4ae8.meta.json",
      metadata: {
        snapshot_id:
          "cb8daed7b30399a1c3c8b83b3b7bee4b774a30fc389afc1d375e4c23a3cc4ae8",
        source: "synthetic",
        url: "https://publisher.test/plain",
        final_url: "https://publisher.test/plain",
        redirect_chain: [],
        status: 200,
        content_type: "application/json",
        etag: '"synthetic-v1"',
        last_modified: "Wed, 01 Jan 2025 00:00:00 GMT",
        sha256:
          "cb8daed7b30399a1c3c8b83b3b7bee4b774a30fc389afc1d375e4c23a3cc4ae8",
        bytes: 19,
        fetched_at: "2026-11-11T00:00:00.000Z",
      },
    },
    {
      outcome: "not_modified",
      status: 304,
      url: "https://publisher.test/unchanged",
      final_url: "https://publisher.test/unchanged",
      redirect_chain: [],
    },
    {
      error: "too_large",
    },
    {
      error: "http_status",
    },
    {
      error: "admission_denied",
    },
    {
      outcome: "reused",
      snapshotId:
        "cb8daed7b30399a1c3c8b83b3b7bee4b774a30fc389afc1d375e4c23a3cc4ae8",
      path: "/raw/synthetic/cb8daed7b30399a1c3c8b83b3b7bee4b774a30fc389afc1d375e4c23a3cc4ae8/payload",
      metadataPath:
        "/raw/synthetic/cb8daed7b30399a1c3c8b83b3b7bee4b774a30fc389afc1d375e4c23a3cc4ae8.meta.json",
      metadata: {
        snapshot_id:
          "cb8daed7b30399a1c3c8b83b3b7bee4b774a30fc389afc1d375e4c23a3cc4ae8",
        source: "synthetic",
        url: "https://publisher.test/plain",
        final_url: "https://publisher.test/plain",
        redirect_chain: [],
        status: 200,
        content_type: "application/json",
        etag: '"synthetic-v1"',
        last_modified: "Wed, 01 Jan 2025 00:00:00 GMT",
        sha256:
          "cb8daed7b30399a1c3c8b83b3b7bee4b774a30fc389afc1d375e4c23a3cc4ae8",
        bytes: 19,
        fetched_at: "2026-11-11T00:00:00.000Z",
      },
    },
  ],
  tree: [
    {
      path: "raw",
      kind: "dir",
    },
    {
      path: "raw/synthetic",
      kind: "dir",
    },
    {
      path: "raw/synthetic/1f738431b43442a38a87ccd22362454502e692d798cf5aba7e5b44bcc3b164f9",
      kind: "dir",
    },
    {
      path: "raw/synthetic/1f738431b43442a38a87ccd22362454502e692d798cf5aba7e5b44bcc3b164f9/meta.json",
      kind: "file",
      size: 496,
      sha256:
        "00f667c610edf821fa279ddb3e8e0608ed9e15c3cd268ea02ac5a4d7da78b546",
      links: 2,
    },
    {
      path: "raw/synthetic/1f738431b43442a38a87ccd22362454502e692d798cf5aba7e5b44bcc3b164f9/payload",
      kind: "file",
      size: 27,
      sha256:
        "1f738431b43442a38a87ccd22362454502e692d798cf5aba7e5b44bcc3b164f9",
      links: 1,
    },
    {
      path: "raw/synthetic/1f738431b43442a38a87ccd22362454502e692d798cf5aba7e5b44bcc3b164f9.meta.json",
      kind: "file",
      size: 496,
      sha256:
        "00f667c610edf821fa279ddb3e8e0608ed9e15c3cd268ea02ac5a4d7da78b546",
      links: 2,
    },
    {
      path: "raw/synthetic/341b80ef0e82a2e6253e1a240c9841ea2dcf0f9b76cf8320b0a3f208eefdb5a4",
      kind: "dir",
    },
    {
      path: "raw/synthetic/341b80ef0e82a2e6253e1a240c9841ea2dcf0f9b76cf8320b0a3f208eefdb5a4/meta.json",
      kind: "file",
      size: 527,
      sha256:
        "6d3661441be3484058c3f8df1c6046282b162966c89c56bf20d7a16e7b116cb9",
      links: 2,
    },
    {
      path: "raw/synthetic/341b80ef0e82a2e6253e1a240c9841ea2dcf0f9b76cf8320b0a3f208eefdb5a4/payload",
      kind: "file",
      size: 42,
      sha256:
        "341b80ef0e82a2e6253e1a240c9841ea2dcf0f9b76cf8320b0a3f208eefdb5a4",
      links: 1,
    },
    {
      path: "raw/synthetic/341b80ef0e82a2e6253e1a240c9841ea2dcf0f9b76cf8320b0a3f208eefdb5a4.meta.json",
      kind: "file",
      size: 527,
      sha256:
        "6d3661441be3484058c3f8df1c6046282b162966c89c56bf20d7a16e7b116cb9",
      links: 2,
    },
    {
      path: "raw/synthetic/910de9a4f17d55fefae07bcbe3b599d032852878e2fb20d87f6c4ceb696accac",
      kind: "dir",
    },
    {
      path: "raw/synthetic/910de9a4f17d55fefae07bcbe3b599d032852878e2fb20d87f6c4ceb696accac/meta.json",
      kind: "file",
      size: 464,
      sha256:
        "854e53bbfb6d2e3cffe2c2df9d2dbd1c1c3c31c4524b18aa11a337bfcc9ad6ef",
      links: 2,
    },
    {
      path: "raw/synthetic/910de9a4f17d55fefae07bcbe3b599d032852878e2fb20d87f6c4ceb696accac/payload",
      kind: "file",
      size: 154,
      sha256:
        "910de9a4f17d55fefae07bcbe3b599d032852878e2fb20d87f6c4ceb696accac",
      links: 1,
    },
    {
      path: "raw/synthetic/910de9a4f17d55fefae07bcbe3b599d032852878e2fb20d87f6c4ceb696accac.meta.json",
      kind: "file",
      size: 464,
      sha256:
        "854e53bbfb6d2e3cffe2c2df9d2dbd1c1c3c31c4524b18aa11a337bfcc9ad6ef",
      links: 2,
    },
    {
      path: "raw/synthetic/QUARANTINE.json",
      kind: "file",
      size: 96,
      sha256:
        "f9d8e3d96e265d79bafa830406f2b88c27dc91cfd6f0ad651d17ba2eda93789c",
      links: 1,
    },
    {
      path: "raw/synthetic/cb8daed7b30399a1c3c8b83b3b7bee4b774a30fc389afc1d375e4c23a3cc4ae8",
      kind: "dir",
    },
    {
      path: "raw/synthetic/cb8daed7b30399a1c3c8b83b3b7bee4b774a30fc389afc1d375e4c23a3cc4ae8/meta.json",
      kind: "file",
      size: 501,
      sha256:
        "12a7d82882923301059ff61fa5f921040c1ac75699c983f77ee0ee48c7e5cc9d",
      links: 2,
    },
    {
      path: "raw/synthetic/cb8daed7b30399a1c3c8b83b3b7bee4b774a30fc389afc1d375e4c23a3cc4ae8/payload",
      kind: "file",
      size: 19,
      sha256:
        "cb8daed7b30399a1c3c8b83b3b7bee4b774a30fc389afc1d375e4c23a3cc4ae8",
      links: 1,
    },
    {
      path: "raw/synthetic/cb8daed7b30399a1c3c8b83b3b7bee4b774a30fc389afc1d375e4c23a3cc4ae8.meta.json",
      kind: "file",
      size: 501,
      sha256:
        "12a7d82882923301059ff61fa5f921040c1ac75699c983f77ee0ee48c7e5cc9d",
      links: 2,
    },
    {
      path: "raw/synthetic/fixed-id",
      kind: "dir",
    },
    {
      path: "raw/synthetic/fixed-id/meta.json",
      kind: "file",
      size: 404,
      sha256:
        "c5dc6c2abf128ff9610d7d18d8998053a7b94c4e0459a1445128b70fb9d9a53d",
      links: 2,
    },
    {
      path: "raw/synthetic/fixed-id/payload",
      kind: "file",
      size: 25,
      sha256:
        "75b72539b888b0127e2c69b516a4a3c9d2fbbe7e45ae94203d7339d0fc61b4d5",
      links: 1,
    },
    {
      path: "raw/synthetic/fixed-id.meta.json",
      kind: "file",
      size: 404,
      sha256:
        "c5dc6c2abf128ff9610d7d18d8998053a7b94c4e0459a1445128b70fb9d9a53d",
      links: 2,
    },
  ],
};

describe("local blob store keeps the fetch cache tree", () => {
  it("writes the recorded paths, bytes, hashes and sidecar links", async () => {
    const live = await syntheticRun(dataDir);
    if (process.env.OPENPLANS_RECORD_BLOB_TREE) {
      await writeFile(
        process.env.OPENPLANS_RECORD_BLOB_TREE,
        `${JSON.stringify(live, null, 2)}\n`,
      );
      return;
    }
    expect(RECORDED).not.toBeNull();
    expect(live).toEqual(RECORDED);
  });

  it.each([
    [
      "meta.json without its final newline",
      "single(Buffer.from(`${JSON.stringify(metadata, null, 2)}\\n`))",
      "single(Buffer.from(JSON.stringify(metadata, null, 2)))",
    ],
    [
      "no sidecar for a new download",
      "await store.alias(`${destination}/meta.json`, `${destination}.meta.json`);",
      "",
    ],
  ])(
    "negative control: the comparison catches %s",
    async (_name, before, after) => {
      const mutant = await plantMutant(
        new URL("../../src/fetch/cache.ts", import.meta.url),
        before,
        after,
      );
      try {
        const module = (await import(
          /* @vite-ignore */ mutant.path
        )) as typeof CacheModule;
        const live = await syntheticRun(dataDir, module.fetchToCache);
        expect(live).not.toEqual(RECORDED);
      } finally {
        await mutant.cleanup();
      }
    },
  );
});
