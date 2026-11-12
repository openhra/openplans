import { readFile } from "node:fs/promises";
import {
  admissionManifestSchema,
  observedHostHolds,
} from "../fetch/admission.js";
import type { PublisherPolicy } from "../fetch/admission.js";

/** Same merge as AdmissionSession: a later manifest's entry replaces an earlier one per host. */
export async function readPublishers(
  paths: readonly string[],
): Promise<Map<string, PublisherPolicy> | undefined> {
  const publishers = new Map<string, PublisherPolicy>();
  try {
    for (const path of paths) {
      const manifest = admissionManifestSchema.parse(
        JSON.parse(await readFile(path, "utf8")),
      );
      for (const publisher of manifest.publishers)
        publishers.set(publisher.host, publisher);
    }
  } catch {
    return undefined;
  }
  return publishers;
}

/** Why a host may not be collected from, as a short code and the admission layer's own text. */
export interface HostRefusal {
  code: string;
  message: string;
}

/**
 * Mirrors the host-level part of AdmissionSession.assertCurrent without a request: observed
 * holds, manifest state and terms review. Paths, egress and keys are still checked per URL.
 */
export function hostRefusal(
  host: string,
  publishers: Map<string, PublisherPolicy> | undefined,
  now: number,
): HostRefusal | undefined {
  if (!publishers)
    return {
      code: "manifest_unreadable",
      message: "Reviewed access manifest is unreadable",
    };
  if (observedHostHolds.some((entry) => entry.host === host))
    return {
      code: "observed_hold",
      message: "Publisher has an observed access restriction",
    };
  const publisher = publishers.get(host);
  if (!publisher)
    return {
      code: "unknown",
      message:
        "Publisher host is not in a reviewed access manifest; add an operator manifest entry to collect from it",
    };
  if (publisher.state !== "allowed")
    return {
      code: publisher.state,
      message: `Publisher host is held by its reviewed manifest (${publisher.state})`,
    };
  const terms = publisher.terms;
  if (
    terms?.disposition !== "allowed" ||
    Date.parse(terms.reviewedAt) > now ||
    Date.parse(terms.expiresAt) <= now
  )
    return {
      code: "terms_expired",
      message: "Publisher terms review is missing or expired",
    };
  return undefined;
}
