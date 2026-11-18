import type {
  CatalogPolicyInput,
  CatalogPolicyResolution,
  McpToolContext,
  OperatorHost,
  OperatorObservation,
  OperatorPluginIdentity,
  OperatorTelemetry,
  OperatorTelemetryQuery,
  StatusHost,
} from "@openplans/plugin-sdk";
import { z } from "zod";
import type { CoreConfig } from "../config/index.js";
import { configurationSettings } from "../config/diagnostics.js";
import { dataGeneration } from "../api/cache/generation.js";
import {
  currentSearchKeys,
  searchKeysCurrentSql,
} from "../api/provider-search-keys.js";
import { boundedDatabase } from "../db/bounded.js";
import type { LoadedStatus } from "./status-host.js";
import type { PluginHost } from "./registries.js";

const packageName = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const inspectInput = z.strictObject({
  source_id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,99}$/),
  plan_ids: z.array(z.string().min(1).max(220)).min(1).max(100),
  year: z.number().int().min(2014).max(2100),
  as_of: z.iso.date().optional(),
  market_segment: z.enum(["on_exchange", "off_exchange"]).optional(),
});
const telemetryInput = z.strictObject({
  window: z.enum(["current_process", "1h", "24h", "7d", "90d"]),
});
type TelemetryReader = NonNullable<OperatorHost["telemetry"]>;
let telemetryReader: TelemetryReader | undefined;

/** Core collector lifecycle hook. It is not a plugin capability or a request callback registry. */
export function setOperatorTelemetryReader(
  reader: TelemetryReader | undefined,
): void {
  telemetryReader = reader;
}

/** Lazy final registries prevent package order from selecting providers or exposing setup DB access. */
export function createOperatorHost(
  config: CoreConfig,
  process: PluginHost,
  status: StatusHost,
  loaded: () => LoadedStatus | undefined,
  now: () => number = Date.now,
): OperatorHost {
  const unavailable = <T>(
    reason: Extract<OperatorObservation<T>, { state: "unavailable" }>["reason"],
  ): OperatorObservation<T> => ({
    state: "unavailable",
    reason,
    observedAt: new Date(now()).toISOString(),
  });
  async function read<T>(
    scope: McpToolContext,
    run: (scope: McpToolContext, state: LoadedStatus) => Promise<T>,
  ): Promise<OperatorObservation<T>> {
    if (scope.signal.aborted) return unavailable("deadline");
    const state = loaded();
    if (!state) return unavailable("not_configured");
    let abort: (() => void) | undefined;
    try {
      const stopped = new Promise<never>((_resolve, reject) => {
        abort = () => reject(new Error("operator_deadline"));
        scope.signal.addEventListener("abort", abort, { once: true });
      });
      const pending = run(
        {
          db: boundedDatabase(scope.db, scope.signal, { readOnly: true }),
          signal: scope.signal,
        },
        state,
      );
      const value = await Promise.race([pending, stopped]);
      scope.signal.throwIfAborted();
      return {
        state: "available",
        value,
        observedAt: new Date(now()).toISOString(),
      };
    } catch {
      return unavailable(scope.signal.aborted ? "deadline" : "read_failed");
    } finally {
      if (abort) scope.signal.removeEventListener("abort", abort);
    }
  }
  return Object.freeze<OperatorHost>({
    configuration: (scope) =>
      read(scope, async (_scope, state) => {
        const plugins: OperatorPluginIdentity[] = state.plugins.map(
          (plugin) => ({
            name: plugin.name,
            configured: true,
            enabled: true,
            loaded: { version: plugin.version, sha256: plugin.sha256 },
            approved: { state: "unverified", reason: "evidence_unavailable" },
          }),
        );
        for (const entry of config.plugins) {
          if (!entry.enabled)
            plugins.push({
              name: packageName.test(entry.package) ? entry.package : null,
              configured: true,
              enabled: false,
              loaded: null,
              approved: { state: "unverified", reason: "evidence_unavailable" },
            });
        }
        plugins.sort((a, b) => {
          const left = a.name ?? "",
            right = b.name ?? "";
          if (left < right) return -1;
          if (left > right) return 1;
          return 0;
        });
        return { settings: configurationSettings(config, process), plugins };
      }),
    availability: (scope) =>
      status.dataAvailability
        ? read(scope, ({ db }) => status.dataAvailability!(db))
        : Promise.resolve(unavailable("not_supported")),
    catalog: (scope) =>
      read(scope, async ({ db }) => {
        const generation = await dataGeneration(db);
        const slot = await currentSearchKeys(db);
        const current =
          (slot === "a" || slot === "b") &&
          (
            await db.query<{ current: boolean }>(
              `SELECT ${searchKeysCurrentSql(slot)} AS current`,
            )
          ).rows[0]?.current;
        return {
          generation,
          providerSearch:
            current === true
              ? ("current" as const)
              : ("unavailable_or_stale" as const),
        };
      }),
    get telemetry(): TelemetryReader | undefined {
      if (!telemetryReader) return undefined;
      return Object.freeze({
        read: (
          input: OperatorTelemetryQuery,
          scope: McpToolContext,
        ): Promise<OperatorObservation<OperatorTelemetry>> => {
          const checked = telemetryInput.safeParse(input);
          if (!checked.success)
            return Promise.resolve(unavailable("not_supported"));
          const reader = telemetryReader;
          if (!reader) return Promise.resolve(unavailable("not_collected"));
          // Keep the collector's explicit collection state; only the wrapper's errors are replaced.
          return read(scope, async (request) =>
            reader.read(checked.data, request),
          ).then((result) =>
            result.state === "available" ? result.value : result,
          );
        },
      });
    },
    msot: Object.freeze({
      async inspect(
        input: CatalogPolicyInput,
        scope: McpToolContext,
      ): Promise<OperatorObservation<CatalogPolicyResolution>> {
        const checked = inspectInput.safeParse(input);
        if (!checked.success) return unavailable("not_supported");
        const provider = loaded()?.registries.catalogPolicies?.msot;
        if (provider?.plugin !== "@openplans/plugin-msot")
          return unavailable("not_configured");
        return read(scope, async (request) => {
          const result = await provider.spec.resolve(checked.data, request);
          if (result.msot.source_id !== checked.data.source_id)
            throw new Error("operator_source_mismatch");
          return result;
        });
      },
    }),
  });
}
