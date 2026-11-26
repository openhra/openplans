import { currentRequestId } from "./request-id.js";

/**
 * The one error body every REST route answers with: `{ error: { code, field?, hint? } }`.
 * `code` is lower snake case; `field` names the request field at fault; `hint` is a short
 * sentence that says how to fix the request. `request_id` is the value of the response's
 * `x-request-id` header, added here and nowhere else. `docs/public-contract.json` pins the shape.
 */
export interface ApiErrorBody {
  error: { code: string; field?: string; hint?: string; request_id?: string };
}

/** Lower snake case: `INVALID_INPUT` and `invalidInput` both become `invalid_input`. */
export function snakeCode(code: string): string {
  return code
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

/** The `request_id` member of the request being served; empty outside a request. */
function requestIdMember(): { request_id?: string } {
  const id = currentRequestId();
  return id === undefined ? {} : { request_id: id };
}

export function apiError(
  code: string,
  field?: string,
  hint?: string,
): ApiErrorBody {
  return {
    error: {
      code: snakeCode(code),
      ...(field === undefined ? {} : { field }),
      ...(hint === undefined ? {} : { hint }),
      ...requestIdMember(),
    },
  };
}

/**
 * An error object that carries more than a code (a ReadError's year or plan fields). The code is
 * normalised; every other member passes through.
 */
export function apiErrorFrom<T extends { code: string; message?: string }>(
  error: T,
): {
  error: Omit<T, "message"> & {
    code: string;
    hint?: string;
    request_id?: string;
  };
} {
  const { message, ...rest } = error;
  return {
    error: {
      ...rest,
      code: snakeCode(error.code),
      ...(message === undefined ? {} : { hint: message }),
      ...requestIdMember(),
    },
  };
}
