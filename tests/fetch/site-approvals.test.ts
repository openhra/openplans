// Per-site source approvals: a terms-restricted publisher carrying `approval: { kind: "owner-env" }`
// is held until the operator sets the named variable to exactly `approved`. Every host, terms
// document and body here is synthetic; no carrier bytes are copied.
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AdmissionSession,
  admissionManifestSchema,
  fetchToCache,
  loadSiteRegistry,
  publicGuardRefusal,
  reportSiteApprovals,
  resolveSiteApprovals,
  SiteApprovalError,
  startSiteApprovals,
} from "../../src/fetch/index.js";
import type {
  AdmissionManifest,
  FetchOptions,
  PublisherPolicy,
  Transport,
} from "../../src/fetch/index.js";
import type * as Approvals from "../../src/fetch/approvals.js";
import type * as Admission from "../../src/fetch/admission.js";
import { loadConfig } from "../../src/config/index.js";
import { hostRefusal } from "../../src/plugins/hosts.js";
import { importMutant, withMutantFile } from "../mutant-file.js";
import { replaceSyntax } from "../source-mutation.js";

vi.mock("../../src/fetch/limiter.js", () => ({
  leaseHost: async () => async () => {},
}));

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const HOST = "restricted.test";
const ENV = "OPENPLANS_SITE_APPROVE_SYNTHETIC_RESTRICTED";
const SLUG = "SYNTHETIC_RESTRICTED";
const terms =
  "Synthetic restricted terms: files may be read only for personal use.";
const allowedTerms = "Synthetic publisher permits scoped automated collection.";
let directory: string;
let manifestPath: string;
let manifest: AdmissionManifest;
let requested: string[];
let robots: string;
let robotsStatus: number;
let robotsType: string;
let termsBody: string;
let options: FetchOptions;

/** A terms-restricted entry the operator may approve by variable. */
function restricted(host = HOST): PublisherPolicy {
  const now = Date.now();
  return {
    host,
    state: "terms-restricted",
    approval: { kind: "owner-env", env: ENV },
    evidence: [
      {
        url: `https://${host}/terms`,
        observedAt: new Date(now).toISOString(),
        status: 200,
      },
    ],
    scope: { products: ["synthetic"], states: ["TX"], years: [2026] },
    discoveryUrls: [`https://${host}/feed/index.json`],
    permittedPaths: ["/feed"],
    delegates: [],
    attribution: "Synthetic fixture",
    updatePolicy: "Recheck daily",
    delayMs: 5000,
    jobCaps: { maxRequests: 200, maxTransferBytes: 50 * 1024 ** 2 },
    robots: {
      url: `https://${host}/robots.txt`,
      status: 200,
      sha256: digest("User-agent: *\nDisallow: /private\n"),
      checkedAt: new Date(now).toISOString(),
    },
    terms: {
      url: `https://${host}/terms`,
      disposition: "restricted",
      sha256: digest(terms),
      reviewedAt: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now + 48 * 60 * 60 * 1000).toISOString(),
    },
  };
}
const session = (approved: readonly string[] = []) =>
  new AdmissionSession(manifestPath, undefined, {
    siteApprovals: new Set(approved),
  });
async function saveManifest(): Promise<void> {
  await writeFile(manifestPath, JSON.stringify(manifest));
}
const run = (overrides: Partial<FetchOptions> = {}) =>
  fetchToCache(`https://${HOST}/feed/index.json`, { ...options, ...overrides });
const paths = () => requested.map((url) => new URL(url).pathname);

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "openplans-synthetic-approval-"));
  manifestPath = join(directory, "access.json");
  manifest = { version: 1, publishers: [restricted()] };
  await saveManifest();
  requested = [];
  robots = "User-agent: *\nDisallow: /private\n";
  robotsStatus = 200;
  robotsType = "text/plain";
  termsBody = terms;
  // Anonymous serving off: the public guard is tested on its own below.
  vi.stubEnv("OPENPLANS_PUBLIC_QUOTING", "off");
  vi.stubEnv("OPENPLANS_PUBLIC_HOUSEHOLD", "off");
  vi.stubEnv("OPENPLANS_PUBLIC_COMPAT", "off");
  vi.stubEnv("OPENPLANS_PUBLIC_RESTRICTED_SITES", "");
  vi.stubEnv("OPENPLANS_SITE_APPROVALS", "");
  vi.stubEnv("OPENPLANS_SITE_APPROVALS_FILE", "");
  vi.stubEnv(ENV, "");
  const transport: Transport = async (url) => {
    requested.push(url.href);
    let body = '{"synthetic":true}';
    let status = 200;
    let type = "application/json";
    if (url.pathname === "/robots.txt") {
      body = robots;
      status = robotsStatus;
      type = robotsType;
    }
    if (url.pathname === "/terms") body = termsBody;
    return {
      status,
      headers: { "content-type": type },
      body: Readable.from([body]),
    };
  };
  options = {
    source: "synthetic",
    dataDir: directory,
    allowHosts: [HOST],
    expectedContent: "json",
    admission: session(),
    transport,
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
    maxAttempts: 1,
  };
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe("resolving approvals from the environment", () => {
  const base = { OPENPLANS_PUBLIC_QUOTING: "off" };

  it("approves nothing by default", () => {
    const result = resolveSiteApprovals(base);
    expect([...result.approved]).toEqual([]);
    expect(result.heldValues).toEqual([]);
  });

  it("approves a per-site variable only on the exact value", () => {
    expect([
      ...resolveSiteApprovals({ ...base, [ENV]: "approved" }).approved,
    ]).toEqual([SLUG]);
    for (const value of [
      "1",
      "true",
      "yes",
      "on",
      "Approved",
      "approved ",
      "APPROVED",
    ]) {
      const result = resolveSiteApprovals({ ...base, [ENV]: value });
      expect([...result.approved], value).toEqual([]);
      expect(result.heldValues, value).toEqual([{ slug: SLUG, env: ENV }]);
    }
  });

  it("treats an empty per-site value as unset, as Compose passes one", () => {
    const result = resolveSiteApprovals({ ...base, [ENV]: "" });
    expect([...result.approved]).toEqual([]);
    expect(result.heldValues).toEqual([]);
  });

  it("resolves the list, the file and the per-site form to the same set", async () => {
    const file = join(directory, "approvals.txt");
    await writeFile(
      file,
      `# synthetic approvals\nSYNTHETIC_RESTRICTED  # first\n\nOTHER_SITE\n`,
    );
    const perSite = resolveSiteApprovals({
      ...base,
      [ENV]: "approved",
      OPENPLANS_SITE_APPROVE_OTHER_SITE: "approved",
    });
    const list = resolveSiteApprovals({
      ...base,
      OPENPLANS_SITE_APPROVALS: " OTHER_SITE, SYNTHETIC_RESTRICTED ,",
    });
    const fromFile = resolveSiteApprovals({
      ...base,
      OPENPLANS_SITE_APPROVALS_FILE: file,
    });
    const expected = ["OTHER_SITE", "SYNTHETIC_RESTRICTED"];
    for (const result of [perSite, list, fromFile])
      expect([...result.approved].sort()).toEqual(expected);
    // The forms add up; a wrong per-site value is still reported beside a list approval.
    const mixed = resolveSiteApprovals({
      ...base,
      [ENV]: "true",
      OPENPLANS_SITE_APPROVALS: "OTHER_SITE",
    });
    expect([...mixed.approved]).toEqual(["OTHER_SITE"]);
    expect(mixed.heldValues).toEqual([{ slug: SLUG, env: ENV }]);
  });

  it("refuses malformed slugs, names and files instead of guessing", async () => {
    expect(() =>
      resolveSiteApprovals({
        ...base,
        OPENPLANS_SITE_APPROVALS: "centene-api",
      }),
    ).toThrow(SiteApprovalError);
    expect(() =>
      resolveSiteApprovals({
        ...base,
        OPENPLANS_SITE_APPROVE_lower: "approved",
      }),
    ).toThrow(SiteApprovalError);
    expect(() =>
      resolveSiteApprovals({
        ...base,
        OPENPLANS_SITE_APPROVALS_FILE: "relative/approvals.txt",
      }),
    ).toThrow(SiteApprovalError);
    expect(() =>
      resolveSiteApprovals({
        ...base,
        OPENPLANS_SITE_APPROVALS_FILE: join(directory, "missing.txt"),
      }),
    ).toThrow(SiteApprovalError);
  });
});

describe("the manifest schema", () => {
  it("accepts an owner-env entry and the declarative terms-allowed form", () => {
    expect(admissionManifestSchema.safeParse(manifest).success).toBe(true);
    const allowed: PublisherPolicy = {
      ...restricted("allowed.test"),
      state: "allowed",
      approval: { kind: "terms-allowed" },
      terms: {
        ...restricted().terms!,
        disposition: "allowed",
        sha256: digest(allowedTerms),
      },
    };
    expect(
      admissionManifestSchema.safeParse({ version: 1, publishers: [allowed] })
        .success,
    ).toBe(true);
  });

  it.each([
    ["an allowed state", { state: "allowed" }],
    ["a robots-disallowed state", { state: "robots-disallowed" }],
    ["no variable name", { approval: { kind: "owner-env" } }],
    [
      "a variable outside the prefix",
      { approval: { kind: "owner-env", env: "SITE_OK" } },
    ],
    [
      "a lower-case slug",
      {
        approval: { kind: "owner-env", env: "OPENPLANS_SITE_APPROVE_centene" },
      },
    ],
    [
      "allowed terms",
      { terms: { ...restricted().terms!, disposition: "allowed" } },
    ],
    ["no terms", { terms: undefined }],
    ["no robots evidence", { robots: undefined }],
    [
      "a keyed API",
      {
        accessMode: "api-key",
        apiKey: { env: "SYNTHETIC_KEY", queryParam: "key" },
        delayMs: 1000,
      },
    ],
    [
      "a terms-allowed approval with a variable",
      { approval: { kind: "terms-allowed", env: ENV } },
    ],
  ] as const)("refuses an owner-env entry with %s", (_name, patch) => {
    const entry = { ...restricted(), ...patch } as PublisherPolicy;
    expect(
      admissionManifestSchema.safeParse({ version: 1, publishers: [entry] })
        .success,
    ).toBe(false);
  });
});

describe("admission of an owner-env host", () => {
  it("is held by default, naming the variable to set, before any request", async () => {
    await expect(run()).rejects.toMatchObject({ code: "admission_denied" });
    // A refusal stops the session; a fresh one names the variable too.
    await expect(run({ admission: session() })).rejects.toThrow(
      `set ${ENV}=approved`,
    );
    expect(requested).toEqual([]);
  });

  it("stays held on any value but the exact one, read from the environment", async () => {
    for (const value of ["1", "true", "yes", "on"]) {
      vi.stubEnv(ENV, value);
      await expect(
        run({ admission: new AdmissionSession(manifestPath) }),
      ).rejects.toMatchObject({ code: "admission_denied" });
    }
    expect(requested).toEqual([]);
    vi.stubEnv(ENV, "approved");
    const result = await run({ admission: new AdmissionSession(manifestPath) });
    expect(result.outcome).toBe("downloaded");
  });

  it("collects once approved, with robots first and the approval in the receipt", async () => {
    const result = await run({ admission: session([SLUG]) });
    expect(paths()).toEqual(["/robots.txt", "/terms", "/feed/index.json"]);
    expect(result.admission?.hosts[0]).toMatchObject({
      host: HOST,
      state: "terms-restricted",
      approvalBasis: `owner-env:${SLUG}`,
      approvalEnv: ENV,
      termsSha256: digest(terms),
      robots: { status: 200, sha256: digest(robots) },
    });
    if (result.outcome === "not_modified")
      throw new Error("Expected a snapshot");
    expect(result.metadata.access_policy).toEqual(result.admission);
    expect(JSON.stringify(result.admission)).not.toContain("approved");
    expect(await readFile(result.path, "utf8")).toBe('{"synthetic":true}');
  });

  it("an approved host with a robots Disallow on the path is still refused", async () => {
    robots = "User-agent: *\nDisallow: /feed\n";
    await expect(run({ admission: session([SLUG]) })).rejects.toMatchObject({
      code: "admission_denied",
    });
    // Robots and the pinned terms are read in the review; the data path is never requested.
    expect(paths()).toEqual(["/robots.txt", "/terms"]);
  });

  it.each([
    ["403", 403, "text/plain"],
    ["503", 503, "text/plain"],
    ["an HTML page", 200, "text/html"],
  ])(
    "an approved host whose robots answers %s is still refused",
    async (_name, status, type) => {
      robotsStatus = status;
      robotsType = type;
      await expect(run({ admission: session([SLUG]) })).rejects.toBeTruthy();
      expect(paths()).toEqual(["/robots.txt"]);
    },
  );

  it("an approved host whose terms changed is still refused", async () => {
    termsBody = `${terms} (revised)`;
    await expect(run({ admission: session([SLUG]) })).rejects.toThrow(
      /terms changed/,
    );
    expect(paths()).toEqual(["/robots.txt", "/terms"]);
  });

  it("an approval never admits a held or unlisted host", async () => {
    manifest.publishers[0]!.state = "bot-protected";
    manifest.publishers[0]!.approval = undefined;
    await saveManifest();
    await expect(run({ admission: session([SLUG]) })).rejects.toMatchObject({
      code: "admission_denied",
    });
    expect(requested).toEqual([]);
  });

  it("reuses an approved snapshot offline and records the approval again", async () => {
    const first = await run({ admission: session([SLUG]) });
    const second = await run({ admission: session([SLUG]) });
    expect(second.outcome).toBe("reused");
    expect(second.admission?.hosts[0]?.approvalBasis).toBe(`owner-env:${SLUG}`);
    expect(first.outcome).toBe("downloaded");
  });
});

describe("the public guard", () => {
  it("refuses an approval while anonymous serving is on, unless allowed by name", async () => {
    vi.stubEnv("OPENPLANS_PUBLIC_QUOTING", "on");
    await expect(run({ admission: session([SLUG]) })).rejects.toThrow(
      /OPENPLANS_PUBLIC_RESTRICTED_SITES=allow/,
    );
    expect(requested).toEqual([]);
    for (const value of ["1", "true", "on", "yes"]) {
      vi.stubEnv("OPENPLANS_PUBLIC_RESTRICTED_SITES", value);
      await expect(run({ admission: session([SLUG]) })).rejects.toMatchObject({
        code: "admission_denied",
      });
    }
    expect(requested).toEqual([]);
    vi.stubEnv("OPENPLANS_PUBLIC_RESTRICTED_SITES", "allow");
    expect((await run({ admission: session([SLUG]) })).outcome).toBe(
      "downloaded",
    );
  });

  it("does not apply without approvals, nor with anonymous serving off", () => {
    vi.stubEnv("OPENPLANS_PUBLIC_QUOTING", "on");
    expect(publicGuardRefusal(loadConfig(), new Set())).toBeUndefined();
    vi.stubEnv("OPENPLANS_PUBLIC_QUOTING", "off");
    expect(publicGuardRefusal(loadConfig(), new Set([SLUG]))).toBeUndefined();
    vi.stubEnv("OPENPLANS_PUBLIC_HOUSEHOLD", "on");
    expect(publicGuardRefusal(loadConfig(), new Set([SLUG]))).toContain(SLUG);
  });

  it("stops the host at start and otherwise logs the resolved set by slug", () => {
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    vi.stubEnv(ENV, "approved");
    vi.stubEnv("OPENPLANS_SITE_APPROVE_UNLISTED", "yes");
    vi.stubEnv("OPENPLANS_SITE_APPROVALS", "NOWHERE");
    vi.stubEnv("OPENPLANS_PUBLIC_QUOTING", "on");
    expect(() => startSiteApprovals(loadConfig(), [manifestPath], log)).toThrow(
      SiteApprovalError,
    );
    expect(lines).toEqual([]);
    vi.stubEnv("OPENPLANS_PUBLIC_RESTRICTED_SITES", "allow");
    const report = startSiteApprovals(loadConfig(), [manifestPath], log);
    expect(report).toEqual({
      approved: ["NOWHERE", SLUG],
      held: [
        {
          slug: "UNLISTED",
          env: "OPENPLANS_SITE_APPROVE_UNLISTED",
          hint: report.held[0]?.hint,
        },
      ],
      hosts: [{ host: HOST, slug: SLUG, env: ENV, approved: true }],
      withoutEntry: ["NOWHERE"],
    });
    expect(report.held[0]?.hint).toMatch(/=approved/);
    expect(lines).toHaveLength(1);
    const logged = JSON.parse(lines[0]!) as { event: string };
    expect(logged.event).toBe("site_approvals");
    // The held variable's value is never logged, only its name.
    expect(lines[0]).not.toContain('"yes"');
    // Nothing to say: no line.
    vi.stubEnv(ENV, "");
    vi.stubEnv("OPENPLANS_SITE_APPROVE_UNLISTED", "");
    vi.stubEnv("OPENPLANS_SITE_APPROVALS", "");
    expect(
      startSiteApprovals(loadConfig(), [join(directory, "none.json")], log),
    ).toMatchObject({ approved: [], hosts: [] });
    expect(lines).toHaveLength(1);
  });

  it("a later manifest entry for the same host replaces an earlier approval", () => {
    const plain = join(directory, "plain.json");
    const entry = { ...restricted(), state: "allowed", approval: undefined };
    return writeFile(
      plain,
      JSON.stringify({ version: 1, publishers: [entry] }),
    ).then(() => {
      const report = reportSiteApprovals([manifestPath, plain], {
        approved: new Set([SLUG]),
        heldValues: [],
      });
      expect(report.hosts).toEqual([]);
      expect(report.withoutEntry).toEqual([SLUG]);
    });
  });
});

describe("the host pre-check that feeds and the plugin loader run", () => {
  const publishers = () => new Map([[HOST, restricted()]]);

  it("mirrors the session: held without the approval, refused by the public guard, clear with it", () => {
    const now = Date.now();
    expect(
      hostRefusal(HOST, publishers(), now, { approved: new Set() }),
    ).toMatchObject({ code: "approval_required" });
    expect(
      hostRefusal(HOST, publishers(), now, { approved: new Set() })?.message,
    ).toContain(`set ${ENV}=approved`);
    expect(
      hostRefusal(HOST, publishers(), now, {
        approved: new Set([SLUG]),
        publicRefusal: "anonymous serving is on",
      }),
    ).toMatchObject({ code: "public_guard" });
    expect(
      hostRefusal(HOST, publishers(), now, { approved: new Set([SLUG]) }),
    ).toBeUndefined();
    // Resolved from the environment by default, like a session.
    expect(hostRefusal(HOST, publishers(), now)).toMatchObject({
      code: "approval_required",
    });
    vi.stubEnv(ENV, "approved");
    expect(hostRefusal(HOST, publishers(), now)).toBeUndefined();
    vi.stubEnv("OPENPLANS_PUBLIC_QUOTING", "on");
    expect(hostRefusal(HOST, publishers(), now)).toMatchObject({
      code: "public_guard",
    });
    // An approval never clears an entry that is held for another reason.
    const held = new Map([
      [
        HOST,
        {
          ...restricted(),
          state: "bot-protected" as const,
          approval: undefined,
        },
      ],
    ]);
    expect(
      hostRefusal(HOST, held, now, { approved: new Set([SLUG]) }),
    ).toMatchObject({ code: "bot-protected" });
  });
});

describe("the shipped slug registry", () => {
  it("names each site once, by issuer and host, and the self-host guide lists every slug", async () => {
    const registry = loadSiteRegistry();
    expect(registry.sites.length).toBeGreaterThanOrEqual(10);
    const guide = await readFile(
      new URL("../../docs/self-host.md", import.meta.url),
      "utf8",
    );
    for (const site of registry.sites) {
      expect(guide).toContain(`\`${site.slug}\``);
      for (const host of site.hosts) expect(guide).toContain(host);
    }
    // Neutral wording in the registry is enforced by the gate's public-wording scan.
  });
});

describe("planted mutants", () => {
  it("an approval that bypasses robots is caught", async () => {
    const source = new URL("../../src/fetch/admission.ts", import.meta.url);
    robots = "User-agent: *\nDisallow: /feed\n";
    await withMutantFile(
      source,
      replaceSyntax(
        await readFile(source, "utf8"),
        `const review = await pending;
    if (
      Date.now() - review.checkedAt >= dailyRecheckMs ||
      !review.robots.allows(url)
    )`,
        `const review = await pending;
    if (
      Date.now() - review.checkedAt >= dailyRecheckMs ||
      (!review.robots.allows(url) && !publisher.approval)
    )`,
      ),
      async (file) => {
        const mutant = await importMutant<typeof Admission>(
          file,
          "AdmissionSession",
        );
        // The mutant sends the data request past the Disallow, which the real session never
        // does (tested above). The pre-publication recheck still refuses the snapshot.
        await expect(
          run({
            admission: new mutant.AdmissionSession(manifestPath, undefined, {
              siteApprovals: new Set([SLUG]),
            }),
          }),
        ).rejects.toMatchObject({ code: "admission_denied" });
        expect(paths()).toContain("/feed/index.json");
      },
    );
  });

  it("a resolver that accepts truthy values is caught", async () => {
    const source = new URL("../../src/fetch/approvals.ts", import.meta.url);
    await withMutantFile(
      source,
      replaceSyntax(
        await readFile(source, "utf8"),
        "if (value === SITE_APPROVAL_VALUE) approved.add(slug);",
        "if (value) approved.add(slug);",
      ),
      async (file) => {
        const mutant = await importMutant<typeof Approvals>(
          file,
          "resolveSiteApprovals",
        );
        const result = mutant.resolveSiteApprovals({
          OPENPLANS_PUBLIC_QUOTING: "off",
          [ENV]: "true",
        });
        expect([...result.approved]).toEqual([SLUG]);
      },
    );
  });

  it("a dropped public guard is caught", async () => {
    const source = new URL("../../src/fetch/approvals.ts", import.meta.url);
    vi.stubEnv("OPENPLANS_PUBLIC_QUOTING", "on");
    await withMutantFile(
      source,
      replaceSyntax(
        await readFile(source, "utf8"),
        "if (!approved.size || !publicServing(config)) return undefined;",
        "return undefined;",
      ),
      async (file) => {
        const mutant = await importMutant<typeof Approvals>(
          file,
          "publicGuardRefusal",
          "startSiteApprovals",
        );
        expect(mutant.publicGuardRefusal(loadConfig(), new Set([SLUG]))).toBe(
          undefined,
        );
        vi.stubEnv(ENV, "approved");
        expect(() =>
          mutant.startSiteApprovals(loadConfig(), [manifestPath], () => {}),
        ).not.toThrow();
      },
    );
  });
});
