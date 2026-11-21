import { loadConfig } from "../../src/config/index.js";
import type { Environment } from "../../src/config/index.js";
import type { UsageReportFacts } from "../../src/usage-report/build.js";
import type { UsageReport } from "../../src/usage-report/schema.js";

/** Synthetic facts for an install that has metrics on and two first-party plugins plus one other. */
export function exampleFacts(
  env: Environment = { OPENPLANS_METRICS: "on" },
  overrides: Partial<UsageReportFacts> = {},
): UsageReportFacts {
  const config = loadConfig(env, {
    version: 1,
    plugins: {
      entries: [
        { package: "@openplans/plugin-status" },
        { package: "@openplans/plugin-webhook" },
        { package: "@openplans/plugin-admin", enabled: false },
        { package: "@example/plugin-local" },
      ],
    },
  });
  const counts = (available: number) => ({
    not_yet_verified: 0,
    available,
    partial: 0,
    unknown: 0,
    unavailable: 0,
    unsupported: 0,
    stale: 0,
    conflicted: 0,
  });
  return {
    installId: "4f1c2a8e-9b7d-4c3e-8f2a-1b6d5e9c7a3f",
    now: new Date("2026-11-20T15:42:07.123Z"),
    version: "0.4.16",
    previousVersion: "0.4.15",
    arch: "arm64",
    nodeVersion: "22.22.2",
    uptimeMs: 3 * 86_400_000,
    config,
    status: {
      states: 3,
      years: [2027, 2026],
      status_counts: {
        catalog: counts(6),
        premium: counts(6),
        provider: counts(0),
        formulary: counts(0),
      },
    },
    schema: "ready",
    schedulerSeen: true,
    telemetry: {
      series: [
        { transport: "http", count: 4000 },
        { transport: "http", count: 1200 },
        { transport: "mcp", count: 42 },
      ],
    },
    ...overrides,
  };
}

/** The report `exampleFacts()` should build, written out by hand. */
export function exampleReport(): UsageReport {
  return {
    schema: "openplans.usage-report.v1",
    install_id: "4f1c2a8e-9b7d-4c3e-8f2a-1b6d5e9c7a3f",
    sent_day: "2026-11-20",
    version: "0.4.16",
    previous_version: "0.4.15",
    arch: "arm64",
    node_major: 22,
    uptime_bucket: "1d-7d",
    data: {
      years: [2026, 2027],
      states_bucket: "2-5",
      coverage: {
        catalog: true,
        premiums: true,
        providers: false,
        formulary: false,
      },
    },
    features: {
      mcp: true,
      public_quoting: true,
      public_household: true,
      compat: true,
      cache_backend: "memory",
      scheduler_seen: true,
      metrics: true,
      cms_fallback: false,
      medicare_part_d: false,
      first_party_plugins: [
        "@openplans/plugin-status",
        "@openplans/plugin-webhook",
      ],
      other_plugins_count: 1,
    },
    last_migration: { from: "0.4.15", to: "0.4.16", outcome: "ok" },
    requests_bucket: { rest: "1k-10k", mcp: "1-100" },
  };
}
