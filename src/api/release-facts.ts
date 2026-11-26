import type { SqlSession } from "../db/database.js";
import { checkDatabase } from "../db/availability.js";
import { dataGeneration, GENERATION_QUERY } from "../db/generation.js";
import { handyManifest } from "../db/handy-repository.js";
import { applicationVersion } from "../mcp/version.js";
import { servingPolicy } from "../services/data-window.js";

/**
 * What `/readyz` and `/healthz` answer with when the API is ready, so an operator or a client can
 * tell which release and which data a slot serves with one GET. No path, host or secret is in it.
 */
export interface ReleaseFacts {
  /** The package.json version, read once when the process loads. */
  release: string;
  /** The data generation id; null when it cannot be read. */
  generation: string | null;
  /** The pricing source hash the release checks compare; null when it cannot be read. */
  pricing: string | null;
  /** The years the instance serves, ascending. */
  plan_years: number[];
  /** How many migration files the database has applied; null without a migration check. */
  schema: number | null;
}

async function orNull<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    // A read that fails is reported as unknown, never as a guess.
    return null;
  }
}

/** The facts and whether every read behind them succeeded, so a partial answer is never kept. */
async function readReleaseFacts(
  db: SqlSession,
  applied: number | undefined,
): Promise<{ facts: ReleaseFacts; complete: boolean }> {
  const [generation, pricing, policy] = await Promise.all([
    orNull(() => dataGeneration(db)),
    orNull(() => handyManifest(db)),
    orNull(() => servingPolicy(db)),
  ]);
  return {
    complete: generation !== null && pricing !== null && policy !== null,
    facts: {
      release: applicationVersion,
      generation,
      pricing,
      plan_years: policy
        ? [
            ...new Set(
              Object.values(policy.domains).flatMap((d) => d.allowed_years),
            ),
          ].sort((a, b) => a - b)
        : [],
      schema: applied ?? null,
    },
  };
}

export async function releaseFacts(
  db: SqlSession,
  applied: number | undefined,
): Promise<ReleaseFacts> {
  return (await readReleaseFacts(db, applied)).facts;
}

/** What one probe of the database learned. */
export interface ReadinessProbe {
  /** The database answered. */
  up: boolean;
  /** The data generation the same answer carried; null when it could not be read. */
  generation: string | null;
}

/**
 * `/readyz` and `/healthz` read the facts through one of these per app. The probe is one query
 * that proves the database answers and reads the data generation. The facts are computed again
 * only when that generation, the calendar year (the serving window moves with it) or the applied
 * migration count differs from the last complete read; a failed or partial read is never kept,
 * and no timer decides when to look again, so a swap is seen on the next request. The release
 * configuration is read when the facts are computed, like every other restart-scoped setting.
 */
export function releaseFactsReader(db: SqlSession) {
  let memo: { key: string; facts: Promise<ReleaseFacts> } | undefined;
  const copy = (facts: ReleaseFacts): ReleaseFacts => ({
    ...facts,
    plan_years: [...facts.plan_years],
  });
  return {
    async probe(): Promise<ReadinessProbe> {
      try {
        const { rows } = await db.query<{ generation: string | null }>(
          GENERATION_QUERY,
        );
        return { up: true, generation: rows[0]?.generation ?? null };
      } catch {
        // The generation table may be unreadable while the database still answers.
        return { up: await checkDatabase(db), generation: null };
      }
    },
    async facts(
      generation: string | null,
      applied: number | undefined,
    ): Promise<ReleaseFacts> {
      if (generation === null) return releaseFacts(db, applied);
      const key = `${generation}:${new Date().getUTCFullYear()}:${applied ?? ""}`;
      if (memo?.key !== key) {
        const entry = {
          key,
          facts: readReleaseFacts(db, applied).then(({ facts, complete }) => {
            // Reads that raced a publication, or that failed, are answered but not kept.
            if (!complete || facts.generation !== generation)
              if (memo === entry) memo = undefined;
            return facts;
          }),
        };
        memo = entry;
      }
      return copy(await memo.facts);
    },
  };
}
