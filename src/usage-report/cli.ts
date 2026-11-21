import type { CoreConfig } from "../config/index.js";
import type { Database } from "../db/database.js";
import type { WorkerOutput } from "../worker/commands.js";
import { loadSender } from "./lazy.js";
import { buildUsageReport } from "./build.js";
import { gatherUsageReportFacts } from "./facts.js";
import { resetUsageReportState } from "./state.js";
import { displayUrl } from "./startup.js";

export const USAGE_REPORT_USAGE =
  "Usage: worker usage-report show | send --dry-run | reset";

/**
 * `worker usage-report show|send --dry-run|reset`. With the report off, `show` and `send
 * --dry-run` never open the database. With it on they only read. Only `reset` writes.
 */
export async function runUsageReport(
  args: string[],
  config: CoreConfig,
  openDatabase: () => Database,
  output: WorkerOutput,
): Promise<number> {
  const [command, ...rest] = args;
  const ok =
    (command === "show" && rest.length === 0) ||
    (command === "reset" && rest.length === 0) ||
    (command === "send" && rest.length === 1 && rest[0] === "--dry-run");
  if (!ok) {
    output.error(
      command === "send" && rest.length === 0
        ? "usage-report send without --dry-run is not available in this build"
        : USAGE_REPORT_USAGE,
    );
    return 1;
  }
  const on = config.usageReport.enabled;
  let db: Database | null = null;
  try {
    if (command === "reset" || on) {
      try {
        db = openDatabase();
      } catch {
        db = null;
      }
    }
    if (command === "reset") {
      if (!db) {
        output.error("usage-report reset failed; check database connectivity");
        return 1;
      }
      output.out(
        (await resetUsageReportState(db))
          ? "usage report: state cleared"
          : "usage report: no state to clear",
      );
      return 0;
    }
    const { facts, state } = await gatherUsageReportFacts({ config, db });
    // The sender module loads for `send` only, never for `show` or at start.
    const body =
      command === "send"
        ? (await loadSender()).prepareUsageReport(facts).body
        : JSON.stringify(buildUsageReport(facts));
    const last =
      state?.lastSentDay == null
        ? "never"
        : `${state.lastSentDay} (status ${state.lastStatus ?? "unknown"})`;
    if (command === "show")
      output.out(
        [
          `state: ${on ? "on" : "off"}`,
          `url: ${displayUrl(config.usageReport.url)}`,
          `install id: ${facts.installId ? "present" : "none"}`,
          `last send: ${last}`,
          `next send: ${on ? "daily after start" : "none (off)"}`,
        ].join("\n"),
      );
    else output.out("dry run: nothing is sent");
    output.out(`payload (${Buffer.byteLength(body)} bytes):`);
    output.out(body);
    return 0;
  } catch {
    output.error(`usage-report ${command} failed`);
    return 1;
  } finally {
    try {
      await db?.close();
    } catch {
      output.error("worker database shutdown failed");
    }
  }
}
