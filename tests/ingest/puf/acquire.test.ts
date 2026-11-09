import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { join } from "node:path";
import {
  acquirePufs,
  discoverPufs,
  PUF_KINDS,
  PUF_LANDING_URL,
  runPufAcquire,
} from "../../../src/ingest/puf/acquire.js";
import {
  inspectPufArchive,
  parsePufHeader,
} from "../../../src/ingest/puf/acquire-archive.js";
import { FetchError } from "../../../src/fetch/index.js";
import * as fetchModule from "../../../src/fetch/index.js";
import type {
  FetchOptions,
  FetchResult,
  SnapshotMetadata,
} from "../../../src/fetch/index.js";
import { runWorker } from "../../../src/worker/commands.js";
import { syntheticZip } from "../../fixtures/fetch/generate.mjs";

const fixture = (name: string) =>
  readFile(
    new URL(`../../fixtures/puf/acquire/${name}`, import.meta.url),
    "utf8",
  );
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "openplans-puf-acquire-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

async function fakeSnapshot(
  url: string,
  body: string | Buffer,
): Promise<Exclude<FetchResult, { outcome: "not_modified" }>> {
  const bytes = Buffer.from(body);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const path = join(directory, sha256);
  await writeFile(path, bytes);
  const metadata: SnapshotMetadata = {
    snapshot_id: sha256,
    source: "cms-exchange-puf",
    url,
    final_url: url,
    redirect_chain: [],
    status: 200,
    content_type: url === PUF_LANDING_URL ? "text/html" : "application/zip",
    etag: "synthetic",
    last_modified: null,
    sha256,
    bytes: bytes.length,
    fetched_at: "2026-11-07T00:00:00.000Z",
  };
  return {
    outcome: "downloaded",
    snapshotId: sha256,
    path,
    metadataPath: `${path}.meta.json`,
    metadata,
  };
}

async function fakeFetcher(
  html?: string,
  brokenUrl?: string,
  body = "PlanId,Value\r\nSYNTHETIC,1\r\n",
) {
  html ??= await fixture("landing.real.html");
  return vi.fn(
    async (
      input: string | URL,
      _options: FetchOptions,
    ): Promise<FetchResult> => {
      const url = input.toString();
      if (url === PUF_LANDING_URL) return fakeSnapshot(url, html);
      if (url === brokenUrl)
        throw new FetchError(
          "html_error_page",
          "Synthetic publisher returned HTML",
        );
      return fakeSnapshot(
        url,
        syntheticZip([
          { name: "SYNTHETIC.csv", body },
          {
            name: "SYNTHETIC.xlsx",
            body: "synthetic format classifier only; not a real workbook",
          },
        ]),
      );
    },
  );
}

describe("CMS PUF discovery", () => {
  it("finds exactly eight real advertised archives for each requested year", async () => {
    const html = await fixture("landing.real.html");
    expect(Buffer.byteLength(html)).toBeLessThan(200_000);
    const files = discoverPufs(html);
    expect(files).toHaveLength(16);
    for (const year of [2026, 2027]) {
      expect(
        files.filter((file) => file.year === year).map((file) => file.kind),
      ).toEqual([...PUF_KINDS]);
      expect(
        files
          .filter((file) => file.year === year)
          .every(
            (file) =>
              file.status === "ok" &&
              file.url?.startsWith(
                `https://download.cms.gov/marketplace-puf/${year}/`,
              ),
          ),
      ).toBe(true);
    }
  });

  it("negative control: missing PY2027 stays not_published with null URLs; renamed Rate link is still discovered", async () => {
    const files = discoverPufs(await fixture("landing.synthetic.html"));
    expect(files.filter((file) => file.year === 2027)).toEqual(
      PUF_KINDS.map((kind) => ({
        year: 2027,
        kind,
        url: null,
        status: "not_published",
      })),
    );
    expect(
      files.find((file) => file.year === 2026 && file.kind === "rate"),
    ).toMatchObject({
      status: "ok",
      url: "https://download.cms.gov/marketplace-puf/2026/rate-puf.zip",
    });
  });

  it("handles relative links, single/unquoted hrefs, entities, nested spans and reordered attributes", () => {
    const files = discoverPufs(
      `<h3 class='year'>PY2026 Exchange PUF Datasets</h3>
      <a title='x' href='/files/rate-puf.zip?download=1&amp;version=2'><span>Rate</span> PUF</a>
      <a href=/files/network-puf.zip>Renamed network download</a>
      <a href='/files/new-publisher-name.zip'>Plan Attributes PUF</a>`,
      [2026],
    );
    expect(files.find((file) => file.kind === "rate")?.url).toBe(
      "https://www.cms.gov/files/rate-puf.zip?download=1&version=2",
    );
    expect(files.find((file) => file.kind === "network")?.status).toBe("ok");
    expect(files.find((file) => file.kind === "plan-attributes")?.url).toBe(
      "https://www.cms.gov/files/new-publisher-name.zip",
    );
  });

  it("ignores comments, scripts, dictionaries, other sections and unrequested years", () => {
    const html = `<h3>2026 Exchange PUF Datasets</h3>
      <!-- <a href='/rate-puf.zip'>Rate PUF</a> -->
      <script><a href='/rate-puf.zip'>Rate PUF</a></script>
      <a href='/rate-puf.pdf'>Rate PUF</a><h3>Other downloads</h3>
      <a href='/rate-puf.zip'>Rate PUF</a><h3>2025 Exchange PUF Datasets</h3>
      <a href='/rate-puf.zip'>Rate PUF</a>`;
    expect(
      discoverPufs(html).every((file) => file.status === "not_published"),
    ).toBe(true);
  });

  it("ignores malformed href escapes without losing the other published files", () => {
    const files = discoverPufs(
      `<h3>2026 Exchange PUF Datasets</h3>
      <a href='/bad%zz.zip'>Rate PUF</a><a href='/network-puf.zip'>Network PUF</a>`,
      [2026],
    );
    expect(files.find((file) => file.kind === "rate")?.status).toBe(
      "not_published",
    );
    expect(files.find((file) => file.kind === "network")?.status).toBe("ok");
  });

  it("quarantines ambiguous, mislabeled and wrong-year archives instead of selecting one", () => {
    for (const anchors of [
      `<a href='/a/rate-puf.zip'>Rate PUF</a><a href='/b/rate-puf.zip'>Rate PUF</a>`,
      `<a href='/2027/rate-puf.zip'>Rate PUF</a>`,
      `<a href='/plan-attributes-puf.zip'>Rate PUF</a>`,
    ]) {
      expect(
        discoverPufs(
          `<h3>2026 Exchange PUF Datasets</h3>${anchors}`,
          [2026],
        ).find((file) => file.kind === "rate"),
      ).toMatchObject({ status: "discovery_conflict", url: null });
    }
  });
});

describe("bounded ZIP header inspection", () => {
  it.each([false, true])(
    "reads ZIP/ZIP64 (%s), classifies CSV/XLSX and retains sizes",
    async (zip64) => {
      const snapshot = await fakeSnapshot(
        "synthetic",
        syntheticZip(
          [
            {
              name: "data.CSV",
              body: '\uFEFF"StandardComponentId","Comma, field","Escaped ""quote"""\r\nSYNTHETIC,1,2\n',
            },
            { name: "data.xlsx", body: "synthetic classifier only" },
          ],
          { zip64 },
        ),
      );
      const members = await inspectPufArchive(snapshot.path);
      expect(members[0]).toMatchObject({
        format: "csv",
        header: ["StandardComponentId", "Comma, field", 'Escaped "quote"'],
        issues: [],
      });
      expect(members[0]!.uncompressedBytes).toBeGreaterThan(0);
      expect(members[1]).toMatchObject({ format: "xlsx", header: null });
      expect(await readdir(directory)).toEqual([snapshot.snapshotId]);
    },
  );

  it("negative control: an oversized header fails the first-line bound", async () => {
    // Deterministic low-compression text avoids tripping the ZIP expansion gate first.
    const body = Array.from({ length: 2500 }, (_, i) =>
      createHash("sha256").update(String(i)).digest("hex"),
    ).join(",");
    const snapshot = await fakeSnapshot(
      "synthetic",
      syntheticZip([{ name: "data.csv", body: `${body}\n` }]),
    );
    await expect(inspectPufArchive(snapshot.path)).rejects.toMatchObject({
      code: "too_large",
    });
  });

  it("reads only the first physical line and rejects an unfinished quoted header", async () => {
    const snapshot = await fakeSnapshot(
      "synthetic",
      syntheticZip([
        { name: "data.csv", body: 'PlanId,Value\n"unfinished data record' },
      ]),
    );
    expect((await inspectPufArchive(snapshot.path))[0]!.header).toEqual([
      "PlanId",
      "Value",
    ]);
    expect(() => parsePufHeader('"unfinished')).toThrow();
    expect(() => parsePufHeader('"PlanId"junk,Value')).toThrow();
  });
});

describe("PUF acquisition manifests", () => {
  it("uses the injected cache fetcher, records provenance and publishes a manifest outside the checkout", async () => {
    const fetcher = await fakeFetcher();
    const result = await acquirePufs({
      dataDir: directory,
      fetcher,
      now: () => new Date("2026-11-07T01:02:03Z"),
    });
    expect(fetcher).toHaveBeenCalledTimes(17);
    expect(
      fetcher.mock.calls.every(
        ([, options]) =>
          options.source === "cms-exchange-puf" &&
          options.dataDir === directory,
      ),
    ).toBe(true);
    expect(fetcher.mock.calls[0]![1].expectedContent).toBe("binary");
    expect(
      fetcher.mock.calls
        .slice(1)
        .every(([, options]) => options.expectedContent === "zip"),
    ).toBe(true);
    expect(
      result.manifest.files.every(
        (file) =>
          file.status === "ok" && file.sha256 && file.bytes && file.snapshot_id,
      ),
    ).toBe(true);
    expect(result.manifest.landing_page.url).toBe(PUF_LANDING_URL);
    expect(JSON.parse(await readFile(result.manifestPath!, "utf8"))).toEqual(
      result.manifest,
    );
    expect(result.manifestPath).toBe(
      join(
        directory,
        "raw/cms-exchange-puf/manifest-2026-11-07T01-02-03.000Z.json",
      ),
    );
  });

  it("negative control: one HTML error is recorded and all other files still succeed", async () => {
    const url = "https://download.cms.gov/marketplace-puf/2026/rate-puf.zip";
    const result = await acquirePufs({
      dataDir: directory,
      fetcher: await fakeFetcher(undefined, url),
    });
    expect(
      result.manifest.files.filter((file) => file.status === "ok"),
    ).toHaveLength(15);
    expect(
      result.manifest.files.find((file) => file.url === url),
    ).toMatchObject({
      status: "html_error_page",
      snapshot_id: null,
      members: [],
    });
  });

  it("negative control: CSV lacking both plan identifier columns is flagged in the saved manifest", async () => {
    const result = await acquirePufs({
      dataDir: directory,
      year: 2026,
      fetcher: await fakeFetcher(
        undefined,
        undefined,
        "IssuerId,Value\nSYNTHETIC,1\n",
      ),
    });
    expect(result.manifest.files).toHaveLength(8);
    expect(
      result.manifest.files.every((file) =>
        file.members[0]?.issues.includes("missing_plan_identifier"),
      ),
    ).toBe(true);
    const saved = JSON.parse(await readFile(result.manifestPath!, "utf8"));
    expect(saved.files[0].members[0].issues).toEqual([
      "missing_plan_identifier",
    ]);
  });

  it("does not fetch absent years or invent snapshot metadata", async () => {
    const fetcher = await fakeFetcher(await fixture("landing.synthetic.html"));
    const { manifest } = await acquirePufs({ dataDir: directory, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(9);
    expect(
      manifest.files
        .filter((file) => file.year === 2027)
        .every(
          (file) =>
            file.status === "not_published" &&
            file.url === null &&
            file.snapshot_id === null &&
            file.bytes === null,
        ),
    ).toBe(true);
  });

  it("dry run fetches only the landing snapshot, honors --year and writes no manifest", async () => {
    const fetcher = await fakeFetcher();
    const { manifest, manifestPath } = await acquirePufs({
      dataDir: directory,
      fetcher,
      dryRun: true,
      year: 2027,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(manifestPath).toBeNull();
    expect(manifest.dry_run).toBe(true);
    expect(manifest.files).toHaveLength(8);
    expect(
      manifest.files.every(
        (file) =>
          file.year === 2027 &&
          file.snapshot_id === null &&
          file.members.length === 0,
      ),
    ).toBe(true);
    expect(
      (await readdir(directory)).every((file) => !file.startsWith("raw")),
    ).toBe(true);
  });

  it("rejects unsupported years before any request", async () => {
    const fetcher = await fakeFetcher();
    await expect(
      acquirePufs({ dataDir: directory, fetcher, year: 2025 }),
    ).rejects.toMatchObject({ code: "invalid_options" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("revalidates a cached landing snapshot by SHA after a conditional 304", async () => {
    const landing = await fakeSnapshot(
      PUF_LANDING_URL,
      await fixture("landing.real.html"),
    );
    const sourceDir = join(directory, "raw/cms-exchange-puf");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      join(sourceDir, `${landing.snapshotId}.meta.json`),
      JSON.stringify(landing.metadata),
    );
    const fetcher = vi.fn(
      async (
        _input: string | URL,
        options: FetchOptions,
      ): Promise<FetchResult> => {
        if (options.expectedSha256) return { ...landing, outcome: "reused" };
        expect(options.conditional).toEqual({ etag: "synthetic" });
        return {
          outcome: "not_modified",
          status: 304,
          url: PUF_LANDING_URL,
          final_url: PUF_LANDING_URL,
          redirect_chain: [],
        };
      },
    );
    const result = await acquirePufs({
      dataDir: directory,
      fetcher,
      dryRun: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]![1].expectedSha256).toBe(
      landing.metadata.sha256,
    );
    expect(result.manifest.landing_page.sha256).toBe(landing.metadata.sha256);
  });

  it("requests a fresh landing page despite a prior SHA so publisher changes remain discoverable", async () => {
    const prior = await fakeSnapshot(
      PUF_LANDING_URL,
      await fixture("landing.synthetic.html"),
    );
    const sourceDir = join(directory, "raw/cms-exchange-puf");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      join(sourceDir, `${prior.snapshotId}.meta.json`),
      JSON.stringify(prior.metadata),
    );
    const fetcher = await fakeFetcher();
    const { manifest } = await acquirePufs({
      dataDir: directory,
      fetcher,
      dryRun: true,
    });
    expect(fetcher.mock.calls[0]![1].expectedSha256).toBeUndefined();
    expect(fetcher.mock.calls[0]![1].conditional).toEqual({
      etag: "synthetic",
    });
    expect(
      manifest.files
        .filter((file) => file.year === 2027)
        .every((file) => file.status === "ok"),
    ).toBe(true);
  });
});

describe("puf acquire worker branch", () => {
  it("dispatches valid dry-run flags without a database and downloads only the provenance page", async () => {
    vi.stubEnv("OPENPLANS_DATA_DIR", directory);
    const fetcher = await fakeFetcher();
    vi.spyOn(fetchModule, "fetchToCache").mockImplementation(fetcher);
    const openDatabase = vi.fn(() => {
      throw new Error("must not connect");
    });
    const output = { out: vi.fn(), error: vi.fn() };
    expect(
      await runWorker(
        ["ingest", "puf", "acquire", "--dry-run", "--year", "2027"],
        openDatabase,
        output,
      ),
    ).toBe(0);
    expect(openDatabase).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(output.error).not.toHaveBeenCalled();
    const result = JSON.parse(output.out.mock.calls[0]![0]);
    expect(result.manifest.files).toHaveLength(8);
    expect(
      result.manifest.files.every(
        (file: { year: number }) => file.year === 2027,
      ),
    ).toBe(true);
  });

  it("returns a failing CLI exit code but still writes the manifest when one download fails", async () => {
    vi.stubEnv("OPENPLANS_DATA_DIR", directory);
    const fetcher = await fakeFetcher(
      undefined,
      "https://download.cms.gov/marketplace-puf/2026/rate-puf.zip",
    );
    vi.spyOn(fetchModule, "fetchToCache").mockImplementation(fetcher);
    const output = { out: vi.fn(), error: vi.fn() };
    expect(await runPufAcquire(["--year", "2026"], output)).toBe(1);
    const result = JSON.parse(output.out.mock.calls[0]![0]);
    expect(
      result.manifest.files.filter(
        (file: { status: string }) => file.status === "ok",
      ),
    ).toHaveLength(7);
    expect(
      JSON.parse(await readFile(result.manifestPath, "utf8")).files,
    ).toHaveLength(8);
  });

  it.each([
    ["--year"],
    ["--year", "2025"],
    ["--unknown"],
    ["--dry-run", "--dry-run"],
    ["--year", "2026", "--year", "2027"],
  ])(
    "rejects invalid flags without opening a database or using the network: %j",
    async (...args) => {
      const errors: string[] = [];
      const openDatabase = vi.fn(() => {
        throw new Error("must not connect");
      });
      expect(
        await runWorker(["ingest", "puf", "acquire", ...args], openDatabase, {
          out: () => {
            throw new Error("must not succeed");
          },
          error: (message) => errors.push(message),
        }),
      ).toBe(1);
      expect(openDatabase).not.toHaveBeenCalled();
      expect(errors[0]).toContain("Usage: worker ingest puf acquire");
    },
  );

  it("accepts valid flags and reports cache errors without exposing underlying paths or errors", async () => {
    vi.stubEnv("OPENPLANS_DATA_DIR", "relative-invalid");
    const errors: string[] = [];
    expect(
      await runPufAcquire(["--year", "2027", "--dry-run"], {
        out: vi.fn(),
        error: (message) => errors.push(message),
      }),
    ).toBe(1);
    expect(errors).toEqual([
      "worker ingest puf acquire failed: invalid_options",
    ]);
  });
});
