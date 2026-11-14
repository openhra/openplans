import type { MiddlewareHandler } from "hono";
import type { SqlSession } from "../db/database.js";
import {
  loadMigrations,
  loadPluginMigrations,
  migrationsDirectory,
} from "../db/migrate.js";
import type { PluginMigrationSource } from "../db/migrate.js";
import { STATUS_ROUTE_PREFIX } from "../plugins/registries.js";
import { unappliedOf } from "../db/schema-ready.js";

/** The reason `/readyz` and the data routes give while migrations are pending. */
export const SCHEMA_NOT_READY = "schema_not_ready";
/** How long one journal read is trusted, so a finished migration is seen without a restart. */
export const SCHEMA_RECHECK_MS = 5000;

export interface SchemaGateOptions {
  /** The core migration files the database must have applied. Default: the shipped ones. */
  readonly directory?: string;
  /** Enabled plugins' migration folders; their journal rows are `plugin:<name>/<file>`. */
  readonly plugins?: readonly PluginMigrationSource[];
  readonly recheckMs?: number;
  readonly now?: () => number;
}

/**
 * `ready` or `pending` from the journal. `unknown` when the journal or the migration files
 * could not be read; it is never cached.
 */
export interface SchemaStatus {
  readonly state: "ready" | "pending" | "unknown";
  /** Unapplied core and plugin files; 0 unless `pending`. */
  readonly pending: number;
}

export interface SchemaGate {
  status(): Promise<SchemaStatus>;
  middleware: MiddlewareHandler;
}

// Liveness, readiness and the status plugin's pages stay served: they report the state themselves.
function exempt(path: string): boolean {
  return (
    path === "/healthz" ||
    path === "/readyz" ||
    path === "/v1/cache-stats" ||
    path === STATUS_ROUTE_PREFIX ||
    path.startsWith(`${STATUS_ROUTE_PREFIX}/`) ||
    path.startsWith(`${STATUS_ROUTE_PREFIX}.`)
  );
}

const UNKNOWN: SchemaStatus = Object.freeze({ state: "unknown", pending: 0 });

/**
 * Read-only check of the migration journal, cached for `recheckMs`. It never migrates. While a
 * migration is pending, every data route answers 503 `schema_not_ready` instead of a 500.
 */
export function schemaGate(
  db: SqlSession,
  options: SchemaGateOptions = {},
): SchemaGate {
  const recheckMs = options.recheckMs ?? SCHEMA_RECHECK_MS;
  const now = options.now ?? Date.now;
  let files: Promise<{ name: string }[]> | undefined;
  let cached: { status: SchemaStatus; at: number } | undefined;
  let running: Promise<SchemaStatus> | undefined;

  async function read(): Promise<SchemaStatus> {
    files ??= Promise.all([
      loadMigrations(options.directory ?? migrationsDirectory),
      loadPluginMigrations(options.plugins ?? []),
    ]).then(([core, plugins]) => [...core, ...plugins]);
    try {
      const pending = (await unappliedOf(db, await files)).length;
      return { state: pending === 0 ? "ready" : "pending", pending };
    } catch {
      return UNKNOWN;
    }
  }

  function status(): Promise<SchemaStatus> {
    const at = now();
    if (cached && at - cached.at < recheckMs)
      return Promise.resolve(cached.status);
    running ??= read().then((result) => {
      // An unreadable database is not cached; the next request asks again.
      cached = result.state === "unknown" ? undefined : { status: result, at };
      running = undefined;
      return result;
    });
    return running;
  }

  const middleware: MiddlewareHandler = async (c, next) => {
    if (c.req.method === "OPTIONS" || exempt(c.req.path)) return next();
    if ((await status()).state !== "pending") return next();
    const headers = {
      "Cache-Control": "no-store",
      "Retry-After": String(Math.max(1, Math.ceil(recheckMs / 1000))),
    };
    if (c.req.path === "/mcp")
      return Response.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32000,
            message: "Database migrations are pending",
            data: { reason: SCHEMA_NOT_READY },
          },
        },
        { status: 503, headers },
      );
    return c.json({ error: { code: SCHEMA_NOT_READY } }, 503, headers);
  };
  return { status, middleware };
}
