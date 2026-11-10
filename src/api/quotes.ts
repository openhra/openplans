import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { SqlSession } from "../db/database.js";
import { boundedDatabase, DEADLINE_MS } from "../db/bounded.js";
import { estimatePremiums } from "../services/catalog.js";
import { quotePlans } from "../services/quotes.js";
import { quoteFallbackContext } from "../services/quote-coverage.js";
import { proxyList, requestSource, sourceAdmission } from "./rate-limit.js";
import type { PeerAddress, SourceLimits } from "./rate-limit.js";
import * as v from "./validation.js";

export interface QuoteOptions {
  /** When set, personalized requests need this Bearer token. Never logged. */
  premiumToken?: string;
  /** Anonymous quotes by age and ZIP. Defaults to OPENPLANS_PUBLIC_QUOTING (on unless "off"). */
  publicQuoting?: boolean;
  /** Anonymous household quotes, benchmark and ICHRA checks when no token is set.
   * Defaults to OPENPLANS_PUBLIC_HOUSEHOLD (on unless "off"). */
  publicHousehold?: boolean;
  /** Anonymous compatibility API when no key is set. Defaults to OPENPLANS_PUBLIC_COMPAT (on unless "off"). */
  publicCompat?: boolean;
  /** Defaults to OPENPLANS_TRUST_PROXY; only these peers may supply X-Forwarded-For. */
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

/** Parses an on/off switch whose default is on (owner, 2026-11-09: available by default). */
function onUnlessOff(name: string, value: string | undefined): boolean {
  if (value === undefined || value === "" || value === "on") return true;
  if (value === "off") return false;
  throw new Error(`${name} must be on or off`);
}
/** Public quoting is on for every install unless OPENPLANS_PUBLIC_QUOTING=off (owner, 2026-11-09). */
export function publicQuotingFromEnv(value: string | undefined): boolean {
  return onUnlessOff("OPENPLANS_PUBLIC_QUOTING", value);
}
/** Household routes are open without a token unless OPENPLANS_PUBLIC_HOUSEHOLD=off. */
export function publicHouseholdFromEnv(value: string | undefined): boolean {
  return onUnlessOff("OPENPLANS_PUBLIC_HOUSEHOLD", value);
}
/** The compatibility API is open without a key unless OPENPLANS_PUBLIC_COMPAT=off. */
export function publicCompatFromEnv(value: string | undefined): boolean {
  return onUnlessOff("OPENPLANS_PUBLIC_COMPAT", value);
}
export function publicQuotingEnabled(options: QuoteOptions): boolean {
  return (
    options.publicQuoting ??
    publicQuotingFromEnv(process.env.OPENPLANS_PUBLIC_QUOTING)
  );
}

function publicHouseholdEnabled(options: QuoteOptions): boolean {
  return (
    options.publicHousehold ??
    publicHouseholdFromEnv(process.env.OPENPLANS_PUBLIC_HOUSEHOLD)
  );
}
export function publicCompatEnabled(options: QuoteOptions): boolean {
  return (
    options.publicCompat ??
    publicCompatFromEnv(process.env.OPENPLANS_PUBLIC_COMPAT)
  );
}
/** Same per-source limits as public quotes, for one anonymous tier. */
export function anonymousAdmission(options: QuoteOptions): MiddlewareHandler {
  return sourceAdmission({
    limits: PUBLIC_QUOTE_RATE,
    trustedProxies:
      options.trustedProxies ?? proxyList(process.env.OPENPLANS_TRUST_PROXY),
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
    const deadline = AbortSignal.timeout(DEADLINE_MS);
    try {
      const scoped = boundedDatabase(db, deadline);
      return c.json(
        await quotePlans(
          scoped,
          body,
          "public_quote",
          quoteFallbackContext(
            scoped,
            requestSource(
              c,
              options.trustedProxies ??
                proxyList(process.env.OPENPLANS_TRUST_PROXY),
              options.peerAddress,
            ),
          ),
        ),
      );
    } catch (error) {
      if (deadline.aborted)
        return c.json({ error: { code: "REQUEST_DEADLINE" } }, 504);
      throw error;
    }
  });
  app.use("/premium-quotes", household);
  app.post("/premium-quotes", jsonBodyLimit, async (c) => {
    const body = await jsonBody(c);
    const deadline = AbortSignal.timeout(DEADLINE_MS);
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
