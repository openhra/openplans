import { currentEnvironment } from "../config/index.js";
import type { Database } from "../db/database.js";
import { createFlusher } from "./flush.js";
import { scheduleFlush } from "./schedule.js";
import { setOperatorTelemetryReader } from "../plugins/operator-host.js";
import { activeRecorder, createRecorder, useRecorder } from "./observer.js";
import { currentReader } from "./read.js";
import { loadConfig } from "../config/index.js";

/** Host opt-in before createApp, independent of admin. Disabled means no recorder, timers, SQL or buffers. */
export function configureTelemetry(options: {
  enabled: boolean;
  now?: () => number;
}): void {
  if (!options.enabled) {
    useRecorder(undefined);
    setOperatorTelemetryReader(undefined);
    return;
  }
  if (activeRecorder()) return;
  const recorder = createRecorder(options.now);
  useRecorder(recorder);
  setOperatorTelemetryReader(currentReader(recorder.aggregate));
}
export { activeRecorder } from "./observer.js";
export { currentReader } from "./read.js";

/** Production API only. Plugin admission precedes collection; this never installs tables. */
export function startTelemetry(options: {
  plugins: readonly { name: string }[];
  openDatabase: () => Database;
  env?: NodeJS.ProcessEnv;
}) {
  const enabled =
    loadConfig(options.env ?? currentEnvironment()).telemetry.enabled &&
    options.plugins.some((plugin) => plugin.name === "@openplans/plugin-admin");
  configureTelemetry({ enabled });
  if (!enabled) return undefined;
  let db: Database;
  try {
    db = options.openDatabase();
  } catch {
    configureTelemetry({ enabled: false });
    return undefined;
  }
  const aggregate = activeRecorder()!.aggregate;
  const flusher = createFlusher(db, aggregate);
  setOperatorTelemetryReader(currentReader(aggregate, flusher));
  const scheduler = scheduleFlush(flusher);
  let stopped = false;
  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      await scheduler.stop();
      flusher.detach();
      configureTelemetry({ enabled: false });
      await db.close();
    },
  };
}
