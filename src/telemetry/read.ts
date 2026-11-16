import type { OperatorHost } from "@openplans/plugin-sdk";
import type { Aggregate } from "./aggregate.js";

export function currentReader(
  aggregate: Aggregate,
): NonNullable<OperatorHost["telemetry"]> {
  return {
    async read(input, scope) {
      const observedAt = new Date().toISOString();
      if (scope.signal.aborted)
        return { state: "unavailable", reason: "deadline", observedAt };
      if (input.window !== "current_process")
        return { state: "unavailable", reason: "not_collected", observedAt };
      return { state: "available", value: aggregate.snapshot(), observedAt };
    },
  };
}
