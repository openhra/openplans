import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FetchError } from "./errors.js";

const minimumIntervalMs = 5000;
const jitterMs = 1000;
const lockTimeoutMs = 60_000;
const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/** Shared by processes using the same external data directory. Abandoned locks fail closed. */
export async function leaseHost(
  dataDir: string,
  hostname: string,
  publishedDelayMs = 0,
  /** Lower floor for a reviewed keyed API (1000 ms); never below that. */
  floorMs = minimumIntervalMs,
): Promise<() => Promise<void>> {
  if (
    !Number.isFinite(publishedDelayMs) ||
    publishedDelayMs < 0 ||
    publishedDelayMs > 2 ** 31 - 1
  )
    throw new FetchError(
      "admission_denied",
      "Publisher delay exceeds supported pacing limits",
    );
  const directory = join(dataDir, "access", "hosts");
  await mkdir(directory, { recursive: true });
  const key = createHash("sha256").update(hostname.toLowerCase()).digest("hex");
  const lock = join(directory, `${key}.lock`);
  const schedule = join(directory, `${key}.json`);
  const started = Date.now();
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() - started >= lockTimeoutMs)
        throw new FetchError(
          "host_busy",
          "Publisher host lease is unavailable",
        );
      await sleep(100);
    }
  }
  try {
    let nextRequestAt = 0;
    const interval = Math.max(
      Math.max(1000, Math.min(floorMs, minimumIntervalMs)),
      publishedDelayMs,
    );
    try {
      const state: unknown = JSON.parse(await readFile(schedule, "utf8"));
      if (
        typeof state !== "object" ||
        state === null ||
        !("nextRequestAt" in state) ||
        typeof state.nextRequestAt !== "number" ||
        !Number.isFinite(state.nextRequestAt) ||
        !("lastRequestAt" in state) ||
        typeof state.lastRequestAt !== "number" ||
        !Number.isFinite(state.lastRequestAt)
      )
        throw new FetchError(
          "admission_denied",
          "Invalid publisher pacing state",
        );
      nextRequestAt = Math.max(
        state.nextRequestAt,
        state.lastRequestAt + interval,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    while (nextRequestAt > Date.now())
      await sleep(Math.min(60_000, nextRequestAt - Date.now()));
    const lastRequestAt = Date.now();
    await writeFile(
      schedule,
      JSON.stringify({
        lastRequestAt,
        nextRequestAt: lastRequestAt + interval + Math.random() * jitterMs,
      }),
    );
    return async () => {
      await rm(lock, { recursive: true });
    };
  } catch (error) {
    await rm(lock, { recursive: true });
    throw error;
  }
}
