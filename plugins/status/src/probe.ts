import { z } from "zod";
import type { SqlSession, WorkerContext } from "@openplans/plugin-sdk";

export const COMPONENTS = ["api", "db", "cache", "worker"] as const;
export type Component = (typeof COMPONENTS)[number];
export type Health = "ok" | "degraded" | "down";

/** How many transitions the state keeps, newest first. */
export const HISTORY_LIMIT = 50;
/** `worker` is down when `deliver-events` has not ticked for this long. */
export const DELIVERY_WINDOW_MS = 5 * 60_000;
export const HEALTH_KEY = "health";

const health = z.enum(["ok", "degraded", "down"]);
const time = z.iso.datetime({ offset: true });
const component = z.enum(COMPONENTS);
const entry = z.strictObject({
  component,
  from: health,
  to: health,
  at: time,
});
export type HealthEntry = z.infer<typeof entry>;

/** The value of `plugin_state(<plugin>, 'health')`. */
export const healthStateSchema = z.strictObject({
  components: z.strictObject(
    Object.fromEntries(
      COMPONENTS.map((name) => [
        name,
        z.strictObject({ state: health, since: time }).optional(),
      ]),
    ) as Record<
      Component,
      z.ZodOptional<
        z.ZodObject<
          { state: typeof health; since: typeof time },
          z.core.$strict
        >
      >
    >,
  ),
  history: z.array(entry).max(HISTORY_LIMIT),
});
export type HealthState = z.infer<typeof healthStateSchema>;

/**
 * Folds one probe into the stored state. A component seen for the first time sets a baseline
 * and is not a transition; a component that was not observed keeps its last state.
 */
export function nextHealth(
  previous: HealthState | undefined,
  observed: Partial<Record<Component, Health>>,
  now: Date,
): { state: HealthState; changes: HealthEntry[]; changed: boolean } {
  const at = now.toISOString();
  const components = { ...previous?.components };
  const changes: HealthEntry[] = [];
  let changed = previous === undefined;
  for (const name of COMPONENTS) {
    const to = observed[name];
    if (!to) continue;
    const before = components[name];
    if (!before) {
      components[name] = { state: to, since: at };
      changed = true;
    } else if (before.state !== to) {
      changes.push({ component: name, from: before.state, to, at });
      components[name] = { state: to, since: at };
      changed = true;
    }
  }
  return {
    state: {
      components,
      history: [...[...changes].reverse(), ...(previous?.history ?? [])].slice(
        0,
        HISTORY_LIMIT,
      ),
    },
    changes,
    changed,
  };
}

async function databaseUp(db: SqlSession): Promise<boolean> {
  try {
    await db.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

/** The minute the scheduler last started `deliver-events`, from its own tick record. */
async function lastDelivery(db: SqlSession): Promise<Date | null> {
  const { rows } = await db.query<{ tick: string | null }>(
    `SELECT value->>'tick' AS tick FROM plugin_state
     WHERE plugin = 'openplans' AND key = 'core:schedule:deliver-events'`,
  );
  const tick = rows[0]?.tick;
  const at = tick ? new Date(tick) : null;
  return at && !Number.isNaN(at.getTime()) ? at : null;
}

export interface ProbeSettings {
  cacheProbe?: () => Promise<boolean>;
  now: () => Date;
}

/**
 * `worker status-page health-probe`: checks the database, the cache when the host can probe it,
 * and whether `deliver-events` ran in the last five minutes. Emits `health.changed` once per
 * transition, then stores the state.
 */
export async function runHealthProbe(
  ctx: Pick<WorkerContext, "db" | "events" | "state" | "log">,
  settings: ProbeSettings,
): Promise<number> {
  const now = settings.now();
  const observed: Partial<Record<Component, Health>> = {};
  const reader = ctx.db.reader;
  observed.db = (await databaseUp(reader)) ? "ok" : "down";
  if (observed.db === "ok") {
    const delivered = await lastDelivery(reader).catch(() => null);
    observed.worker =
      delivered && now.getTime() - delivered.getTime() <= DELIVERY_WINDOW_MS
        ? "ok"
        : "down";
  }
  if (settings.cacheProbe)
    observed.cache = (await settings.cacheProbe().catch(() => false))
      ? "ok"
      : "down";

  let previous: HealthState | undefined;
  try {
    const stored = healthStateSchema.safeParse(await ctx.state.get(HEALTH_KEY));
    previous = stored.success ? stored.data : undefined;
  } catch {
    ctx.log({ event: "health_probe_failed", step: "read" });
    return 1;
  }
  const next = nextHealth(previous, observed, now);
  try {
    // Emit first: the key repeats on a retry, and the outbox keeps one row per key.
    for (const change of next.changes) {
      const since = previous?.components[change.component]?.since ?? "none";
      await ctx.events.emit({
        type: "health.changed",
        idempotencyKey: `status:health:${change.component}:${since}:${change.to}`,
        payload: {
          component: change.component,
          from: change.from,
          to: change.to,
        },
      });
    }
    if (next.changed) await ctx.state.set(HEALTH_KEY, next.state);
  } catch {
    ctx.log({ event: "health_probe_failed", step: "write" });
    return 1;
  }
  ctx.log({
    event: "health_probe",
    db: observed.db,
    worker: observed.worker ?? "unknown",
    cache: observed.cache ?? "unknown",
    transitions: next.changes.length,
  });
  return 0;
}
