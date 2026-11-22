import type { AcquiredFile } from "@openplans/plugin-sdk";

/**
 * The approval that admitted the file's host, from the fetch receipt the core stored with the
 * snapshot: `owner-env:<SLUG>` for a terms-restricted host the operator approved by variable, else
 * null. The value is written beside the document and served with every answer the document backs.
 */
export function approvalBasisOf(file: AcquiredFile): string | null {
  let host: string;
  try {
    host = new URL(file.url).hostname;
  } catch {
    return null;
  }
  const entry = file.metadata.access_policy?.hosts.find(
    (candidate) => candidate.host === host,
  );
  return typeof entry?.approvalBasis === "string" ? entry.approvalBasis : null;
}
