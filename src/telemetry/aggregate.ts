import type { OperatorTelemetry } from "@openplans/plugin-sdk";

export const DURATION_BOUNDS = [
  5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 15000,
] as const;
export const SERIES_CAP = 128;
export const MEMORY_CAP = 16 * 1024 * 1024;
export const BUCKET_MS = 5 * 60 * 1000;
// Labels are bounded at registration. This reserves more than the maximum row payload.
export const SERIES_BYTES = 2048;
export type Series = OperatorTelemetry["series"][number];
export type Labels = Pick<Series, "transport" | "operation" | "owner">;
export type CacheOutcome = "hit" | "miss" | "bypass";
export interface CurrentTelemetry extends OperatorTelemetry {
  readonly resets: number;
  readonly seriesCap: number;
  readonly memoryCap: number;
  readonly reservedBytes: number;
  readonly lastFlush: string | null;
  readonly cache: {
    readonly hits: number;
    readonly misses: number;
    readonly bypasses: number;
  };
}

export function statusClass(status: number): Series["statusClass"] {
  if (status === 429) return "429";
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  if (status >= 300) return "3xx";
  return "2xx";
}

export class Aggregate {
  private series = new Map<
    string,
    {
      labels: Labels;
      outcome: Series["outcome"];
      statusClass: Series["statusClass"];
      count: number;
      durationBuckets: number[];
    }
  >();
  private since: number;
  private resets = 0;
  private drops = 0;
  private cache = { hits: 0, misses: 0, bypasses: 0 };
  constructor(private readonly now: () => number = Date.now) {
    this.since = now();
  }
  onRollover?: (snapshot: CurrentTelemetry) => void;
  private rotate() {
    const now = this.now();
    if (Math.floor(now / BUCKET_MS) === Math.floor(this.since / BUCKET_MS))
      return;
    this.onRollover?.(this.value());
    this.series.clear();
    this.cache = { hits: 0, misses: 0, bypasses: 0 };
    this.since = now;
    this.resets++;
  }
  record(
    labels: Labels,
    status: number,
    outcome: Series["outcome"],
    duration: number,
  ) {
    this.rotate();
    if (!Number.isFinite(duration) || duration < 0) {
      this.drops++;
      return;
    }
    let key = `${labels.transport}|${labels.operation}|${labels.owner}|${outcome}|${statusClass(status)}`;
    let row = this.series.get(key);
    if (!row && this.series.size >= SERIES_CAP - 1) {
      // One fixed overflow row bounds all label dimensions together.
      this.drops++;
      key = "other";
      labels = { transport: "http", operation: "other", owner: "core" };
      outcome = "completed";
      status = 200;
      row = this.series.get(key);
    }
    if (!row) {
      row = {
        labels,
        outcome,
        statusClass: statusClass(status),
        count: 0,
        durationBuckets: Array<number>(DURATION_BOUNDS.length + 1).fill(0),
      };
      this.series.set(key, row);
    }
    row.count++;
    const boundary = DURATION_BOUNDS.findIndex((limit) => duration <= limit);
    const index = boundary < 0 ? DURATION_BOUNDS.length : boundary;
    row.durationBuckets[index] = (row.durationBuckets[index] ?? 0) + 1;
  }
  recordCache(outcome: CacheOutcome) {
    this.rotate();
    if (outcome === "hit") this.cache.hits++;
    else if (outcome === "miss") this.cache.misses++;
    else this.cache.bypasses++;
  }
  snapshot(): CurrentTelemetry {
    this.rotate();
    return this.value();
  }
  private value(): CurrentTelemetry {
    return {
      collection: "partial",
      since: new Date(this.since).toISOString(),
      until: new Date(this.now()).toISOString(),
      drops: this.drops,
      series: [...this.series.values()].map((row) => ({
        ...row.labels,
        outcome: row.outcome,
        statusClass: row.statusClass,
        count: row.count,
        durationBuckets: [...row.durationBuckets],
      })),
      resets: this.resets,
      seriesCap: SERIES_CAP,
      memoryCap: MEMORY_CAP,
      reservedBytes: this.series.size * SERIES_BYTES,
      lastFlush: null,
      cache: { ...this.cache },
    };
  }
}
