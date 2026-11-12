import { loadConfig } from "../config/index.js";
import { sharedResponseCache } from "../api/cache/index.js";
import type { CacheOutcome } from "../api/cache/index.js";
import { Hono } from "hono";
import { hostHeaderValidation } from "@modelcontextprotocol/hono";
import {
  createMcpHandler,
  readRequestBody,
} from "@modelcontextprotocol/server";
import type { SqlSession } from "../db/database.js";
import { createSourceLimiter, requestSource } from "../api/rate-limit.js";
import { buildServer } from "./server.js";
import { PERSONALIZED_TOOLS } from "./schemas.js";
import {
  estimateToolHooks,
  MEDICARE_ESTIMATE_TOOL,
} from "./medicare-estimate.js";
import { isToolName } from "../plugins/mcp-tools.js";
import { runWithScope } from "../plugins/request-scope.js";
import type { ScopeHandle } from "../plugins/request-scope.js";
import type { CacheLevel } from "@openplans/plugin-sdk";
import type { ToolName } from "./schemas.js";
import { MAX_OUTPUT_BYTES, MAX_TOOL_LIST_BYTES, limits } from "./tools.js";
import {
  authenticated,
  boundedDatabase,
  configDependencies,
  DEADLINE_MS,
  configHouseholdOpen,
} from "./policy.js";
import type { McpEnvironment } from "./policy.js";

export interface McpLog {
  tool: string | null;
  status: number;
  timing_ms: number;
  bytes: number;
  cache: CacheOutcome;
}
export interface HttpOptions {
  env?: McpEnvironment;
  now?: () => number;
  log?: (entry: McpLog) => void;
  /** Trusted socket peer supplied by a hosting adapter, never an HTTP header. */
  peerAddress?: (request: Request) => string | undefined;
  /** Called once with the request's cache level, before the first response byte is sent. */
  onCacheLevel?: (level: CacheLevel | null) => void;
}
function failure(
  status: number,
  code: number,
  message: string,
  headers?: HeadersInit,
) {
  return Response.json(
    { jsonrpc: "2.0", id: null, error: { code, message } },
    { status, headers },
  );
}

export function createMcpHttp(db: SqlSession, options: HttpOptions = {}) {
  const cache = sharedResponseCache(db);
  const config = loadConfig(options.env ?? process.env);
  const now = options.now ?? Date.now;
  const hosts = [...config.mcp.allowedHosts];
  const origins = config.mcp.allowedOrigins;
  const proxies = [...config.trustProxy];
  // Anonymous callers share the 60 per minute bucket whether or not household tools are open.
  const open = configHouseholdOpen(config);
  const log = options.log ?? ((entry) => console.error(JSON.stringify(entry)));
  const limiter = createSourceLimiter(now);
  let active = 0;
  const app = new Hono();
  app.use("/mcp", async (c, next) => {
    // Exact scheme/host/port comparison; SDK hostname checks alone are insufficient.
    const origin = c.req.header("origin");
    if (origin !== undefined && !origins.includes(origin))
      return failure(403, -32000, "Origin forbidden");
    await next();
    // Apply to the finalized response, including SDK streams and early error responses.
    if (origin) {
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Vary", "Origin", { append: true });
      c.header(
        "Access-Control-Expose-Headers",
        "Mcp-Session-Id, MCP-Protocol-Version, WWW-Authenticate, Retry-After",
      );
    }
  });
  app.use("/mcp", async (c, next) => {
    if (!config.mcp.enabled) return c.notFound();
    const host = c.req.header("host") ?? new URL(c.req.url).host;
    if (!hosts.includes(host)) return failure(403, -32000, "Host forbidden");
    await next();
  });
  // The official adapter additionally checks a supplied Host's hostname.
  app.use("/mcp", async (c, next) =>
    c.req.header("host")
      ? hostHeaderValidation(hosts.map((h) => new URL(`http://${h}`).hostname))(
          c,
          next,
        )
      : next(),
  );
  app.options("/mcp", (c) => {
    c.header("Access-Control-Allow-Methods", "POST");
    c.header(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Accept",
    );
    return c.body(null, 204);
  });
  app.all("/mcp", async (c) => {
    if (c.req.method !== "POST")
      return failure(405, -32600, "Method not allowed", {
        Allow: "POST, OPTIONS",
      });
    const started = now(),
      controller = new AbortController();
    const signal = AbortSignal.any([c.req.raw.signal, controller.signal]);
    let done = false,
      acquired = false,
      bytes = 0,
      tool: string | null = null;
    let status = 500,
      cacheOutcome: CacheOutcome = "bypass";
    let handler: ReturnType<typeof createMcpHandler> | undefined;
    let scope: ScopeHandle | undefined,
      levelSeen = false;
    // Read through the handle: stream callbacks run outside the request's async context.
    const seeLevel = () => {
      if (levelSeen || !scope) return;
      levelSeen = true;
      const level = scope.level();
      if (level === "none" || level === "request") cacheOutcome = "bypass";
      options.onCacheLevel?.(level);
    };
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (acquired) active--;
      void handler?.close().catch(() => {});
      log({
        tool,
        status,
        timing_ms: Math.max(0, now() - started),
        bytes,
        cache: cacheOutcome,
      });
    };
    let rejectAbort: (reason: Error) => void;
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () => {
      if (status === 500) status = 504;
      rejectAbort(new Error("Request cancelled"));
      finish();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
    timer.unref();
    try {
      signal.throwIfAborted();
      const granted = authenticated(
        c.req.header("authorization") ?? null,
        config.tokens.mcp?.reveal(),
      );
      const source = requestSource(c, proxies, options.peerAddress);
      const admission = limiter.take(
        `${granted ? "auth" : "anon"}:${source}`,
        granted ? 120 : 60,
      );
      if (!admission.allowed) {
        status = 429;
        return failure(status, -32000, "Rate limit exceeded", {
          "Retry-After": String(admission.retryAfterSeconds),
        });
      }
      if (
        c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() !==
        "application/json"
      ) {
        status = 415;
        return failure(status, -32600, "JSON required");
      }
      const body = await Promise.race([
        readRequestBody(c.req.raw, limits.input_bytes),
        aborted,
      ]);
      if (body.tooLarge) {
        status = 413;
        return failure(status, -32600, "Request too large");
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(body.text);
      } catch {
        status = 400;
        return failure(status, -32700, "Parse error");
      }
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
        status = 400;
        return failure(status, -32600, "Invalid request");
      }
      const responseLimit =
        parsed.method === "tools/list" ? MAX_TOOL_LIST_BYTES : MAX_OUTPUT_BYTES;
      const params = parsed.params as Record<string, unknown> | undefined;
      // The Medicare estimate exists only while its switches are on; off, it is an unknown name.
      const estimateCall =
        parsed.method === "tools/call" &&
        params?.name === MEDICARE_ESTIMATE_TOOL &&
        estimateToolHooks.enabled();
      tool =
        parsed.method === "tools/call" &&
        (isToolName(params?.name) || estimateCall)
          ? String(params?.name)
          : null;
      // Legacy initialize predates metadata headers; all modern metadata validation is delegated to the SDK.
      if (
        parsed.method !== "initialize" &&
        !c.req.header("mcp-protocol-version")
      ) {
        status = 400;
        return failure(status, -32020, "Missing MCP-Protocol-Version");
      }
      const needsGrant =
        parsed.method === "tools/call" &&
        PERSONALIZED_TOOLS.has(params?.name as ToolName) &&
        !granted &&
        !open;
      // The estimate needs a verified Bearer token; household openness never grants it.
      const needsEstimateGrant = estimateCall && !granted;
      const heavy =
        parsed.method === "tools/call" || parsed.method === "resources/read";
      if (heavy && active >= 4) {
        status = 429;
        return failure(status, -32000, "Concurrency limit exceeded", {
          "Retry-After": "1",
        });
      }
      if (heavy) {
        active++;
        acquired = true;
      }
      handler = createMcpHandler(
        () =>
          buildServer({
            ...configDependencies(
              boundedDatabase(db, signal),
              config,
              granted || open,
              granted,
            ),
            cache,
            onCache: (outcome) => {
              cacheOutcome = outcome;
            },
          }),
        {
          legacy: "stateless",
          responseMode: "auto",
          keepAliveMs: 15000,
          maxRequestBodySize: limits.input_bytes,
          maxSubscriptions: 0,
        },
      );
      const request = new Request(c.req.url, {
        method: "POST",
        headers: c.req.raw.headers,
        body: body.text,
        signal,
      });
      const mcp = handler;
      // Design 5.10.5: tools and catalog() run inside this scope, so the level is known before
      // any byte is written.
      const response = await Promise.race([
        runWithScope((handle) => {
          scope = handle;
          return mcp.fetch(request, { parsedBody: parsed });
        }),
        aborted,
      ]);
      status = response.status;
      // The denied factory omits personalized quotes entirely, so validation cannot dispatch household work.
      // Preserve SDK metadata errors before applying the HTTP authentication challenge.
      if (needsGrant && (status === 200 || status === 404)) {
        await response.body?.cancel();
        status = 401;
        return failure(status, -32000, "Personalized access required", {
          "WWW-Authenticate": 'Bearer realm="openplans-mcp"',
        });
      }
      if (needsEstimateGrant && (status === 200 || status === 404)) {
        await response.body?.cancel();
        // Like the HTTP estimate route: no token configured means no grant can be verified.
        if (!config.tokens.mcp) {
          status = 503;
          return failure(status, -32000, "AUTH_NOT_CONFIGURED");
        }
        status = 401;
        return failure(status, -32000, "Estimate access required", {
          "WWW-Authenticate": 'Bearer realm="openplans-mcp"',
        });
      }
      if (!response.body) {
        seeLevel();
        finish();
        return response;
      }
      const reader = response.body.getReader();
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", "no-store");
      headers.set("X-Accel-Buffering", "no");
      // Streaming preserves SDK auto mode while binding disconnect to SQL cancellation.
      const stream = new ReadableStream<Uint8Array>({
        async pull(out) {
          try {
            const part = await Promise.race([reader.read(), aborted]);
            seeLevel();
            if (part.done) {
              out.close();
              finish();
              return;
            }
            bytes += part.value.byteLength;
            if (bytes > responseLimit) throw new Error("Response limit");
            out.enqueue(part.value);
          } catch {
            controller.abort();
            void reader.cancel();
            out.error(new Error("MCP response interrupted"));
            finish();
          }
        },
        async cancel() {
          controller.abort();
          await reader.cancel();
          finish();
        },
      });
      return new Response(stream, { status, headers });
    } catch {
      status = signal.aborted ? 504 : 500;
      return failure(
        status,
        -32603,
        signal.aborted ? "Request deadline or cancellation" : "Request failed",
      );
    } finally {
      // Body-bearing responses keep their request scope until EOF or disconnect.
      if (!handler || status >= 400) {
        controller.abort();
        finish();
      }
      // Avoid an unhandled rejection when a completed response is subsequently cancelled.
      void aborted.catch(() => {});
    }
  });
  return app;
}
