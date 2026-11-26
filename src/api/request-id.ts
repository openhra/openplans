import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import type { MiddlewareHandler } from "hono";

/** The response header, and the member `error.request_id` carries the same value. */
export const REQUEST_ID_HEADER = "x-request-id";
const MAX_LENGTH = 128;
// Visible ASCII only: no space, no control character, nothing that can split a log line or header.
const ACCEPTED = /^[\x21-\x7e]{1,128}$/;

const scope = new AsyncLocalStorage<{ id: string }>();

/** The id of the request being served, or undefined outside a request. */
export const currentRequestId = (): string | undefined => scope.getStore()?.id;

/** A client id survives only when it is 1 to 128 visible ASCII characters; otherwise a fresh one. */
export function requestIdFor(sent: string | undefined | null): string {
  if (sent && sent.length <= MAX_LENGTH && ACCEPTED.test(sent)) return sent;
  return randomBytes(8).toString("hex");
}

/** Runs the rest of the request with its id in scope and echoes the id on every response. */
export const requestIdMiddleware: MiddlewareHandler = async (c, next) => {
  const id = requestIdFor(c.req.header(REQUEST_ID_HEADER));
  await scope.run({ id }, next);
  try {
    c.res.headers.set(REQUEST_ID_HEADER, id);
  } catch {
    // A response with immutable headers is copied, never left without the id.
    c.res = new Response(c.res.body, c.res);
    c.res.headers.set(REQUEST_ID_HEADER, id);
  }
};
