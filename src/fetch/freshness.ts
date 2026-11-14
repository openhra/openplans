import { readFileSync } from "node:fs";
import {
  AdmissionSession,
  admissionManifestSchema,
  assertObservedHostAllowed,
  permitsPath,
} from "./admission.js";
import type { PublisherPolicy } from "./admission.js";
import { FetchError } from "./errors.js";
import { fetchTransient } from "./transient.js";
import type { TransientFetchOptions } from "./transient.js";

/**
 * Read-only publisher freshness check. For each target it either sends one HEAD request (an
 * archive: Last-Modified, ETag, Content-Length) or reads one small index page and lists the file
 * names it links. It never downloads an archive and writes nothing but the shared host leases.
 * A target whose host is held, missing from every manifest or outside the permitted paths gets
 * no request at all and reports `unknown`.
 */
export interface FreshnessTarget {
  /** Source family, for example `cms-exchange-puf:2026` or `cms-nppes`. */
  family: string;
  url: string;
  /** `head` for an archive, `index` for a small listing page. */
  mode: "head" | "index";
  /** For `index`: a regular expression whose matches name the published files. */
  match?: string;
  /** What the running instance loaded, when known. */
  loaded?: { lastModified?: string; names?: string[] };
  /**
   * For `index`: what the instance serves. Listing pages keep older years and files the instance
   * leaves out on purpose. The result still lists such names, but `behind` ignores them.
   */
  served?: {
    /** A name that carries a four-digit year counts only when one of its years is listed here. */
    years?: number[];
    /** A name that matches this pattern is out of scope, for example a state left out on purpose. */
    exclude?: string;
  };
}

export type FreshnessDecision =
  | { action: "check"; host: string }
  | {
      action: "skip";
      reason: "held" | "not_admitted" | "over_session_cap" | "invalid_target";
      detail: string;
    };

export interface FreshnessResult {
  family: string;
  url: string;
  mode: FreshnessTarget["mode"];
  status: "checked" | "unknown";
  reason?: string;
  lastModified?: string;
  etag?: string;
  contentLength?: string;
  contentType?: string;
  names?: string[];
  /** How many of `names` fall outside the target's `served` years or scope and were not compared. */
  outOfScope?: number;
  /** `yes` or `no` only when both the loaded and the published side are known. */
  behind: "yes" | "no" | "unknown";
}

/** Archives are checked by HEAD only; an index read must not name an archive. */
const archivePath = /\.(?:zip|csv|txt|xlsx?|gz|json|pdf)$/i;
/** Requests kept back from each host's per-session cap for robots, terms and redirects. */
export const policyHeadroom = 4;

/** Load manifests in order; a later entry replaces an earlier one for the same host. */
export function loadPublishers(
  paths: readonly string[],
): Map<string, PublisherPolicy> {
  const publishers = new Map<string, PublisherPolicy>();
  for (const path of paths)
    for (const publisher of admissionManifestSchema.parse(
      JSON.parse(readFileSync(path, "utf8")),
    ).publishers)
      publishers.set(publisher.host, publisher);
  return publishers;
}

/**
 * Decide, without any network access, which targets may be checked. Held hosts, hosts no
 * manifest names, expired terms, paths outside `permittedPaths`, index reads of an archive and
 * requests beyond a host's session cap are skipped.
 */
export function planFreshness(
  targets: readonly FreshnessTarget[],
  publishers: ReadonlyMap<string, PublisherPolicy>,
  now = Date.now(),
): FreshnessDecision[] {
  const planned = new Map<string, number>();
  return targets.map((target): FreshnessDecision => {
    let url: URL;
    try {
      url = new URL(target.url);
    } catch {
      return { action: "skip", reason: "invalid_target", detail: "bad URL" };
    }
    if (url.protocol !== "https:" || url.search || url.username)
      return {
        action: "skip",
        reason: "invalid_target",
        detail: "only plain HTTPS URLs without query values",
      };
    for (const pattern of [target.match, target.served?.exclude])
      try {
        if (pattern !== undefined) new RegExp(pattern);
      } catch {
        return {
          action: "skip",
          reason: "invalid_target",
          detail: "a name pattern is not a valid regular expression",
        };
      }
    if (target.mode === "index" && archivePath.test(url.pathname))
      return {
        action: "skip",
        reason: "invalid_target",
        detail: "an archive is checked with HEAD, never read",
      };
    try {
      assertObservedHostAllowed(url);
    } catch {
      return { action: "skip", reason: "held", detail: "observed host hold" };
    }
    const publisher = publishers.get(url.hostname);
    if (!publisher)
      return {
        action: "skip",
        reason: "not_admitted",
        detail: "host is in no reviewed access manifest",
      };
    if (publisher.state !== "allowed")
      return { action: "skip", reason: "held", detail: publisher.state };
    const terms = publisher.terms;
    if (
      terms?.disposition !== "allowed" ||
      Date.parse(terms.reviewedAt) > now ||
      Date.parse(terms.expiresAt) <= now
    )
      return {
        action: "skip",
        reason: "held",
        detail: "terms review missing or expired",
      };
    if (!permitsPath(publisher, url))
      return {
        action: "skip",
        reason: "not_admitted",
        detail: "path is outside the reviewed permitted paths",
      };
    const count = (planned.get(url.hostname) ?? 0) + 1;
    if (count > publisher.jobCaps.maxRequests - policyHeadroom)
      return {
        action: "skip",
        reason: "over_session_cap",
        detail: "run this family in its own job",
      };
    planned.set(url.hostname, count);
    return { action: "check", host: url.hostname };
  });
}

/** Four-digit years in a file name; `202609` or `110226` are dates, not years. */
const yearPattern = /(?<![0-9])(?:19|20)[0-9]{2}(?![0-9])/g;

/** Whether a listed name falls inside the years and scope the instance serves. */
export function servedName(target: FreshnessTarget, name: string): boolean {
  const served = target.served;
  if (!served) return true;
  if (served.exclude && new RegExp(served.exclude).test(name)) return false;
  const years = name.match(yearPattern)?.map(Number) ?? [];
  if (served.years && years.length)
    return years.some((year) => served.years!.includes(year));
  return true;
}

function behind(
  target: FreshnessTarget,
  result: Pick<FreshnessResult, "lastModified" | "names">,
): FreshnessResult["behind"] {
  if (target.mode === "head") {
    const loaded = Date.parse(target.loaded?.lastModified ?? "");
    const published = Date.parse(result.lastModified ?? "");
    if (Number.isNaN(loaded) || Number.isNaN(published)) return "unknown";
    return published > loaded ? "yes" : "no";
  }
  if (!target.loaded?.names || !result.names?.length) return "unknown";
  const loaded = new Set(target.loaded.names);
  const compared = result.names.filter((name) => servedName(target, name));
  // A page that lists nothing the instance serves has changed shape; say so instead of "no".
  if (!compared.length) return "unknown";
  return compared.some((name) => !loaded.has(name)) ? "yes" : "no";
}

export interface FreshnessOptions extends Pick<
  TransientFetchOptions,
  "dataDir" | "lookup" | "transport" | "projectUrl" | "sleep" | "random"
> {
  manifests: readonly string[];
  egressCountry?: string;
  now?: number;
}

/** Plan, then check the admitted targets one at a time in one admission session. */
export async function checkFreshness(
  targets: readonly FreshnessTarget[],
  options: FreshnessOptions,
): Promise<FreshnessResult[]> {
  const publishers = loadPublishers(options.manifests);
  const plan = planFreshness(targets, publishers, options.now);
  const hosts = [
    ...new Set(
      plan.flatMap((decision) =>
        decision.action === "check" ? [decision.host] : [],
      ),
    ),
  ];
  const admission = hosts.length
    ? new AdmissionSession(
        options.manifests,
        { maxRequests: 200, maxTransferBytes: 32 * 1024 ** 2 },
        { egressCountry: options.egressCountry },
      )
    : undefined;
  const results: FreshnessResult[] = [];
  for (const [index, target] of targets.entries()) {
    const decision = plan[index]!;
    const base = { family: target.family, url: target.url, mode: target.mode };
    if (decision.action === "skip") {
      results.push({
        ...base,
        status: "unknown",
        reason: `${decision.reason}: ${decision.detail}`,
        behind: "unknown",
      });
      continue;
    }
    if (admission!.isStopped) {
      results.push({
        ...base,
        status: "unknown",
        reason: "session stopped after an earlier refusal",
        behind: "unknown",
      });
      continue;
    }
    try {
      const fetched = await fetchTransient(target.url, {
        admission,
        allowHosts: hosts,
        dataDir: options.dataDir,
        lookup: options.lookup,
        transport: options.transport,
        projectUrl: options.projectUrl,
        sleep: options.sleep,
        random: options.random,
        maxAttempts: 2,
        deadlineMs: 120_000,
        ...(target.mode === "head"
          ? { headOnly: true }
          : { maxBytes: 2 * 1024 ** 2, expectedContent: "binary" as const }),
      });
      const found =
        target.mode === "index" && target.match
          ? [
              ...new Set(
                fetched.body
                  .toString("utf8")
                  .match(new RegExp(target.match, "g")) ?? [],
              ),
            ].sort()
          : undefined;
      const outOfScope = found?.filter(
        (name) => !servedName(target, name),
      ).length;
      const checked = {
        ...fetched.validators,
        ...(found && { names: found }),
        ...(outOfScope && { outOfScope }),
      };
      results.push({
        ...base,
        status: "checked",
        ...checked,
        behind: behind(target, checked),
      });
    } catch (error) {
      results.push({
        ...base,
        status: "unknown",
        reason:
          error instanceof FetchError
            ? `${error.code}${error.status ? ` ${error.status}` : ""}: ${error.message}`
            : "check failed",
        behind: "unknown",
      });
    }
  }
  return results;
}
