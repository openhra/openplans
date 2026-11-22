import { readFile } from "node:fs/promises";
import {
  admissionManifestSchema,
  observedHostHolds,
} from "../fetch/admission.js";
import type { PublisherPolicy } from "../fetch/admission.js";
import {
  publicGuardRefusal,
  resolveSiteApprovals,
  SITE_APPROVAL_VALUE,
  SiteApprovalError,
  slugOfApprovalEnv,
} from "../fetch/approvals.js";
import { loadConfig } from "../config/index.js";
import type { CoreConfig, Environment } from "../config/index.js";

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

/** The owner approvals a host check applies: the resolved slug set and the public guard. */
export interface HostApprovals {
  approved: ReadonlySet<string>;
  publicRefusal?: string;
}

/**
 * Approvals from the environment and the public guard from the config. A malformed approval
 * form approves nothing here; the API and worker report it at start and exit.
 */
export function hostApprovals(
  env?: Environment,
  config?: CoreConfig,
): HostApprovals {
  try {
    const approved = resolveSiteApprovals(env).approved;
    return {
      approved,
      publicRefusal: publicGuardRefusal(config ?? loadConfig(env), approved),
    };
  } catch (error) {
    if (error instanceof SiteApprovalError) return { approved: new Set() };
    throw error;
  }
}

/**
 * Mirrors the host-level part of AdmissionSession.assertCurrent without a request: observed
 * holds, manifest state, owner approval and terms review. Paths, egress and keys are still
 * checked per URL.
 */
export function hostRefusal(
  host: string,
  publishers: Map<string, PublisherPolicy> | undefined,
  now: number,
  approvals: HostApprovals = hostApprovals(),
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
  const env =
    publisher.approval?.kind === "owner-env"
      ? publisher.approval.env
      : undefined;
  if (publisher.state !== "allowed" && !env)
    return {
      code: publisher.state,
      message: `Publisher host is held by its reviewed manifest (${publisher.state})`,
    };
  if (env && !approvals.approved.has(slugOfApprovalEnv(env)))
    return {
      code: "approval_required",
      message: `Publisher host is held by its terms (${publisher.state}); set ${env}=${SITE_APPROVAL_VALUE} to collect from it under your own review of those terms`,
    };
  if (env && approvals.publicRefusal)
    return { code: "public_guard", message: approvals.publicRefusal };
  const terms = publisher.terms;
  if (
    terms?.disposition !== (env ? "restricted" : "allowed") ||
    Date.parse(terms.reviewedAt) > now ||
    Date.parse(terms.expiresAt) <= now
  )
    return {
      code: "terms_expired",
      message: "Publisher terms review is missing or expired",
    };
  return undefined;
}
