import { ReadError } from "../services/errors.js";
import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { SqlSession } from "../db/database.js";
import { DEADLINE_MS } from "../db/bounded.js";
import { loadConfig } from "../config/index.js";
import {
  CensusError,
  censusRows,
  ichraAffordabilityBatch,
} from "../services/ichra-batch.js";
import type { QuoteOptions } from "./quotes.js";

export interface TpaOptions {
  enabled: boolean;
  /** Operator attestation that this installation has private ingress and no body capture. */
  privateIngress: boolean;
}
const PATH = "/ichra/affordability/batch";
const MAX_BODY_BYTES = 65_536;
const EMPLOYEES_PER_MINUTE = 30;
let activeProcess = 0;

async function censusBody(
  request: Request,
  signal: AbortSignal,
): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new CensusError("INVALID_JSON");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        cancel();
        throw new CensusError("REQUEST_TOO_LARGE");
      }
      chunks.push(part.value);
    }
    signal.throwIfAborted();
    try {
      return JSON.parse(Buffer.concat(chunks).toString()) as unknown;
    } catch {
      throw new CensusError("INVALID_JSON");
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

export function ichraBatchRoutes(
  db: SqlSession,
  options: QuoteOptions & { tpa?: TpaOptions },
) {
  const app = new Hono();
  const tpa = options.tpa ?? loadConfig().tpa;
  let activeOperator = 0;
  let used = 0;
  let until = 0;
  const now = options.now ?? Date.now;
  app.use(PATH, async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (!tpa.enabled) return c.notFound();
    if (!tpa.privateIngress || !options.premiumToken)
      return c.json({ error: { code: "TPA_ACCESS_NOT_CONFIGURED" } }, 503);
    const hash = (value: string) => createHash("sha256").update(value).digest();
    if (
      !timingSafeEqual(
        hash(c.req.header("authorization") ?? ""),
        hash(`Bearer ${options.premiumToken}`),
      )
    )
      return c.json({ error: { code: "UNAUTHORIZED" } }, 401);
    if (activeOperator >= 2 || activeProcess >= 4) {
      c.header("Retry-After", "1");
      return c.json({ error: { code: "RATE_LIMITED" } }, 429);
    }
    activeOperator++;
    activeProcess++;
    try {
      await next();
    } finally {
      activeOperator--;
      activeProcess--;
    }
  });
  app.post(PATH, async (c) => {
    const signal = AbortSignal.any([
      c.req.raw.signal,
      AbortSignal.timeout(DEADLINE_MS),
    ]);
    let aborted: (() => void) | undefined;
    try {
      const work = async () => {
        const body = await censusBody(c.req.raw, signal);
        signal.throwIfAborted();
        const rows = censusRows(body);
        const time = now();
        if (time >= until) {
          used = 0;
          until = time + 60_000;
        }
        if (used + rows.length > EMPLOYEES_PER_MINUTE) {
          c.header(
            "Retry-After",
            String(Math.max(1, Math.ceil((until - time) / 1000))),
          );
          return c.json({ error: { code: "RATE_LIMITED" } }, 429);
        }
        used += rows.length;
        return c.json(await ichraAffordabilityBatch(db, rows, signal));
      };
      return await Promise.race([
        work(),
        new Promise<never>((_resolve, reject) => {
          aborted = () => reject(new CensusError("REQUEST_DEADLINE"));
          signal.addEventListener("abort", aborted, { once: true });
          if (signal.aborted) aborted();
        }),
      ]);
    } catch (error) {
      if (signal.aborted)
        return c.json({ error: { code: "REQUEST_DEADLINE" } }, 504);
      if (
        error instanceof ReadError &&
        ["not_loaded", "data_policy_unavailable"].includes(error.error.code)
      )
        return c.json(
          { error: error.error },
          error.error.code === "not_loaded" ? 404 : 503,
        );
      if (error instanceof CensusError)
        return c.json(
          { error: { code: error.code } },
          error.code === "GENERATION_CHANGED" ? 503 : 400,
        );
      // Do not fingerprint exceptions: messages and stacks may contain sensitive inputs.
      return c.json({ error: { code: "BATCH_READ_FAILED" } }, 503);
    } finally {
      if (aborted) signal.removeEventListener("abort", aborted);
    }
  });
  return app;
}
