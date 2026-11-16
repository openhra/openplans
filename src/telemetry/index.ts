import { setOperatorTelemetryReader } from "../plugins/operator-host.js";
import { activeRecorder, createRecorder, useRecorder } from "./observer.js";
import { currentReader } from "./read.js";

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
