import { Hono } from "hono";
import type { CacheStoreFactory } from "@openplans/plugin-sdk";
import { loadConfig } from "../../config/index.js";
import type { SqlSession } from "../../db/database.js";
import { createResponseCache } from "./index.js";
import { MAX_ENTRY_BYTES } from "./resp.js";
import type { CacheStore } from "./store.js";

/** A cache store provider under test, with hooks that drive its clock and its backend. */
export interface CacheStoreSubject {
  factory: CacheStoreFactory;
  /** Passed to the factory; `maxBytes` defaults to 8 MiB. */
  settings?: { maxBytes?: number; url?: string };
  /** Moves the clock the store expires entries by. */
  advance(seconds: number): void | Promise<void>;
  /** Makes the backend unavailable. Omit for a store that cannot fail (in-process memory). */
  fail?(): void | Promise<void>;
  /** Bound for each store call; a call that takes longer fails the check. Default 5 000 ms. */
  timeoutMs?: number;
}
export type CacheStoreCheck =
  "ttl-expiry" | "byte-accounting" | "entry-bound" | "failure-bypass";
export interface CacheStoreResult {
  check: CacheStoreCheck;
  ok: boolean;
  detail: string;
}

class ContractFailure extends Error {}
const expect = (condition: boolean, detail: string) => {
  if (!condition) throw new ContractFailure(detail);
};

function bounded<T>(value: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    value,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new ContractFailure("store call exceeded its bound")),
        timeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

const validBytes = (store: CacheStore) => {
  const bytes = store.bytes();
  expect(
    Number.isSafeInteger(bytes) && bytes >= 0,
    "bytes() is not a non-negative integer",
  );
  return bytes;
};

/** Synthetic database: one fixed generation row, so the response cache can build keys. */
const generationOnly = {
  query: async () => ({ rows: [{ generation: "contract-generation" }] }),
  exec: async () => {},
} as unknown as SqlSession;

/**
 * Design 5.7 contract for cache store providers: TTL expiry, byte accounting, the 2 MiB entry
 * bound, and failure → bypass. Returns one result per check and never throws for a failed check.
 */
export async function checkCacheStore(
  subject: CacheStoreSubject,
): Promise<CacheStoreResult[]> {
  const timeoutMs = subject.timeoutMs ?? 5_000;
  const create = () =>
    subject.factory({
      maxBytes: subject.settings?.maxBytes ?? 8 * 1024 * 1024,
      url: subject.settings?.url,
    });
  const get = (store: CacheStore, key: string) =>
    bounded(store.get(key), timeoutMs);
  const set = (store: CacheStore, key: string, value: string, ttl: number) =>
    bounded(store.set(key, value, ttl), timeoutMs);

  const checks: [CacheStoreCheck, () => Promise<string>][] = [
    [
      "ttl-expiry",
      async () => {
        const store = create();
        await set(store, "contract:ttl", "fresh", 2);
        expect(
          (await get(store, "contract:ttl")) === "fresh",
          "a fresh entry was not returned",
        );
        await subject.advance(1);
        expect(
          (await get(store, "contract:ttl")) === "fresh",
          "an entry expired before its TTL",
        );
        await subject.advance(1.5);
        expect(
          (await get(store, "contract:ttl")) === null,
          "an entry outlived its TTL",
        );
        return "served within the TTL, absent after it";
      },
    ],
    [
      "byte-accounting",
      async () => {
        const store = create();
        const key = "contract:bytes";
        const value = "é雪 synthetic".repeat(16);
        const size = Buffer.byteLength(value);
        const before = validBytes(store);
        await set(store, key, value, 60);
        const stored = validBytes(store) - before;
        expect(
          stored >= size && stored <= size + Buffer.byteLength(key),
          "a write was not counted in UTF-8 bytes",
        );
        expect(
          (await get(store, key)) === value,
          "the stored value changed on the way back",
        );
        const read = validBytes(store) - before - stored;
        expect(
          read >= 0 && read <= size,
          "a read was not counted in UTF-8 bytes",
        );
        return "writes and reads counted in UTF-8 bytes";
      },
    ],
    [
      "entry-bound",
      async () => {
        const store = create();
        const largest = "x".repeat(MAX_ENTRY_BYTES);
        await set(store, "contract:largest", largest, 60);
        expect(
          (await get(store, "contract:largest")) === largest,
          "an entry of exactly 2 MiB did not round-trip",
        );
        const over = "y".repeat(MAX_ENTRY_BYTES + 1);
        await set(store, "contract:over", over, 60);
        const back = await get(store, "contract:over");
        expect(
          back === null || back === over,
          "an entry over 2 MiB came back altered",
        );
        return "2 MiB entries round-trip; larger entries never come back altered";
      },
    ],
    [
      "failure-bypass",
      async () => {
        if (!subject.fail) return "not applicable: the store cannot fail";
        const store = create();
        await subject.fail();
        const cache = createResponseCache(generationOnly, undefined, {
          store,
          config: loadConfig({}),
        });
        const app = new Hono();
        app.use("*", cache.middleware);
        app.get("/v1/plans", (c) => c.json({ synthetic: true }));
        const response = await bounded(
          Promise.resolve(app.request("/v1/plans")),
          timeoutMs * 3,
        );
        expect(response.status === 200, "a failing store changed the status");
        expect(
          response.headers.get("x-cache") === "bypass",
          "a failing store was not bypassed",
        );
        expect(
          (await response.text()) === '{"synthetic":true}',
          "a failing store changed the body",
        );
        const outcomes: string[] = [];
        const value = await bounded(
          cache.catalog(
            {
              namespace: "contract",
              version: "1",
              generation: "contract-generation",
              query: { synthetic: true },
              authorized: () => true,
              accept: (dto): dto is { synthetic: boolean } =>
                typeof dto === "object" && dto !== null,
              ttlSeconds: 60,
              outcome: (outcome) => outcomes.push(outcome),
            },
            async () => ({ synthetic: true }),
          ),
          timeoutMs * 3,
        );
        expect(
          value.synthetic === true && outcomes.join() === "bypass",
          "a failing store was not bypassed by catalog()",
        );
        return "responses and catalog answers served with X-Cache: bypass";
      },
    ],
  ];

  const results: CacheStoreResult[] = [];
  for (const [check, run] of checks) {
    try {
      results.push({ check, ok: true, detail: await run() });
    } catch (error) {
      results.push({
        check,
        ok: false,
        detail:
          error instanceof ContractFailure ? error.message : "the store threw",
      });
    }
  }
  return results;
}
