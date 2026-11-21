import type { MiddlewareHandler } from "hono";
import {
  PASSTHROUGH_FIELD,
  UPSTREAM_HEADER,
  passThroughDeclined,
  upstreamSources,
  withUpstreamDisclosure,
} from "../services/upstream-disclosure.js";

/**
 * One disclosure scope per request (D-PRX-5). `?passthrough=off` keeps the request local; a POST
 * body's `passthrough` field is read by the routes that parse the body. After the handler, the
 * sources that filled an answer go into `x-openplans-upstream`. It runs inside the response cache,
 * which stores the header with the body, so a cached replay discloses the same sources.
 */
export const upstreamDisclosure: MiddlewareHandler = async (c, next) => {
  let declined: boolean;
  try {
    declined = passThroughDeclined(c.req.query(PASSTHROUGH_FIELD));
  } catch {
    return c.json(
      { error: { code: "INVALID_INPUT", field: PASSTHROUGH_FIELD } },
      400,
    );
  }
  await withUpstreamDisclosure(async () => {
    await next();
    const sources = upstreamSources();
    if (!sources.length) return;
    // Mutate the finished Response's headers in place (see the response cache's note on
    // c.header() and stream reuse).
    c.res.headers.set(UPSTREAM_HEADER, sources.join(","));
  }, declined);
};
