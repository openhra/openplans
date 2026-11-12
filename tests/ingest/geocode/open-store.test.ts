import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Readable } from "node:stream";
import { deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BlobStore } from "@openplans/plugin-sdk";
import { configureHostBlobStore } from "../../../src/fetch/blob/index.js";
import type { Transport } from "../../../src/fetch/transport.js";
import type * as OpenStore from "../../../src/ingest/geocode/open-store.js";
import {
  acquireOpenSnapshot,
  openExtractSource,
  openSnapshotDirectory,
  pbfDataTimestamp,
  prepareOpenSnapshot,
  readOpenInputs,
} from "../../../src/ingest/geocode/open-store.js";
import { plantMutant } from "../../../src/plugins/testing/index.js";

/**
 * The open geocoder's extracts over a store that offers only the SDK interface, so nothing is a
 * file under `<dataDir>/raw`. Every extract here is a synthetic header-only PBF; no network,
 * Docker or real geocoder runs.
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
const md5 = (data: Buffer) => createHash("md5").update(data).digest("hex");

/** Protobuf helpers for a synthetic OSM PBF that holds only its header block. */
const varint = (value: number) => {
  const out: number[] = [];
  do {
    out.push((value % 128) | (value >= 128 ? 128 : 0));
    value = Math.floor(value / 128);
  } while (value > 0);
  return Buffer.from(out);
};
const field = (number: number, value: number | Buffer) =>
  typeof value === "number"
    ? Buffer.concat([varint(number * 8), varint(value)])
    : Buffer.concat([varint(number * 8 + 2), varint(value.length), value]);
function syntheticPbf(timestamp: number, compressed = false): Buffer {
  const header = Buffer.concat([
    field(4, Buffer.from("OsmSchema-V0.6")),
    field(32, timestamp),
  ]);
  const blob = compressed
    ? Buffer.concat([field(2, header.length), field(3, deflateSync(header))])
    : field(1, header);
  const blobHeader = Buffer.concat([
    field(1, Buffer.from("OSMHeader")),
    field(3, blob.length),
  ]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(blobHeader.length);
  return Buffer.concat([size, blobHeader, blob]);
}
// 2026-11-07T21:21:36Z
const stamp = 1794086496;
const extract = syntheticPbf(stamp);
const url =
  "https://download.geofabrik.de/north-america/us/texas-261107.osm.pbf";

let root: string;
let store: MemoryStore;
async function files(prefix: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(root, {
    recursive: true,
    withFileTypes: true,
  }).catch(() => []))
    if (entry.isFile())
      out.push(relative(root, join(entry.parentPath, entry.name)));
  return out.filter((path) => path.startsWith(prefix)).sort();
}
/** A transport answering the checksum and the extract; `calls` records each URL. */
function geofabrik(body = extract, checksum = md5(extract)) {
  const calls: string[] = [];
  const transport: Transport = async (requested) => {
    calls.push(requested.toString());
    const md5Request = requested.pathname.endsWith(".md5");
    return {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
      body: Readable.from([
        md5Request ? Buffer.from(`${checksum}  texas-261107.osm.pbf\n`) : body,
      ]),
    };
  };
  return {
    calls,
    options: {
      transport,
      lookup: async () => [{ address: "8.8.8.8", family: 4 as const }],
      sleep: async () => {},
      minFreeBytes: 0,
    },
  };
}
/** The filtered address index prepare-open.py leaves under work/, for readOpenInputs. */
async function writeIndex(rawSha: string) {
  const work = join(root, "work", "open-geocoder");
  await mkdir(work, { recursive: true });
  const index = Buffer.from("synthetic filtered index");
  await writeFile(join(work, "tx-261107-addresses.osm.pbf"), index);
  await writeFile(
    join(work, "tx-261107-address-index.json"),
    JSON.stringify({
      index_sha256: sha(index),
      raw_sha256: rawSha,
      profile: "nominatim-address-v1",
      state: "TX",
      data_timestamp: "2026-11-07T21:21:36+00:00",
      object_timestamp: "2026-11-07T21:20:56Z",
    }),
  );
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openplans-open-store-"));
  store = new MemoryStore();
  configureHostBlobStore(store);
  vi.stubEnv("OPENPLANS_DATA_DIR", root);
});
afterEach(async () => {
  configureHostBlobStore(undefined);
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("PBF header timestamp", () => {
  it("reads raw and zlib header blobs as download-open.py records them", async () => {
    for (const compressed of [false, true]) {
      const path = join(root, `header-${compressed}.osm.pbf`);
      await writeFile(path, syntheticPbf(stamp, compressed));
      expect(await pbfDataTimestamp(path)).toBe("2026-11-07T21:21:36+00:00");
    }
    await writeFile(join(root, "bad.osm.pbf"), Buffer.alloc(8));
    await expect(pbfDataTimestamp(join(root, "bad.osm.pbf"))).rejects.toThrow(
      "Invalid PBF header size",
    );
  });
});

describe("local store", () => {
  it("names raw/open-geocoder and reads, copies or acquires nothing", async () => {
    configureHostBlobStore(undefined);
    const { calls, options } = geofabrik();
    expect(await openSnapshotDirectory(root, "TX", "261107")).toBe(
      join(root, "raw", "open-geocoder", "tx", "261107"),
    );
    expect(await prepareOpenSnapshot(root, "TX", "261107", options)).toBe(
      undefined,
    );
    await expect(
      acquireOpenSnapshot(root, "TX", "261107", options),
    ).rejects.toThrow("download-open.py");
    expect(calls).toEqual([]);
    expect(await files("")).toEqual([]);
  });
});

describe("remote store", () => {
  it("acquires the checksum and extract through the fetch cache into the store", async () => {
    const { calls, options } = geofabrik();
    const copy = await prepareOpenSnapshot(root, "TX", "261107", options);
    expect(calls).toEqual([`${url}.md5`, url]);
    // Every acquired byte is in the store, under the fetch cache's layout and the extract key.
    const keys = [...store.objects.keys()];
    expect(
      keys.filter((key) => key.startsWith(`raw/${openExtractSource}/`)),
    ).toHaveLength(6);
    const metadataText = store.objects
      .get("raw/open-geocoder/tx/261107/metadata.json")!
      .toString();
    const metadata = JSON.parse(metadataText);
    expect(metadata).toMatchObject({
      state: "TX",
      snapshot: "261107",
      url,
      publisher_md5: md5(extract),
      sha256: sha(extract),
      bytes: extract.length,
      licence: "ODbL-1.0",
      attribution: "© OpenStreetMap contributors",
      data_timestamp: "2026-11-07T21:21:36+00:00",
      data_date: "2026-11-07",
      cache: { source: openExtractSource },
    });
    // Written as download-open.py's json.dumps writes it.
    expect(metadataText).toContain('"attribution": "\\u00a9 OpenStreetMap');
    expect(
      store.objects.get(
        `raw/${openExtractSource}/${metadata.cache.snapshot_id}/payload`,
      ),
    ).toEqual(extract);
    // Nothing went straight to raw/ on this host.
    expect(await files("raw/")).toEqual([]);
    // The copy geocoder.sh mounts holds the checked extract and its metadata.
    expect(copy).toBe(join(root, "work", "open-geocoder", "from-store"));
    expect(await readFile(join(copy!, "tx", "261107", "data.osm.pbf"))).toEqual(
      extract,
    );
    expect(
      await readFile(join(copy!, "tx", "261107", "metadata.json"), "utf8"),
    ).toBe(metadataText);
    expect(
      (await stat(join(copy!, "tx", "261107", "data.osm.pbf"))).mode & 0o777,
    ).toBe(0o644);
    // A second run finds the metadata in the store and sends nothing.
    await prepareOpenSnapshot(root, "TX", "261107", options);
    expect(calls).toHaveLength(2);
  });

  it("rejects an extract whose bytes differ from the publisher MD5 and stores no metadata", async () => {
    const { options } = geofabrik(extract, "0".repeat(32));
    await expect(
      acquireOpenSnapshot(root, "TX", "261107", options),
    ).rejects.toThrow("Publisher MD5 mismatch");
    expect(store.objects.has("raw/open-geocoder/tx/261107/metadata.json")).toBe(
      false,
    );
    expect(await files("work/")).toEqual([]);
  });

  it("copies down an extract stored in download-open.py's layout", async () => {
    const metadata = {
      state: "TX",
      snapshot: "261107",
      sha256: sha(extract),
      bytes: extract.length,
    };
    store.objects.set("raw/open-geocoder/tx/261107/data.osm.pbf", extract);
    store.objects.set(
      "raw/open-geocoder/tx/261107/metadata.json",
      Buffer.from(JSON.stringify(metadata)),
    );
    const directory = await openSnapshotDirectory(root, "TX", "261107");
    expect(await readFile(join(directory, "data.osm.pbf"))).toEqual(extract);
    expect(await files("raw/")).toEqual([]);
  });

  it("refuses a stored extract that differs from its metadata", async () => {
    store.objects.set(
      "raw/open-geocoder/tx/261107/data.osm.pbf",
      Buffer.from("tampered"),
    );
    store.objects.set(
      "raw/open-geocoder/tx/261107/metadata.json",
      Buffer.from(
        JSON.stringify({
          state: "TX",
          snapshot: "261107",
          sha256: sha(extract),
          bytes: extract.length,
        }),
      ),
    );
    await expect(openSnapshotDirectory(root, "TX", "261107")).rejects.toThrow(
      "differs from its snapshot metadata",
    );
    await expect(
      access(join(root, "work", "open-geocoder", "from-store", "tx")),
    ).resolves.toBe(false);
  });

  it("open-cli's inputs resolve from the store copy", async () => {
    const { options } = geofabrik();
    await acquireOpenSnapshot(root, "TX", "261107", options);
    await writeIndex(sha(extract));
    const inputs = await readOpenInputs(root, "TX", "261107");
    expect(inputs.dataset).toEqual({
      sha256: sha(extract),
      index_sha256: inputs.index.index_sha256,
      import_profile: "nominatim-address-v1",
      data_date: "2026-11-07",
      state: "TX",
    });
    expect(inputs.directory).toBe(
      join(root, "work", "open-geocoder", "from-store", "tx", "261107"),
    );
    expect(await files("raw/")).toEqual([]);
  });

  it("negative control: open-cli reading raw/ directly finds no extract", async () => {
    const { options } = geofabrik();
    await acquireOpenSnapshot(root, "TX", "261107", options);
    await writeIndex(sha(extract));
    const planted = await plantMutant(
      new URL("../../../src/ingest/geocode/open-store.ts", import.meta.url),
      "const directory = await openSnapshotDirectory(root, state, snapshot, options)",
      `const directory = join(root, "raw", "open-geocoder", state.toLowerCase(), snapshot)`,
    );
    try {
      const module = (await import(
        /* @vite-ignore */ planted.path
      )) as typeof OpenStore;
      await expect(
        module.readOpenInputs(root, "TX", "261107"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await planted.cleanup();
    }
  });
});

async function access(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}
