import type {
  CatalogPolicyInput,
  CatalogPolicyResolution,
} from "./catalog-policy.js";
import type { HostAvailabilityEntry, McpToolContext } from "./contracts.js";

export type SettingOrigin = "environment" | "file" | "default" | "unknown";
export interface OperatorSetting {
  readonly key: string;
  readonly displayValue: string | number | boolean | null;
  readonly source: SettingOrigin;
  readonly appliedAt: "startup";
  readonly process: "api" | "worker" | "stdio";
  readonly writable: false;
  readonly reason:
    "deployment_managed" | "secret_presence_only" | "unsupported_value";
}
export type OperatorObservation<T> =
  | {
      readonly state: "available";
      readonly value: T;
      readonly observedAt: string;
    }
  | {
      readonly state: "unavailable";
      readonly reason:
        | "not_configured"
        | "not_collected"
        | "not_supported"
        | "read_failed"
        | "deadline";
      readonly observedAt: string;
    };

export type OperatorApproval =
  | { readonly state: "unverified"; readonly reason: "evidence_unavailable" }
  | {
      readonly state: "available";
      readonly deploymentId: string;
      readonly version: string;
      readonly sha256: string;
      readonly completedAt: string;
    };

export interface OperatorPluginIdentity {
  /** Unknown for a disabled local package whose manifest was never loaded. */
  readonly name: string | null;
  readonly configured: boolean;
  readonly enabled: boolean;
  readonly loaded: {
    readonly version: string | null;
    readonly sha256: string | null;
  } | null;
  /** Receipt identity is separate from whether its hash matches the loaded package. */
  readonly approved: OperatorApproval;
}
export interface OperatorConfiguration {
  readonly settings: readonly OperatorSetting[];
  readonly plugins: readonly OperatorPluginIdentity[];
}
export interface OperatorCatalog {
  readonly generation: string;
  readonly providerSearch: "current" | "unavailable_or_stale";
}

/** Only the configured MSoT owner can answer this annotation-only facade. */
export interface OperatorMsot {
  inspect(
    input: CatalogPolicyInput,
    scope: McpToolContext,
  ): Promise<OperatorObservation<CatalogPolicyResolution>>;
}

export interface OperatorTelemetryQuery {
  readonly window: "current_process" | "1h" | "24h" | "7d" | "90d";
}
export interface OperatorTelemetry {
  readonly collection: "not_enabled" | "complete" | "partial";
  readonly since: string | null;
  readonly until: string;
  readonly drops: number;
  /** Operations and owners come from registration, never request URLs or input values. */
  readonly series: readonly {
    readonly transport: "http" | "mcp";
    readonly operation: string;
    readonly owner: string;
    readonly outcome: "completed" | "cancelled" | "timeout";
    readonly statusClass: "2xx" | "3xx" | "4xx" | "429" | "5xx";
    readonly count: number;
    readonly durationBuckets: readonly number[];
  }[];
}

/** Optional SDK 0.1 contract. No callbacks, SQL, provider names or evidence paths are inputs. */
export interface OperatorHost {
  configuration(
    scope: McpToolContext,
  ): Promise<OperatorObservation<OperatorConfiguration>>;
  availability(
    scope: McpToolContext,
  ): Promise<OperatorObservation<readonly HostAvailabilityEntry[]>>;
  catalog(scope: McpToolContext): Promise<OperatorObservation<OperatorCatalog>>;
  readonly msot: OperatorMsot;
  /** Absent until a collector and its bounded reader are installed. */
  readonly telemetry?: {
    read(
      input: OperatorTelemetryQuery,
      scope: McpToolContext,
    ): Promise<OperatorObservation<OperatorTelemetry>>;
  };
}
