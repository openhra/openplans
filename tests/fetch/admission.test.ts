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
const paths = () => requested.map((entry) => new URL(entry.url).pathname);

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

  it.each([401, 403, 405, 429, 451, 500, 503])(
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
    vi.stubEnv("OPENPLANS_SHIPPED_ACCESS", "off");
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
    vi.stubEnv("OPENPLANS_SHIPPED_ACCESS", "off");
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
    "<html>unresolved policy</html>",
    "  <!DOCTYPE html><title>Error Page</title>",
    "\uFEFF<html>",
  ])("holds an HTML document served as robots: %s", (text) => {
    expect(() => parseRobots(text)).toThrow(
      expect.objectContaining({ code: "admission_denied" }),
    );
  });
});

describe("tolerant robots parsing (RFC 9309 2.3.1.5)", () => {
  const allowed = (text: string, path: string) =>
    parseRobots(text).allows(new URL(`https://publisher.test${path}`));
  it("reads a path without its leading slash and still disallows it", () => {
    expect(allowed("User-agent: *\nDisallow: private\n", "/private/a")).toBe(
      false,
    );
    expect(allowed("User-agent: *\nDisallow: *.pdf\n", "/x/a.pdf")).toBe(false);
    expect(allowed("User-agent: *\nDisallow: *.pdf\n", "/x/a.json")).toBe(true);
  });
  it("skips unparseable lines but keeps the parseable rules around them", () => {
    const text = "---\nUser-agent: *\nnonsense line\nDisallow: /feed\n";
    expect(allowed(text, "/feed/a.json")).toBe(false);
    expect(allowed(text, "/other")).toBe(true);
  });
  it("applies an ungrouped Crawl-delay and Disallow to every agent but ignores an ungrouped Allow", () => {
    const text =
      "Crawl-delay: 10\nDisallow: /held\nAllow: /feed/open\nUser-agent: *\nDisallow: /feed\n";
    expect(parseRobots(text).delayMs).toBe(10_000);
    expect(allowed(text, "/held/a")).toBe(false);
    expect(allowed(text, "/feed/open/a")).toBe(false);
  });
  it("reads a leading number from a crawl delay and skips one it cannot read", () => {
    expect(parseRobots("User-agent: *\nCrawl-delay: 7s\n").delayMs).toBe(7000);
    expect(parseRobots("User-agent: *\nCrawl-delay: soon\n").delayMs).toBe(0);
  });
  it("never lets a named agent with spaces select a group", () => {
    const text =
      "User-agent: Example Spider 2.0\nAllow: /\nUser-agent: *\nDisallow: /\n";
    expect(allowed(text, "/feed")).toBe(false);
  });
  it("adds Disallow lines from a wildcard agent pattern that matches openplans", () => {
    const text =
      "User-agent: *\nDisallow:\nUser-agent: open*\nDisallow: /feed\nAllow: /\n";
    expect(allowed(text, "/feed/a")).toBe(false);
    expect(allowed(text, "/other")).toBe(true);
    const unrelated =
      "User-agent: *\nDisallow:\nUser-agent: *AI*\nDisallow: /\n";
    expect(allowed(unrelated, "/feed/a")).toBe(true);
  });
});

describe("real published robots files", () => {
  const fixture = (name: string) =>
    readFile(new URL(`../fixtures/robots/${name}`, import.meta.url), "utf8");
  const allowed = async (name: string, path: string) =>
    parseRobots(await fixture(name)).allows(
      new URL(`https://host.test${path}`),
    );
  it("disallows the whole Virginia SCC host for openplans (User-agent * / Disallow /)", async () => {
    expect(await allowed("scc-virginia.txt", "/")).toBe(false);
    expect(await allowed("scc-virginia.txt", "/any/page")).toBe(false);
  });
  it("disallows the Cigna QHP index under Disallow: /sites*", async () => {
    expect(await allowed("cigna.txt", "/sites/json/cms-data-index.json")).toBe(
      false,
    );
  });
  it("disallows the Oscar CloudFront host", async () => {
    expect(await allowed("oscar-cloudfront.txt", "/ffm/plans.json")).toBe(
      false,
    );
  });
  it("admits Capital Health paths and honours its ungrouped 10 s crawl delay", async () => {
    const policy = parseRobots(await fixture("capitalhealth.txt"));
    expect(policy.delayMs).toBe(10_000);
    expect(
      policy.allows(new URL("https://host.test/cms-data-index.json")),
    ).toBe(true);
  });
  it("reads Alliant's *.pdf rule as /*.pdf without blocking its JSON index", async () => {
    expect(await allowed("alliantplans.txt", "/docs/a.pdf")).toBe(false);
    expect(await allowed("alliantplans.txt", "/cms-data-index.json")).toBe(
      true,
    );
  });
  it("admits Best Life JSON paths: its *AI* pattern does not match openplans", async () => {
    expect(await allowed("bestlife.txt", "/cms-data-index.json")).toBe(true);
  });
});

describe("robots 404/410 as absent rules (owner decision D1, 2026-11-09)", () => {
  function absentRobots(status = 404, country = "CO"): void {
    policyStatus = status;
    for (const entry of manifest.publishers)
      entry.robots = {
        url: `https://${entry.host}/robots.txt`,
        status,
        sha256: null,
        checkedAt: new Date().toISOString(),
        country,
      };
  }
  const session = (egressCountry?: string) =>
    new AdmissionSession(manifestPath, undefined, { egressCountry });
  it.each([404, 410])(
    "admits a direct robots %s, still checks terms, and records absence and egress",
    async (status) => {
      absentRobots(status);
      await saveManifest();
      const result = await run({ admission: session("CO") });
      expect(paths()).toEqual(["/robots.txt", "/terms", "/feed/index.json"]);
      expect(result.admission?.hosts[0]).toMatchObject({
        egressCountry: "CO",
        robots: { status, sha256: null, absent: true },
      });
    },
  );

  it("holds a 404 host whose terms are restricted, without any request", async () => {
    absentRobots();
    manifest.publishers[0]!.terms!.disposition = "restricted";
    await saveManifest();
    await expect(run({ admission: session("CO") })).rejects.toMatchObject({
      code: "admission_denied",
    });
    expect(requested).toEqual([]);
  });

  it("stops a 404 host whose terms changed before any data request", async () => {
    absentRobots();
    await saveManifest();
    termsBody = "Synthetic changed terms forbid automated access.";
    await expect(run({ admission: session("CO") })).rejects.toMatchObject({
      code: "admission_denied",
    });
    expect(paths()).toEqual(["/robots.txt", "/terms"]);
    expect(await dataEntries()).toEqual([]);
  });

  it("admits a 404 reviewed from another country and records the egress country (owner decision, 2026-11-09)", async () => {
    absentRobots(404, "US");
    await saveManifest();
    const elsewhere = await run({ admission: session("CO") });
    expect(elsewhere.admission?.hosts[0]).toMatchObject({
      egressCountry: "CO",
      robots: { status: 404, absent: true },
    });
    const unrecorded = await run({
      admission: session(),
      expectedSha256: undefined,
      snapshotId: undefined,
    });
    expect(unrecorded.admission?.hosts[0]).toMatchObject({
      egressCountry: null,
      robots: { status: 404, absent: true },
    });
  });

  it("rejects a manifest recording robots absence without a country", () => {
    absentRobots();
    delete manifest.publishers[0]!.robots!.country;
    expect(admissionManifestSchema.safeParse(manifest).success).toBe(false);
    absentRobots();
    manifest.publishers[0]!.robots!.sha256 = digest("x");
    expect(admissionManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it("holds a host reviewed with a robots file that now answers 404", async () => {
    policyStatus = 404;
    await expect(run({ admission: session("CO") })).rejects.toMatchObject({
      code: "admission_denied",
    });
    expect(paths()).toEqual(["/robots.txt"]);
  });

  it.each([
    "https://publisher.test/missing-robots",
    "https://elsewhere.test/robots.txt",
  ])(
    "holds a robots 404 reached through a redirect to %s",
    async (location) => {
      absentRobots();
      await saveManifest();
      const original = transport;
      transport = async (url, context) => {
        if (url.href === "https://publisher.test/robots.txt") {
          requested.push({ url: url.href, agent: "" });
          return {
            status: 302,
            headers: { location },
            body: Readable.from([]),
          };
        }
        if (url.pathname === "/missing-robots") {
          requested.push({ url: url.href, agent: "" });
          return { status: 404, headers: {}, body: Readable.from(["gone"]) };
        }
        return original(url, context);
      };
      await expect(run({ admission: session("CO") })).rejects.toBeInstanceOf(
        Error,
      );
      expect(paths()).not.toContain("/terms");
      expect(paths()).not.toContain("/feed/index.json");
      expect(await dataEntries()).toEqual([]);
    },
  );

  it("holds a 200 HTML error page served as robots (soft 404)", async () => {
    robots = "<!DOCTYPE html><html><title>Error Page</title></html>";
    await expect(run()).rejects.toMatchObject({ code: "admission_denied" });
    const original = transport;
    transport = async (url, context) => {
      const response = await original(url, context);
      if (url.pathname === "/robots.txt") {
        response.headers = { "content-type": "text/html; charset=utf-8" };
        response.body = Readable.from(["User-agent: *\nAllow: /\n"]);
      }
      return response;
    };
    await expect(
      run({ admission: new AdmissionSession(manifestPath) }),
    ).rejects.toMatchObject({ code: "admission_denied" });
    expect(paths()).toEqual(["/robots.txt", "/robots.txt"]);
  });

  it("obeys a robots file that appears with Disallow at the daily recheck", async () => {
    absentRobots();
    await saveManifest();
    const admission = session("CO");
    await run({ admission });
    const tomorrow = Date.now() + 24 * 60 * 60 * 1000;
    vi.spyOn(Date, "now").mockReturnValue(tomorrow);
    try {
      policyStatus = 200;
      robots = "User-agent: *\nDisallow: /\n";
      await expect(run({ admission })).rejects.toMatchObject({
        code: "admission_denied",
      });
      expect(
        paths().filter((path) => path === "/feed/index.json"),
      ).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("stops when an absent robots file turns into a 403 at the daily recheck", async () => {
    absentRobots();
    await saveManifest();
    const admission = session("CO");
    await run({ admission });
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 24 * 60 * 60 * 1000);
    try {
      policyStatus = 403;
      await expect(run({ admission })).rejects.toMatchObject({
        code: "http_status",
        status: 403,
      });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("still stops a captcha or login page from a 404-robots host", async () => {
    absentRobots();
    await saveManifest();
    for (const body of [
      '<div class="g-recaptcha">',
      '<form action="/login">',
    ]) {
      dataBody = body;
      await expect(
        run({ admission: session("CO"), expectedContent: "binary" }),
      ).rejects.toMatchObject({ code: "challenge_detected" });
    }
    expect(await dataEntries()).toEqual([]);
  });

  it("rejects an invalid egress country", () => {
    expect(() => session("co")).toThrow(
      expect.objectContaining({ code: "invalid_options" }),
    );
  });
});

describe("quarantined pre-admission snapshots", () => {
  async function quarantine(snapshots: string[]): Promise<void> {
    await writeFile(
      join(directory, "raw", "synthetic", "QUARANTINE.json"),
      JSON.stringify({ version: 1, reason: "pre-admission", snapshots }),
    );
  }
  async function cached() {
    const first = await run();
    if (first.outcome === "not_modified") throw new Error("Expected snapshot");
    requested = [];
    return first;
  }
  const reuse = (sha256: string) =>
    run({
      admission: new AdmissionSession(manifestPath),
      expectedSha256: sha256,
    });

  it("refuses to reuse a listed snapshot with the right hash but no readmission", async () => {
    const first = await cached();
    await quarantine([first.snapshotId]);
    await expect(reuse(first.metadata.sha256)).rejects.toMatchObject({
      code: "admission_denied",
    });
    vi.stubEnv("OPENPLANS_ACCESS_MANIFEST", "");
    await expect(
      run({
        admission: undefined,
        transport: undefined,
        expectedSha256: first.metadata.sha256,
      }),
    ).rejects.toMatchObject({ code: "admission_denied" });
  });

  it("ignores a marker that lists only unknown snapshots", async () => {
    const first = await cached();
    await quarantine(["0".repeat(64)]);
    expect((await reuse(first.metadata.sha256)).outcome).toBe("reused");
  });

  it("re-admits identical bytes downloaded now under a current admission, then reuses them", async () => {
    const first = await cached();
    await quarantine([first.snapshotId]);
    const fresh = await run({ admission: new AdmissionSession(manifestPath) });
    expect(fresh.outcome).toBe("reused");
    expect(paths()).toContain("/feed/index.json");
    const readmission = JSON.parse(
      await readFile(
        join(
          directory,
          "raw",
          "synthetic",
          `${first.snapshotId}.readmitted.json`,
        ),
        "utf8",
      ),
    );
    expect(readmission).toMatchObject({
      sha256: first.metadata.sha256,
      bytes: first.metadata.bytes,
    });
    expect((await reuse(first.metadata.sha256)).outcome).toBe("reused");
  });

  it("refuses a readmission whose receipt hash, bytes or host do not match", async () => {
    const first = await cached();
    await quarantine([first.snapshotId]);
    await run({ admission: new AdmissionSession(manifestPath) });
    const path = join(
      directory,
      "raw",
      "synthetic",
      `${first.snapshotId}.readmitted.json`,
    );
    const valid = JSON.parse(await readFile(path, "utf8"));
    for (const mutant of [
      { ...valid, admissionReceiptSha256: "0".repeat(64) },
      { ...valid, bytes: valid.bytes + 1 },
      { ...valid, admissionReceipt: "relative.json" },
    ]) {
      await writeFile(path, JSON.stringify(mutant));
      await expect(reuse(first.metadata.sha256)).rejects.toMatchObject({
        code: "admission_denied",
      });
    }
    const receipt = JSON.parse(await readFile(valid.admissionReceipt, "utf8"));
    receipt.hosts = receipt.hosts.map((entry: { host: string }) => ({
      ...entry,
      host: "other.test",
    }));
    const forged = join(directory, "forged-receipt.json");
    const forgedBytes = JSON.stringify(receipt);
    await writeFile(forged, forgedBytes);
    await writeFile(
      path,
      JSON.stringify({
        ...valid,
        admissionReceipt: forged,
        admissionReceiptSha256: digest(forgedBytes),
      }),
    );
    await expect(reuse(first.metadata.sha256)).rejects.toMatchObject({
      code: "admission_denied",
    });
  });

  it("negative control: changed bytes admit the new snapshot and leave the old one refused", async () => {
    const old = await cached();
    await quarantine([old.snapshotId]);
    dataBody = '{"synthetic":true,"republished":1}';
    const fresh = await run({ admission: new AdmissionSession(manifestPath) });
    if (fresh.outcome === "not_modified") throw new Error("Expected snapshot");
    expect(fresh.outcome).toBe("downloaded");
    expect(fresh.metadata.sha256).not.toBe(old.metadata.sha256);
    expect(await dataEntries()).not.toContain(
      `${old.snapshotId}.readmitted.json`,
    );
    expect((await reuse(fresh.metadata.sha256)).outcome).toBe("reused");
    await expect(reuse(old.metadata.sha256)).rejects.toMatchObject({
      code: "admission_denied",
    });
    vi.stubEnv("OPENPLANS_ACCESS_MANIFEST", "");
    await expect(
      run({
        admission: undefined,
        transport: undefined,
        expectedSha256: old.metadata.sha256,
      }),
    ).rejects.toMatchObject({ code: "admission_denied" });
  });

  it("negative control: a readmission written for another snapshot does not cover a listed one", async () => {
    const old = await cached();
    // Same length as the first body, so only identity and hash tell the two apart.
    dataBody = '{"synthetic":1234}';
    const other = await run();
    if (other.outcome === "not_modified") throw new Error("Expected snapshot");
    await quarantine([old.snapshotId, other.snapshotId]);
    await run({ admission: new AdmissionSession(manifestPath) });
    expect((await reuse(other.metadata.sha256)).outcome).toBe("reused");
    const borrowed = await readFile(
      join(
        directory,
        "raw",
        "synthetic",
        `${other.snapshotId}.readmitted.json`,
      ),
    );
    await writeFile(
      join(directory, "raw", "synthetic", `${old.snapshotId}.readmitted.json`),
      borrowed,
    );
    await expect(reuse(old.metadata.sha256)).rejects.toMatchObject({
      code: "admission_denied",
    });
  });
});

describe("tolerant robots parsing keeps every real block", () => {
  const allowed = (text: string, path: string) =>
    parseRobots(text).allows(new URL(`https://publisher.test${path}`));
  it("selects a group by the openplans product token, with a version or any case", () => {
    const text =
      "User-agent: *\nDisallow:\nUser-agent: OpenPlans/1.0\nDisallow: /feed\n";
    expect(allowed(text, "/feed/a")).toBe(false);
    expect(allowed(text, "/other")).toBe(true);
  });
  it("reads a Disallow written without its colon or with a common misspelling", () => {
    expect(allowed("User-agent: *\nDisallow /feed\n", "/feed/a")).toBe(false);
    expect(allowed("User-agent: *\nDissallow: /feed\n", "/feed/a")).toBe(false);
    expect(allowed("User-agent *\nDisallow /feed:x\n", "/feed:x/a")).toBe(
      false,
    );
  });
  it("negative control: an unrelated directive never becomes a rule", () => {
    expect(allowed("User-agent: *\nNoindex: /feed\n", "/feed/a")).toBe(true);
    expect(allowed("User-agent: *\nSitemap: /feed\n", "/feed/a")).toBe(true);
  });
});

describe("terms published on another host", () => {
  function offHostTerms(): void {
    manifest.publishers[0]!.terms!.url = "https://legal.test/terms";
  }
  it("checks the terms host's robots, verifies the terms hash and records both", async () => {
    offHostTerms();
    await saveManifest();
    const result = await run();
    expect(requested.map((entry) => entry.url)).toEqual([
      "https://publisher.test/robots.txt",
      "https://legal.test/robots.txt",
      "https://legal.test/terms",
      "https://publisher.test/feed/index.json",
    ]);
    expect(result.admission?.hosts[0]).toMatchObject({
      termsUrl: "https://legal.test/terms",
      termsRobots: { url: "https://legal.test/robots.txt", status: 200 },
    });
  });
  it("reads terms when the terms host has no robots file (direct 404)", async () => {
    offHostTerms();
    await saveManifest();
    const original = transport;
    transport = async (url, context) =>
      url.href === "https://legal.test/robots.txt"
        ? (requested.push({ url: url.href, agent: "" }),
          { status: 404, headers: {}, body: Readable.from([""]) })
        : original(url, context);
    const result = await run();
    expect(result.admission?.hosts[0]?.termsRobots).toMatchObject({
      status: 404,
      absent: true,
    });
  });
  it.each([
    [
      "robots disallows the terms page",
      200,
      "User-agent: *\nDisallow: /terms\n",
    ],
    ["terms host robots answers 403", 403, ""],
  ])("holds when the %s, before any data request", async (_, status, body) => {
    offHostTerms();
    await saveManifest();
    const original = transport;
    transport = async (url, context) =>
      url.href === "https://legal.test/robots.txt"
        ? (requested.push({ url: url.href, agent: "" }),
          { status, headers: {}, body: Readable.from([body]) })
        : original(url, context);
    await expect(run()).rejects.toBeInstanceOf(Error);
    expect(paths()).not.toContain("/feed/index.json");
    expect(paths()).not.toContain("/terms");
  });
  it("stops when off-host terms changed", async () => {
    offHostTerms();
    await saveManifest();
    termsBody = "Synthetic changed terms forbid copying.";
    await expect(run()).rejects.toMatchObject({ code: "admission_denied" });
    expect(paths()).not.toContain("/feed/index.json");
  });
  it("stops when off-host terms are a captcha or login page", async () => {
    offHostTerms();
    manifest.publishers[0]!.terms!.sha256 = digest('<div class="g-recaptcha">');
    await saveManifest();
    termsBody = '<div class="g-recaptcha">';
    await expect(run()).rejects.toMatchObject({ code: "challenge_detected" });
    expect(paths()).not.toContain("/feed/index.json");
  });
  it("never grants the terms host data clearance", async () => {
    offHostTerms();
    await saveManifest();
    await run();
    await expect(
      fetchToCache("https://legal.test/feed/index.json", {
        ...options,
        allowHosts: ["legal.test"],
      }),
    ).rejects.toMatchObject({ code: "admission_denied" });
  });
});
