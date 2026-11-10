import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { boundedDatabase, DEADLINE_MS } from "../db/bounded.js";
import type { SqlSession } from "../db/database.js";
import { ichraAffordability } from "../services/ichra.js";
import { personalizedOnly } from "./quotes.js";
import type { QuoteOptions } from "./quotes.js";
import * as v from "./validation.js";

const MAX_BODY_BYTES = 65_536;
const limit = bodyLimit({
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

/** The request carries income: household access rules apply and it is never cached. */
export function ichraRoutes(
  db: SqlSession,
  options: QuoteOptions,
  household: MiddlewareHandler = personalizedOnly(options),
) {
  const app = new Hono();
  app.use("/ichra/affordability", household);
  app.post("/ichra/affordability", limit, async (c) => {
    const request = v.ichraRequest(await jsonBody(c));
    const deadline = AbortSignal.timeout(DEADLINE_MS);
    try {
      return c.json(
        await ichraAffordability(boundedDatabase(db, deadline), request),
      );
    } catch (error) {
      if (deadline.aborted)
        return c.json({ error: { code: "REQUEST_DEADLINE" } }, 504);
      throw error;
    }
  });
  return app;
}
