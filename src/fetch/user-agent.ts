import { applicationVersion } from "../mcp/version.js";

/** The one outbound identity: the package.json version is read once at module load. */
export function userAgent(project: string): string {
  return `openplans/${applicationVersion} (public health-plan source discovery; +${project})`;
}
