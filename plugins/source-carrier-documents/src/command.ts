import type {
  PassThroughApi,
  WorkerCommandSpec,
  WorkerContext,
} from "@openplans/plugin-sdk";
import {
  IDENTITY_JOIN_ARGV,
  IDENTITY_JOIN_DEFAULT_LOOKUPS,
  IDENTITY_JOIN_MAX_LOOKUPS,
  IDENTITY_JOIN_USAGE,
} from "./constants.js";
import { joinFormularyIdentities } from "./join.js";
import type { JoinOptions } from "./join.js";
import {
  activeRxnormRelease,
  passThroughIdentityLookup,
  releaseIdentityLookup,
} from "./lookup.js";

/** `--max-lookups N` (1 to `IDENTITY_JOIN_MAX_LOOKUPS`); null when the arguments are wrong. */
export function joinArgs(
  args: readonly string[],
): { maxLookups: number } | null {
  if (!args.length) return { maxLookups: IDENTITY_JOIN_DEFAULT_LOOKUPS };
  if (
    args.length !== 2 ||
    args[0] !== "--max-lookups" ||
    !/^[1-9][0-9]{0,4}$/.test(args[1]!)
  )
    return null;
  const maxLookups = Number(args[1]);
  return maxLookups <= IDENTITY_JOIN_MAX_LOOKUPS ? { maxLookups } : null;
}

/** Each run holds the scope for its whole length, so the identity stage writes its attempts. */
const TIMEOUT_MS = 3 * 60 * 60 * 1000;

/**
 * `worker ingest carrier-formulary-identity`: one paced run of the RxCUI join. With the plugin's
 * `identityJoin` switch off it asks nothing and writes nothing. It exits 0 when the run completed or
 * paused (lookup limit, budget, outage); the next run resumes.
 */
export function identityJoinCommand(
  api: Pick<PassThroughApi, "apply">,
  enabled: boolean,
  options: Pick<JoinOptions, "pace" | "now"> = {},
): WorkerCommandSpec {
  return {
    argv: IDENTITY_JOIN_ARGV,
    usage: IDENTITY_JOIN_USAGE,
    timeoutMs: TIMEOUT_MS,
    async run(args: string[], ctx: WorkerContext) {
      const parsed = joinArgs(args);
      if (!parsed) {
        ctx.log({
          code: "carrier_formulary_identity_usage",
          usage: IDENTITY_JOIN_USAGE,
        });
        return 2;
      }
      if (!enabled) {
        ctx.log({ code: "carrier_formulary_identity_off" });
        return 0;
      }
      const writer = ctx.db.writer;
      if (!writer) throw new Error("The RxCUI join needs the staging writer");
      // A loaded ACTIVE RxNorm release wins, as it does for request-time identity: RxNav is not
      // asked while one is ACTIVE.
      const release = await activeRxnormRelease(ctx.db.reader);
      const lookup = release
        ? releaseIdentityLookup(ctx.db.reader, release, options.now)
        : passThroughIdentityLookup(
            api,
            () => ({ reader: ctx.db.reader, writer }),
            new Date().getUTCFullYear(),
          );
      const summary = await joinFormularyIdentities(writer, lookup, {
        enabled,
        maxLookups: parsed.maxLookups,
        signal: ctx.signal,
        ...options,
      });
      ctx.log({
        code: "carrier_formulary_identity",
        status: summary.status,
        stopped: summary.stopped ?? null,
        identity_source: lookup.sourceId,
        lookups: summary.lookups,
        reconfirmed: summary.reconfirmed,
        dropped: summary.dropped,
        resolved: summary.resolved,
        unresolved: summary.unresolved,
        reused: summary.reused,
        pending: summary.pending,
      });
      return 0;
    },
  };
}
