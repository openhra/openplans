import type { CoreConfig } from "../config/index.js";
import { isFirstPartyPlugin } from "./first-party.js";
import { ARCHES, USAGE_REPORT_SCHEMA, usageReportSchema } from "./schema.js";
import type { UsageReport } from "./schema.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

type Kind = "catalog" | "premium" | "provider" | "formulary";

/**
 * What the report is made from. Each fact is one the service already keeps: the package version,
 * the schema journal's state, the status plugin's data view, the loaded configuration and, when
 * metrics are on, the request histograms. Raw values stay here; the report carries buckets.
 */
export interface UsageReportFacts {
  readonly installId: string | null;
  readonly now: Date;
  readonly version: string;
  /** The version recorded at the previous start, when one was recorded. */
  readonly previousVersion: string | null;
  readonly arch: string;
  /** `process.versions.node`. */
  readonly nodeVersion: string;
  readonly uptimeMs: number;
  readonly config: Pick<
    CoreConfig,
    | "mcp"
    | "public"
    | "cache"
    | "telemetry"
    | "cmsFallback"
    | "medicarePartD"
    | "plugins"
  >;
  /** The status view's `data` section; null when the status read failed. */
  readonly status: {
    readonly states: number | null;
    readonly years: readonly number[] | null;
    readonly status_counts: Readonly<
      Record<Kind, Readonly<Record<string, number>>>
    > | null;
  } | null;
  /** The schema journal check's state. */
  readonly schema: "ready" | "pending" | "unknown";
  readonly schedulerSeen: boolean;
  /** Request histogram series; read only when `telemetry.enabled`. */
  readonly telemetry: {
    readonly series: readonly {
      readonly transport: "http" | "mcp";
      readonly count: number;
    }[];
  } | null;
}

export function uptimeBucket(ms: number): UsageReport["uptime_bucket"] {
  if (ms < HOUR_MS) return "<1h";
  if (ms < DAY_MS) return "1h-1d";
  if (ms < 7 * DAY_MS) return "1d-7d";
  if (ms < 30 * DAY_MS) return "7d-30d";
  return "30d+";
}

export function statesBucket(
  states: number,
): NonNullable<UsageReport["data"]["states_bucket"]> {
  if (states <= 0) return "0";
  if (states === 1) return "1";
  if (states <= 5) return "2-5";
  if (states <= 20) return "6-20";
  return "21+";
}

export function requestsBucket(
  count: number,
): NonNullable<UsageReport["requests_bucket"]>["rest"] {
  if (count <= 0) return "0";
  if (count <= 100) return "1-100";
  if (count <= 1000) return "101-1k";
  if (count <= 10_000) return "1k-10k";
  return "10k+";
}

const served = (counts: Readonly<Record<string, number>>) =>
  (counts.available ?? 0) + (counts.partial ?? 0) > 0;

function cacheBackend(
  cache: UsageReportFacts["config"]["cache"],
): UsageReport["features"]["cache_backend"] {
  if (!cache.enabled) return "off";
  if (cache.provider === "memory" || cache.provider === "valkey")
    return cache.provider;
  return "other";
}

function requests(facts: UsageReportFacts): UsageReport["requests_bucket"] {
  if (!facts.config.telemetry.enabled || !facts.telemetry) return null;
  let rest = 0;
  let mcp = 0;
  for (const series of facts.telemetry.series)
    if (series.transport === "mcp") mcp += series.count;
    else rest += series.count;
  return { rest: requestsBucket(rest), mcp: requestsBucket(mcp) };
}

const OUTCOMES = {
  ready: "ok",
  pending: "failed",
  unknown: "unknown",
} as const;

function lastMigration(facts: UsageReportFacts): UsageReport["last_migration"] {
  if (!facts.previousVersion || facts.previousVersion === facts.version)
    return null;
  return {
    from: facts.previousVersion,
    to: facts.version,
    outcome: OUTCOMES[facts.schema],
  };
}

/** The report object before validation. `buildUsageReport` is the one to call. */
export function assembleUsageReport(facts: UsageReportFacts): unknown {
  const arches: readonly string[] = ARCHES;
  const counts = facts.status?.status_counts ?? null;
  const plugins = facts.config.plugins.entries
    .filter((entry) => entry.enabled)
    .map((entry) => entry.package);
  const named = [...new Set(plugins.filter(isFirstPartyPlugin))].sort();
  const report = {
    schema: USAGE_REPORT_SCHEMA,
    install_id: facts.installId,
    sent_day: facts.now.toISOString().slice(0, 10),
    version: facts.version,
    previous_version: facts.previousVersion,
    arch: arches.includes(facts.arch) ? facts.arch : "other",
    node_major: Number.parseInt(facts.nodeVersion, 10),
    uptime_bucket: uptimeBucket(facts.uptimeMs),
    data: {
      years:
        facts.status?.years == null
          ? null
          : [...new Set(facts.status.years)].sort((a, b) => a - b),
      states_bucket:
        facts.status?.states == null ? null : statesBucket(facts.status.states),
      coverage: counts && {
        catalog: served(counts.catalog),
        premiums: served(counts.premium),
        providers: served(counts.provider),
        formulary: served(counts.formulary),
      },
    },
    features: {
      mcp: facts.config.mcp.enabled,
      public_quoting: facts.config.public.quoting,
      public_household: facts.config.public.household,
      compat: facts.config.public.compat,
      cache_backend: cacheBackend(facts.config.cache),
      scheduler_seen: facts.schedulerSeen,
      metrics: facts.config.telemetry.enabled,
      cms_fallback: facts.config.cmsFallback.enabled,
      medicare_part_d: facts.config.medicarePartD,
      first_party_plugins: named,
      other_plugins_count: new Set(
        plugins.filter((name) => !isFirstPartyPlugin(name)),
      ).size,
    },
    last_migration: lastMigration(facts),
    requests_bucket: requests(facts),
  };
  return report;
}

/** Assemble the report and validate it against the strict v1 schema; throws on any extra key. */
export function buildUsageReport(facts: UsageReportFacts): UsageReport {
  return usageReportSchema.parse(assembleUsageReport(facts));
}
