import { apiError } from "../api/errors.js";
import { createOperatorCommandClient } from "../operator/commands/service.js";
import { timingSafeEqual } from "node:crypto";
import { ADMIN_CSP, adminHeaders } from "../operator/csrf.js";
import type { AdminAuth } from "../operator/auth-routes.js";
import type {
  PassThroughSource,
  PluginRouteEnv,
  Question,
  RouteSpec,
} from "@openplans/plugin-sdk";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { hasCredentials } from "../api/cache/index.js";
import { sourceAdmission } from "../api/rate-limit.js";
import type { PeerAddress, SourceLimits } from "../api/rate-limit.js";
import { boundedDatabase, DEADLINE_MS } from "../db/bounded.js";
import type { SqlSession } from "../db/database.js";
import { rowProvenanceLeaks } from "../db/row-provenance.js";
import {
  operatorCommandsForRoutes,
  ADMIN_AUTH_PATHS,
  ADMIN_PLUGIN,
  isAdminPath,
  validAdminRoute,
  STATUS_PLUGIN,
  STATUS_ROUTE_PREFIX,
} from "./registries.js";
import type { PluginRegistries } from "./registries.js";
import { passThroughWriter } from "./sources/scoped-writer.js";

/** Design 5.5: 60 per minute, 2 active per source, 8 active in total. */
export const DEFAULT_ROUTE_LIMITS: SourceLimits = Object.freeze({
  perMinute: 60,
  activePerSource: 2,
  activeTotal: 8,
});

/** Request bodies above this are refused before the plugin sees them, as on core routes. */
export const PLUGIN_REQUEST_MAX_BYTES = 65_536;
/** The wrapper rejects a JSON response above this before parsing or scanning it. */
export const PLUGIN_RESPONSE_MAX_BYTES = 1024 * 1024;

// The same reserved paths the loader refuses; checked again so a hand-built registry cannot shadow a core route.
const CORE_PATHS = ["/healthz", "/readyz", "/mcp"];
const CORE_PREFIXES = ["/v1", "/compat"];
export function isCoreRoutePath(path: string, plugin?: string): boolean {
  return (
    ADMIN_AUTH_PATHS.includes(path) ||
    (plugin !== ADMIN_PLUGIN && isAdminPath(path)) ||
    (plugin !== STATUS_PLUGIN && path.startsWith(STATUS_ROUTE_PREFIX)) ||
    CORE_PATHS.includes(path) ||
    CORE_PREFIXES.some(
      (prefix) => path === prefix || path.startsWith(`${prefix}/`),
    )
  );
}

/** The body as text, or undefined once it passes `limit` bytes; reading stops there. */
async function boundedText(
  response: Response,
  limit: number,
): Promise<string | undefined> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function routeOwner(
  registries: Pick<PluginRegistries, "routes">,
  spec: RouteSpec,
): string | undefined {
  return registries.routes.find((entry) => entry.spec === spec)?.plugin;
}

const HTML_HEADERS: readonly (readonly [string, string])[] = [
  ["Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'"],
  ["X-Content-Type-Options", "nosniff"],
  ["Referrer-Policy", "no-referrer"],
];

export interface PluginRouteOptions {
  db: SqlSession;
  commandWritable?: () => boolean;
  adminAuth?: AdminAuth;
  /** Read per request, so a removed token closes the operator surface at once. */
  operatorToken: () => string | undefined;
  trustedProxies: readonly string[];
  peerAddress?: PeerAddress;
  now?: () => number;
  deadlineMs?: number;
  writeLog?: (line: string) => void;
}

function bearerMatches(header: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(header ?? "");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function noStore(c: Context) {
  c.header("Cache-Control", "no-store");
}

/**
 * Wraps plugin routes. `guard` runs before the response cache (exposure, then the rate limit, so
 * cached answers count against the limit); `mount` adds the handlers after the core routes.
 */
export function pluginRoutes(
  registries: Pick<PluginRegistries, "routes"> &
    Partial<Pick<PluginRegistries, "sources" | "operatorCommands">>,
  options: PluginRouteOptions,
) {
  const routes = registries.routes.map(({ spec }) => spec);
  // Each route's plugin and that plugin's own pass-through sources (design 5.10.3).
  const owners = new Map(
    registries.routes.map(({ plugin, spec }) => [spec, plugin]),
  );
  const ownSources = (plugin: string | undefined) =>
    (registries.sources ?? [])
      .filter((entry) => entry.plugin === plugin)
      .map((entry) => entry.spec)
      .filter(
        (spec): spec is PassThroughSource<Question, unknown> =>
          spec.kind === "passthrough",
      );
  const seen = new Set<string>();
  for (const spec of routes) {
    const key = `${spec.method} ${spec.path}`;
    if (
      !validAdminRoute(routeOwner(registries, spec) ?? "", spec) ||
      isCoreRoutePath(spec.path, routeOwner(registries, spec)) ||
      seen.has(key)
    )
      throw new Error(`Plugin route collides with a reserved path: ${key}`);
    seen.add(key);
  }
  const writeLog =
    options.writeLog ?? ((line: string) => void console.error(line));
  const deadlineMs = options.deadlineMs ?? DEADLINE_MS;

  function exposure(spec: RouteSpec): MiddlewareHandler {
    return async (c, next) => {
      if (spec.adminSession) adminHeaders(c);
      if (spec.exposure === "operator") {
        const token = options.operatorToken();
        // No token configured: the operator surface does not exist.
        if (!token) return c.notFound();
        if (
          (spec.adminSession && spec.method === "POST") ||
          !bearerMatches(c.req.header("authorization"), token)
        ) {
          if (spec.adminSession && options.adminAuth) {
            const refusal = await options.adminAuth.authorize(c);
            if (refusal) return refusal;
          } else {
            noStore(c);
            return c.json(apiError("unauthorized"), 401);
          }
        }
      }
      await next();
    };
  }

  function rejected(
    c: Context,
    path: string,
    reason:
      "response_too_large" | "invalid_json" | "row_provenance" | "credentials",
  ) {
    writeLog(
      JSON.stringify({ event: "plugin_response_rejected", path, reason }),
    );
    noStore(c);
    return c.json(apiError("plugin_response_rejected"), 500);
  }

  function handler(spec: RouteSpec) {
    const sources = ownSources(owners.get(spec));
    // The SDK types these variables through PluginRouteEnv.
    return async (c: Context<PluginRouteEnv>) => {
      const deadline =
        (spec.adminSession && options.adminAuth?.signal(c)) ||
        AbortSignal.timeout(deadlineMs);
      const signal = AbortSignal.any([deadline, c.req.raw.signal]);
      if (signal.aborted)
        return c.json(apiError("plugin_deadline_exceeded"), 503);
      c.set("pluginSignal", signal);
      const reader = boundedDatabase(options.db, signal, { readOnly: true });
      c.set("pluginDb", reader);
      // Only for a plugin with its own pass-through sources, and never a general writer.
      const writer = passThroughWriter(
        sources,
        reader,
        boundedDatabase(options.db, signal, { readOnly: false }),
      );
      if (writer) c.set("pluginPassThroughWriter", writer);
      if (spec.adminSession && owners.get(spec) === ADMIN_PLUGIN) {
        const commands =
          registries.operatorCommands ??
          operatorCommandsForRoutes(registries.routes);
        const credential = options.operatorToken();
        c.set(
          "pluginOperatorCommands",
          createOperatorCommandClient(
            {
              db: options.db,
              commands,
              writable: () =>
                spec.method === "POST" &&
                Boolean(credential) &&
                credential === options.operatorToken() &&
                options.commandWritable?.() === true,
              now: options.now,
            },
            {
              actor: { class: "shared_operator" },
              signal,
              grants: commands.flatMap(({ spec: command }) =>
                command.sources.map((source) => ({
                  source,
                  permissions: [command.permission],
                })),
              ),
            },
          ),
        );
      }
      let response: Response;
      try {
        response = await new Promise<Response>((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
          Promise.resolve()
            .then(() => spec.handler(c))
            .then(resolve, reject);
        });
      } catch (error) {
        if (!signal.aborted) throw error;
        noStore(c);
        return c.json(apiError("plugin_deadline_exceeded"), 503);
      }
      if (
        spec.exposure === "public" &&
        response.status === 503 &&
        !response.headers.has("Retry-After")
      ) {
        response = new Response(response.body, response);
        response.headers.set("Retry-After", "1");
      }
      if (spec.contentType === "application/json") {
        const text = await boundedText(response, PLUGIN_RESPONSE_MAX_BYTES);
        if (text === undefined)
          return rejected(c, spec.path, "response_too_large");
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          return rejected(c, spec.path, "invalid_json");
        }
        if (rowProvenanceLeaks(body, spec.path).length > 0)
          return rejected(c, spec.path, "row_provenance");
        if (hasCredentials(body)) return rejected(c, spec.path, "credentials");
        return new Response(text, {
          status: response.status,
          headers: response.headers,
        });
      }
      const text = await boundedText(response, PLUGIN_RESPONSE_MAX_BYTES);
      if (text === undefined)
        return rejected(c, spec.path, "response_too_large");
      const html = new Response(text, response);
      for (const [name, value] of HTML_HEADERS) html.headers.set(name, value);
      if (spec.adminSession) {
        adminHeaders(c);
        html.headers.set("Content-Security-Policy", ADMIN_CSP);
        html.headers.set("Cache-Control", "no-store");
      }
      return html;
    };
  }

  return {
    guard(app: Hono) {
      for (const spec of routes) {
        app.on(
          spec.method,
          spec.path,
          exposure(spec),
          sourceAdmission({
            limits: spec.rateLimit ?? DEFAULT_ROUTE_LIMITS,
            trustedProxies: options.trustedProxies,
            peerAddress: options.peerAddress,
            now: options.now,
          }),
          bodyLimit({
            maxSize: PLUGIN_REQUEST_MAX_BYTES,
            onError: (c) => {
              noStore(c);
              return c.json(apiError("request_too_large", "body"), 400);
            },
          }),
          async (c, next) => {
            if (
              spec.adminSession &&
              spec.method === "POST" &&
              options.adminAuth
            ) {
              const refusal = await options.adminAuth.authorizeForm(c);
              if (refusal) return refusal;
            }
            await next();
          },
        );
      }
    },
    mount(app: Hono) {
      for (const spec of routes) app.on(spec.method, spec.path, handler(spec));
    },
  };
}
