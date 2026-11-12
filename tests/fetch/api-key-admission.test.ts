// Keyed API admission (accessMode "api-key"). Synthetic host and synthetic key; no network.
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AdmissionSession,
  FetchError,
  admissionManifestSchema,
  fetchToCache,
  shippedManifestPaths,
} from "../../src/fetch/index.js";
import type {
  AdmissionManifest,
  FetchOptions,
  PublisherPolicy,
} from "../../src/fetch/index.js";

vi.mock("../../src/fetch/limiter.js", () => ({
  leaseHost: async () => async () => {},
}));

/** Manifest file names only, so the checkout's own directory names cannot affect the check. */
const shippedManifestNames = (paths: readonly string[]) =>
  paths.map((path) => basename(path));
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const plantedKey = "PLANTED-synthetic-key-7f3a9c1e";
const docs = "Synthetic API documentation: live per-question access.";
let directory: string;
let manifestPath: string;
let sent: string[];
let robotsStatus: number;
let dataStatus: number;
let dataBody: string;

function keyed(): PublisherPolicy {
  const now = new Date().toISOString();
  return {
    host: "api.test",
    state: "allowed",
    accessMode: "api-key",
    apiKey: { env: "SYNTHETIC_API_KEY", queryParam: "apikey" },
    evidence: [
      { url: "https://api.test/robots.txt", observedAt: now, status: 401 },
    ],
    scope: { products: ["synthetic"], states: ["US"], years: [2026] },
    discoveryUrls: ["https://docs.test/api/"],
    permittedPaths: ["/api/v1/drugs/covered"],
    delegates: [],
    attribution: "Synthetic fixture",
    updatePolicy: "Synthetic",
    delayMs: 1000,
    jobCaps: { maxRequests: 10, maxTransferBytes: 1024 ** 2 },
    robots: {
      url: "https://api.test/robots.txt",
      status: 401,
      sha256: null,
      checkedAt: now,
      notApplicable: "Keyed API answers 401 without a key",
    },
    terms: {
      url: "https://docs.test/api/",
      disposition: "allowed",
      sha256: digest(docs),
      reviewedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    },
  };
}
async function save(publishers: PublisherPolicy[]): Promise<void> {
  const manifest: AdmissionManifest = { version: 1, publishers };
  await writeFile(manifestPath, JSON.stringify(manifest));
}
function options(admission: AdmissionSession): FetchOptions {
  return {
    source: "synthetic-api",
    dataDir: directory,
    allowHosts: ["api.test"],
    expectedContent: "json",
    admission,
    maxAttempts: 1,
    maxRedirects: 0,
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
    transport: async (url) => {
      sent.push(url.href);
      let status = dataStatus;
      let body = dataBody;
      if (url.pathname === "/robots.txt") {
        status = url.hostname === "api.test" ? robotsStatus : 404;
        body = status === 401 ? '{"message":"No API key found"}' : "";
      } else if (url.hostname === "docs.test") {
        status = 200;
        body = docs;
      }
      return { status, headers: {}, body: Readable.from([body]) };
    },
  };
}
const dataUrl = "https://api.test/api/v1/drugs/covered?year=2026&drugs=1";

async function everyStoredFile(): Promise<string> {
  const out: string[] = [];
  async function walk(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(await readFile(full, "utf8"));
    }
  }
  await walk(directory);
  return out.join("\n");
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "openplans-synthetic-keyed-"));
  manifestPath = join(directory, "access.json");
  sent = [];
  robotsStatus = 401;
  dataStatus = 200;
  dataBody = '{"coverage":[{"synthetic":true}]}';
  await save([keyed()]);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

describe("keyed API admission", () => {
  it("refuses a keyed host without a key, before any request", async () => {
    vi.stubEnv("SYNTHETIC_API_KEY", "");
    const error = await fetchToCache(
      dataUrl,
      options(new AdmissionSession(manifestPath)),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FetchError);
    expect((error as FetchError).code).toBe("admission_denied");
    expect((error as FetchError).message).toContain("SYNTHETIC_API_KEY");
    expect(sent).toEqual([]);
  });

  it("admits on the API docs when robots answers the reviewed 401, and never records the key", async () => {
    vi.stubEnv("SYNTHETIC_API_KEY", plantedKey);
    const logs: unknown[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, method).mockImplementation((...args) => {
        logs.push(args);
      });
    const result = await fetchToCache(
      dataUrl,
      options(new AdmissionSession(manifestPath)),
    );
    expect(result.outcome).toBe("downloaded");
    // Robots (no key), docs host robots and docs (no key), then one data call with the key.
    const [robots, ...rest] = sent;
    expect(robots).toBe("https://api.test/robots.txt");
    const policy = rest.filter((url) => new URL(url).hostname === "docs.test");
    expect(policy).toEqual([
      "https://docs.test/robots.txt",
      "https://docs.test/api/",
    ]);
    const data = sent.filter((url) => url.includes("/drugs/covered"));
    expect(data).toHaveLength(1);
    expect(new URL(data[0]!).searchParams.get("apikey")).toBe(plantedKey);
    expect(sent.filter((url) => url.includes(plantedKey))).toHaveLength(1);
    const host = result.admission!.hosts.find((h) => h.host === "api.test")!;
    expect(host.accessMode).toBe("api-key");
    expect(host.apiKeyParam).toBe("apikey");
    expect(host.termsUrl).toBe("https://docs.test/api/");
    expect(host.termsSha256).toBe(digest(docs));
    expect(host.robots).toMatchObject({
      status: 401,
      sha256: null,
      notApplicable: true,
    });
    const recorded = JSON.stringify([result, logs]) + (await everyStoredFile());
    expect(recorded).not.toContain(plantedKey);
    expect(result.outcome === "downloaded" && result.metadata.url).not.toMatch(
      /apikey=(?!%5BREDACTED%5D)/,
    );
  });

  it("keeps the key out of errors and their evidence", async () => {
    vi.stubEnv("SYNTHETIC_API_KEY", plantedKey);
    dataStatus = 500;
    const error = await fetchToCache(
      dataUrl,
      options(new AdmissionSession(manifestPath)),
    ).catch((caught: unknown) => caught as FetchError);
    expect(error).toBeInstanceOf(FetchError);
    const text = JSON.stringify({
      message: (error as FetchError).message,
      evidence: (error as FetchError).evidence,
      stack: (error as FetchError).stack,
    });
    expect(text).not.toContain(plantedKey);
    expect(await everyStoredFile()).not.toContain(plantedKey);
  });

  it("negative control: a 401 at robots holds an ordinary entry", async () => {
    vi.stubEnv("SYNTHETIC_API_KEY", plantedKey);
    const plain = keyed();
    delete plain.accessMode;
    delete plain.apiKey;
    plain.delayMs = 5000;
    plain.robots = {
      url: "https://api.test/robots.txt",
      status: 200,
      sha256: digest(""),
      checkedAt: new Date().toISOString(),
    };
    await save([plain]);
    await expect(
      fetchToCache(dataUrl, options(new AdmissionSession(manifestPath))),
    ).rejects.toMatchObject({ code: "http_status", status: 401 });
    expect(sent).toEqual(["https://api.test/robots.txt"]);
  });

  it("negative control: a keyed host whose robots answers anything but 401 or a file holds", async () => {
    vi.stubEnv("SYNTHETIC_API_KEY", plantedKey);
    robotsStatus = 403;
    await expect(
      fetchToCache(dataUrl, options(new AdmissionSession(manifestPath))),
    ).rejects.toMatchObject({ code: "http_status", status: 403 });
    expect(sent.some((url) => url.includes("/drugs/"))).toBe(false);
  });

  it("refuses changed API docs before any keyed request", async () => {
    vi.stubEnv("SYNTHETIC_API_KEY", plantedKey);
    const changed = keyed();
    changed.terms!.sha256 = digest("other docs");
    await save([changed]);
    await expect(
      fetchToCache(dataUrl, options(new AdmissionSession(manifestPath))),
    ).rejects.toMatchObject({ code: "admission_denied" });
    expect(sent.some((url) => url.includes(plantedKey))).toBe(false);
  });

  it("takes the key from the session options when given", async () => {
    vi.stubEnv("SYNTHETIC_API_KEY", "");
    const session = new AdmissionSession(manifestPath, undefined, {
      apiKeys: { "api.test": plantedKey },
    });
    await fetchToCache(dataUrl, options(session));
    expect(sent.at(-1)).toContain(`apikey=${plantedKey}`);
    expect(session.pacingFloorMs(new URL(dataUrl))).toBe(1000);
  });

  it("schema: a keyed entry needs its 401 recorded, and only keyed entries go below 5 s", () => {
    const good = keyed();
    expect(
      admissionManifestSchema.safeParse({ version: 1, publishers: [good] })
        .success,
    ).toBe(true);
    const unrecorded = keyed();
    delete unrecorded.robots!.notApplicable;
    const fast = keyed();
    delete fast.accessMode;
    delete fast.apiKey;
    fast.robots = { ...fast.robots!, notApplicable: undefined };
    const keyless = keyed();
    delete keyless.apiKey;
    const wrongStatus = keyed();
    wrongStatus.robots!.status = 403;
    for (const mutant of [unrecorded, fast, keyless, wrongStatus])
      expect(
        admissionManifestSchema.safeParse({
          version: 1,
          publishers: [JSON.parse(JSON.stringify(mutant))],
        }).success,
      ).toBe(false);
  });

  it("ships the CMS entry only with OPENPLANS_CMS_FALLBACK=on, and it parses", async () => {
    vi.stubEnv("OPENPLANS_CMS_FALLBACK", "");
    expect(shippedManifestNames(shippedManifestPaths())).toEqual([
      "federal-publishers.json",
    ]);
    vi.stubEnv("OPENPLANS_CMS_FALLBACK", "on");
    expect(shippedManifestNames(shippedManifestPaths())).toEqual([
      "federal-publishers.json",
      "cms-marketplace-api.json",
    ]);
    const path = shippedManifestPaths().find((p) =>
      p.endsWith("cms-marketplace-api.json"),
    )!;
    const manifest = admissionManifestSchema.parse(
      JSON.parse(await readFile(path, "utf8")),
    );
    expect(manifest.publishers[0]).toMatchObject({
      host: "marketplace.api.healthcare.gov",
      accessMode: "api-key",
      apiKey: { env: "CMS_API_KEY", queryParam: "apikey" },
      delayMs: 1000,
    });
  });

  it("judges shipped manifests by file name, whatever directory holds the checkout", () => {
    const at = (root: string) =>
      shippedManifestNames([`${root}/data/access/federal-publishers.json`]);
    // A checkout under a directory whose name contains "cms-" still passes, where a substring
    // test of the full path would not.
    expect(
      [
        "/work/lane-cms-pins/openplans/data/access/federal-publishers.json",
      ].some((path) => path.includes("cms-")),
    ).toBe(true);
    expect(at("/work/lane-cms-pins/openplans")).toEqual([
      "federal-publishers.json",
    ]);
    // A shipped CMS manifest is still caught, wherever it lives.
    expect(
      shippedManifestNames([
        "/work/plain/openplans/data/access/federal-publishers.json",
        "/work/plain/openplans/data/access/cms-marketplace-api.json",
      ]),
    ).not.toEqual(["federal-publishers.json"]);
  });
});
