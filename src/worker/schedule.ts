import type { ScheduleSpec } from "@openplans/plugin-sdk";
import type { Database } from "../db/database.js";
import { CORE_KEY_PREFIX, CORE_STATE_OWNER } from "../plugins/state.js";
import type { WorkerOutput } from "./commands.js";
import { databaseErrorDiagnostic } from "./database-error.js";

/** A five-field UTC cron expression, parsed. Each field is the set of values it matches. */
export interface Cron {
  minute: ReadonlySet<number>;
  hour: ReadonlySet<number>;
  dayOfMonth: ReadonlySet<number>;
  month: ReadonlySet<number>;
  dayOfWeek: ReadonlySet<number>;
  /** Day-of-month and day-of-week were both restricted: either may match (cron's OR rule). */
  eitherDay: boolean;
}

export class CronError extends Error {
  constructor(detail: string) {
    super(`invalid cron: ${detail}`);
    this.name = "CronError";
  }
}

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  // 7 is Sunday as well as 0.
  { name: "day of week", min: 0, max: 7 },
] as const;

const NUMBER = /^(0|[1-9][0-9]?)$/;

interface Field {
  readonly name: string;
  readonly min: number;
  readonly max: number;
}

function number(text: string, field: Field): number {
  if (!NUMBER.test(text)) throw new CronError(`${field.name} value ${text}`);
  const value = Number(text);
  if (value < field.min || value > field.max)
    throw new CronError(`${field.name} value ${text} out of range`);
  return value;
}

function parseField(text: string, field: Field): Set<number> {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const [range, stepText, extra] = part.split("/");
    if (extra !== undefined || range === undefined || range === "")
      throw new CronError(`${field.name} part ${part}`);
    let step = 1;
    if (stepText !== undefined) {
      step = number(stepText, { ...field, min: 1 });
    }
    let low: number, high: number;
    if (range === "*") {
      [low, high] = [field.min, field.max];
    } else if (range.includes("-")) {
      const [a, b, more] = range.split("-");
      if (more !== undefined || a === undefined || b === undefined)
        throw new CronError(`${field.name} range ${range}`);
      [low, high] = [number(a, field), number(b, field)];
      if (low > high) throw new CronError(`${field.name} range ${range}`);
    } else {
      low = number(range, field);
      // "5/15" means from 5 to the end in steps of 15.
      high = stepText === undefined ? low : field.max;
    }
    for (let value = low; value <= high; value += step) values.add(value);
  }
  return values;
}

/** Parse `minute hour day-of-month month day-of-week`. Names and `@` macros are refused. */
export function parseCron(expression: string): Cron {
  if (typeof expression !== "string") throw new CronError("not a string");
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new CronError("expected five fields");
  const sets = parts.map((part, index) => parseField(part, FIELDS[index]!));
  const dayOfWeek = sets[4]!;
  if (dayOfWeek.delete(7)) dayOfWeek.add(0);
  return {
    minute: sets[0]!,
    hour: sets[1]!,
    dayOfMonth: sets[2]!,
    month: sets[3]!,
    dayOfWeek,
    eitherDay: parts[2] !== "*" && parts[4] !== "*",
  };
}

/** True when the cron fires in the UTC minute that holds `at`. */
export function cronMatches(cron: Cron, at: Date): boolean {
  if (
    !cron.minute.has(at.getUTCMinutes()) ||
    !cron.hour.has(at.getUTCHours()) ||
    !cron.month.has(at.getUTCMonth() + 1)
  )
    return false;
  const dom = cron.dayOfMonth.has(at.getUTCDate());
  const dow = cron.dayOfWeek.has(at.getUTCDay());
  return cron.eitherDay ? dom || dow : dom && dow;
}

/** The core schedules. Plugin schedules may not reuse these names. */
export const CORE_SCHEDULES: readonly ScheduleSpec[] = Object.freeze([
  Object.freeze({
    name: "deliver-events",
    cron: "* * * * *",
    command: Object.freeze(["deliver-events"]),
    maxRunMs: 55_000,
  }),
]);

export interface ScheduledCommand {
  readonly plugin: string;
  readonly spec: ScheduleSpec;
}

/** Runs one registered worker command in this process, bounded by `maxRunMs`. */
export type Dispatch = (
  argv: string[],
  run: { signal: AbortSignal; timeoutMs: number },
) => Promise<number>;

export type TickOutcome =
  "ran" | "failed" | "timed_out" | "locked" | "already_ran" | "invalid";

export interface ScheduleOptions {
  now?: () => Date;
  log?: (entry: Record<string, string | number | boolean | null>) => void;
  signal?: AbortSignal;
}

function tickKey(name: string): string {
  return `${CORE_KEY_PREFIX}schedule:${name}`;
}

function minuteOf(at: Date): Date {
  return new Date(Math.floor(at.getTime() / 60_000) * 60_000);
}

async function runBounded(
  dispatch: Dispatch,
  argv: string[],
  maxRunMs: number,
  outer: AbortSignal | undefined,
): Promise<"ran" | "failed" | "timed_out"> {
  const controller = new AbortController();
  const signal = outer
    ? AbortSignal.any([controller.signal, outer])
    : controller.signal;
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<"timed_out">((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error("schedule maxRunMs"));
      resolve("timed_out");
    }, maxRunMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      dispatch(argv, { signal, timeoutMs: maxRunMs }).then(
        (code) => (code === 0 ? "ran" : "failed"),
        () => "failed" as const,
      ),
      limit,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One tick: every schedule whose cron matches this UTC minute runs once. Each holds
 * `pg_try_advisory_xact_lock(hashtext('schedule:' || name))` for the whole run, so a second
 * runner skips it, and records the minute in `plugin_state`, so a runner that ticks after the
 * first finished does not run it again.
 */
export async function runScheduleTick(
  db: Database,
  schedules: readonly ScheduledCommand[],
  dispatch: Dispatch,
  options: ScheduleOptions = {},
): Promise<Record<string, TickOutcome>> {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  const tick = minuteOf(now());
  const outcomes: Record<string, TickOutcome> = {};
  for (const { plugin, spec } of schedules) {
    let cron: Cron;
    try {
      cron = parseCron(spec.cron);
    } catch {
      outcomes[spec.name] = "invalid";
      log({ event: "schedule_invalid", schedule: spec.name, plugin });
      continue;
    }
    if (!cronMatches(cron, tick)) continue;
    if (options.signal?.aborted) break;
    const outcome = await db.transaction(async (session) => {
      const { rows } = await session.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtext('schedule:' || $1)) AS locked",
        [spec.name],
      );
      if (!rows[0]?.locked) return "locked" as const;
      const { rows: last } = await session.query<{ tick: string | null }>(
        "SELECT value->>'tick' AS tick FROM plugin_state WHERE plugin = $1 AND key = $2",
        [CORE_STATE_OWNER, tickKey(spec.name)],
      );
      const previous = last[0]?.tick;
      if (previous && new Date(previous).getTime() >= tick.getTime())
        return "already_ran" as const;
      await session.query(
        `INSERT INTO plugin_state (plugin, key, value)
         VALUES ($1, $2, jsonb_build_object('tick', $3::text))
         ON CONFLICT (plugin, key) DO UPDATE SET value = EXCLUDED.value`,
        [CORE_STATE_OWNER, tickKey(spec.name), tick.toISOString()],
      );
      const started = Date.now();
      const result = await runBounded(
        dispatch,
        [...spec.command],
        spec.maxRunMs,
        options.signal,
      );
      log({
        event: "schedule_run",
        schedule: spec.name,
        plugin,
        outcome: result,
        duration_ms: Date.now() - started,
      });
      return result;
    });
    outcomes[spec.name] = outcome;
  }
  return outcomes;
}

export interface ScheduleCommandOptions extends ScheduleOptions {
  /** Waits until the next minute; replaced in tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/** `worker schedule run [--loop]`: one tick, or one tick per minute until the signal aborts. */
export async function runScheduleCommand(
  args: string[],
  open: () => Database,
  output: WorkerOutput,
  schedules: readonly ScheduledCommand[],
  dispatch: Dispatch,
  options: ScheduleCommandOptions = {},
): Promise<number> {
  const loop = args.length === 2 && args[0] === "run" && args[1] === "--loop";
  if (!loop && !(args.length === 1 && args[0] === "run")) {
    output.error("Usage: worker schedule run [--loop]");
    return 1;
  }
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? defaultSleep;
  let db: Database | undefined;
  let code = 0;
  try {
    db = open();
    for (;;) {
      const outcomes = await runScheduleTick(db, schedules, dispatch, {
        ...options,
        log: (entry) => output.error(JSON.stringify(entry)),
      });
      output.out(JSON.stringify(outcomes));
      if (!loop) {
        if (
          Object.values(outcomes).some(
            (o) => o !== "ran" && o !== "locked" && o !== "already_ran",
          )
        )
          code = 1;
        break;
      }
      if (options.signal?.aborted) break;
      const at = now().getTime();
      await sleep(60_000 - (at % 60_000), options.signal);
      if (options.signal?.aborted) break;
    }
  } catch (error) {
    output.error(
      `worker schedule run failed${databaseErrorDiagnostic(error)}; run worker migrate first and check the database`,
    );
    code = 1;
  } finally {
    try {
      await db?.close();
    } catch {
      output.error("worker database shutdown failed");
      code = 1;
    }
  }
  return code;
}
