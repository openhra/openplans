import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AdmissionSession,
  admissionManifestSchema,
  fetchToCache,
  observedHostHolds,
} from "../../src/fetch/index.js";
import type {
  AdmissionManifest,
  FetchOptions,
  PublisherPolicy,
  Transport,
} from "../../src/fetch/index.js";
import { parseRobots } from "../../src/fetch/robots.js";

vi.mock("../../src/fetch/limiter.js", () => ({
  leaseHost: async () => async () => {},
}));

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const terms = "Synthetic publisher permits scoped automated feed collection.";
let directory: string;
let manifestPath: string;
let manifest: AdmissionManifest;
let requested: { url: string; agent: string }[];
let robots: string;
let policyStatus: number;
let termsBody: string;
let dataBody: string;
let dataStatus: number;
let dataHeaders: Record<string, string>;
let options: FetchOptions;
let transport: Transport;

function publisher(host = "publisher.test"): PublisherPolicy {
  return {
    host,
    state: "allowed",
    evidence: [
      {
        url: `https://${host}/terms`,
        observedAt: new Date().toISOString(),
        status: 200,
      },
    ],
    scope: { products: ["synthetic"], states: ["TX"], years: [2026] },
    discoveryUrls: [`https://${host}/feed/index.json`],
    permittedPaths: ["/feed"],
    delegates: ["delegate.test"],
    attribution: "Synthetic fixture",
    updatePolicy: "Recheck daily",
    delayMs: 5000,
    jobCaps: { maxRequests: 200, maxTransferBytes: 50 * 1024 ** 2 },
    robots: {
      url: `https://${host}/robots.txt`,
      status: 200,
      sha256: digest("User-agent: *\nDisallow: /private\n"),
      checkedAt: new Date().toISOString(),
    },
    terms: {
      url: `https://${host}/terms`,
      disposition: "allowed",
      sha256: digest(terms),
      reviewedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    },
  };
}
async function saveManifest(): Promise<void> {
  await writeFile(manifestPath, JSON.stringify(manifest));
}
async function run(overrides: Partial<FetchOptions> = {}) {
  return fetchToCache("https://publisher.test/feed/index.json", {
    ...options,
    ...overrides,
  });
}
async function dataEntries(): Promise<string[]> {
  return readdir(join(directory, "raw", "synthetic")).catch(() => []);
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "openplans-synthetic-admission-"));
  manifestPath = join(directory, "access.json");
  manifest = {
    version: 1,
    publishers: [publisher(), publisher("delegate.test")],
  };
  await saveManifest();
  requested = [];
  robots = "User-agent: *\nDisallow: /private\n";
  policyStatus = 200;
  termsBody = terms;
  dataBody = '{"synthetic":true}';
  dataStatus = 200;
  dataHeaders = {};
  transport = async (url, context) => {
    requested.push({ url: url.href, agent: context.headers["user-agent"]! });
    let body = dataBody;
    let status = dataStatus;
    if (url.pathname === "/robots.txt") {
      body = robots;
      status = policyStatus;
    }
    if (url.pathname === "/terms") {
      body = termsBody;
      status = 200;
    }
    return {
      status,
      headers: url.pathname.startsWith("/feed") ? dataHeaders : {},
      body: Readable.from([body]),
    };
  };
  options = {
    source: "synthetic",
    dataDir: directory,
    allowHosts: ["publisher.test", "delegate.test"],
    expectedContent: "json",
    admission: new AdmissionSession(manifestPath),
    transport: (url, context) => transport(url, context),
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
    maxAttempts: 1,
  };
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe("publisher admission before acquisition and publication", () => {
  it("checks robots then pinned terms once per job, identifies requests, and attaches receipts", async () => {
    const first = await run();
    const second = await run();
    expect(requested.map((entry) => new URL(entry.url).pathname)).toEqual([
      "/robots.txt",
      "/terms",
      "/feed/index.json",
      "/feed/index.json",
    ]);
    expect(
      requested.every(
        (entry) =>
          entry.agent.includes("+https://plans.openhra.com/") &&
          !entry.agent.includes("@"),
      ),
    ).toBe(true);
    expect(first.admission?.hosts[0]).toMatchObject({
      host: "publisher.test",
      state: "allowed",
      termsSha256: digest(terms),
      robots: { status: 200, sha256: digest(robots) },
    });
    if (first.outcome === "not_modified" || second.outcome === "not_modified")
      throw new Error("Expected snapshots");
    expect(first.metadata.access_policy).toEqual(first.admission);
    expect(second.outcome).toBe("reused");
    expect(await readFile(first.path, "utf8")).toBe(dataBody);
  });

  it.each([
    "robots-disallowed",
    "terms-restricted",
    "bot-protected",
    "geo-restricted",
    "unknown",
  ] as const)("never requests or reuses a %s publisher", async (state) => {
    manifest.publishers[0]!.state = state;
    await saveManifest();
    await expect(run()).rejects.toMatchObject({ code: "admission_denied" });
    expect(requested).toEqual([]);
    expect(await dataEntries()).toEqual([]);
  });

  it.each([401, 403, 429, 500, 503])(
    "holds unresolved robots HTTP %s without a terms or data request",
    async (status) => {
      policyStatus = status;
      await expect(run()).rejects.toMatchObject({
        code: "http_status",
        status,
      });
      expect(requested.map((entry) => new URL(entry.url).pathname)).toEqual([
        "/robots.txt",
      ]);
      expect(await dataEntries()).toEqual([]);
    },
  );

  it("records a robots 404 as absent policy, while still requiring reviewed terms", async () => {
    policyStatus = 404;
    const result = await run();
    expect(result.admission?.hosts[0]?.robots).toMatchObject({
      status: 404,
      sha256: null,
    });
    expect(requested).toHaveLength(3);
  });

  it("rejects an unreviewed host even if it is allowlisted", async () => {
    manifest.publishers.shift();
    await saveManifest();
    await expect(run()).rejects.toMatchObject({ code: "admission_denied" });
    expect(requested).toEqual([]);
  });

  it("rejects a disallowed path before a data request", async () => {
    robots = "User-agent: *\nDisallow: /feed\n";
    await expect(run()).rejects.toMatchObject({ code: "admission_denied" });
    expect(requested.every((entry) => !entry.url.includes("/feed"))).toBe(true);
    expect(await dataEntries()).toEqual([]);
  });

  it("rejects changed terms bytes before a data request", async () => {
    termsBody = "Synthetic changed terms.";
    await expect(run()).rejects.toMatchObject({ code: "admission_denied" });
    expect(requested).toHaveLength(2);
    expect(await dataEntries()).toEqual([]);
  });

  it("rejects expired or unreviewed terms without network access", async () => {
    manifest.publishers[0]!.terms!.expiresAt = "2020-01-01T00:00:00Z";
    await saveManifest();
    await expect(run()).rejects.toMatchObject({ code: "admission_denied" });
    expect(requested).toEqual([]);
  });

  it.each(["/feed-other/index.json", "/private/feed.json"])(
    "requires a reviewed path boundary for %s",
    async (path) => {
      await expect(
        fetchToCache(`https://publisher.test${path}`, options),
      ).rejects.toMatchObject({ code: "admission_denied" });
      expect(requested).toEqual([]);
    },
  );

  it("rejects a modified manifest during streaming and removes staging", async () => {
    const original = transport;
    transport = async (url, context) => {
      const response = await original(url, context);
      if (url.pathname.startsWith("/feed")) {
        response.body = Readable.from(
          (async function* () {
            yield '{"synthetic":';
            manifest.publishers[0]!.state = "terms-restricted";
            await saveManifest();
            yield "true}";
          })(),
        );
      }
      return response;
    };
    await expect(run()).rejects.toMatchObject({ code: "admission_denied" });
    expect(await dataEntries()).toEqual([]);
  });

  it.each([
    "https://127.0.0.1/feed/file",
    "https://unregistered.test/feed/file",
  ])("rejects redirect %s before following it", async (location) => {
    dataStatus = 302;
    dataHeaders = { location };
    await expect(run()).rejects.toMatchObject({
      code: location.includes("127.0.0.1")
        ? "blocked_address"
        : "host_not_allowed",
    });
    expect(requested).toHaveLength(3);
    expect(await dataEntries()).toEqual([]);
  });

  it("checks an allowlisted redirect host's own robots and terms", async () => {
    const original = transport;
    transport = async (url, context) => {
      const response = await original(url, context);
      if (
        url.hostname === "publisher.test" &&
        url.pathname.startsWith("/feed")
      ) {
        response.status = 302;
        response.headers = { location: "https://delegate.test/feed/file.json" };
      }
      return response;
    };
    const result = await run();
    expect(result.admission?.hosts.map((entry) => entry.host)).toEqual([
      "publisher.test",
      "delegate.test",
    ]);
    expect(requested).toHaveLength(6);
  });

  it("rejects an allowlisted delegate without explicit delegation", async () => {
    manifest.publishers[0]!.delegates = [];
    await saveManifest();
    dataStatus = 302;
    dataHeaders = { location: "https://delegate.test/feed/file.json" };
    await expect(run()).rejects.toMatchObject({ code: "admission_denied" });
    expect(requested).toHaveLength(3);
  });

  it.each([
    "<title>Just a moment...</title>",
    "Please verify you are human",
    '<div class="g-recaptcha">',
    '<form action="/login">',
  ])(
    "rejects a challenge body before snapshot publication: %s",
    async (challenge) => {
      dataBody = challenge;
      await expect(run({ expectedContent: "binary" })).rejects.toMatchObject({
        code: "challenge_detected",
      });
      expect(await dataEntries()).toEqual([]);
      await expect(run()).rejects.toMatchObject({ code: "admission_denied" });
      expect(requested).toHaveLength(3);
    },
  );

  it("detects a challenge split across chunks", async () => {
    const original = transport;
    transport = async (url, context) => {
      const response = await original(url, context);
      if (url.pathname.startsWith("/feed"))
        response.body = Readable.from(["Please verify you ", "are human"]);
      return response;
    };
    await expect(run({ expectedContent: "binary" })).rejects.toMatchObject({
      code: "challenge_detected",
    });
    expect(await dataEntries()).toEqual([]);
  });

  it("enforces per-response and collection byte caps before publication", async () => {
    await expect(run({ maxBytes: 5 })).rejects.toMatchObject({
      code: "too_large",
    });
    expect(await dataEntries()).toEqual([]);
    options.admission = new AdmissionSession(manifestPath, {
      maxRequests: 200,
      maxTransferBytes: Buffer.byteLength(robots + terms) + 1,
    });
    await expect(run()).rejects.toMatchObject({ code: "too_large" });
    expect(await dataEntries()).toEqual([]);
  });

  it("counts policy requests against the discovery request cap", async () => {
    options.admission = new AdmissionSession(manifestPath, {
      maxRequests: 2,
      maxTransferBytes: 1024,
    });
    await expect(run()).rejects.toMatchObject({ code: "admission_denied" });
    expect(requested).toHaveLength(2);
    expect(await dataEntries()).toEqual([]);
  });

  it("enforces the publisher cap even when the session budget is larger", async () => {
    manifest.publishers[0]!.jobCaps.maxRequests = 2;
    await saveManifest();
    await expect(run()).rejects.toMatchObject({ code: "admission_denied" });
    expect(requested).toHaveLength(2);
    expect(await dataEntries()).toEqual([]);
  });

  it("retains unresolved robots evidence on the outer failure", async () => {
    policyStatus = 403;
    await expect(run()).rejects.toMatchObject({
      evidence: {
        requested_url: "https://publisher.test/feed/index.json",
        policy: {
          requested_url: "https://publisher.test/robots.txt",
          status: 403,
        },
      },
    });
  });

  it("stops a transient-status captcha without retrying the challenge", async () => {
    dataStatus = 503;
    dataBody = "Please verify you are human";
    await expect(
      run({ maxAttempts: 3, sleep: async () => {} }),
    ).rejects.toMatchObject({ code: "challenge_detected" });
    expect(requested).toHaveLength(3);
    expect(await dataEntries()).toEqual([]);
  });

  it("caps error-response bytes before retry", async () => {
    dataStatus = 500;
    dataBody = "Synthetic oversized error";
    await expect(
      run({ maxBytes: 5, maxAttempts: 3, sleep: async () => {} }),
    ).rejects.toMatchObject({ code: "too_large" });
    expect(requested).toHaveLength(3);
    expect(await dataEntries()).toEqual([]);
  });

  it("holds changed policy even when matching bytes are already cached", async () => {
    const first = await run();
    if (first.outcome === "not_modified") throw new Error("Expected snapshot");
    requested = [];
    manifest.publishers[0]!.state = "robots-disallowed";
    await saveManifest();
    await expect(
      run({
        admission: new AdmissionSession(manifestPath),
        expectedSha256: first.metadata.sha256,
      }),
    ).rejects.toMatchObject({ code: "admission_denied" });
    expect(requested).toEqual([]);
    expect(await readFile(first.path, "utf8")).toBe(dataBody);
  });

  it("revalidates robots and terms daily within a collection", async () => {
    await run();
    const tomorrow = Date.now() + 24 * 60 * 60 * 1000;
    vi.spyOn(Date, "now").mockReturnValue(tomorrow);
    try {
      robots = "User-agent: *\nDisallow: /feed\n";
      await expect(run()).rejects.toMatchObject({ code: "admission_denied" });
      expect(requested).toHaveLength(5);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("holds a policy review that crosses the daily robots deadline before data starts", async () => {
    const now = Date.now();
    const original = transport;
    transport = async (url, context) => {
      const response = await original(url, context);
      if (url.pathname === "/terms")
        vi.spyOn(Date, "now").mockReturnValue(now + 24 * 60 * 60 * 1000 + 1000);
      return response;
    };
    await expect(run()).rejects.toMatchObject({ code: "admission_denied" });
    expect(requested).toHaveLength(2);
    expect(await dataEntries()).toEqual([]);
  });

  it("requires a manifest for native transport, including an expected-hash cache request", async () => {
    vi.stubEnv("OPENPLANS_ACCESS_MANIFEST", "");
    await expect(
      run({ transport: undefined, admission: undefined }),
    ).rejects.toMatchObject({ code: "admission_required" });
    expect(requested).toEqual([]);
  });

  it("preserves hash-verified offline reuse without claiming admission", async () => {
    const first = await run();
    if (first.outcome === "not_modified") throw new Error("Expected snapshot");
    requested = [];
    vi.stubEnv("OPENPLANS_ACCESS_MANIFEST", "");
    const reused = await run({
      admission: undefined,
      transport: undefined,
      expectedSha256: first.metadata.sha256,
    });
    expect(reused.outcome).toBe("reused");
    expect(reused.admission).toBeUndefined();
    expect(requested).toEqual([]);
    await expect(
      run({
        admission: undefined,
        transport: undefined,
        expectedSha256: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "admission_required" });
  });

  it.each(observedHostHolds)(
    "preserves the observed $state hold for $host",
    async (hold) => {
      await expect(
        fetchToCache(`https://${hold.host}/`, {
          ...options,
          admission: undefined,
          allowHosts: [hold.host],
        }),
      ).rejects.toMatchObject({ code: "admission_denied" });
      expect(requested).toEqual([]);
      expect(hold.observations).toHaveLength(2);
    },
  );

  it("rejects duplicate host and allowed-without-reviewed-terms manifest mutants", () => {
    const duplicate = structuredClone(manifest);
    duplicate.publishers.push(duplicate.publishers[0]!);
    expect(admissionManifestSchema.safeParse(duplicate).success).toBe(false);
    const unreviewed = structuredClone(manifest);
    delete unreviewed.publishers[0]!.terms;
    expect(admissionManifestSchema.safeParse(unreviewed).success).toBe(false);
  });
});

describe("robots path policy", () => {
  const allowed = (text: string, path: string) =>
    parseRobots(text).allows(new URL(`https://publisher.test${path}`));
  it("merges matching groups, applies the most specific rule, and lets equivalent allow win", () => {
    const policy =
      "User-agent: *\nDisallow: /\nUser-agent: openplans\nDisallow: /feed\nAllow: /feed/public\nUser-agent: OpenPlans\nDisallow: /other\nAllow: /other\n";
    expect(allowed(policy, "/feed/private")).toBe(false);
    expect(allowed(policy, "/feed/public/file")).toBe(true);
    expect(allowed(policy, "/other")).toBe(true);
    expect(allowed(policy, "/unlisted")).toBe(true);
  });
  it("matches wildcards, query strings, end anchors and case-sensitive paths", () => {
    const policy = "User-agent: *\nDisallow: /*.json$\nDisallow: /*?private=\n";
    expect(allowed(policy, "/feed/a.json")).toBe(false);
    expect(allowed(policy, "/feed/a.json?public=true")).toBe(true);
    expect(allowed(policy, "/feed?private=true")).toBe(false);
    expect(allowed(policy, "/feed/A.JSON")).toBe(true);
  });
  it("normalizes unreserved escapes and UTF-8 without decoding reserved slashes", () => {
    const policy =
      "User-agent: *\nDisallow: /feed\nDisallow: /café\nDisallow: /x%2Fy\n";
    expect(allowed(policy, "/%66eed")).toBe(false);
    expect(allowed(policy, "/caf%C3%A9")).toBe(false);
    expect(allowed(policy, "/x%2fy")).toBe(false);
    expect(allowed(policy, "/x/y")).toBe(true);
  });
  it("retains the longer published crawl delay", () => {
    expect(parseRobots("User-agent: *\nCrawl-delay: 30\n").delayMs).toBe(
      30_000,
    );
  });
  it.each([
    "User-agent: *\nDisallow: private",
    "User-agent: *\nCrawl-delay: soon",
    "Disallow: /",
    "<html>unresolved policy</html>",
  ])("holds malformed policy: %s", (text) => {
    expect(() => parseRobots(text)).toThrow(
      expect.objectContaining({ code: "admission_denied" }),
    );
  });
});
