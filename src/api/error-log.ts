import { createHash } from "node:crypto";
import type { Context } from "hono";
import { QUERY_TIMEOUT } from "../services/errors.js";

/** Logs a class and fingerprint only. Messages, stacks and request values stay private. */
export function logInternalError(error: unknown): void {
  const errorClass =
    error instanceof Error ? error.constructor.name : "UnknownError";
  const stack = error instanceof Error ? (error.stack ?? "") : "";
  console.error(
    JSON.stringify({
      event: "api_internal_error",
      error_class: /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(errorClass)
        ? errorClass
        : "Error",
      stack_hash: createHash("sha256").update(stack).digest("hex"),
    }),
  );
}

/** A read past the database time limit is a gateway timeout the client may retry, never a 500. */
export const queryTimeoutResponse = (c: Context) =>
  c.json({ error: { code: QUERY_TIMEOUT } }, 504);
