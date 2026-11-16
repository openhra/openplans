import type { AdminPageDependencies } from "./contracts.js";
import { registerConfiguration } from "./configuration/index.js";
import { registerCoverage } from "./coverage/index.js";
import { registerMetrics } from "./metrics/index.js";
import { registerEvidence } from "./evidence/index.js";
import { registerCustomizations } from "./customizations/index.js";

export function registerAdminPages(dependencies: AdminPageDependencies): void {
  registerConfiguration(dependencies);
  registerCoverage(dependencies);
  registerMetrics(dependencies);
  registerEvidence(dependencies);
  registerCustomizations(dependencies);
}
