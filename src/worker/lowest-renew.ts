import { loadavg } from "node:os";
import type { Database } from "../db/database.js";
import { handyManifest, lowestRenewalGroups } from "../db/handy-repository.js";
import { readState, writeState, CORE_STATE_OWNER } from "../plugins/state.js";
import { loadConfig } from "../config/index.js";
import { buildLowestCounty } from "./handy-build.js";
import type { WorkerOutput } from "./commands.js";

export const lowestRenewUsage =
  "Usage: worker prebuild lowest-premiums --renew [--max-groups N] [--max-seconds N]";
const STATE_KEY = "core:lowest-renewal";
const LOCK = 1869636992;
export const LOWEST_RENEW_BEFORE_MS = 12 * 60 * 60 * 1000;
interface RenewalState {
  after: string;
  status: string;
  built_cells: number;
  groups: number;
  last_failure?: { at: string; group: string; code: string };
}

/** Only registered cells renew. Initial publication remains an explicit prebuild. */
export async function renewLowestPremiums(
  db: Database,
  options: {
    maxGroups?: number;
    maxRunMs?: number;
    admitted?: () => boolean;
    now?: () => number;
    signal?: AbortSignal;
  } = {},
) {
  const maxGroups = options.maxGroups ?? 100;
  const maxRunMs = options.maxRunMs ?? 120_000;
  if (
    !Number.isInteger(maxGroups) ||
    maxGroups < 1 ||
    maxGroups > 1000 ||
    !Number.isInteger(maxRunMs) ||
    maxRunMs < 1 ||
    maxRunMs > 300_000
  )
    throw new Error("Invalid renewal bounds");
  if (!db.withSession) throw new Error("Renewal requires a dedicated session");
  return db.withSession(async (session) => {
    const { rows } = await session.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(${LOCK}) AS locked`,
    );
    if (!rows[0]?.locked)
      return { status: "locked", groups: 0, built_cells: 0 };
    try {
      const previous = (await readState(
        session,
        CORE_STATE_OWNER,
        STATE_KEY,
      )) as RenewalState | undefined;
      const state: RenewalState = {
        after: previous?.after ?? "",
        status: "running",
        groups: 0,
        built_cells: 0,
        ...(previous?.last_failure
          ? { last_failure: previous.last_failure }
          : {}),
      };
      const now = options.now ?? Date.now;
      const started = now();
      const admitted = options.admitted ?? (() => loadavg()[0]! <= 24);
      const save = () =>
        writeState(
          session,
          CORE_STATE_OWNER,
          STATE_KEY,
          JSON.stringify({ ...state, checked_at: new Date().toISOString() }),
        );
      let groupKey = state.after;
      try {
        await save();
        if (!admitted() || options.signal?.aborted) {
          state.status = "deferred";
        } else {
          const manifest = await handyManifest(db);
          const groups = await lowestRenewalGroups(
            db,
            state.after,
            manifest,
            LOWEST_RENEW_BEFORE_MS,
            maxGroups + 1,
          );
          for (const group of groups.slice(0, maxGroups)) {
            if (
              !admitted() ||
              options.signal?.aborted ||
              now() - started >= maxRunMs
            ) {
              state.status = "deferred";
              break;
            }
            groupKey = group.key;
            const result = await buildLowestCounty(
              db,
              group.inputs,
              undefined,
              LOWEST_RENEW_BEFORE_MS,
            );
            if (result.input_manifest !== manifest)
              throw new Error("Source generation changed");
            state.after = group.key;
            state.groups++;
            state.built_cells += result.built_cells;
            await save();
          }
          if (state.status === "running") {
            state.status = groups.length > maxGroups ? "bounded" : "complete";
            if (state.status === "complete") state.after = "";
          }
        }
      } catch {
        state.status = "failed";
        // Advance past a failed group so it cannot starve later counties. Retry next sweep.
        state.after = groupKey;
        state.last_failure = {
          at: new Date().toISOString(),
          group: groupKey,
          code: "renewal_failed",
        };
      }
      await save();
      return state;
    } finally {
      await session.query(`SELECT pg_advisory_unlock(${LOCK})`);
    }
  });
}

export async function runLowestRenew(
  args: string[],
  open: () => Database,
  output: WorkerOutput,
  options: { signal?: AbortSignal } = {},
) {
  let db: Database | undefined;
  try {
    const params = new Map<string, number>();
    for (let at = 0; at < args.length; at += 2) {
      const key = args[at]!;
      const value = args[at + 1] ?? "";
      if (
        !["--max-groups", "--max-seconds"].includes(key) ||
        params.has(key) ||
        !/^[1-9]\d*$/.test(value) ||
        !Number.isSafeInteger(Number(value))
      )
        throw new Error("Invalid arguments");
      params.set(key, Number(value));
    }
    const maxGroups = params.get("--max-groups") ?? 100;
    const maxRunMs = (params.get("--max-seconds") ?? 120) * 1000;
    if (maxGroups > 1000 || maxRunMs > 300_000)
      throw new Error("Invalid bounds");
    if (!loadConfig().lowestPremiums) {
      output.out(
        JSON.stringify({ status: "disabled", groups: 0, built_cells: 0 }),
      );
      return 0;
    }
    db = open();
    const result = await renewLowestPremiums(db, {
      ...options,
      maxGroups,
      maxRunMs,
    });
    output.out(JSON.stringify(result));
    if (result.status === "failed") return 1;
    if (result.status === "deferred") return 75;
    return 0;
  } catch {
    output.error(lowestRenewUsage);
    output.error(
      "Lowest renewal failed; inspect the host renewal log and core:lowest-renewal state",
    );
    return 1;
  } finally {
    await db?.close();
  }
}
