import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BlobStore } from "@openplans/plugin-sdk";
import { expectedHash } from "@openplans/source-nucc-taxonomy";
import { configureHostBlobStore } from "../../src/fetch/blob/index.js";
import {
  ensureCachedPayload,
  snapshotPath,
  snapshotStore,
  storeCachedText,
  remoteSnapshotStore,
} from "../../src/fetch/index.js";
import type { FetchResult, SnapshotMetadata } from "../../src/fetch/index.js";
import type * as MedicareAcquire from "../../src/ingest/medicare/acquire.js";
import { cachedArchives } from "../../src/ingest/medicare/acquire.js";
import { cachedSpuf } from "../../src/ingest/medicare/spuf.js";
import type * as Georgia from "../../src/ingest/sbe/georgia.js";
import {
  cachedGeorgiaAccess,
  cachedGeorgiaRegistry,
} from "../../src/ingest/sbe/georgia.js";
import type * as Registry from "../../src/ingest/qhp/discover-registry.js";
import { cachedRegistry } from "../../src/ingest/qhp/discover-registry.js";
import type * as Provider from "../../src/ingest/qhp/provider.js";
import { providerCachedRecords } from "../../src/ingest/qhp/provider.js";
import type * as Transfer from "../../src/ingest/geocode/transfer.js";
import { verifyTransferSnapshot } from "../../src/ingest/geocode/transfer.js";
import { acquireBatch } from "../../src/ingest/geocode/census.js";
import { cachedSha } from "../../src/ingest/geocode/counties.js";
import { priorHash } from "../../src/ingest/qhp/formulary-acquire.js";
import type * as ImportSource from "../../src/ingest/puf/import-source.js";
import { newestPufManifest } from "../../src/ingest/puf/import-source.js";
import { acquirePufs } from "../../src/ingest/puf/acquire.js";
import type * as ProviderAcquire from "../../src/ingest/qhp/provider-acquire.js";
import { soleCachedHash } from "../../src/ingest/qhp/provider-acquire.js";
import type * as Bootstrap from "../../src/worker/bootstrap.js";
import { runBootstrap } from "../../src/worker/bootstrap.js";
import { plantMutant } from "../../src/plugins/testing/index.js";

/**
 * Ingest readers outside fetchToCache, over a store that offers only the SDK interface: the
 * host runs it behind RemoteFetchStore, so nothing is a file under `<dataDir>/raw`. Each reader
 * finds what only the store holds; a planted mutant that reads `raw/` directly does not. All
 * data is synthetic.
 */
class MemoryStore implements BlobStore {
  readonly objects = new Map<string, Buffer>();
  async put(key: string, body: AsyncIterable<Uint8Array>) {
    const parts: Buffer[] = [];
    for await (const part of body) parts.push(Buffer.from(part));
    const data = Buffer.concat(parts);
    this.objects.set(key, data);
    return { bytes: data.length, sha256: sha(data) };
  }
  async get(key: string) {
    const data = this.objects.get(key);
    return data ? Readable.from([data]) : null;
  }
  async stat(key: string) {
    const data = this.objects.get(key);
    return data ? { bytes: data.length, sha256: sha(data) } : null;
  }
  async *list(prefix: string) {
    const seen = new Set<string>();
    for (const key of [...this.objects.keys()].sort()) {
      if (!key.startsWith(`${prefix}/`)) continue;
      const rest = key.slice(prefix.length + 1);
      const child = rest.includes("/")
        ? `${prefix}/${rest.slice(0, rest.indexOf("/"))}/`
        : key;
      if (!seen.has(child)) {
        seen.add(child);
        yield child;
      }
    }
  }
  async publish(from: string, to: string) {
    if (this.objects.has(to))
      throw Object.assign(new Error("exists"), { code: "EEXIST" });
    this.objects.set(to, this.objects.get(from)!);
    this.objects.delete(from);
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}

const sha = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");
const src = (path: string) => new URL(`../../src/${path}`, import.meta.url);
let root: string;
let store: MemoryStore;

/** Puts one snapshot in the store as the fetch cache lays it out. */
function seed(
  source: string,
  url: string,
  body: Buffer | string,
  extra: Partial<SnapshotMetadata> = {},
): SnapshotMetadata {
  const data = Buffer.from(body);
  const id = sha(data);
  const metadata: SnapshotMetadata = {
    snapshot_id: id,
    source,
    url,
    final_url: url,
    redirect_chain: [],
    status: 200,
    content_type: "application/octet-stream",
    etag: null,
    last_modified: null,
    sha256: id,
    bytes: data.length,
    fetched_at: "2026-11-01T00:00:00.000Z",
    ...extra,
  };
  const text = Buffer.from(JSON.stringify(metadata));
  store.objects.set(`raw/${source}/${id}/payload`, data);
  store.objects.set(`raw/${source}/${id}/meta.json`, text);
  store.objects.set(`raw/${source}/${id}.meta.json`, text);
  return metadata;
}
async function rawFiles(): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(root, {
    recursive: true,
    withFileTypes: true,
  }).catch(() => []))
    if (entry.isFile())
      out.push(relative(root, join(entry.parentPath, entry.name)));
  return out.filter((path) => path.startsWith("raw/"));
}
/** Imports a disposable copy of `file` with one call swapped for a direct read of `raw/`. */
async function mutant<T>(
  file: string,
  before: string,
  after: string,
  run: (module: T) => Promise<void>,
) {
  const planted = await plantMutant(src(file), before, after);
  try {
    await run((await import(/* @vite-ignore */ planted.path)) as T);
  } finally {
    await planted.cleanup();
  }
}
const fsRead = `(await import("node:fs/promises"))`;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openplans-raw-readers-"));
  store = new MemoryStore();
  configureHostBlobStore(store);
  vi.stubEnv("OPENPLANS_DATA_DIR", root);
});
afterEach(async () => {
  configureHostBlobStore(undefined);
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("medicare", () => {
  const landscape = "https://www.cms.gov/files/zip/cy2027-landscape-202610.zip";
  const spuf =
    "https://data.cms.gov/sites/default/files/2026-10/SPUF_2027_20261007.zip";

  it("lists remote archives without downloading them, then copies the chosen one down", async () => {
    const body = Buffer.from("synthetic landscape archive");
    const meta = seed("cms-medicare-landscape", landscape, body);
    seed("cms-partd-spuf-quarterly", spuf, "synthetic spuf archive");
    const listed = await cachedArchives("landscape", root);
    expect(listed.map((entry) => entry.archive.label)).toEqual(["202610"]);
    expect(listed[0]!.metadata).toEqual(meta);
    expect(
      (await cachedSpuf("quarterly", root)).map((e) => e.archive.label),
    ).toEqual(["20261007"]);
    // Listing reads sidecars only; no payload is copied and nothing lands under raw/.
    await expect(readFile(listed[0]!.path)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const ready = await ensureCachedPayload(root, listed[0]!);
    expect(ready.path).toBe(listed[0]!.path);
    expect(await readFile(ready.path)).toEqual(body);
    expect(await rawFiles()).toEqual([]);
  });

  it("with the local store the paths are the cached files", async () => {
    configureHostBlobStore(undefined);
    expect(remoteSnapshotStore(root)).toBeUndefined();
    expect(await cachedArchives("landscape", root)).toEqual([]);
  });

  it("negative control: a listing that reads raw/ directly finds nothing", async () => {
    seed("cms-medicare-landscape", landscape, "synthetic landscape archive");
    await mutant<typeof MedicareAcquire>(
      "ingest/medicare/acquire.ts",
      "sidecarNames(dataDir, source)",
      `${fsRead}.readdir((await import("node:path")).join(dataDir, "raw", source))`,
      async (module) => {
        expect(await module.cachedArchives("landscape", root)).toEqual([]);
      },
    );
  });
});

describe("georgia access", () => {
  const admitted = {
    access_policy: {
      hosts: [{ host: "georgiaaccess.gov", state: "allowed" }],
    },
  } as unknown as Partial<SnapshotMetadata>;
  const mr =
    "https://georgiaaccess.gov/wp-content/uploads/MR-PUF_20261015105252_2027.csv";

  it("reads the registry sidecar and payload from the store", async () => {
    const body = "State,Issuer ID,URL Submitted\nGA,00000,https://x.test/\n";
    const meta = seed("georgia-access-puf", mr, body, admitted);
    const registry = await cachedGeorgiaRegistry(root, 2027);
    expect(registry.metadata).toEqual(meta);
    expect(await readFile(registry.path, "utf8")).toBe(body);
    expect(await rawFiles()).toEqual([]);
  });

  it("still fails with ENOENT when the store holds nothing for the source", async () => {
    await expect(cachedGeorgiaAccess(root, 2027)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("negative control: a registry lookup that reads raw/ directly fails", async () => {
    seed("georgia-access-puf", mr, "State\n", admitted);
    await mutant<typeof Georgia>(
      "ingest/sbe/georgia.ts",
      `const found: SnapshotMetadata[] = [];
  for (const name of await sidecarNames(dataDir, GEORGIA_ACCESS_SOURCE, {
    missing: "throw",
  }))`,
      `const found: SnapshotMetadata[] = [];
  for (const name of await ${fsRead}.readdir(dataDir + "/raw/" + GEORGIA_ACCESS_SOURCE))`,
      async (module) => {
        await expect(module.cachedGeorgiaRegistry(root, 2027)).rejects.toThrow(
          /ENOENT/,
        );
      },
    );
  });
});

/** A PUF manifest naming one machine-readable URL registry snapshot. */
function pufManifest(registry: SnapshotMetadata) {
  return {
    schema_version: 1,
    publisher: "Centers for Medicare & Medicaid Services",
    created_at: "2026-11-01T00:00:00.000Z",
    dry_run: false,
    landing_page: registry,
    files: [
      {
        year: 2027,
        kind: "machine-readable-url",
        url: registry.url,
        status: "ok",
        snapshot_id: registry.sha256,
        sha256: registry.sha256,
        bytes: registry.bytes,
        issues: [],
      },
    ],
  };
}

describe("qhp and PUF manifests", () => {
  const mrUrl = "https://download.cms.gov/marketplace-puf/2027/mr-puf.zip";

  it("finds the newest manifest and its registry snapshot in the store", async () => {
    const registry = seed("cms-exchange-puf", mrUrl, "synthetic registry");
    const text = `${JSON.stringify(pufManifest(registry), null, 2)}\n`;
    await storeCachedText(
      snapshotStore(root),
      "cms-exchange-puf",
      "manifest-2026-11-01T00-00-00.000Z.json",
      text,
    );
    const found = await cachedRegistry(root, 2027);
    expect(found.metadata).toEqual(registry);
    expect(await readFile(found.path, "utf8")).toBe("synthetic registry");
    const newest = await newestPufManifest(root);
    expect(await readFile(newest.manifestPath, "utf8")).toBe(text);
    expect(newest.manifest.files).toHaveLength(1);
    expect(await rawFiles()).toEqual([]);
  });

  it("acquirePufs writes its manifest to the remote store", async () => {
    const landing = join(root, "landing.html");
    await writeFile(landing, "<html><body>no datasets listed</body></html>");
    const metadata = seed(
      "cms-exchange-puf",
      "https://www.cms.gov/marketplace/resources/data/public-use-files",
      "landing",
    );
    const fetcher = (async () => ({
      outcome: "downloaded",
      path: landing,
      metadata,
      snapshotId: metadata.snapshot_id,
    })) as unknown as () => Promise<FetchResult>;
    const result = await acquirePufs({
      dataDir: root,
      year: 2027,
      fetcher,
      now: () => new Date("2026-11-02T00:00:00.000Z"),
    });
    const key = "raw/cms-exchange-puf/manifest-2026-11-02T00-00-00.000Z.json";
    expect(store.objects.has(key)).toBe(true);
    expect(await readFile(result.manifestPath!, "utf8")).toBe(
      store.objects.get(key)!.toString("utf8"),
    );
    expect(await rawFiles()).toEqual([]);
  });

  it("resolves a child payload recorded on another host through the store", async () => {
    const body = JSON.stringify([{ npi: "1234567893" }]);
    const meta = seed("qhp-child-provider_urls-abc", "https://x.test/p", body);
    const records: unknown[] = [];
    for await (const value of providerCachedRecords(childOf(meta)))
      records.push(value);
    expect(records).toEqual([{ npi: "1234567893" }]);
  });

  it("reuses a QHP acquisition another source holds in the store", async () => {
    const url = "https://issuer.test/providers.json";
    const meta = seed("qhp-child-provider_urls-other", url, "[]");
    expect(
      await priorHash(root, "qhp-child-provider_urls-mine", url),
    ).toMatchObject({
      source: "qhp-child-provider_urls-other",
      sha256: meta.sha256,
    });
    configureHostBlobStore(undefined);
    expect(
      await priorHash(root, "qhp-child-provider_urls-mine", url),
    ).toBeUndefined();
  });

  it("negative control: a registry lookup that lists raw/ directly fails", async () => {
    const registry = seed("cms-exchange-puf", mrUrl, "synthetic registry");
    await storeCachedText(
      snapshotStore(root),
      "cms-exchange-puf",
      "manifest-2026-11-01T00-00-00.000Z.json",
      JSON.stringify(pufManifest(registry)),
    );
    await mutant<typeof Registry>(
      "ingest/qhp/discover-registry.ts",
      `cachedNames(dataDir, source, { missing: "throw" })`,
      `${fsRead}.readdir(join(dataDir, "raw", source))`,
      async (module) => {
        await expect(module.cachedRegistry(root, 2027)).rejects.toThrow(
          /ENOENT/,
        );
      },
    );
  });

  it("negative control: a manifest lookup that lists raw/ directly fails", async () => {
    const registry = seed("cms-exchange-puf", mrUrl, "synthetic registry");
    await storeCachedText(
      snapshotStore(root),
      "cms-exchange-puf",
      "manifest-2026-11-01T00-00-00.000Z.json",
      JSON.stringify(pufManifest(registry)),
    );
    await mutant<typeof ImportSource>(
      "ingest/puf/import-source.ts",
      `cachedNames(dataDir, "cms-exchange-puf", { missing: "throw" })`,
      `${fsRead}.readdir(directory)`,
      async (module) => {
        await expect(module.newestPufManifest(root)).rejects.toThrow(/ENOENT/);
      },
    );
  });

  it("negative control: a child reader that opens raw_path directly fails", async () => {
    const meta = seed(
      "qhp-child-provider_urls-abc",
      "https://x.test/p",
      JSON.stringify([]),
    );
    await mutant<typeof Provider>(
      "ingest/qhp/provider.ts",
      "const path = await childPayloadPath(child);",
      "const path = child.raw_path!;",
      async (module) => {
        const read = async () => {
          await module.providerCachedRecords(childOf(meta)).next();
        };
        await expect(read()).rejects.toMatchObject({ code: "ENOENT" });
      },
    );
  });
});

/** A downloaded child row whose raw_path is another host's local copy. */
const childOf = (meta: SnapshotMetadata) => ({
  child_id: "1",
  snapshot_id: `qhp-child:provider_urls:${meta.sha256}`,
  raw_path: join(
    "/elsewhere",
    "blob-read",
    "raw",
    meta.source,
    meta.sha256,
    "payload",
  ),
  sha256: meta.sha256,
  status: "downloaded",
  kind: "provider_urls",
  url: meta.url,
  url_sha256: sha(meta.url),
  http_status: 200,
  compressed_bytes: String(meta.bytes),
});

describe("geocode transfer", () => {
  const snapshotOf = (meta: SnapshotMetadata) => ({
    validation_state: "ACTIVE",
    source_id: meta.source,
    sha256: meta.sha256,
    requested_url: meta.url,
    compressed_bytes: String(meta.bytes),
  });
  const url =
    "https://geocoding.geo.census.gov/geocoder/locations/addressbatch";

  it("verifies retained evidence held only in the store", async () => {
    const meta = seed("census-geocoder-batch", url, "synthetic,answer\n");
    await verifyTransferSnapshot(snapshotOf(meta), root);
    expect(await rawFiles()).toEqual([]);
  });

  it("keeps the Census request index in the store, so a repeat batch sends nothing", async () => {
    let calls = 0;
    const options = {
      dataDir: root,
      lookup: async () => [{ address: "8.8.8.8", family: 4 as const }],
      transport: async () => {
        calls++;
        return {
          status: 200,
          headers: { "content-type": "text/csv" },
          body: Readable.from('"1","input","No_Match"\n'),
        };
      },
    };
    const csv = "1,901 Bagby St,Houston,TX,77002\n";
    expect((await acquireBatch(csv, options)).requests).toBe(1);
    const index = [...store.objects.keys()].filter((key) =>
      key.startsWith("raw/census-geocoder-requests/"),
    );
    expect(index.map((key) => key.slice(key.lastIndexOf(".")))).toEqual([
      ".csv",
      ".json",
    ]);
    const again = await acquireBatch(csv, options);
    expect(again.requests).toBe(0);
    expect(calls).toBe(1);
    expect(await rawFiles()).toEqual([]);
  });

  it("finds the cached county outline file in the store", async () => {
    const meta = seed(
      "census-county-outlines-2024",
      "https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_us_county_500k.zip",
      "synthetic outlines",
    );
    expect(await cachedSha(root)).toBe(meta.sha256);
  });

  it("negative control: a verifier that reads the raw/ sidecar directly fails", async () => {
    const meta = seed("census-geocoder-batch", url, "synthetic,answer\n");
    await mutant<typeof Transfer>(
      "ingest/geocode/transfer.ts",
      `readCachedText(root, source, snapshot.sha256 + ".meta.json")`,
      `${fsRead}.readFile(root + "/raw/" + source + "/" + snapshot.sha256 + ".meta.json", "utf8")`,
      async (module) => {
        await expect(
          module.verifyTransferSnapshot(snapshotOf(meta), root),
        ).rejects.toMatchObject({ code: "ENOENT" });
      },
    );
  });
});

describe("NUCC taxonomy plugin", () => {
  const url = "https://www.nucc.org/images/stories/CSV/nucc_taxonomy_251.csv";
  const releaseFile = new URL(
    "../../plugins/source-nucc-taxonomy/src/release.ts",
    import.meta.url,
  );

  it("reuses a release copy held in the fetch cache's store", async () => {
    const meta = seed("nucc-provider-taxonomy", url, "Code,Grouping\n");
    expect(
      await expectedHash(
        root,
        "nucc-provider-taxonomy",
        url,
        snapshotStore(root),
      ),
    ).toBe(meta.sha256);
    // Without the store the plugin reads raw/ on disk, which holds nothing here.
    expect(
      await expectedHash(root, "nucc-provider-taxonomy", url),
    ).toBeUndefined();
  });

  it("negative control: a lookup that ignores the store finds nothing", async () => {
    seed("nucc-provider-taxonomy", url, "Code,Grouping\n");
    const planted = await plantMutant(
      releaseFile,
      "if (store) {",
      "if (false) {",
    );
    try {
      const module = (await import(/* @vite-ignore */ planted.path)) as {
        expectedHash: typeof expectedHash;
      };
      expect(
        await module.expectedHash(
          root,
          "nucc-provider-taxonomy",
          url,
          snapshotStore(root),
        ),
      ).toBeUndefined();
    } finally {
      await planted.cleanup();
    }
  });
});

describe("snapshot paths", () => {
  it("with the local store a raw/ path is the file it always was", () => {
    configureHostBlobStore(undefined);
    expect(snapshotPath(root, "cms-exchange-puf")).toBe(
      join(root, "raw", "cms-exchange-puf"),
    );
    expect(snapshotPath(root, "cms-exchange-puf", "manifest-x.json")).toBe(
      join(root, "raw", "cms-exchange-puf", "manifest-x.json"),
    );
  });

  it("with a remote store a raw/ path is the store's local copy, never <dataDir>/raw", () => {
    expect(snapshotPath(root, "cms-exchange-puf", "manifest-x.json")).toBe(
      snapshotStore(root).localPath("raw/cms-exchange-puf/manifest-x.json"),
    );
    expect(snapshotPath(root, "cms-exchange-puf", "manifest-x.json")).not.toBe(
      join(root, "raw", "cms-exchange-puf", "manifest-x.json"),
    );
  });
});

describe("QHP provider runner", () => {
  const source = "qhp-76589-2026-provider_urls";
  const url = "https://example.test/providers.json";

  it("pins the one provider download the store holds", async () => {
    const meta = seed(source, url, '{"synthetic":true}');
    expect(await soleCachedHash(root, source)).toBe(meta.sha256);
    expect(await rawFiles()).toEqual([]);
  });

  it("pins nothing when the source holds none or several downloads", async () => {
    expect(await soleCachedHash(root, source)).toBeUndefined();
    seed(source, url, "first synthetic body");
    seed(source, url, "second synthetic body");
    expect(await soleCachedHash(root, source)).toBeUndefined();
  });

  it("with the local store reads the sidecar under raw/", async () => {
    configureHostBlobStore(undefined);
    const directory = join(root, "raw", source);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, `${"a".repeat(64)}.meta.json`),
      JSON.stringify({ sha256: "a".repeat(64) }),
    );
    expect(await soleCachedHash(root, source)).toBe("a".repeat(64));
  });

  it("negative control: a lookup that reads raw/ directly pins nothing", async () => {
    seed(source, url, '{"synthetic":true}');
    await mutant<typeof ProviderAcquire>(
      "ingest/qhp/provider-acquire.ts",
      "const names = await sidecarNames(dataDir, source, options);",
      `const names = (await ${fsRead}.readdir(dataDir + "/raw/" + source)).filter((name) => name.endsWith(".meta.json"));`,
      async (module) => {
        expect(await module.soleCachedHash(root, source)).toBeUndefined();
      },
    );
  });
});

describe("bootstrap", () => {
  /** A manifest held only in the store, for a dry run to size from. */
  function seedManifest(): number {
    const files = ["rate", "plan-attributes"].map((kind, index) => ({
      kind,
      year: 2026,
      status: "ok",
      snapshot_id: sha(kind),
      sha256: sha(kind),
      bytes: 1000 + index,
      url: `https://download.cms.gov/marketplace-puf/2026/${kind}-puf.zip`,
    }));
    store.objects.set(
      "raw/cms-exchange-puf/manifest-2026-11-01T00-00-00.000Z.json",
      Buffer.from(JSON.stringify({ schema_version: 1, dry_run: false, files })),
    );
    return files.reduce((sum, file) => sum + file.bytes, 0);
  }
  const args = ["bootstrap", "--states", "TX", "--years", "2026", "--dry-run"];
  const plannedBytes = async (run: typeof runBootstrap) => {
    const lines: string[] = [];
    const open = () => {
      throw new Error("a dry run must not connect");
    };
    await run(args.slice(1), open, {
      out: (line) => lines.push(line),
      error: () => undefined,
    });
    return lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((row) => row.id === "puf-acquire-2026")?.estimated_download_bytes;
  };

  it("a dry run sizes the PUF step from a manifest held only in the store", async () => {
    const total = seedManifest();
    expect(await plannedBytes(runBootstrap)).toBe(total);
    expect(await rawFiles()).toEqual([]);
  });

  it("negative control: a manifest lookup that lists raw/ directly sizes nothing", async () => {
    seedManifest();
    await mutant<typeof Bootstrap>(
      "worker/bootstrap.ts",
      `const name = (await cachedNames(dataDir, "cms-exchange-puf"))`,
      `const name = (await ${fsRead}.readdir(dataDir + "/raw/cms-exchange-puf"))`,
      async (module) => {
        expect(await plannedBytes(module.runBootstrap)).toBe("unknown");
      },
    );
  });
});
