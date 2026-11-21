import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  buildUsageReport,
  requestsBucket,
  statesBucket,
  uptimeBucket,
} from "../../src/usage-report/build.js";
import type * as Build from "../../src/usage-report/build.js";
import { isFirstPartyPlugin } from "../../src/usage-report/first-party.js";
import { usageReportSchema } from "../../src/usage-report/schema.js";
import { importMutant, withMutantFile } from "../mutant-file.js";
import { exampleFacts, exampleReport } from "./facts.js";

const buildSource = new URL("../../src/usage-report/build.ts", import.meta.url);

// Numbers may appear only here; any other number could be a ZIP, NPI, drug id or raw count.
const NUMERIC_PATHS = [
  /^data\.years\.\d+$/,
  /^node_major$/,
  /^features\.other_plugins_count$/,
];
const TOKEN = /^[A-Za-z0-9<>+./-]{1,48}$/;

/** Every finding that would make a payload unsafe to send. An empty list means it passed. */
function scan(payload: unknown): string[] {
  const found: string[] = [];
  const text = JSON.stringify(payload);
  if (text.length > 2048) found.push(`size ${text.length} bytes`);
  const walk = (value: unknown, path: string) => {
    if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}.${i}`));
    else if (value && typeof value === "object")
      for (const [key, child] of Object.entries(value))
        walk(child, path ? `${path}.${key}` : key);
    else if (typeof value === "number") {
      if (!NUMERIC_PATHS.some((allowed) => allowed.test(path)))
        found.push(`number at ${path}`);
    } else if (typeof value === "string") {
      if (path === "install_id") return; // a validated UUID v4
      if (path === "schema") return; // the literal schema name
      if (/\d{5}/.test(value)) found.push(`ZIP or longer digit run at ${path}`);
      if (/\d{10}/.test(value)) found.push(`NPI-like number at ${path}`);
      if (/\d{4,5}-\d{3,4}-\d{1,2}/.test(value))
        found.push(`NDC-like code at ${path}`);
      if (/[?&=#]/.test(value)) found.push(`query string at ${path}`);
      if (/\b\d{1,3}(\.\d{1,3}){3}\b/.test(value))
        found.push(`IPv4 address at ${path}`);
      if (/[0-9a-f]{0,4}:[0-9a-f]{0,4}:/i.test(value))
        found.push(`IPv6 address at ${path}`);
      if (value.includes("://")) found.push(`URL at ${path}`);
      if (value.includes("@") && !isFirstPartyPlugin(value))
        found.push(`@ at ${path}`);
      if (!TOKEN.test(value) && !isFirstPartyPlugin(value))
        found.push(`free text at ${path}`);
    }
  };
  walk(payload, "");
  return found;
}

describe("buildUsageReport", () => {
  it("builds the documented report from existing facts", () => {
    expect(buildUsageReport(exampleFacts())).toEqual(exampleReport());
  });

  it("pins the exact key set", () => {
    const report = buildUsageReport(exampleFacts());
    expect(Object.keys(report)).toEqual([
      "schema",
      "install_id",
      "sent_day",
      "version",
      "previous_version",
      "arch",
      "node_major",
      "uptime_bucket",
      "data",
      "features",
      "last_migration",
      "requests_bucket",
    ]);
    expect(Object.keys(report.data)).toEqual([
      "years",
      "states_bucket",
      "coverage",
    ]);
    expect(Object.keys(report.features)).toEqual([
      "mcp",
      "public_quoting",
      "public_household",
      "compat",
      "cache_backend",
      "scheduler_seen",
      "metrics",
      "cms_fallback",
      "medicare_part_d",
      "first_party_plugins",
      "other_plugins_count",
    ]);
  });

  it("leaves request buckets null when metrics are off, even if series are passed", () => {
    const report = buildUsageReport(exampleFacts({}));
    expect(report.features.metrics).toBe(false);
    expect(report.requests_bucket).toBeNull();
  });

  it("reports unknown status as null, not as missing coverage", () => {
    const report = buildUsageReport(exampleFacts(undefined, { status: null }));
    expect(report.data).toEqual({
      years: null,
      states_bucket: null,
      coverage: null,
    });
  });

  it("reports the upgrade outcome from the schema journal state", () => {
    const outcome = (schema: Build.UsageReportFacts["schema"]) =>
      buildUsageReport(exampleFacts(undefined, { schema })).last_migration;
    expect(outcome("ready")?.outcome).toBe("ok");
    expect(outcome("pending")?.outcome).toBe("failed");
    expect(outcome("unknown")?.outcome).toBe("unknown");
    expect(
      buildUsageReport(exampleFacts(undefined, { previousVersion: "0.4.16" }))
        .last_migration,
    ).toBeNull();
    expect(
      buildUsageReport(exampleFacts(undefined, { previousVersion: null }))
        .last_migration,
    ).toBeNull();
  });

  it("names only allowlisted plugins and maps unknown cache stores and arches", () => {
    const report = buildUsageReport(
      exampleFacts(
        { OPENPLANS_API_CACHE: "on" },
        { arch: "sparc", installId: null },
      ),
    );
    expect(report.features.first_party_plugins).not.toContain(
      "@example/plugin-local",
    );
    expect(report.features.other_plugins_count).toBe(1);
    expect(report.arch).toBe("other");
    expect(report.install_id).toBeNull();
    const off = buildUsageReport(exampleFacts({ OPENPLANS_API_CACHE: "off" }));
    expect(off.features.cache_backend).toBe("off");
  });

  it("buckets raw values at their edges", () => {
    expect(
      [0, 3_599_999, 3_600_000, 86_400_000, 604_800_000, 2_592_000_000].map(
        uptimeBucket,
      ),
    ).toEqual(["<1h", "<1h", "1h-1d", "1d-7d", "7d-30d", "30d+"]);
    expect([0, 1, 2, 5, 6, 20, 21, 56].map(statesBucket)).toEqual([
      "0",
      "1",
      "2-5",
      "2-5",
      "6-20",
      "6-20",
      "21+",
      "21+",
    ]);
    expect(
      [0, 1, 100, 101, 1000, 1001, 10_000, 10_001].map(requestsBucket),
    ).toEqual([
      "0",
      "1-100",
      "1-100",
      "101-1k",
      "101-1k",
      "1k-10k",
      "1k-10k",
      "10k+",
    ]);
  });
});

describe("usage report string scan", () => {
  it("finds nothing in a built report", () => {
    expect(scan(buildUsageReport(exampleFacts()))).toEqual([]);
  });

  it("carries no configured secret, host, path or address", () => {
    const env = {
      OPENPLANS_METRICS: "on",
      DATABASE_URL: "postgres://db.sentinel.invalid:5432/sentineldb",
      HOST: "10.20.30.40",
      PORT: "54321",
      OPENPLANS_API_TOKEN: "sentinel-api-token-value",
      OPENPLANS_OPERATOR_TOKEN: "sentinel-operator-token",
      OPENPLANS_MCP_TOKEN: "sentinel-mcp-token-value",
      CMS_API_KEY: "sentinel-cms-key-value",
      OPENPLANS_CACHE_URL: "redis://cache.sentinel.invalid:6379",
      OPENPLANS_DATA_DIR: "/srv/sentinel-data",
      OPENPLANS_PROJECT_URL: "https://sentinel.invalid/",
      OPENPLANS_MCP_ALLOWED_HOSTS: "mcp.sentinel.invalid",
    };
    const text = JSON.stringify(buildUsageReport(exampleFacts(env)));
    expect(text).not.toMatch(/sentinel|54321|10\.20\.30\.40/);
    for (const value of Object.values(env))
      if (value.length > 3) expect(text).not.toContain(value);
  });

  it.each([
    ["a ZIP", { zip: "77002" }],
    ["an NPI", { npi: "1234567893" }],
    ["a drug id", { rxcui: 197361 }],
    ["an NDC", { ndc: "0002-8215-01" }],
    ["a query string", { route: "plans?zip=7700" }],
    ["an IPv4 address", { peer: "203.0.113.7" }],
    ["an IPv6 address", { peer: "2001:db8::1" }],
    ["free text", { note: "no coverage found for this county" }],
    ["an @ handle", { by: "@sentinel" }],
  ])("flags %s", (_what, extra) => {
    expect(scan({ ...buildUsageReport(exampleFacts()), ...extra })).not.toEqual(
      [],
    );
  });
});

describe("planted mutant: the builder adds a zip field", () => {
  it("the strict schema rejects it, the scan flags it and buildUsageReport throws", async () => {
    const source = await readFile(buildSource, "utf8");
    const mutated = source.replace(
      "const report = {",
      'const report = {\n    zip: "77002",',
    );
    expect(mutated).not.toBe(source);
    await withMutantFile(buildSource, mutated, async (file) => {
      const mutant = await importMutant<typeof Build>(
        file,
        "assembleUsageReport",
        "buildUsageReport",
      );
      const raw = mutant.assembleUsageReport(exampleFacts());
      expect(raw).toHaveProperty("zip", "77002");
      const result = usageReportSchema.safeParse(raw);
      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error?.issues)).toContain("zip");
      expect(scan(raw)).toContain("ZIP or longer digit run at zip");
      expect(() => mutant.buildUsageReport(exampleFacts())).toThrow(/zip/);
    });
  });
});

describe("usage report module boundary", () => {
  it("has no network, timer or database code in this slice", async () => {
    const folder = new URL("../../src/usage-report/", import.meta.url);
    for (const name of ["build.ts", "first-party.ts", "schema.ts"]) {
      const source = await readFile(new URL(name, folder), "utf8");
      expect(source, name).not.toMatch(
        /\bfetch\(|node:(https?|net|dns|tls|dgram)|undici|setTimeout|setInterval|\.query\(|\.exec\(/,
      );
    }
  });
});
