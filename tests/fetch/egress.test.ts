import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fetchModule from "../../src/fetch/index.js";
import type {
  AdmissionManifest,
  PublisherPolicy,
  Transport,
} from "../../src/fetch/index.js";
import { runBulk } from "../../src/fetch/bulk.js";
import { rebaseImports, replaceSyntax } from "../source-mutation.js";

vi.mock("../../src/fetch/limiter.js", () => ({
  leaseHost: async () => async () => {},
}));

// Synthetic egress records only: documentation-range exit addresses, no real window.
const syntheticExitIp = "198.51.100.23";
const terms = "Synthetic publisher permits scoped automated feed collection.";
const robots = "User-agent: *\nDisallow: /private\n";
const hour = 60 * 60 * 1000;
const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

let directory: string;
let manifestPath: string;
let egressDir: string;

interface SessionModule {
  AdmissionSession: typeof fetchModule.AdmissionSession;
}

function publisher(requiredEgressCountry?: string): PublisherPolicy {
  return {
    host: "publisher.test",
    state: "allowed",
    evidence: [
      {
        url: "https://publisher.test/terms",
        observedAt: new Date().toISOString(),
        status: 200,
        country: "US",
      },
    ],
    scope: { products: ["synthetic"], states: ["TX"], years: [2026] },
    discoveryUrls: ["https://publisher.test/feed/index.json"],
    permittedPaths: ["/feed"],
    delegates: [],
    attribution: "Synthetic fixture",
    updatePolicy: "Recheck daily",
    delayMs: 5000,
    jobCaps: { maxRequests: 50, maxTransferBytes: 10 * 1024 ** 2 },
    ...(requiredEgressCountry && { requiredEgressCountry }),
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
      expiresAt: new Date(Date.now() + 48 * hour).toISOString(),
    },
  };
}

async function saveManifest(requiredEgressCountry?: string): Promise<void> {
  const manifest: AdmissionManifest = {
    version: 1,
    publishers: [publisher(requiredEgressCountry)],
  };
  await writeFile(manifestPath, JSON.stringify(manifest));
}

interface RecordShape {
  country?: string;
  checkedCountry?: string;
  startedAgoMs?: number;
  windowMs?: number;
}

/** Writes a synthetic schema 1 record and returns its path and the hash handed over with it. */
async function writeRecord(shape: RecordShape = {}) {
  const now = Date.now();
  const startedAt = now - (shape.startedAgoMs ?? 60_000);
  const windowId = `vpn-synthetic-${Math.random().toString(16).slice(2, 8)}`;
  const record = {
    schema: 1,
    windowId,
    kind: "vpn",
    provider: "Synthetic provider",
    tunnelType: "openvpn-udp",
    country: shape.country ?? "US",
    exitIp: syntheticExitIp,
    server: { id: "us0000.synthetic.test", country: "United States" },
    check: {
      method: "synthetic-echo+offline-db",
      geoDb: { name: "Synthetic DB", release: "2026-11", sha256: digest("db") },
    },
    checks: {
      before: {
        at: new Date(startedAt - 5000).toISOString(),
        country: shape.checkedCountry ?? shape.country ?? "US",
        hostIpDiffers: true,
      },
    },
    startedAt: new Date(startedAt).toISOString(),
    maxEndAt: new Date(startedAt + (shape.windowMs ?? 2 * hour)).toISOString(),
  };
  const file = join(egressDir, `${windowId}.json`);
  const bytes = JSON.stringify(record);
  await writeFile(file, bytes);
  return { file, sha256: digest(bytes), windowId };
}

const policyBodies: Record<string, string> = {
  "/robots.txt": robots,
  "/terms": terms,
};
const policyTransport =
  (requested: string[]): Transport =>
  async (url) => {
    requested.push(url.pathname);
    const body = policyBodies[url.pathname] ?? '{"synthetic":true}';
    return { status: 200, headers: {}, body: Readable.from([body]) };
  };

const feed = new URL("https://publisher.test/feed/index.json");

/**
 * Negative controls. Each must reject on the real fetcher and must stop rejecting on the planted
 * mutant named after it, so a control that cannot fail is caught.
 */
const controls: Record<string, (module: SessionModule) => Promise<void>> = {
  async "missing egress record for a US-required host"({ AdmissionSession }) {
    await saveManifest("US");
    vi.stubEnv("OPENPLANS_EGRESS_FILE", "");
    vi.stubEnv("OPENPLANS_EGRESS_COUNTRY", "US");
    // A declared country alone is not a record.
    const session = new AdmissionSession(manifestPath, undefined, {
      egressCountry: "US",
    });
    await expect(session.assertCurrent(feed)).rejects.toThrow(
      /requires a recorded US egress/,
    );
  },
  async "stale egress record"({ AdmissionSession }) {
    const record = await writeRecord({
      startedAgoMs: 3 * hour,
      windowMs: 2 * hour,
    });
    expect(
      () =>
        new AdmissionSession(manifestPath, undefined, {
          egressFile: record.file,
          egressSha256: record.sha256,
        }),
    ).toThrow(/stale/);
  },
  async "egress window already closed"({ AdmissionSession }) {
    const record = await writeRecord();
    await writeFile(record.file.replace(/\.json$/, ".result.json"), "{}");
    expect(
      () =>
        new AdmissionSession(manifestPath, undefined, {
          egressFile: record.file,
          egressSha256: record.sha256,
        }),
    ).toThrow(/stale/);
  },
  async "egress country mismatch"({ AdmissionSession }) {
    const record = await writeRecord({ country: "US" });
    vi.stubEnv("OPENPLANS_EGRESS_COUNTRY", "CO");
    expect(
      () =>
        new AdmissionSession(manifestPath, undefined, {
          egressFile: record.file,
          egressSha256: record.sha256,
        }),
    ).toThrow(/differs from the egress record/);
  },
  async "tampered egress record"({ AdmissionSession }) {
    const record = await writeRecord();
    const original = await readFile(record.file, "utf8");
    await writeFile(record.file, original.replace('"US"', '"CA"'));
    expect(
      () =>
        new AdmissionSession(manifestPath, undefined, {
          egressFile: record.file,
          egressSha256: record.sha256,
        }),
    ).toThrow(/differ from the handed-over SHA-256/);
  },
  async "egress record changed during collection"({ AdmissionSession }) {
    await saveManifest("US");
    const record = await writeRecord();
    const session = new AdmissionSession(manifestPath, undefined, {
      egressFile: record.file,
      egressSha256: record.sha256,
    });
    await session.assertCurrent(feed);
    await writeFile(record.file, `${await readFile(record.file, "utf8")} `);
    await expect(session.assertCurrent(feed)).rejects.toThrow(
      /changed during collection/,
    );
  },
};

const mutants: Record<string, { file: string; before: string; after: string }> =
  {
    "missing egress record for a US-required host": {
      file: "admission.ts",
      before: "required && this.egress?.country !== required",
      after: "false",
    },
    "stale egress record": {
      file: "egress.ts",
      before: "now >= maxEndAt",
      after: "false",
    },
    "egress window already closed": {
      file: "egress.ts",
      before: 'existsSync(file.replace(/\\.json$/, ".result.json"))',
      after: "false",
    },
    "egress country mismatch": {
      file: "egress.ts",
      before: "declared !== undefined && declared !== record.country",
      after: "false",
    },
    "tampered egress record": {
      file: "egress.ts",
      before: "recordSha256 !== input.expectedSha256",
      after: "false",
    },
    "egress record changed during collection": {
      file: "egress.ts",
      before:
        "digest(readRecordBytes(binding.file)) !== binding.receipt.recordSha256",
      after: "false",
    },
  };

const sourceDir = new URL("../../src/fetch/", import.meta.url);
const builtDir = new URL("../../dist/fetch/", import.meta.url);
const zodUrl = pathToFileURL(
  createRequire(import.meta.url).resolve("zod"),
).href;

/**
 * Compiles admission.ts and egress.ts side by side, at most one of them mutated; the rest is the
 * build. Without a mutant the compiled pair is the baseline that must still reject.
 */
async function loadMutant(
  name: string,
  mutant?: (typeof mutants)[string],
): Promise<SessionModule> {
  const out = join(directory, "mutants", name.replace(/\W+/g, "-"));
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "package.json"), '{"type":"module"}\n');
  for (const file of ["admission.ts", "egress.ts"]) {
    let source = await readFile(new URL(file, sourceDir), "utf8");
    if (file === mutant?.file)
      source = replaceSyntax(source, mutant.before, mutant.after);
    source = rebaseImports(source, builtDir)
      .replaceAll(
        JSON.stringify(new URL("egress.js", builtDir).href),
        '"./egress.js"',
      )
      .replace(/from\s+["']zod["']/, `from ${JSON.stringify(zodUrl)}`);
    const output = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ES2022,
      },
    }).outputText;
    await writeFile(join(out, file.replace(/\.ts$/, ".js")), output);
  }
  return (await import(
    pathToFileURL(join(out, "admission.js")).href
  )) as SessionModule;
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "openplans-synthetic-egress-"));
  manifestPath = join(directory, "access.json");
  egressDir = join(directory, "access", "egress");
  await mkdir(egressDir, { recursive: true });
  await saveManifest();
  vi.stubEnv("OPENPLANS_EGRESS_FILE", "");
  vi.stubEnv("OPENPLANS_EGRESS_SHA256", "");
  vi.stubEnv("OPENPLANS_EGRESS_COUNTRY", "");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe("egress record from OPENPLANS_EGRESS_FILE", () => {
  it("copies the validated record into every receipt and the snapshot, never the exit address", async () => {
    await saveManifest("US");
    const record = await writeRecord();
    vi.stubEnv("OPENPLANS_EGRESS_FILE", record.file);
    vi.stubEnv("OPENPLANS_EGRESS_SHA256", record.sha256);
    vi.stubEnv("OPENPLANS_EGRESS_COUNTRY", "US");
    const requested: string[] = [];
    const result = await fetchModule.fetchToCache(feed, {
      source: "synthetic",
      dataDir: directory,
      allowHosts: ["publisher.test"],
      expectedContent: "json",
      admission: new fetchModule.AdmissionSession(manifestPath),
      transport: policyTransport(requested),
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      maxAttempts: 1,
    });
    expect(requested).toEqual(["/robots.txt", "/terms", "/feed/index.json"]);
    const host = result.admission!.hosts[0]!;
    expect(host.egressCountry).toBe("US");
    expect(host.egress).toMatchObject({
      recordSha256: record.sha256,
      windowId: record.windowId,
      country: "US",
      kind: "vpn",
      exitIpSha256: digest(`${record.windowId}\n${syntheticExitIp}`),
      server: { id: "us0000.synthetic.test" },
      check: { method: "synthetic-echo+offline-db" },
    });
    if (result.outcome === "not_modified") throw new Error("Expected snapshot");
    const metadata = await readFile(result.metadataPath, "utf8");
    expect(JSON.parse(metadata).access_policy.hosts[0].egress).toEqual(
      host.egress,
    );
    expect(metadata).not.toContain(syntheticExitIp);
  });

  it("keeps today's behaviour without a record: declared country only, null egress", async () => {
    const session = new fetchModule.AdmissionSession(manifestPath, undefined, {
      egressCountry: "CO",
    });
    expect(session.egress).toBeUndefined();
    expect(session.egressCountry).toBe("CO");
    await expect(session.assertCurrent(feed)).resolves.toMatchObject({
      host: "publisher.test",
    });
  });

  it("refuses a record without its hash, outside schema 1, or whose check found another country", async () => {
    const record = await writeRecord();
    const open = (file: string, sha256?: string) =>
      new fetchModule.AdmissionSession(manifestPath, undefined, {
        egressFile: file,
        egressSha256: sha256,
      });
    expect(() => open(record.file)).toThrow(/SHA-256/);
    expect(() => open(join(egressDir, "missing.json"), record.sha256)).toThrow(
      /cannot be read/,
    );
    const bad = join(egressDir, "bad.json");
    await writeFile(bad, '{"schema":2}');
    expect(() => open(bad, digest('{"schema":2}'))).toThrow(/schema 1/);
    const split = await writeRecord({ country: "US", checkedCountry: "MX" });
    expect(() => open(split.file, split.sha256)).toThrow(/another country/);
    const long = await writeRecord({ windowMs: 25 * hour });
    expect(() => open(long.file, long.sha256)).toThrow(/bounds/);
  });

  it("refuses a US-required host with a valid record for another country", async () => {
    await saveManifest("US");
    const record = await writeRecord({ country: "CO" });
    const session = new fetchModule.AdmissionSession(manifestPath, undefined, {
      egressFile: record.file,
      egressSha256: record.sha256,
    });
    await expect(session.assertCurrent(feed)).rejects.toThrow(
      /requires a recorded US egress/,
    );
  });

  it("refuses a bulk job before its first request when the record is stale", async () => {
    const record = await writeRecord({
      startedAgoMs: 3 * hour,
      windowMs: hour,
    });
    vi.stubEnv("OPENPLANS_EGRESS_FILE", record.file);
    vi.stubEnv("OPENPLANS_EGRESS_SHA256", record.sha256);
    const reportPath = join(directory, "report.json");
    await expect(
      runBulk({
        id: "synthetic-egress",
        dataDir: directory,
        admissionManifest: manifestPath,
        reportPath,
        allowHosts: ["publisher.test"],
        targets: [
          {
            url: feed.href,
            source: "synthetic",
            expectedContent: "json",
          },
        ],
        maxTransferBytes: 10000,
        maxFileBytes: 5000,
        maxRequests: 20,
        wallSeconds: 100,
      }),
    ).rejects.toMatchObject({ code: "admission_denied" });
    expect(existsSync(reportPath)).toBe(false);
  });

  it("refuses a bulk spec country that differs from the record", async () => {
    const record = await writeRecord({ country: "US" });
    vi.stubEnv("OPENPLANS_EGRESS_FILE", record.file);
    vi.stubEnv("OPENPLANS_EGRESS_SHA256", record.sha256);
    await expect(
      runBulk({
        id: "synthetic-egress",
        dataDir: directory,
        admissionManifest: manifestPath,
        reportPath: join(directory, "report.json"),
        allowHosts: ["publisher.test"],
        targets: [
          { url: feed.href, source: "synthetic", expectedContent: "json" },
        ],
        maxTransferBytes: 10000,
        maxFileBytes: 5000,
        maxRequests: 20,
        wallSeconds: 100,
        egressCountry: "CO",
      }),
    ).rejects.toThrow(/differs from the egress record/);
  });

  describe.each(Object.keys(controls))("negative control: %s", (name) => {
    it("rejects on the real fetcher", async () => {
      await controls[name]!(fetchModule);
    });
    it("rejects on the compiled baseline the mutant is cut from", async () => {
      await controls[name]!(await loadMutant(`${name} baseline`));
    });
    it("stops rejecting on its planted mutant", async () => {
      const mutant = await loadMutant(name, mutants[name]!);
      await expect(controls[name]!(mutant)).rejects.toThrow();
    });
  });
});
