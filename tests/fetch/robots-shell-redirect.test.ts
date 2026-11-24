import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { plantMutantFile } from "../mutant-file.js";
import type {
  AdmissionManifest,
  PublisherPolicy,
  TransientFetchOptions,
  Transport,
} from "../../src/fetch/index.js";

vi.mock("../../src/fetch/limiter.js", () => ({
  leaseHost: vi.fn(async () => async () => {}),
}));

// Every host, policy and response here is synthetic. The redirect shapes follow the layouts seen in
// published issuer sites (apex to www, www to a sibling brand domain, a content handler host).
const A = "www.issuer-a.test";
const terms = "Synthetic publisher permits transient requests.";
const rules = "User-agent: *\nDisallow: /feed/blocked\n";
const shell = '<!doctype html><html><div id="app"></div></html>';
const digest = (body: string) =>
  createHash("sha256").update(body).digest("hex");
type Reply = {
  status: number;
  headers?: Record<string, string>;
  body?: string;
};
let directory: string;
let manifestPath: string;
let manifest: AdmissionManifest;
let replies: Map<string, Reply>;
let fallback: Reply | undefined;
let seen: string[];
let transport: Transport;
let options: TransientFetchOptions;

function publisher(host = A): PublisherPolicy {
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
    delegates: [],
    attribution: "Synthetic fixture",
    updatePolicy: "Recheck daily",
    delayMs: 5000,
    jobCaps: { maxRequests: 200, maxTransferBytes: 50 * 1024 ** 2 },
    robots: {
      url: `https://${host}/robots.txt`,
      status: 200,
      sha256: digest(rules),
      checkedAt: new Date().toISOString(),
    },
    terms: {
      url: `https://${host}/terms`,
      disposition: "allowed",
      sha256: digest(terms),
      reviewedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
    },
  };
}
const reply = (host: string, path: string, value: Reply) =>
  replies.set(`${host}${path}`, value);
const redirect = (host: string, to: string, status = 301) =>
  reply(host, "/robots.txt", { status, headers: { location: to } });
const save = () => writeFile(manifestPath, JSON.stringify(manifest));

beforeEach(async () => {
  vi.stubEnv("OPENPLANS_EGRESS_FILE", "");
  vi.stubEnv("OPENPLANS_EGRESS_SHA256", "");
  vi.stubEnv("OPENPLANS_EGRESS_COUNTRY", "");
  directory = await mkdtemp(join(tmpdir(), "openplans-synthetic-robots-"));
  await mkdir(join(directory, "data"));
  manifestPath = join(directory, "access.json");
  manifest = { version: 1, publishers: [publisher()] };
  await save();
  replies = new Map();
  fallback = undefined;
  seen = [];
  reply(A, "/robots.txt", { status: 200, body: rules });
  reply(A, "/terms", { status: 200, body: terms });
  reply(A, "/feed/index.json", { status: 200, body: '{"synthetic":true}' });
  transport = async (url) => {
    seen.push(`${url.hostname}${url.pathname}`);
    const found =
      replies.get(`${url.hostname}${url.pathname}`) ??
      fallback ??
      ({ status: 404, body: "not found" } satisfies Reply);
    return {
      status: found.status,
      headers: found.headers ?? {},
      body: Readable.from([found.body ?? ""]),
    };
  };
  options = {
    dataDir: join(directory, "data"),
    allowHosts: [A],
    expectedContent: "json",
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
    transport: (url, context) => transport(url, context),
    maxAttempts: 1,
  };
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const name of mocked) vi.doUnmock(`../../src/fetch/${name}.js`);
  vi.resetModules();
  while (planted.length) await planted.pop()!();
  await rm(directory, { recursive: true, force: true });
});

import type * as FetchModules from "../../src/fetch/index.js";
type Modules = typeof FetchModules;
const mocked = ["robots", "admission", "transient"];
const planted: (() => Promise<void>)[] = [];
type Mutant =
  | { module: "robots" | "admission"; values: Record<string, unknown> }
  | { source: "transient"; from: string; to: string };
async function load(mutant?: Mutant): Promise<Modules> {
  vi.resetModules();
  for (const name of mocked) vi.doUnmock(`../../src/fetch/${name}.js`);
  if (mutant && "source" in mutant) {
    const file = new URL("../../src/fetch/transient.ts", import.meta.url);
    const text = await readFile(file, "utf8");
    if (!text.includes(mutant.from)) throw new Error("mutant target moved");
    const copy = await plantMutantFile(
      file,
      text.replace(mutant.from, mutant.to),
    );
    planted.push(copy.cleanup);
    vi.doMock("../../src/fetch/transient.js", () => import(copy.path));
  } else if (mutant)
    vi.doMock(`../../src/fetch/${mutant.module}.js`, async (original) => ({
      ...(await original<object>()),
      ...mutant.values,
    }));
  return import("../../src/fetch/index.js");
}
const run = (modules: Modules, path = "/feed/index.json") =>
  modules.fetchTransient(`https://${A}${path}`, {
    ...options,
    admission: new modules.AdmissionSession(manifestPath),
  });
function beforeEachReset() {
  seen = [];
  replies.clear();
  fallback = undefined;
  reply(A, "/robots.txt", { status: 200, body: rules });
  reply(A, "/terms", { status: 200, body: terms });
  reply(A, "/feed/index.json", { status: 200, body: '{"synthetic":true}' });
  manifest.publishers[0] = publisher();
}
const robotsOf = (result: Awaited<ReturnType<Modules["fetchTransient"]>>) =>
  result.admission.hosts[0]!.robots;

describe("robots redirects inside one organisation", () => {
  it("follows a same-domain redirect, applies its rules to the initial authority and records the chain", async () => {
    redirect(A, "https://cdn.issuer-a.test/robots.txt");
    reply("cdn.issuer-a.test", "/robots.txt", { status: 200, body: rules });
    const modules = await load();
    const result = await run(modules);
    expect(result.status).toBe(200);
    expect(robotsOf(result)).toMatchObject({
      url: `https://${A}/robots.txt`,
      status: 200,
      sha256: digest(rules),
      redirectChain: ["https://cdn.issuer-a.test/robots.txt"],
    });
    expect(seen.slice(0, 2)).toEqual([
      `${A}/robots.txt`,
      "cdn.issuer-a.test/robots.txt",
    ]);
    await expect(run(modules, "/feed/blocked")).rejects.toMatchObject({
      code: "admission_denied",
    });
  });

  it("follows a host named by robotsAliasOf and holds the same redirect without it", async () => {
    redirect(A, "https://www.issuer-a-corp.example/robots.txt", 302);
    reply("www.issuer-a-corp.example", "/robots.txt", {
      status: 200,
      body: rules,
    });
    await expect(run(await load())).rejects.toThrow();
    expect(seen).toEqual([`${A}/robots.txt`]);
    manifest.publishers[0]!.robotsAliasOf = ["www.issuer-a-corp.example"];
    await save();
    seen = [];
    const result = await run(await load());
    expect(robotsOf(result).redirectChain).toEqual([
      "https://www.issuer-a-corp.example/robots.txt",
    ]);
    // Only the named host is reachable; its alias grants no data clearance.
    expect(
      seen.filter((entry) => entry.startsWith("www.issuer-a-corp")),
    ).toEqual(["www.issuer-a-corp.example/robots.txt"]);
  });

  it("holds a cross-organisation redirect and never asks the other host", async () => {
    redirect(A, "https://www.other-org.example/robots.txt");
    reply("www.other-org.example", "/robots.txt", { status: 200, body: rules });
    await expect(run(await load())).rejects.toThrow();
    expect(seen).toEqual([`${A}/robots.txt`]);
  });

  it("follows five hops and holds six", async () => {
    const hop = (index: number) => `h${index}.issuer-a.test`;
    redirect(A, `https://${hop(1)}/robots.txt`);
    for (let index = 1; index < 5; index++)
      redirect(hop(index), `https://${hop(index + 1)}/robots.txt`);
    reply(hop(5), "/robots.txt", { status: 200, body: rules });
    expect(robotsOf(await run(await load())).redirectChain).toHaveLength(5);
    // A sixth hop is refused.
    redirect(hop(5), `https://${hop(6)}/robots.txt`);
    reply(hop(6), "/robots.txt", { status: 200, body: rules });
    seen = [];
    await expect(run(await load())).rejects.toMatchObject({
      code: "too_many_redirects",
    });
    expect(seen.filter((entry) => entry.startsWith(hop(6)))).toEqual([]);
  });

  it("holds a redirect that ends in 404 even when the manifest recorded absence", async () => {
    manifest.publishers[0]!.robots = {
      url: `https://${A}/robots.txt`,
      status: 404,
      sha256: null,
      country: "US",
      checkedAt: new Date().toISOString(),
    };
    await save();
    redirect(A, "https://azblue.issuer-a.test/robots.txt");
    reply("azblue.issuer-a.test", "/robots.txt", { status: 404 });
    await expect(run(await load())).rejects.toMatchObject({
      code: "http_status",
    });
  });

  it("keeps a restricted terms disposition restricted after a followed redirect", async () => {
    const approvals = JSON.parse(
      await readFile(
        new URL("../../data/access/site-approvals.json", import.meta.url),
        "utf8",
      ),
    ) as { sites: { slug: string; hosts: string[] }[] };
    for (const slug of ["FLORIDA_BLUE_WWW", "AZBLUE_WWW"])
      expect(approvals.sites.find((site) => site.slug === slug)).toBeDefined();
    manifest.publishers[0]!.state = "terms-restricted";
    manifest.publishers[0]!.terms!.disposition = "restricted";
    manifest.publishers[0]!.approval = {
      kind: "owner-env",
      env: "OPENPLANS_SITE_APPROVE_SYNTHETIC_A",
    };
    await save();
    redirect(A, "https://cdn.issuer-a.test/robots.txt");
    reply("cdn.issuer-a.test", "/robots.txt", { status: 200, body: rules });
    await expect(run(await load())).rejects.toMatchObject({
      code: "admission_denied",
    });
  });
});

function recordShell(basis: "real-404" | "index-equal") {
  manifest.publishers[0]!.robots = {
    url: `https://${A}/robots.txt`,
    status: 200,
    sha256: digest(shell),
    country: "US",
    checkedAt: new Date().toISOString(),
    shell: {
      probePath: `/${"a1".repeat(16)}`,
      probeStatus: basis === "real-404" ? 404 : 200,
      probeSha256: null,
      basis,
    },
  };
  return save();
}
const htmlHeaders = { "content-type": "text/html; charset=utf-8" };

describe("an HTML shell at /robots.txt", () => {
  it("is no robots file when the same host answers a random path with a real 404", async () => {
    reply(A, "/robots.txt", { status: 200, headers: htmlHeaders, body: shell });
    await recordShell("real-404");
    const result = await run(await load());
    const probe = seen.filter((entry) => /\/[0-9a-f]{32}$/.test(entry));
    expect(probe).toHaveLength(1);
    expect(robotsOf(result)).toMatchObject({
      status: 200,
      sha256: digest(shell),
      absent: true,
      shell: {
        probePath: `/${probe[0]!.split("/").pop()}`,
        probeStatus: 404,
        probeSha256: digest("not found"),
        basis: "real-404",
      },
    });
  });

  it("is no robots file when it is byte-equal to the index document", async () => {
    fallback = { status: 200, headers: htmlHeaders, body: shell };
    reply(A, "/robots.txt", { status: 200, headers: htmlHeaders, body: shell });
    reply(A, "/terms", { status: 200, body: terms });
    reply(A, "/feed/index.json", { status: 200, body: "{}" });
    await recordShell("index-equal");
    const result = await run(await load());
    expect(robotsOf(result).shell).toMatchObject({
      probeStatus: 200,
      basis: "index-equal",
    });
    expect(seen).toContain(`${A}/`);
  });

  it("stays held on a host with no real 404 whose pages differ from the shell", async () => {
    fallback = {
      status: 200,
      headers: htmlHeaders,
      body: "<html>other page</html>",
    };
    reply(A, "/robots.txt", { status: 200, headers: htmlHeaders, body: shell });
    await recordShell("real-404");
    await expect(run(await load())).rejects.toMatchObject({
      code: "admission_denied",
    });
  });

  it.each([401, 403, 500])(
    "stays held when the probe answers %s",
    async (status) => {
      fallback = { status, body: "no" };
      reply(A, "/robots.txt", {
        status: 200,
        headers: htmlHeaders,
        body: shell,
      });
      await recordShell("real-404");
      await expect(run(await load())).rejects.toThrow();
    },
  );

  it("stays held unless the reviewed manifest recorded the same shell reading", async () => {
    reply(A, "/robots.txt", { status: 200, headers: htmlHeaders, body: shell });
    await expect(run(await load())).rejects.toThrow(/shell was not recorded/);
  });

  it("still holds a 403 at /robots.txt", async () => {
    reply(A, "/robots.txt", { status: 403, body: "denied" });
    await expect(run(await load())).rejects.toMatchObject({
      code: "http_status",
    });
  });

  it("decides the basis from the probe answer alone", async () => {
    const { shellBasis } = await import("../../src/fetch/robots.js");
    expect(shellBasis(404, "x")).toBe("real-404");
    expect(shellBasis(410, "x")).toBe("real-404");
    expect(shellBasis(403, "x", "x")).toBeUndefined();
    expect(shellBasis(200, "x", "y")).toBeUndefined();
    expect(shellBasis(200, "x", "x")).toBe("index-equal");
  });

  it("rejects a malformed shell record in a manifest", async () => {
    await recordShell("real-404");
    manifest.publishers[0]!.robots!.shell!.probePath = "/guess";
    await save();
    await expect(run(await load())).rejects.toThrow();
  });
});

/** Each scenario asserts the rule; a planted mutant must make it throw. */
async function crossDomainScenario(modules: Modules) {
  redirect(A, "https://www.other-org.example/robots.txt");
  reply("www.other-org.example", "/robots.txt", { status: 200, body: rules });
  await run(modules).catch(() => undefined);
  expect(seen).toEqual([`${A}/robots.txt`]);
}
async function sixHopScenario(modules: Modules) {
  const hop = (index: number) => `h${index}.issuer-a.test`;
  redirect(A, `https://${hop(1)}/robots.txt`);
  for (let index = 1; index < 6; index++)
    redirect(hop(index), `https://${hop(index + 1)}/robots.txt`);
  reply(hop(6), "/robots.txt", { status: 200, body: rules });
  await expect(run(modules)).rejects.toMatchObject({
    code: "too_many_redirects",
  });
}
async function softHostScenario(modules: Modules) {
  fallback = {
    status: 200,
    headers: htmlHeaders,
    body: "<html>other page</html>",
  };
  reply(A, "/robots.txt", { status: 200, headers: htmlHeaders, body: shell });
  await recordShell("real-404");
  await expect(run(modules)).rejects.toMatchObject({
    code: "admission_denied",
  });
}
async function forbiddenRobotsScenario(modules: Modules) {
  manifest.publishers[0]!.robots = {
    url: `https://${A}/robots.txt`,
    status: 404,
    sha256: null,
    country: "US",
    checkedAt: new Date().toISOString(),
  };
  await save();
  reply(A, "/robots.txt", { status: 403, body: "denied" });
  await expect(run(modules)).rejects.toMatchObject({ code: "http_status" });
}

describe("negative controls for the robots readers", () => {
  it.each([
    [
      "a cross-domain redirect is followed",
      crossDomainScenario,
      { module: "robots", values: { sameOrganisation: () => true } },
    ],
    [
      "a sixth hop is accepted",
      sixHopScenario,
      {
        source: "transient",
        from: "evidence.redirect_chain.length >= (options.maxRedirects ?? 5)",
        to: "evidence.redirect_chain.length >= 50",
      },
    ],
    [
      "a soft-200 host's shell is read as no robots",
      softHostScenario,
      { module: "robots", values: { shellBasis: () => "real-404" } },
    ],
    [
      "a 403 at /robots.txt is read as no robots",
      forbiddenRobotsScenario,
      {
        module: "admission",
        values: { absentRobotsStatuses: [403, 404, 410] },
      },
    ],
  ] as const)(
    "the scenario passes, and fails when %s",
    async (_name, scenario, mutant) => {
      await scenario(await load());
      beforeEachReset();
      await expect(scenario(await load(mutant))).rejects.toThrow();
    },
  );
});
