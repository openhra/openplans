import { readFile } from "node:fs/promises";
import { BlobError } from "./store.js";

interface ManifestHost {
  host?: unknown;
  state?: unknown;
  terms?: { disposition?: unknown; reviewedAt?: unknown; expiresAt?: unknown };
}

/**
 * The endpoint host must have an `allowed` entry with a current, allowed terms review in the
 * operator manifest (`OPENPLANS_ACCESS_MANIFEST`). The shipped manifests list publishers only,
 * so a storage host is never admitted by them.
 */
export async function assertEndpointAdmitted(
  host: string,
  operatorManifest: string | undefined,
  now: number = Date.now(),
): Promise<void> {
  if (!operatorManifest)
    throw new BlobError(
      "endpoint_not_admitted",
      "The S3 endpoint host needs an entry in the operator access manifest, and none is configured",
    );
  let publishers: ManifestHost[];
  try {
    const manifest = JSON.parse(await readFile(operatorManifest, "utf8")) as {
      publishers?: unknown;
    };
    if (!Array.isArray(manifest.publishers)) throw new Error("no publishers");
    publishers = manifest.publishers as ManifestHost[];
  } catch {
    throw new BlobError(
      "endpoint_not_admitted",
      "The operator access manifest is unreadable",
    );
  }
  const entry = publishers.find((publisher) => publisher?.host === host);
  const terms = entry?.terms;
  if (
    !entry ||
    entry.state !== "allowed" ||
    terms?.disposition !== "allowed" ||
    typeof terms.reviewedAt !== "string" ||
    typeof terms.expiresAt !== "string" ||
    !(Date.parse(terms.reviewedAt) <= now) ||
    !(Date.parse(terms.expiresAt) > now)
  )
    throw new BlobError(
      "endpoint_not_admitted",
      "The S3 endpoint host has no allowed, current entry in the operator access manifest",
    );
}
