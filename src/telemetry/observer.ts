import type { MiddlewareHandler } from "hono";
import { performance } from "node:perf_hooks";
import { Aggregate } from "./aggregate.js";
import type { CacheOutcome, Labels, Series } from "./aggregate.js";

const operationId = /^[a-zA-Z0-9_.:-]{1,120}$/;
const ownerId = /^(core|@[a-z0-9._-]+\/[a-z0-9._-]+)$/;
const registered = new WeakSet<Labels>();
export interface Recorder {
  readonly aggregate: Aggregate;
  register(
    transport: Labels["transport"],
    operation: string,
    owner?: string,
  ): Labels;
  complete(
    labels: Labels,
    status: number,
    outcome: Series["outcome"],
    duration: number,
  ): void;
  cache(outcome: CacheOutcome): void;
}
export function createRecorder(now?: () => number): Recorder {
  const aggregate = new Aggregate(now);
  const labels = new Map<string, Labels>();
  return {
    aggregate,
    register(transport, operation, owner = "core") {
      if (
        !operationId.test(operation) ||
        !ownerId.test(owner) ||
        owner.length > 120 ||
        !["http", "mcp"].includes(transport)
      )
        throw new Error("Invalid telemetry registration");
      const key = `${transport}|${operation}|${owner}`;
      const existing = labels.get(key);
      if (existing) return existing;
      if (labels.size >= 512) throw new Error("Telemetry registration limit");
      const value = Object.freeze({ transport, operation, owner });
      labels.set(key, value);
      registered.add(value);
      return value;
    },
    complete(labels, status, outcome, duration) {
      if (
        !registered.has(labels) ||
        !["completed", "cancelled", "timeout"].includes(outcome) ||
        !Number.isInteger(status) ||
        status < 100 ||
        status > 599
      )
        return;
      try {
        aggregate.record(labels, status, outcome, duration);
      } catch {
        /* Disposable collection cannot fail a request. */
      }
    },
    cache(outcome) {
      try {
        aggregate.recordCache(outcome);
      } catch {
        /* No request-side sink. */
      }
    },
  };
}

let recorder: Recorder | undefined;
export function activeRecorder(): Recorder | undefined {
  return recorder;
}
export function useRecorder(value: Recorder | undefined): void {
  recorder = value;
}
export function recordCache(outcome: CacheOutcome): void {
  try {
    recorder?.cache(outcome);
  } catch {
    /* Collection is optional. */
  }
}

/** Lookup contains registration templates only. Request paths never become labels. */
export function httpObserver(
  resolve: (method: string, template: string) => Labels | undefined,
): MiddlewareHandler {
  return async (c, next) => {
    const sink = recorder;
    if (!sink || c.req.path === "/admin" || c.req.path.startsWith("/admin/"))
      return next();
    const started = performance.now();
    let ended = false;
    const finish = (outcome: Series["outcome"] = "completed") => {
      if (ended) return;
      ended = true;
      c.req.raw.signal.removeEventListener("abort", aborted);
      try {
        const routes = c.req.matchedRoutes;
        let template = "unmatched";
        for (let i = routes.length - 1; i >= 0; i--) {
          const route = routes[i];
          if (
            route &&
            (route.method === c.req.method || route.method === "ALL")
          ) {
            template = route.path;
            break;
          }
        }
        const labels = resolve(c.req.method, template);
        if (labels)
          sink.complete(
            labels,
            c.res.status,
            outcome,
            performance.now() - started,
          );
      } catch {
        /* Never execute a sink outside this guard. */
      }
    };
    const aborted = () => finish("cancelled");
    c.req.raw.signal.addEventListener("abort", aborted, { once: true });
    await next();
    if (c.req.raw.signal.aborted) {
      finish("cancelled");
      return;
    }
    const response = c.res;
    if (!response.body) {
      finish();
      return;
    }
    const reader = response.body.getReader();
    c.res = new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const part = await reader.read();
            if (part.done) {
              finish(response.status === 504 ? "timeout" : "completed");
              controller.close();
            } else controller.enqueue(part.value);
          } catch (error) {
            finish("cancelled");
            controller.error(error);
          }
        },
        async cancel(reason) {
          finish("cancelled");
          await reader.cancel(reason);
        },
      }),
      {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      },
    );
  };
}
