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
