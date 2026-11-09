import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";

/** Fixed per-source window shared by MCP and public quotes. */
export const WINDOW_MS = 60_000;
/** Bounded bucket table: new sources beyond it are refused, not tracked. */
export const MAX_SOURCE_BUCKETS = 10_000;

export type PeerAddress = (request: Request) => string | undefined;
export type Admission =
  { allowed: true } | { allowed: false; retryAfterSeconds: number };

export function proxyList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** X-Forwarded-For's last hop is trusted only from a configured proxy peer. */
export function requestSource(
  c: Context,
  trustedProxies: readonly string[],
  peerAddress?: PeerAddress,
): string {
  let peer = peerAddress?.(c.req.raw);
  if (!peer) {
    try {
      peer = getConnInfo(c).remote.address;
    } catch {
      /* In-process hosts share one conservative bucket. */
    }
  }
  const forwarded = c.req.header("x-forwarded-for");
  return peer && trustedProxies.includes(peer) && forwarded
    ? forwarded.split(",").at(-1)!.trim()
    : (peer ?? "in-process");
}

export function createSourceLimiter(now: () => number = Date.now) {
  const buckets = new Map<string, { count: number; until: number }>();
  return {
    take(key: string, perMinute: number): Admission {
      const time = now();
      for (const [k, bucket] of buckets)
        if (bucket.until <= time) buckets.delete(k);
      let bucket = buckets.get(key);
      if (!bucket && buckets.size < MAX_SOURCE_BUCKETS) {
        bucket = { count: 0, until: time + WINDOW_MS };
        buckets.set(key, bucket);
      }
      if (!bucket || ++bucket.count > perMinute)
        return {
          allowed: false,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil(((bucket?.until ?? time + WINDOW_MS) - time) / 1000),
          ),
        };
      return { allowed: true };
    },
  };
}

export interface SourceLimits {
  perMinute: number;
  activePerSource: number;
  activeTotal: number;
}
export interface SourceAdmissionOptions {
  limits: SourceLimits;
  trustedProxies: readonly string[];
  peerAddress?: PeerAddress;
  now?: () => number;
}

function rateLimited(c: Context, retryAfterSeconds: number) {
  c.header("Cache-Control", "no-store");
  c.header("Retry-After", String(retryAfterSeconds));
  return c.json({ error: { code: "RATE_LIMITED" } }, 429);
}

/** Per-source window plus per-source and total concurrency for one route. */
export function sourceAdmission(
  options: SourceAdmissionOptions,
): MiddlewareHandler {
  const limiter = createSourceLimiter(options.now);
  const active = new Map<string, number>();
  let total = 0;
  return async (c, next) => {
    const source = requestSource(
      c,
      options.trustedProxies,
      options.peerAddress,
    );
    const admission = limiter.take(source, options.limits.perMinute);
    if (!admission.allowed) return rateLimited(c, admission.retryAfterSeconds);
    const mine = active.get(source) ?? 0;
    if (
      mine >= options.limits.activePerSource ||
      total >= options.limits.activeTotal
    )
      return rateLimited(c, 1);
    active.set(source, mine + 1);
    total++;
    try {
      await next();
    } finally {
      total--;
      const left = (active.get(source) ?? 1) - 1;
      if (left > 0) active.set(source, left);
      else active.delete(source);
    }
  };
}
