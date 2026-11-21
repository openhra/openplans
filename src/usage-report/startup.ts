import type { CoreConfig } from "../config/index.js";

export const USAGE_REPORT_DOC = "docs/usage-report.md";

/** The URL as shown in logs and `show`: scheme, host and path only. */
export function displayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "invalid";
  }
}

export function startupLine(config: Pick<CoreConfig, "usageReport">): string {
  return config.usageReport.enabled
    ? `usage report: on; daily to ${displayUrl(config.usageReport.url)}; see ${USAGE_REPORT_DOC}`
    : `usage report: off (see ${USAGE_REPORT_DOC})`;
}

/**
 * Called once when the API starts. Logs the one line, always. While the report is off it
 * registers no timer, loads no sender module and touches no table. The scheduled send arrives
 * with the sender.
 */
export function startUsageReport(
  config: Pick<CoreConfig, "usageReport">,
  log: (line: string) => void = (line) => console.log(line),
): void {
  log(startupLine(config));
}
