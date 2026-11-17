import type { TelemetryFlusher } from "./flush.js";

export function scheduleFlush(
  flusher: Pick<TelemetryFlusher, "flush">,
  intervalMs = 60_000,
) {
  if (
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 5000 ||
    intervalMs > 300_000
  )
    throw new Error("Invalid telemetry interval");
  let stopped = false;
  const flushNow = async () => {
    try {
      await flusher.flush();
    } catch {
      /* Disposable telemetry: retry at the next interval. */
    }
  };
  const timer = setInterval(() => {
    if (!stopped) void flushNow();
  }, intervalMs);
  timer.unref();
  return {
    flushNow,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      await flushNow();
      // A concurrent flush may have captured an earlier snapshot; drain the final one.
      await flushNow();
    },
  };
}
