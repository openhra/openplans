export class ReadError extends Error {
  constructor(
    readonly error: {
      code: string;
      field?: string;
      message?: string;
      plan_id?: string;
      year?: number;
    },
  ) {
    super(error.code);
  }
}

/** The code every surface gives a read that ran past the database time limit. */
export const QUERY_TIMEOUT = "query_timeout";

/**
 * A read stopped by the time limit: the server's statement timeout (SQLSTATE 57014 with its
 * timeout message) or the client's read timeout on a pooled query. A cancelled request is not
 * a timeout; its own deadline handling answers it.
 */
export function isQueryTimeout(error: unknown): boolean {
  for (let e = error, depth = 0; e && depth < 4; depth++) {
    if (e instanceof Error) {
      const code = (e as { code?: unknown }).code;
      if (e.message === "Query read timeout") return true;
      if (code === "57014" && /statement timeout/.test(e.message)) return true;
      e = e.cause;
    } else return false;
  }
  return false;
}
