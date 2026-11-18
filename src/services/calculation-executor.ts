import { AsyncLocalStorage } from "node:async_hooks";
import { Worker } from "node:worker_threads";
import type { CalculationHost, CalculationScope } from "@openplans/plugin-sdk";
import type { QueryOptions } from "../db/database.js";
import { boundedDatabase } from "../db/bounded.js";

export type CalculationMethod =
  "enumerateHouseholdOffers" | "householdDistributions";
type Results = {
  [K in CalculationMethod]: Awaited<
    ReturnType<NonNullable<CalculationHost[K]>>
  >;
};
export interface CalculationExecutor {
  call<K extends CalculationMethod>(
    method: K,
    input: unknown,
    scope: CalculationScope,
    options?: unknown,
  ): Promise<Results[K]>;
}
let installed: CalculationExecutor | undefined;
export const calculationExecutor = () => installed;
export function installCalculationExecutor(
  executor: CalculationExecutor | undefined,
) {
  installed = executor;
}

export type WireError = { name: string; message: string; code?: string };
export function calculationError(error: unknown): WireError {
  const code =
    error instanceof Error
      ? (error as Error & { code?: unknown }).code
      : undefined;
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : "calculation_failed",
    ...(typeof code === "string" ? { code } : {}),
  };
}
export type WorkerReply =
  | { type: "ready" }
  | {
      type: "result";
      id: number;
      result?: unknown;
      error?: WireError;
      remaining?: number;
    }
  | {
      type: "query";
      id: number;
      query: number;
      sql: string;
      parameters?: unknown[];
      options?: QueryOptions;
    };
export type WorkerRequest =
  | {
      type: "calculate";
      id: number;
      method: CalculationMethod;
      input: unknown;
      options?: unknown;
      remaining?: number;
    }
  | { type: "cancel"; id: number }
  | {
      type: "query-result";
      id: number;
      query: number;
      result?: unknown;
      error?: WireError;
    };

type Active = {
  id: number;
  scope: CalculationScope;
  inRequest: ReturnType<typeof AsyncLocalStorage.snapshot>;
  finish(error?: Error, result?: unknown, remaining?: number): void;
};

/** SQL stays with the caller's reader; only computation and its heap move to the worker. */
export class CalculationWorker implements CalculationExecutor {
  private thread?: Worker;
  private ready?: Promise<void>;
  private current?: Active;
  private sequence = 0;
  private closed = false;
  constructor(
    private readonly script = new URL(
      "./calculation-worker.js",
      import.meta.url,
    ),
  ) {}

  start(): Promise<void> {
    if (this.closed)
      return Promise.reject(new Error("calculation_worker_closed"));
    if (this.thread && this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const thread = new Worker(this.script, {
        resourceLimits: {
          maxOldGenerationSizeMb: 192,
          maxYoungGenerationSizeMb: 16,
        },
      });
      this.thread = thread;
      thread.on("message", (message: WorkerReply) => {
        if (message.type === "ready") resolve();
        else if (message.type === "result" && this.current?.id === message.id) {
          const error = message.error
            ? Object.assign(new Error(message.error.message), {
                name: message.error.name,
                code: message.error.code,
              })
            : undefined;
          this.current.finish(error, message.result, message.remaining);
        } else if (
          message.type === "query" &&
          this.current?.id === message.id
        ) {
          const job = this.current;
          const read = job.inRequest(() =>
            boundedDatabase(job.scope.db, job.scope.signal, {
              readOnly: true,
            }).query(message.sql, message.parameters, message.options),
          );
          void read
            .then(
              ({ rows, jsonColumns }) => {
                if (this.current === job)
                  thread.postMessage({
                    type: "query-result",
                    id: job.id,
                    query: message.query,
                    result: { rows, jsonColumns },
                  });
              },
              (error: unknown) => {
                if (this.current === job)
                  thread.postMessage({
                    type: "query-result",
                    id: job.id,
                    query: message.query,
                    error: calculationError(error),
                  });
              },
            )
            .catch(() => {
              void thread.terminate();
            });
        }
      });
      const failed = () => {
        const error = new Error("calculation_worker_unavailable");
        reject(error);
        if (this.thread !== thread) return;
        this.thread = undefined;
        this.current?.finish(error);
      };
      thread.on("error", failed);
      thread.on("exit", failed);
    });
    return this.ready;
  }

  async call<K extends CalculationMethod>(
    method: K,
    input: unknown,
    scope: CalculationScope,
    options?: unknown,
  ): Promise<Results[K]> {
    scope.signal.throwIfAborted();
    await this.start();
    scope.signal.throwIfAborted();
    if (this.current) throw new Error("calculation_worker_busy");
    const thread = this.thread;
    if (!thread || this.closed)
      throw new Error("calculation_worker_unavailable");
    return new Promise<Results[K]>((resolve, reject) => {
      const id = ++this.sequence;
      let grace: ReturnType<typeof setTimeout> | undefined;
      const abort = () => {
        thread.postMessage({ type: "cancel", id });
        grace = setTimeout(() => {
          void thread.terminate();
        }, 1000);
        grace.unref();
      };
      const job: Active = {
        id,
        scope,
        inRequest: AsyncLocalStorage.snapshot(),
        finish: (error, result, remaining) => {
          if (this.current !== job) return;
          this.current = undefined;
          scope.signal.removeEventListener("abort", abort);
          if (grace) clearTimeout(grace);
          if (
            scope.budget &&
            typeof remaining === "number" &&
            Number.isSafeInteger(remaining) &&
            remaining >= 0 &&
            remaining <= 10_000
          )
            scope.budget.remainingOffers = remaining;
          if (scope.signal.aborted) reject(scope.signal.reason);
          else if (error) reject(error);
          else resolve(result as Results[K]);
        },
      };
      this.current = job;
      scope.signal.addEventListener("abort", abort, { once: true });
      try {
        thread.postMessage({
          type: "calculate",
          id,
          method,
          input,
          options,
          remaining: scope.budget?.remainingOffers,
        });
      } catch {
        job.finish(new Error("calculation_worker_input_invalid"));
      }
    });
  }

  async close() {
    this.closed = true;
    this.current?.finish(new Error("calculation_worker_closed"));
    const thread = this.thread;
    this.thread = undefined;
    await thread?.terminate();
  }
}
