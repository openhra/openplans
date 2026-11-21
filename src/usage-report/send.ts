import { createHash } from "node:crypto";
import { buildUsageReport } from "./build.js";
import type { UsageReportFacts } from "./build.js";
import type { UsageReport } from "./schema.js";

/** A report built, validated and serialised exactly as it would be sent. */
export interface PreparedReport {
  readonly report: UsageReport;
  readonly body: string;
  readonly bytes: number;
  readonly sha256: string;
}

/**
 * The sender module. It is loaded only by `usage-report send`, never at start while the report
 * is off. It holds no delivery code yet; this step builds and checks the body.
 */
export function prepareUsageReport(facts: UsageReportFacts): PreparedReport {
  const report = buildUsageReport(facts);
  const body = JSON.stringify(report);
  return {
    report,
    body,
    bytes: Buffer.byteLength(body),
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}
