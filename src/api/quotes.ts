import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { SqlSession } from "../db/database.js";
import { boundedDatabase, DEADLINE_MS } from "../db/bounded.js";
import { estimatePremiums } from "../services/catalog.js";
import { quotePlans } from "../services/quotes.js";
import { proxyList, sourceAdmission } from "./rate-limit.js";
import type { PeerAddress, SourceLimits } from "./rate-limit.js";
import * as v from "./validation.js";

export interface QuoteOptions {
  /** Required for personalized requests (spec §14). Never logged. */
  premiumToken?: string;
  /** Anonymous quotes by age and ZIP. Defaults to OPENPLANS_PUBLIC_QUOTING (on unless "off"). */
  publicQuoting?: boolean;
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

/** Public quoting is on for every install unless OPENPLANS_PUBLIC_QUOTING=off (owner, 2026-11-09). */
export function publicQuotingFromEnv(value: string | undefined): boolean {
  if (value === undefined || value === "" || value === "on") return true;
  if (value === "off") return false;
  throw new Error("OPENPLANS_PUBLIC_QUOTING must be on or off");
}
export function publicQuotingEnabled(options: QuoteOptions): boolean {
  return (
    options.publicQuoting ??
    publicQuotingFromEnv(process.env.OPENPLANS_PUBLIC_QUOTING)
  );
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
    sourceAdmission({
      limits: PUBLIC_QUOTE_RATE,
      trustedProxies:
        options.trustedProxies ?? proxyList(process.env.OPENPLANS_TRUST_PROXY),
      peerAddress: options.peerAddress,
      now: options.now,
    }),
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
/** Personalized routes keep their 503/401 answers; the token is never logged. */
export function personalizedOnly(options: QuoteOptions): MiddlewareHandler {
  return async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (!options.premiumToken)
      return c.json({ error: { code: "AUTH_NOT_CONFIGURED" } }, 503);
    if (!authorized(c.req.header("authorization"), options.premiumToken))
      return c.json({ error: { code: "UNAUTHORIZED" } }, 401);
    await next();
  };
}

export function quoteRoutes(db: SqlSession, options: QuoteOptions) {
  const app = new Hono();
  const enabled = publicQuotingEnabled(options);
  app.post("/quotes", jsonBodyLimit, async (c) => {
    if (!enabled) return quotingDisabled(c);
    c.header("Cache-Control", "no-store");
    c.header("X-Quote-Tier", "public");
    const body = await jsonBody(c);
    const deadline = AbortSignal.timeout(DEADLINE_MS);
    try {
      return c.json(await quotePlans(boundedDatabase(db, deadline), body));
    } catch (error) {
      if (deadline.aborted)
        return c.json({ error: { code: "REQUEST_DEADLINE" } }, 504);
      throw error;
    }
  });
  app.use("/premium-quotes", personalizedOnly(options));
  app.post("/premium-quotes", jsonBodyLimit, async (c) => {
    const { estimates } = await estimatePremiums(db, await jsonBody(c));
    return c.json({ quotes: estimates });
  });
  return app;
}
