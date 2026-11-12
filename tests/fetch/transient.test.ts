import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { gzipSync, deflateSync, brotliCompressSync } from "node:zlib";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AdmissionSession,
  fetchToCache,
  fetchTransient,
} from "../../src/fetch/index.js";
import type {
  AdmissionManifest,
  PublisherPolicy,
  TransientFetchOptions,
  Transport,
  TransportContext,
} from "../../src/fetch/index.js";
import { rebaseImports, replaceSyntax } from "../source-mutation.js";

const release = vi.fn(async () => {});
vi.mock("../../src/fetch/limiter.js", () => ({
  leaseHost: vi.fn(async () => release),
}));
import { leaseHost } from "../../src/fetch/limiter.js";

// Every publisher, policy, credential and response in this suite is synthetic.
const terms = "Synthetic publisher permits transient requests.";
const robots = "User-agent: *\nDisallow: /private\n";
const feed = "https://publisher.test/feed/index.json";
const digest = (body: string | Buffer) =>
  createHash("sha256").update(body).digest("hex");
let directory: string;
let manifestPath: string;
let dataDir: string;
let manifest: AdmissionManifest;
let options: TransientFetchOptions;
let dataBody: Buffer;
let dataStatus: number;
let dataHeaders: Record<string, string>;
let requests: { url: URL; context: TransportContext }[];
let transport: Transport;
function publisher(): PublisherPolicy {
  return {
    host: "publisher.test",
    state: "allowed",
    evidence: [
      {
        url: "https://publisher.test/terms",
        observedAt: new Date().toISOString(),
        status: 200,
      },
    ],
    scope: { products: ["synthetic"], states: ["TX"], years: [2026] },
    discoveryUrls: [feed],
    permittedPaths: ["/feed"],
    delegates: [],
    attribution: "Synthetic fixture",
    updatePolicy: "Recheck daily",
    delayMs: 5000,
    jobCaps: { maxRequests: 200, maxTransferBytes: 50 * 1024 ** 2 },
    robots: {
      url: "https://publisher.test/robots.txt",
      status: 200,
      sha256: digest(robots),
      checkedAt: new Date().toISOString(),
    },
    terms: {
      url: "https://publisher.test/terms",
      disposition: "allowed",
      sha256: digest(terms),
      reviewedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    },
  };
}
const saveManifest = () => writeFile(manifestPath, JSON.stringify(manifest));
const run = (overrides: Partial<TransientFetchOptions> = {}) =>
  fetchTransient(feed, { ...options, ...overrides });
beforeEach(async () => {
  vi.stubEnv("OPENPLANS_EGRESS_FILE", "");
  vi.stubEnv("OPENPLANS_EGRESS_SHA256", "");
  vi.stubEnv("OPENPLANS_EGRESS_COUNTRY", "");
  directory = await mkdtemp(join(tmpdir(), "openplans-synthetic-transient-"));
  dataDir = join(directory, "data");
  await mkdir(dataDir);
  await writeFile(join(dataDir, "sentinel"), "unchanged");
  manifestPath = join(directory, "access.json");
  manifest = { version: 1, publishers: [publisher()] };
  await saveManifest();
  dataBody = Buffer.from('{"synthetic":true}');
  dataStatus = 200;
  dataHeaders = {};
  requests = [];
  release.mockClear();
  vi.mocked(leaseHost).mockClear();
  transport = async (url, context) => {
    requests.push({ url, context });
    let policy: string | undefined;
    if (url.pathname === "/robots.txt") policy = robots;
    if (url.pathname === "/terms") policy = terms;
    return {
      status: policy ? 200 : dataStatus,
      headers: policy ? {} : dataHeaders,
      body: Readable.from([policy ?? dataBody]),
    };
  };
  options = {
    dataDir,
    admission: new AdmissionSession(manifestPath),
    allowHosts: ["publisher.test"],
    expectedContent: "json",
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
    transport: (url, context) => transport(url, context),
    maxAttempts: 1,
  };
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe("transient admitted acquisition", () => {
  it("returns bytes, decoded hash, receipt and selected headers without changing the data directory", async () => {
    dataHeaders = {
      "content-type": "application/json",
      "set-cookie": "synthetic-cookie",
      authorization: "synthetic-auth",
      etag: "synthetic-etag",
    };
    const before = await readFile(join(dataDir, "sentinel"));
    const result = await run();
    expect(result).toMatchObject({
      body: dataBody,
      sha256: digest(dataBody),
      status: 200,
      headers: { "content-type": "application/json" },
      admission: { hosts: [{ host: "publisher.test", state: "allowed" }] },
    });
    expect(result.headers).toEqual({ "content-type": "application/json" });
    expect(await readdir(dataDir, { recursive: true })).toEqual(["sentinel"]);
    expect(await readFile(join(dataDir, "sentinel"))).toEqual(before);
    expect(requests.map(({ url }) => url.pathname)).toEqual([
      "/robots.txt",
      "/terms",
      "/feed/index.json",
    ]);
    expect(leaseHost).toHaveBeenCalledTimes(3);
    expect(leaseHost).toHaveBeenLastCalledWith(
      dataDir,
      "publisher.test",
      5000,
      5000,
    );
    expect(release).toHaveBeenCalledTimes(3);
    const agents = requests.map(({ context }) => context.headers["user-agent"]);
    requests = [];
    await fetchToCache(feed, {
      ...options,
      source: "synthetic",
      expectedContent: "json",
    });
    expect(
      requests.map(({ context }) => context.headers["user-agent"]),
    ).toEqual(agents.slice(-1));
  });

  it("makes another data request instead of retaining a response", async () => {
    const first = await run();
    dataBody = Buffer.from("changed synthetic response");
    const second = await run({ expectedContent: "binary" });
    expect(second.body).toEqual(dataBody);
    expect(first.sha256).not.toBe(second.sha256);
    expect(requests.map(({ url }) => url.pathname)).toEqual([
      "/robots.txt",
      "/terms",
      "/feed/index.json",
      "/feed/index.json",
    ]);
  });

  it.each([201, 202, 204])(
    "accepts successful delivery status %s",
    async (status) => {
      dataStatus = status;
      dataBody = Buffer.alloc(0);
      expect((await run()).status).toBe(status);
    },
  );

  it("defaults to a 2 MiB cap and refuses a larger advertised response", async () => {
    dataHeaders["content-length"] = String(2 * 1024 ** 2 + 1);
    await expect(run()).rejects.toMatchObject({ code: "too_large" });
    expect(options.admission!.isStopped).toBe(true);
    expect(await readdir(dataDir)).toEqual(["sentinel"]);
  });

  it.each([
    ["gzip", gzipSync],
    ["deflate", deflateSync],
    ["br", brotliCompressSync],
  ] as const)(
    "bounds decoded bytes for compressed responses (%s)",
    async (encoding, compress) => {
      const payload = Buffer.from("synthetic ".repeat(100));
      dataBody = compress(payload);
      dataHeaders["content-encoding"] = encoding;
      expect(
        (await run({ expectedContent: "binary", maxBytes: 2048 })).body,
      ).toEqual(payload);
      await expect(
        run({ maxBytes: 2048, maxDecompressedBytes: 10 }),
      ).rejects.toMatchObject({ code: "too_large" });
    },
  );

  it.each(["identity", "gzip"])(
    "bounds actual transfer bytes without Content-Length (%s)",
    async (encoding) => {
      dataBody = encoding === "gzip" ? gzipSync(dataBody) : dataBody;
      dataHeaders["content-encoding"] = encoding;
      await expect(run({ maxBytes: 5 })).rejects.toMatchObject({
        code: "too_large",
      });
    },
  );

  it.each(["bad", "1", "999"])(
    "rejects invalid or inconsistent Content-Length %s",
    async (length) => {
      dataHeaders["content-length"] = length;
      await expect(run()).rejects.toMatchObject({ code: "truncated" });
    },
  );

  it.each(["gzip", "deflate", "br", "compress"])(
    "rejects invalid compressed data or unsupported encoding %s",
    async (encoding) => {
      dataHeaders["content-encoding"] = encoding;
      await expect(run()).rejects.toMatchObject({
        code: encoding === "compress" ? "unsupported_encoding" : "truncated",
      });
    },
  );

  it.each([{}, { maxRedirects: 1 }])(
    "requires zero redirects for an upload (%j)",
    async (overrides) => {
      await expect(
        run({
          ...overrides,
          requestBody: {
            contentType: "application/json",
            body: Buffer.from("synthetic upload"),
          },
        }),
      ).rejects.toMatchObject({ code: "invalid_options" });
      expect(requests).toEqual([]);
    },
  );

  it("sends an upload only with data requests and refuses its redirect", async () => {
    const upload = Buffer.from("synthetic upload");
    dataStatus = 307;
    dataHeaders.location = "https://publisher.test/feed/next";
    await expect(
      run({
        maxRedirects: 0,
        requestBody: { contentType: "application/json", body: upload },
      }),
    ).rejects.toMatchObject({ code: "too_many_redirects" });
    expect(
      requests
        .slice(0, 2)
        .every(({ context }) => !context.body && !context.method),
    ).toBe(true);
    expect(requests[2]!.context).toMatchObject({
      method: "POST",
      body: upload,
    });
    expect(requests).toHaveLength(3);
  });

  it.each([408, 429, 500, 502, 503, 504])(
    "retries HTTP %s with the same retry delay rules",
    async (status) => {
      dataStatus = status;
      dataHeaders["retry-after"] = "2";
      const sleep = vi.fn(async () => {
        dataStatus = 200;
      });
      expect(
        (await run({ maxAttempts: 3, sleep, random: () => 0 })).status,
      ).toBe(200);
      expect(sleep).toHaveBeenCalledOnce();
      expect(sleep).toHaveBeenCalledWith(2000);
      expect(requests).toHaveLength(4);
    },
  );

  it.each([401, 403])("never retries HTTP %s", async (status) => {
    dataStatus = status;
    const sleep = vi.fn(async () => {});
    await expect(run({ maxAttempts: 3, sleep })).rejects.toMatchObject({
      code: "http_status",
      status,
    });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not retry sooner than an excessive Retry-After", async () => {
    dataStatus = 429;
    dataHeaders["retry-after"] = "61";
    await expect(run({ maxAttempts: 3 })).rejects.toMatchObject({
      code: "http_status",
    });
    expect(requests).toHaveLength(3);
  });

  it.each([200, 503])(
    "stops on a split challenge at status %s",
    async (status) => {
      const original = transport;
      transport = async (url, context) => {
        const response = await original(url, context);
        if (url.pathname.startsWith("/feed")) {
          response.status = status;
          response.body = Readable.from(["Please verify you ", "are human"]);
        }
        return response;
      };
      await expect(
        run({ maxAttempts: 3, sleep: async () => {} }),
      ).rejects.toMatchObject({ code: "challenge_detected" });
      expect(requests).toHaveLength(3);
    },
  );

  it("revalidates the manifest before returning bytes", async () => {
    const original = transport;
    transport = async (url, context) => {
      const response = await original(url, context);
      if (url.pathname.startsWith("/feed"))
        response.body = Readable.from(
          (async function* () {
            yield "synthetic";
            manifest.publishers[0]!.state = "unknown";
            await saveManifest();
            yield " response";
          })(),
        );
      return response;
    };
    await expect(run({ expectedContent: "binary" })).rejects.toMatchObject({
      code: "admission_denied",
    });
  });

  it("checks a delegated host's policies and returns its admitted body", async () => {
    const delegate = publisher();
    delegate.host = "delegate.test";
    delegate.discoveryUrls = ["https://delegate.test/feed/index.json"];
    delegate.evidence[0]!.url = "https://delegate.test/terms";
    delegate.robots!.url = "https://delegate.test/robots.txt";
    delegate.terms!.url = "https://delegate.test/terms";
    manifest.publishers[0]!.delegates = ["delegate.test"];
    manifest.publishers.push(delegate);
    await saveManifest();
    const original = transport;
    transport = async (url, context) => {
      const response = await original(url, context);
      if (
        url.hostname === "publisher.test" &&
        url.pathname.startsWith("/feed")
      ) {
        response.status = 302;
        response.headers = {
          location: "https://delegate.test/feed/index.json",
        };
      }
      return response;
    };
    const result = await run({
      allowHosts: ["publisher.test", "delegate.test"],
    });
    expect(result.body).toEqual(dataBody);
    expect(result.admission.hosts.map(({ host }) => host)).toEqual([
      "publisher.test",
      "delegate.test",
    ]);
    expect(requests).toHaveLength(6);
    expect(release).toHaveBeenCalledTimes(6);
  });

  it.each([404, 410])(
    "accepts directly absent robots at HTTP %s without persisting policies",
    async (status) => {
      manifest.publishers[0]!.robots!.status = status;
      manifest.publishers[0]!.robots!.sha256 = null;
      manifest.publishers[0]!.robots!.country = "US";
      await saveManifest();
      const original = transport;
      transport = async (url, context) => {
        const response = await original(url, context);
        if (url.pathname === "/robots.txt") response.status = status;
        return response;
      };
      expect((await run()).body).toEqual(dataBody);
      expect(await readdir(dataDir)).toEqual(["sentinel"]);
    },
  );

  it("requires admission even with an injected transport", async () => {
    vi.stubEnv("OPENPLANS_ACCESS_MANIFEST", "");
    vi.stubEnv("OPENPLANS_SHIPPED_ACCESS", "off");
    await expect(run({ admission: undefined })).rejects.toMatchObject({
      code: "admission_required",
    });
    expect(requests).toEqual([]);
  });

  it("adds API keys only to the data URL and redacts query values in errors", async () => {
    manifest.publishers[0]!.accessMode = "api-key";
    manifest.publishers[0]!.apiKey = {
      env: "SYNTHETIC_TRANSIENT_KEY",
      queryParam: "api_key",
    };
    await saveManifest();
    const key = "synthetic-transient-secret";
    options.admission = new AdmissionSession(manifestPath, undefined, {
      apiKeys: { "publisher.test": key },
    });
    dataStatus = 403;
    let failure: unknown;
    try {
      await fetchTransient(`${feed}?query=synthetic-sensitive`, options);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "http_status" });
    expect(JSON.stringify(failure)).not.toContain(key);
    expect(JSON.stringify(failure)).not.toContain("synthetic-sensitive");
    expect(
      requests
        .filter(({ url }) => url.pathname !== "/feed/index.json")
        .every(({ url }) => !url.search),
    ).toBe(true);
    expect(requests.at(-1)!.url.searchParams.get("api_key")).toBe(key);
  });

  it.each([0, -1, NaN, Infinity])(
    "rejects an invalid deadline %s before admission",
    async (deadlineMs) => {
      await expect(run({ deadlineMs })).rejects.toMatchObject({
        code: "invalid_options",
      });
      expect(requests).toEqual([]);
    },
  );

  it("enforces the deadline while the body stalls and releases its lease", async () => {
    const original = transport;
    let body: Readable | undefined;
    transport = async (url, context) => {
      const response = await original(url, context);
      if (url.pathname.startsWith("/feed")) {
        body = new Readable({ read() {} });
        response.body = body;
      }
      return response;
    };
    await expect(run({ deadlineMs: 80, maxAttempts: 3 })).rejects.toMatchObject(
      { code: "read_timeout" },
    );
    expect(body!.destroyed).toBe(true);
    expect(release).toHaveBeenCalledTimes(3);
  });

  it("releases a lease acquired after the deadline without sending a late data request", async () => {
    let unlock: (() => void) | undefined;
    const lateRelease = vi.fn(async () => {});
    vi.mocked(leaseHost).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          unlock = () => resolve(lateRelease);
        }),
    );
    await expect(run({ deadlineMs: 40 })).rejects.toMatchObject({
      code: "read_timeout",
    });
    unlock!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lateRelease).toHaveBeenCalledOnce();
    expect(requests).toEqual([]);
  });

  it("destroys a transport response that arrives after the deadline", async () => {
    let finish: (() => void) | undefined;
    const body = Readable.from(["late synthetic response"]);
    transport = () =>
      new Promise((resolve) => {
        finish = () => resolve({ status: 200, headers: {}, body });
      });
    await expect(run({ deadlineMs: 40 })).rejects.toMatchObject({
      code: "read_timeout",
    });
    finish!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(body.destroyed).toBe(true);
  });
});

// Only the transient module uses this compiled session. The cache implementation is untouched.
async function egressModules(mutant: boolean) {
  const out = join(directory, mutant ? "mutant" : "baseline");
  await mkdir(out);
  await writeFile(join(out, "package.json"), '{"type":"module"}\n');
  const builtDir = new URL("../../dist/fetch/", import.meta.url);
  const zodUrl = pathToFileURL(
    createRequire(import.meta.url).resolve("zod"),
  ).href;
  for (const file of ["transient.ts", "admission.ts"]) {
    let source = await readFile(
      new URL(`../../src/fetch/${file}`, import.meta.url),
      "utf8",
    );
    if (mutant && file === "admission.ts")
      source = replaceSyntax(
        source,
        "assertEgressCurrent(this.egress)",
        "void 0",
      );
    source = rebaseImports(source, builtDir)
      .replaceAll(
        JSON.stringify(new URL("admission.js", builtDir).href),
        '"./admission.js"',
      )
      .replaceAll(
        JSON.stringify(new URL("limiter.js", builtDir).href),
        '"./limiter.js"',
      )
      .replace(/from\s+["']zod["']/, `from ${JSON.stringify(zodUrl)}`);
    await writeFile(
      join(out, file.replace(/\.ts$/, ".js")),
      ts.transpileModule(source, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ES2022,
        },
      }).outputText,
    );
  }
  await writeFile(
    join(out, "limiter.js"),
    "export const leaseHost = async () => async () => {};\n",
  );
  const transient = (await import(
    pathToFileURL(join(out, "transient.js")).href
  )) as { fetchTransient: typeof fetchTransient };
  const admission = (await import(
    pathToFileURL(join(out, "admission.js")).href
  )) as { AdmissionSession: typeof AdmissionSession };
  return { ...transient, ...admission };
}

async function egressControl(module: {
  fetchTransient: typeof fetchTransient;
  AdmissionSession: typeof AdmissionSession;
}) {
  const now = Date.now();
  const record = {
    schema: 1,
    windowId: "vpn-synthetic-transient",
    kind: "vpn",
    provider: "Synthetic provider",
    tunnelType: "openvpn-udp",
    country: "US",
    exitIp: "198.51.100.23",
    server: { id: "synthetic.test", country: "United States" },
    check: {
      method: "synthetic-echo+offline-db",
      geoDb: { name: "Synthetic DB", release: "2026-11", sha256: digest("db") },
    },
    checks: {
      before: {
        at: new Date(now - 65_000).toISOString(),
        country: "US",
        hostIpDiffers: true,
      },
    },
    startedAt: new Date(now - 60_000).toISOString(),
    maxEndAt: new Date(now + 60_000).toISOString(),
  };
  const file = join(
    directory,
    `egress-${Math.random().toString(16).slice(2)}.json`,
  );
  const bytes = JSON.stringify(record);
  await writeFile(file, bytes);
  const admission = new module.AdmissionSession(manifestPath, undefined, {
    egressFile: file,
    egressSha256: digest(bytes),
  });
  const original = transport;
  const transportWithTampering: Transport = async (url, context) => {
    const response = await original(url, context);
    if (url.pathname.startsWith("/feed"))
      response.body = Readable.from(
        (async function* () {
          yield "synthetic";
          await writeFile(file, `${bytes} `);
          yield " response";
        })(),
      );
    return response;
  };
  await expect(
    module.fetchTransient(feed, {
      ...options,
      admission,
      expectedContent: "binary",
      transport: transportWithTampering,
    }),
  ).rejects.toMatchObject({ code: "admission_denied" });
}

describe("transient egress negative control", () => {
  it("rejects a changed egress record on the real path", async () => {
    await egressControl({ fetchTransient, AdmissionSession });
  });
  it("rejects a changed egress record on the compiled baseline", async () => {
    await egressControl(await egressModules(false));
  });
  it("fails the same egress assertion when assertEgressCurrent is removed from the transient session", async () => {
    await expect(egressControl(await egressModules(true))).rejects.toThrow(
      /promise resolved/,
    );
  });
});
