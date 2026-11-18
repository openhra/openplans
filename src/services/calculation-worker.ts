import { calculationError } from "./calculation-executor.js";
import { parentPort } from "node:worker_threads";
import type { CalculationScope } from "@openplans/plugin-sdk";
import type { SqlSession } from "../db/database.js";
import type { WorkerRequest } from "./calculation-executor.js";
import {
  createCalculationHost,
  MAX_CALCULATION_OFFERS,
} from "../plugins/calculation-host.js";
import { loadConfig } from "../config/index.js";

const port = parentPort;
if (!port) throw new Error("Calculation worker requires a parent");
const host = createCalculationHost(loadConfig());
let active: { id: number; controller: AbortController } | undefined;
let sequence = 0;
const pending = new Map<
  number,
  { id: number; resolve(value: unknown): void; reject(error: Error): void }
>();
const reader: SqlSession = {
  query<Row extends Record<string, unknown>>(
    sql: string,
    parameters?: unknown[],
    options?: Parameters<SqlSession["query"]>[2],
  ) {
    if (!active) return Promise.reject(new Error("calculation_scope_missing"));
    const id = active.id;
    const query = ++sequence;
    return new Promise<{ rows: Row[] }>((resolve, reject) => {
      pending.set(query, {
        id,
        resolve: (value) => {
          try {
            const result = value as { rows: Row[]; jsonColumns?: string[] };
            // The database driver leaves JSON untouched; decoding and allocation stay here.
            for (const row of result.rows)
              for (const column of result.jsonColumns ?? [])
                if (typeof row[column] === "string")
                  (row as Record<string, unknown>)[column] = JSON.parse(
                    row[column],
                  );
            resolve({ rows: result.rows });
          } catch (error) {
            reject(error);
          }
        },
        reject,
      });
      port.postMessage({
        type: "query",
        id,
        query,
        sql,
        parameters,
        options: { ...options, jsonAsText: true },
      });
    });
  },
  async exec() {
    throw new Error("calculation_read_only");
  },
};
port.on("message", (message: WorkerRequest) => {
  if (message.type === "query-result") {
    const waiting = pending.get(message.query);
    if (!waiting || waiting.id !== message.id) return;
    pending.delete(message.query);
    if (message.error)
      waiting.reject(
        Object.assign(new Error(message.error.message), {
          name: message.error.name,
          code: message.error.code,
        }),
      );
    else waiting.resolve(message.result);
  } else if (message.type === "cancel" && active?.id === message.id) {
    active.controller.abort(new Error("calculation_cancelled"));
  } else if (message.type === "calculate") {
    if (active) {
      port.postMessage({
        type: "result",
        id: message.id,
        error: { name: "Error", message: "calculation_worker_busy" },
      });
      return;
    }
    const controller = new AbortController();
    active = { id: message.id, controller };
    const scope: CalculationScope = {
      db: reader,
      signal: controller.signal,
      budget: { remainingOffers: message.remaining ?? MAX_CALCULATION_OFFERS },
    };
    void (async () => {
      try {
        if (!Object.hasOwn(host, message.method))
          throw new Error("calculation_method_invalid");
        const calculate = host[message.method] as (
          input: unknown,
          scope: CalculationScope,
          options?: unknown,
        ) => Promise<unknown>;
        if (typeof calculate !== "function")
          throw new Error("calculation_method_invalid");
        const result = await calculate(message.input, scope, message.options);
        port.postMessage({
          type: "result",
          id: message.id,
          result,
          remaining: scope.budget!.remainingOffers,
        });
      } catch (error) {
        port.postMessage({
          type: "result",
          id: message.id,
          error: calculationError(error),
          remaining: scope.budget!.remainingOffers,
        });
      } finally {
        for (const [query, waiting] of pending)
          if (waiting.id === message.id) {
            pending.delete(query);
            waiting.reject(new Error("calculation_finished"));
          }
        active = undefined;
      }
    })();
  }
});
port.postMessage({ type: "ready" });
