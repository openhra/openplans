import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { currentEnvironment, loadConfig } from "../config/index.js";
import type { CoreConfig, Environment } from "../config/index.js";
import { shippedManifestPaths, siteRegistryPath } from "./shipped.js";

/**
 * Per-site source approval. A publisher whose terms restrict reuse ships in the manifests as
 * `terms-restricted` with `approval: { kind: "owner-env", env }`. It stays held until the operator
 * sets that variable to exactly `approved`, taking responsibility for the site's terms. Approval
 * changes nothing else: robots rules, a held robots response, challenge pages, pacing and caps
 * still apply, and no approval can bypass them.
 */
export const SITE_APPROVAL_PREFIX = "OPENPLANS_SITE_APPROVE_";
export const SITE_APPROVALS_LIST = "OPENPLANS_SITE_APPROVALS";
export const SITE_APPROVALS_FILE = "OPENPLANS_SITE_APPROVALS_FILE";
export const PUBLIC_RESTRICTED_SITES = "OPENPLANS_PUBLIC_RESTRICTED_SITES";
/** The only value that approves; `1`, `true`, `yes` and `on` leave the site held. */
export const SITE_APPROVAL_VALUE = "approved";
export const PUBLIC_RESTRICTED_SITES_VALUE = "allow";
export const siteSlugPattern = /^[A-Z][A-Z0-9_]{0,62}$/;
export const approvalEnvPattern =
  /^OPENPLANS_SITE_APPROVE_[A-Z][A-Z0-9_]{0,62}$/;

export const approvalEnvName = (slug: string): string =>
  `${SITE_APPROVAL_PREFIX}${slug}`;
export const approvalBasisOf = (slug: string): string => `owner-env:${slug}`;
/** The slug of an approval variable name, which the manifest schema has already validated. */
export const slugOfApprovalEnv = (env: string): string =>
  env.slice(SITE_APPROVAL_PREFIX.length);

export class SiteApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SiteApprovalError";
  }
}

export interface SiteApprovals {
  /** Slugs approved by any of the three forms. */
  approved: ReadonlySet<string>;
  /** Per-site variables set to something other than the exact value; those sites stay held. */
  heldValues: readonly { slug: string; env: string }[];
}

const slugList = (value: string, origin: string): string[] =>
  value
    .split(/[\s,]+/)
    .map((slug) => slug.trim())
    .filter(Boolean)
    .map((slug) => {
      if (!siteSlugPattern.test(slug))
        throw new SiteApprovalError(
          `${origin} names a site slug that is not upper-case letters, digits and underscores`,
        );
      return slug;
    });

/**
 * The approved slug set from the three forms, which are equivalent: `OPENPLANS_SITE_APPROVE_<SLUG>=approved`
 * per site, `OPENPLANS_SITE_APPROVALS=<SLUG>,<SLUG>`, and `OPENPLANS_SITE_APPROVALS_FILE` naming a
 * mounted file with one slug per line (`#` comments allowed). Values are never logged; the
 * resolved set is reported by slug.
 */
export function resolveSiteApprovals(
  env: Environment = currentEnvironment(),
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): SiteApprovals {
  const approved = new Set<string>();
  const heldValues: { slug: string; env: string }[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(SITE_APPROVAL_PREFIX)) continue;
    // Compose passes an empty value for a variable .env leaves out; empty is unset.
    if (value === undefined || value === "") continue;
    if (!approvalEnvPattern.test(name))
      throw new SiteApprovalError(
        `${name} is not a site approval variable: the slug must be upper-case letters, digits and underscores`,
      );
    const slug = slugOfApprovalEnv(name);
    if (value === SITE_APPROVAL_VALUE) approved.add(slug);
    else heldValues.push({ slug, env: name });
  }
  const config = loadConfig(env).access;
  for (const slug of slugList(config.siteApprovals ?? "", SITE_APPROVALS_LIST))
    approved.add(slug);
  const file = config.siteApprovalsFile;
  if (file) {
    if (!isAbsolute(file))
      throw new SiteApprovalError(
        `${SITE_APPROVALS_FILE} must be an absolute path`,
      );
    let text: string;
    try {
      text = read(file);
    } catch {
      throw new SiteApprovalError(
        `${SITE_APPROVALS_FILE} names a file that could not be read`,
      );
    }
    const lines = text
      .split("\n")
      .map((line) => line.replace(/#.*$/, ""))
      .join("\n");
    for (const slug of slugList(lines, SITE_APPROVALS_FILE)) approved.add(slug);
  }
  // A per-site variable with the wrong value does not cancel another form's approval of the same
  // slug, but it is still reported so the operator sees the variable to fix.
  return { approved, heldValues };
}

/** The manifests a host loads by default: the shipped ones, then the operator manifest. */
export function configuredManifestPaths(config: CoreConfig): readonly string[] {
  const operator = config.access.operatorManifest;
  return [...shippedManifestPaths(), ...(operator ? [operator] : [])];
}

/** Anonymous serving is on: any public switch (quoting, household, compat) is on. */
export const publicServing = (config: CoreConfig): boolean =>
  config.public.quoting || config.public.household || config.public.compat;

/**
 * The public guard: an installation that serves anonymous traffic refuses any owner-env approval
 * unless `OPENPLANS_PUBLIC_RESTRICTED_SITES=allow` says restricted-site data may be served there.
 * Returns the refusal message, or undefined when approvals may be used.
 */
export function publicGuardRefusal(
  config: CoreConfig,
  approved: ReadonlySet<string>,
): string | undefined {
  if (!approved.size || !publicServing(config)) return undefined;
  if (config.access.publicRestrictedSites) return undefined;
  return `Site approvals (${[...approved].sort().join(", ")}) are refused while anonymous serving is on; set ${PUBLIC_RESTRICTED_SITES}=${PUBLIC_RESTRICTED_SITES_VALUE} to serve restricted-site data from this installation, or turn the OPENPLANS_PUBLIC_* switches off`;
}

/** The shipped registry of site slugs: issuer, hosts and the variable that turns each on. */
export const siteRegistrySchema = z
  .object({
    version: z.literal(1),
    sites: z
      .array(
        z
          .object({
            slug: z.string().regex(siteSlugPattern),
            issuer: z.string().min(1),
            hosts: z.array(z.string().regex(/^[a-z0-9.-]+$/)).min(1),
            turnsOn: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((registry, context) => {
    const slugs = registry.sites.map((site) => site.slug);
    if (new Set(slugs).size !== slugs.length)
      context.addIssue({ code: "custom", message: "Duplicate site slug" });
    const hosts = registry.sites.flatMap((site) => site.hosts);
    if (new Set(hosts).size !== hosts.length)
      context.addIssue({ code: "custom", message: "Duplicate site host" });
  });
export type SiteRegistry = z.infer<typeof siteRegistrySchema>;

export function loadSiteRegistry(path = siteRegistryPath()): SiteRegistry {
  return siteRegistrySchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export interface SiteApprovalHost {
  host: string;
  slug: string;
  env: string;
  approved: boolean;
}
export interface SiteApprovalReport {
  approved: string[];
  held: { slug: string; env: string; hint: string }[];
  /** Owner-env entries of the loaded manifests, by host. */
  hosts: SiteApprovalHost[];
  /** Approved slugs that no loaded manifest entry names; nothing is collected for them. */
  withoutEntry: string[];
}

interface ManifestLike {
  publishers?: {
    host?: string;
    approval?: { kind?: string; env?: string };
  }[];
}

/**
 * What the approvals resolve to against the loaded manifests. Reads the manifest files as plain
 * JSON; a file the session will refuse anyway is skipped here.
 */
export function reportSiteApprovals(
  manifestPaths: readonly string[],
  approvals: SiteApprovals,
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): SiteApprovalReport {
  const hosts = new Map<string, SiteApprovalHost>();
  for (const path of manifestPaths) {
    let manifest: ManifestLike;
    try {
      manifest = JSON.parse(read(path)) as ManifestLike;
    } catch {
      continue;
    }
    for (const publisher of manifest.publishers ?? []) {
      if (typeof publisher?.host !== "string") continue;
      const approval = publisher.approval;
      if (
        approval?.kind !== "owner-env" ||
        typeof approval.env !== "string" ||
        !approvalEnvPattern.test(approval.env)
      ) {
        hosts.delete(publisher.host);
        continue;
      }
      const slug = slugOfApprovalEnv(approval.env);
      hosts.set(publisher.host, {
        host: publisher.host,
        slug,
        env: approval.env,
        approved: approvals.approved.has(slug),
      });
    }
  }
  const named = new Set([...hosts.values()].map((entry) => entry.slug));
  return {
    approved: [...approvals.approved].sort(),
    held: approvals.heldValues.map(({ slug, env }) => ({
      slug,
      env,
      hint: `set ${env}=${SITE_APPROVAL_VALUE} to approve this site; any other value leaves it held`,
    })),
    hosts: [...hosts.values()].sort((a, b) => a.host.localeCompare(b.host)),
    withoutEntry: [...approvals.approved]
      .filter((slug) => !named.has(slug))
      .sort(),
  };
}

/**
 * Startup: resolve the approvals, apply the public guard, and log the resolved set by slug (never
 * by value). Throws `SiteApprovalError` when a form is malformed or the public guard refuses;
 * the host then exits before serving or collecting anything.
 */
export function startSiteApprovals(
  config: CoreConfig,
  manifestPaths: readonly string[],
  log: (line: string) => void = (line) => console.error(line),
  env: Environment = currentEnvironment(),
): SiteApprovalReport {
  const approvals = resolveSiteApprovals(env);
  const refusal = publicGuardRefusal(config, approvals.approved);
  if (refusal) throw new SiteApprovalError(refusal);
  const report = reportSiteApprovals(manifestPaths, approvals);
  if (
    report.approved.length ||
    report.held.length ||
    report.hosts.length ||
    report.withoutEntry.length
  )
    log(JSON.stringify({ event: "site_approvals", ...report }));
  return report;
}
