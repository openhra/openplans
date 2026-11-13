import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { SqlSession } from "../db/database.js";
import { boundedDatabase, DEADLINE_MS } from "../db/bounded.js";
import { estimatePremiums } from "../services/catalog.js";
import { quotePlans } from "../services/quotes.js";
import { quoteFallbackContext } from "../services/quote-coverage.js";
import { requestSource, sourceAdmission } from "./rate-limit.js";
import { publicAccess, trustedProxies } from "../config/access.js";
import type { PeerAddress, SourceLimits } from "./rate-limit.js";
import * as v from "./validation.js";

export interface QuoteOptions {
  /** When set, personalized requests need this Bearer token. Never logged. */
  premiumToken?: string;
  /** Anonymous quotes by age and ZIP. Defaults to OPENPLANS_PUBLIC_QUOTING, else `public.quoting`. */
  publicQuoting?: boolean;
  /** Anonymous household quotes, benchmark and ICHRA checks when no token is set.
   * Defaults to OPENPLANS_PUBLIC_HOUSEHOLD, else `public.household`. */
  publicHousehold?: boolean;
  /** Anonymous compatibility API when no key is set. Defaults to OPENPLANS_PUBLIC_COMPAT, else `public.compat`. */
  publicCompat?: boolean;
  /**
   * When set, compatibility routes need this key. Defaults to OPENPLANS_COMPAT_API_KEY, else
   * `tokens.compatKey` in the config file, read when the routes are built. Never logged.
   */
  compatKey?: string;
  /** Defaults to OPENPLANS_TRUST_PROXY, else `trustProxy` in the config file; only these peers
   * may supply X-Forwarded-For. */
  trustedProxies?: string[];
  /** Trusted socket peer supplied by a hosting adapter, never an HTTP header. */
  peerAddress?: PeerAddress;
  now?: () => number;
}

/** Owner defaults (2026-11-09): 30 per minute per source, 2 active per source, 4 in total. */
export const PUBLIC_QUOTE_RATE: SourceLimits = {
  perMinute: 30,
  activePerSource: 2,
  activeTotal: 4,
};
const MAX_BODY_BYTES = 65_536;

/** Public switches are on unless set to off (owner, 2026-11-09: available by default). */
export function publicQuotingEnabled(options: QuoteOptions): boolean {
  return options.publicQuoting ?? publicAccess().quoting;
}

function publicHouseholdEnabled(options: QuoteOptions): boolean {
  return options.publicHousehold ?? publicAccess().household;
}
export function publicCompatEnabled(options: QuoteOptions): boolean {
  return options.publicCompat ?? publicAccess().compat;
}
/** Same per-source limits as public quotes, for one anonymous tier. */
export function anonymousAdmission(options: QuoteOptions): MiddlewareHandler {
  return sourceAdmission({
    limits: PUBLIC_QUOTE_RATE,
    trustedProxies: options.trustedProxies ?? trustedProxies(),
    peerAddress: options.peerAddress,
    now: options.now,
  });
}

function quotingDisabled(c: Context) {
  c.header("Cache-Control", "no-store");
  return c.json({ error: { code: "QUOTING_DISABLED" } }, 503);
}
/** Runs before the response cache, so cached answers count against the same limits. */
export function publicQuoteAdmission(
  options: QuoteOptions,
): MiddlewareHandler[] {
  const enabled = publicQuotingEnabled(options);
  return [
    async (c, next) => (enabled ? next() : quotingDisabled(c)),
    anonymousAdmission(options),
  ];
}

const jsonBodyLimit = bodyLimit({
  maxSize: MAX_BODY_BYTES,
  onError: (c) =>
    c.json({ error: { code: "REQUEST_TOO_LARGE", field: "body" } }, 400),
});
async function jsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return v.fail("body", "INVALID_JSON");
  }
}
function authorized(header: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`),
    actual = Buffer.from(header ?? "");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
/**
 * Household routes carry income and ages. With no token they are open to everyone, rate-limited
 * per source and never cached (the response cache bypasses requests without the token). A set
 * token restricts them to Bearer callers; OPENPLANS_PUBLIC_HOUSEHOLD=off with no token closes
 * them with 503. Request values and the token are never logged.
 */
export function personalizedOnly(options: QuoteOptions): MiddlewareHandler {
  const open = !options.premiumToken && publicHouseholdEnabled(options);
  const admission = open ? anonymousAdmission(options) : undefined;
  return async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (admission) return admission(c, next);
    if (!options.premiumToken)
      return c.json({ error: { code: "AUTH_NOT_CONFIGURED" } }, 503);
    if (!authorized(c.req.header("authorization"), options.premiumToken))
      return c.json({ error: { code: "UNAUTHORIZED" } }, 401);
    await next();
  };
}

export function quoteRoutes(
  db: SqlSession,
  options: QuoteOptions,
  household: MiddlewareHandler = personalizedOnly(options),
) {
  const app = new Hono();
  const enabled = publicQuotingEnabled(options);
  app.post("/quotes", jsonBodyLimit, async (c) => {
    if (!enabled) return quotingDisabled(c);
    c.header("Cache-Control", "no-store");
    c.header("X-Quote-Tier", "public");
    const body = await jsonBody(c);
    const deadline = AbortSignal.any([
      c.req.raw.signal,
      AbortSignal.timeout(DEADLINE_MS),
    ]);
    try {
      const scoped = boundedDatabase(db, deadline);
      const result = await quotePlans(
        scoped,
        body,
        "public_quote",
        quoteFallbackContext(
          scoped,
          requestSource(
            c,
            options.trustedProxies ?? trustedProxies(),
            options.peerAddress,
          ),
          boundedDatabase(db, deadline, { readOnly: false }),
        ),
      );
      deadline.throwIfAborted();
      return c.json(result);
    } catch (error) {
      if (deadline.aborted)
        return c.json({ error: { code: "REQUEST_DEADLINE" } }, 504);
      throw error;
    }
  });
  app.use("/premium-quotes", household);
  app.post("/premium-quotes", jsonBodyLimit, async (c) => {
    const body = await jsonBody(c);
    const deadline = AbortSignal.any([
      c.req.raw.signal,
      AbortSignal.timeout(DEADLINE_MS),
    ]);
    try {
      const { estimates } = await estimatePremiums(
        boundedDatabase(db, deadline),
        body,
      );
      return c.json({ quotes: estimates });
    } catch (error) {
      if (deadline.aborted)
        return c.json({ error: { code: "REQUEST_DEADLINE" } }, 504);
      throw error;
    }
  });
  return app;
}
