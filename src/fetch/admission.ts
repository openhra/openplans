import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { assertEgressCurrent, egressFromEnvironment } from "./egress.js";
import type { EgressBinding, EgressReceipt } from "./egress.js";
import { FetchError } from "./errors.js";
import { checkedUrl } from "./policy.js";
import { parseRobots } from "./robots.js";
import type { RobotsPolicy } from "./robots.js";

const dailyRecheckMs = 24 * 60 * 60 * 1000;
/** RFC 9309 2.3.1.3, narrowed: only Not Found and Gone, received without a redirect, mean no robots rules. */
export const absentRobotsStatuses: readonly number[] = [404, 410];
/** Pacing floor for ordinary hosts, and for documented keyed APIs (`accessMode: "api-key"`). */
export const minimumDelayMs = 5000;
export const minimumApiKeyDelayMs = 1000;
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const countryCode = z.string().regex(/^[A-Z]{2}$/);
const robotsObservation = z
  .object({
    url: z.string().url(),
    status: z.number().int().min(100).max(599),
    sha256: sha256.nullable(),
    checkedAt: z.iso.datetime(),
    /** Egress country the observation was made from; required for an absent robots file. */
    country: countryCode.optional(),
    /**
     * Why robots does not apply: a keyed API answers every unauthenticated path, `/robots.txt`
     * included, with 401. Only valid with status 401 on an `accessMode: "api-key"` entry.
     */
    notApplicable: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((robots, context) => {
    const absent = absentRobotsStatuses.includes(robots.status);
    if (robots.notApplicable !== undefined && robots.status !== 401)
      context.addIssue({
        code: "custom",
        message: "Robots can be not applicable only for a recorded 401",
      });
    if (
      absent || robots.notApplicable !== undefined
        ? robots.sha256 !== null
        : robots.sha256 === null
    )
      context.addIssue({
        code: "custom",
        message: "Robots hash must be null exactly when the file is absent",
      });
    if (absent && !robots.country)
      context.addIssue({
        code: "custom",
        message:
          "An absent robots file needs the egress country it was seen from",
      });
  });
const httpsUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  });
export const accessState = z.enum([
  "allowed",
  "robots-disallowed",
  "terms-restricted",
  "bot-protected",
  "geo-restricted",
  "unknown",
]);
export type AccessState = z.infer<typeof accessState>;
const publisherSchema = z
  .object({
    host: z.string().regex(/^[a-z0-9.-]+$/),
    state: accessState,
    evidence: z
      .array(
        z
          .object({
            url: httpsUrl,
            observedAt: z.iso.datetime(),
            status: z.number().int().min(100).max(599),
            country: countryCode.optional(),
          })
          .strict(),
      )
      .min(1),
    scope: z
      .object({
        products: z.array(z.string().min(1)).min(1),
        states: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1),
        years: z.array(z.number().int().min(2000).max(2100)).min(1),
      })
      .strict(),
    discoveryUrls: z.array(httpsUrl).min(1),
    apiVersion: z.string().min(1).optional(),
    permittedPaths: z.array(z.string().startsWith("/")).min(1),
    delegates: z.array(z.string().regex(/^[a-z0-9.-]+$/)),
    attribution: z.string().min(1),
    updatePolicy: z.string().min(1),
    /**
     * `api-key`: a documented API that requires a key. Admission rests on the published API
     * documentation (the `terms` entry) because the host answers robots with 401. The key comes
     * from the environment variable named in `apiKey` and is added only to data requests.
     */
    accessMode: z.enum(["public", "api-key"]).optional(),
    apiKey: z
      .object({
        env: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
        queryParam: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
      })
      .strict()
      .optional(),
    /** At least 5000 ms; a keyed API entry may go down to 1000 ms. */
    delayMs: z.number().finite().min(minimumApiKeyDelayMs),
    jobCaps: z
      .object({
        maxRequests: z.number().int().positive(),
        maxTransferBytes: z.number().int().positive(),
      })
      .strict(),
    robots: robotsObservation.optional(),
    /**
     * Country the host serves its files to (decision D3). Collection is refused unless the session
     * holds a valid egress record (`OPENPLANS_EGRESS_FILE`) for that country; a declared country alone
     * does not count.
     */
    requiredEgressCountry: countryCode.optional(),
    terms: z
      .object({
        url: httpsUrl,
        disposition: z.enum(["allowed", "restricted", "unknown"]),
        sha256,
        reviewedAt: z.iso.datetime(),
        expiresAt: z.iso.datetime(),
        /** Who reviewed the terms; shipped manifests name the OpenPlans maintainers. */
        reviewer: z.string().min(1).optional(),
        /** Quoted publisher text the allowed disposition rests on. */
        basis: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const admissionManifestSchema = z
  .object({
    version: z.literal(1),
    publishers: z.array(publisherSchema).min(1),
  })
  .strict()
  .superRefine((manifest, context) => {
    const hosts = manifest.publishers.map((publisher) => publisher.host);
    if (new Set(hosts).size !== hosts.length)
      context.addIssue({ code: "custom", message: "Duplicate publisher host" });
    for (const publisher of manifest.publishers) {
      const keyed = publisher.accessMode === "api-key";
      if (keyed !== (publisher.apiKey !== undefined))
        context.addIssue({
          code: "custom",
          message: "An API key entry needs accessMode api-key, and only it",
        });
      if (!keyed && publisher.delayMs < minimumDelayMs)
        context.addIssue({
          code: "custom",
          message: `Publisher delay below ${minimumDelayMs} ms needs accessMode api-key`,
        });
      if (!keyed && publisher.robots?.notApplicable !== undefined)
        context.addIssue({
          code: "custom",
          message: "Only an api-key entry can record robots as not applicable",
        });
      const robotsReviewed =
        publisher.robots &&
        ([200, ...absentRobotsStatuses].includes(publisher.robots.status) ||
          (keyed && publisher.robots.notApplicable !== undefined));
      if (
        publisher.state === "allowed" &&
        (publisher.terms?.disposition !== "allowed" || !robotsReviewed)
      )
        context.addIssue({
          code: "custom",
          message:
            "Allowed publishers require reviewed terms and robots evidence",
        });
    }
  });
export type AdmissionManifest = z.infer<typeof admissionManifestSchema>;
export type PublisherPolicy = AdmissionManifest["publishers"][number];

export interface PolicyDocument {
  status: number;
  sha256: string | null;
  text: string;
  /** True only for a direct 404/410 at /robots.txt: the host publishes no robots rules. */
  absent?: boolean;
  /** True only for a direct 401 at /robots.txt. Holds unless the entry is a reviewed keyed API. */
  unauthorized?: boolean;
  /** The original 401 failure, rethrown when the entry is not a reviewed keyed API. */
  failure?: FetchError;
  contentType?: string | null;
}
export interface AdmissionOptions {
  /** ISO 3166 alpha-2 country this collection egresses from, recorded in every receipt. */
  egressCountry?: string;
  /** Absolute path of an egress record; defaults to `OPENPLANS_EGRESS_FILE`. */
  egressFile?: string;
  /** SHA-256 of the egress record; defaults to `OPENPLANS_EGRESS_SHA256`. */
  egressSha256?: string;
  /**
   * API keys by host, for keyed API entries. Without one, the entry's `apiKey.env` variable is
   * read. The value is only ever added to a data request URL; it is never stored or reported.
   */
  apiKeys?: Readonly<Record<string, string>>;
}
export interface AdmissionReceipt {
  manifestSha256: string;
  hosts: {
    host: string;
    state: AccessState;
    termsSha256: string;
    /** Absent from receipts written before off-host terms were supported. */
    termsUrl?: string;
    /** Robots of the terms host, when terms are published on another host. */
    termsRobots?: TermsRobotsObservation;
    /** Absent from receipts written before egress recording. */
    egressCountry?: string | null;
    /** The validated egress record, or null without one. Absent from receipts written before it. */
    egress?: EgressReceipt | null;
    /** Present for a keyed API: admitted on its API documentation (`termsUrl`, `termsSha256`). */
    accessMode?: "api-key";
    /** Name of the query parameter that carried the key. Never the key itself. */
    apiKeyParam?: string;
    robots: {
      url: string;
      status: number;
      sha256: string | null;
      absent?: boolean;
      /** True when a keyed API answered robots with the reviewed 401. */
      notApplicable?: boolean;
      checkedAt: string;
    };
  }[];
}
interface HostReview {
  robots: RobotsPolicy;
  checkedAt: number;
}
interface TermsRobotsObservation {
  url: string;
  status: number;
  sha256: string | null;
  absent: boolean;
}
export type PolicyReader = (
  url: URL,
  delayMs: number,
) => Promise<PolicyDocument>;

function assertNotHtml(document: PolicyDocument): void {
  if (
    /(?:text\/html|application\/xhtml\+xml)/i.test(document.contentType ?? "")
  )
    throw new FetchError(
      "admission_denied",
      "Robots response is an HTML document, not robots directives",
    );
}

/** `permittedPaths` match a path or its descendants, so `/feed` does not admit `/feed-other`. */
function permitsPath(publisher: PublisherPolicy, url: URL): boolean {
  return publisher.permittedPaths.some(
    (path) =>
      url.pathname === path ||
      url.pathname.startsWith(path.endsWith("/") ? path : `${path}/`),
  );
}

/** Observed restrictions remain holds until the owner supplies a separate access decision. */
export const observedHostHolds = [
  {
    host: "www.molinahealthcare.com",
    state: "geo-restricted",
    observedOn: "2026-11-09",
    observations: [
      { country: "CO", status: 403 },
      { country: "US", status: 200 },
    ],
  },
  {
    host: "nystateofhealth.ny.gov",
    state: "geo-restricted",
    observedOn: "2026-11-09",
    observations: [
      { country: "CO", status: 403 },
      { country: "US", status: 200 },
    ],
  },
  {
    host: "dmhc.ca.gov",
    state: "bot-protected",
    observedOn: "2026-11-09",
    observations: [
      { country: "CO", status: 403 },
      { country: "US", status: 403 },
    ],
  },
  {
    host: "www.dmhc.ca.gov",
    state: "bot-protected",
    observedOn: "2026-11-09",
    observations: [
      { country: "CO", status: 403 },
      { country: "US", status: 403 },
    ],
  },
] as const;

export function assertObservedHostAllowed(url: URL): void {
  if (observedHostHolds.some((entry) => entry.host === url.hostname))
    throw new FetchError(
      "admission_denied",
      "Publisher has an observed access restriction",
    );
}

/**
 * One session per collection job. Input is one or more reviewed manifests, never a URL allowlist.
 * With several manifests, a later manifest's entry replaces an earlier entry for the same host, so an
 * operator manifest can add hosts to, or re-review hosts of, the manifests shipped with OpenPlans.
 */
export class AdmissionSession {
  readonly manifestPaths: readonly string[];
  private pinnedHash?: string;
  private reviews = new Map<string, Promise<HostReview>>();
  private stopped = false;
  private requests = 0;
  private bytes = 0;
  private hostRequests = new Map<string, number>();
  private hostBytes = new Map<string, number>();
  private hostCaps = new Map<string, PublisherPolicy["jobCaps"]>();
  private receipts = new Map<string, AdmissionReceipt["hosts"][number]>();
  private reviewedKeyed = new Map<string, PublisherPolicy>();
  /** Set when an egress record was given; its country is then the session's egress country. */
  readonly egress?: EgressBinding;
  readonly egressCountry?: string;

  constructor(
    manifestPath: string | readonly string[],
    readonly limits = { maxRequests: 200, maxTransferBytes: 50 * 1024 ** 2 },
    readonly options: AdmissionOptions = {},
  ) {
    this.manifestPaths =
      typeof manifestPath === "string" ? [manifestPath] : [...manifestPath];
    if (
      !this.manifestPaths.length ||
      !this.manifestPaths.every((path) => isAbsolute(path)) ||
      (options.egressCountry !== undefined &&
        !countryCode.safeParse(options.egressCountry).success) ||
      !Object.values(limits).every(
        (value) => Number.isSafeInteger(value) && value > 0,
      )
    )
      throw new FetchError("invalid_options", "Invalid admission budget");
    this.egress = this.loadEgress(options);
    this.egressCountry = this.egress?.country ?? options.egressCountry;
  }

  /** A set but invalid, mismatched or stale record refuses the session before any request. */
  private loadEgress(options: AdmissionOptions): EgressBinding | undefined {
    if (options.egressFile === undefined)
      return egressFromEnvironment(options.egressCountry);
    return egressFromEnvironment(options.egressCountry, {
      OPENPLANS_EGRESS_FILE: options.egressFile,
      OPENPLANS_EGRESS_SHA256: options.egressSha256,
      OPENPLANS_EGRESS_COUNTRY: process.env.OPENPLANS_EGRESS_COUNTRY,
    });
  }

  /** The reviewed manifest this session was given last, which takes precedence per host. */
  get manifestPath(): string {
    return this.manifestPaths.at(-1)!;
  }

  /** True once a manifest was read and the session has not stopped, so a receipt exists. */
  get active(): boolean {
    return !this.stopped && this.pinnedHash !== undefined;
  }

  stop(): void {
    this.stopped = true;
  }

  /** True after any refusal or failure; a long-lived caller starts a new session. */
  get isStopped(): boolean {
    return this.stopped;
  }

  private apiKey(publisher: PublisherPolicy): string | undefined {
    if (!publisher.apiKey) return undefined;
    const key =
      this.options.apiKeys?.[publisher.host] ??
      process.env[publisher.apiKey.env];
    return key && /^[\x21-\x7e]{8,256}$/.test(key) ? key : undefined;
  }

  /** Pacing floor for this host: lower only for a reviewed keyed API. */
  pacingFloorMs(url: URL): number {
    return this.reviewedKeyed.has(url.hostname)
      ? minimumApiKeyDelayMs
      : minimumDelayMs;
  }

  /**
   * The URL actually sent for a data request: a keyed API gets its key as the reviewed query
   * parameter. Callers keep using the key-free URL for evidence, metadata and errors.
   */
  credentialUrl(url: URL): URL {
    const publisher = this.reviewedKeyed.get(url.hostname);
    if (!publisher) return url;
    const key = this.apiKey(publisher);
    if (!key) {
      this.stop();
      throw new FetchError(
        "admission_denied",
        `Publisher requires an API key in ${publisher.apiKey!.env}`,
      );
    }
    const sent = new URL(url);
    sent.searchParams.set(publisher.apiKey!.queryParam, key);
    return sent;
  }

  reserveRequest(url: URL): void {
    const count = (this.hostRequests.get(url.hostname) ?? 0) + 1;
    this.hostRequests.set(url.hostname, count);
    const caps = this.hostCaps.get(url.hostname);
    if (
      this.stopped ||
      ++this.requests > this.limits.maxRequests ||
      !caps ||
      count > caps.maxRequests
    ) {
      this.stop();
      throw new FetchError(
        "admission_denied",
        "Collection request budget exhausted or stopped",
      );
    }
  }

  transferred(url: URL, bytes: number): void {
    this.bytes += bytes;
    const hostBytes = (this.hostBytes.get(url.hostname) ?? 0) + bytes;
    this.hostBytes.set(url.hostname, hostBytes);
    const caps = this.hostCaps.get(url.hostname);
    if (
      this.stopped ||
      this.bytes > this.limits.maxTransferBytes ||
      !caps ||
      hostBytes > caps.maxTransferBytes
    ) {
      this.stop();
      throw new FetchError(
        "too_large",
        "Collection transfer budget exceeded or stopped",
      );
    }
  }

  private async manifest(): Promise<AdmissionManifest> {
    if (this.stopped)
      throw new FetchError("admission_denied", "Collection is stopped");
    try {
      const fileHashes: string[] = [];
      const publishers = new Map<string, PublisherPolicy>();
      for (const path of this.manifestPaths) {
        const bytes = await readFile(path);
        fileHashes.push(createHash("sha256").update(bytes).digest("hex"));
        const manifest = admissionManifestSchema.parse(
          JSON.parse(bytes.toString("utf8")),
        );
        for (const publisher of manifest.publishers)
          publishers.set(publisher.host, publisher);
      }
      // A single manifest keeps its own file hash, so existing receipts stay comparable.
      const hash =
        fileHashes.length === 1
          ? fileHashes[0]!
          : createHash("sha256").update(fileHashes.join("\n")).digest("hex");
      if (this.pinnedHash && hash !== this.pinnedHash)
        throw new FetchError(
          "admission_denied",
          "Reviewed access manifest changed during collection",
        );
      this.pinnedHash = hash;
      return { version: 1, publishers: [...publishers.values()] };
    } catch {
      this.stop();
      throw new FetchError(
        "admission_denied",
        "Access manifest is missing, invalid or changed",
      );
    }
  }

  async assertCurrent(url: URL): Promise<PublisherPolicy> {
    assertObservedHostAllowed(url);
    const manifest = await this.manifest();
    const publisher = manifest.publishers.find(
      (entry) => entry.host === url.hostname,
    );
    const denied = (message: string): never => {
      this.stop();
      throw new FetchError("admission_denied", message);
    };
    if (!publisher)
      return denied(
        "Publisher host is not in a reviewed access manifest; add an operator manifest entry to collect from it",
      );
    if (publisher.state !== "allowed")
      return denied(
        `Publisher host is held by its reviewed manifest (${publisher.state})`,
      );
    this.assertEgress(publisher, denied);
    const terms = publisher.terms;
    const now = Date.now();
    if (
      terms?.disposition !== "allowed" ||
      Date.parse(terms.reviewedAt) > now ||
      Date.parse(terms.expiresAt) <= now
    )
      return denied("Publisher terms review is missing or expired");
    if (!permitsPath(publisher, url))
      return denied("Path is outside the publisher's reviewed permitted paths");
    if (publisher.accessMode === "api-key") {
      if (!this.apiKey(publisher))
        return denied(
          `Publisher requires an API key in ${publisher.apiKey!.env}; none is set`,
        );
      this.reviewedKeyed.set(publisher.host, publisher);
    } else this.reviewedKeyed.delete(publisher.host);
    this.hostCaps.set(publisher.host, publisher.jobCaps);
    return publisher;
  }

  private assertEgress(
    publisher: PublisherPolicy,
    denied: (message: string) => never,
  ): void {
    if (this.egress) {
      try {
        assertEgressCurrent(this.egress);
      } catch (error) {
        return denied((error as Error).message);
      }
    }
    const required = publisher.requiredEgressCountry;
    if (required && this.egress?.country !== required)
      denied(
        `Publisher requires a recorded ${required} egress; set OPENPLANS_EGRESS_FILE to a current ${required} egress record`,
      );
  }

  async assertReady(url: URL): Promise<void> {
    await this.assertCurrent(url);
    const review = await this.reviews.get(url.hostname);
    if (
      !review ||
      Date.now() - review.checkedAt >= dailyRecheckMs ||
      !review.robots.allows(url)
    ) {
      this.stop();
      throw new FetchError(
        "admission_denied",
        "Publisher policy expired before snapshot publication",
      );
    }
  }

  async authorize(
    url: URL,
    readPolicy: PolicyReader,
    from?: URL,
  ): Promise<number> {
    const publisher = await this.assertCurrent(url);
    if (from && from.hostname !== url.hostname) {
      const origin = await this.assertCurrent(from);
      if (!origin.delegates.includes(url.hostname)) {
        this.stop();
        throw new FetchError(
          "admission_denied",
          "Redirect delegate is not reviewed",
        );
      }
    }
    let pending = this.reviews.get(publisher.host);
    if (pending && Date.now() - (await pending).checkedAt >= dailyRecheckMs)
      pending = undefined;
    if (!pending) {
      pending = this.review(publisher, readPolicy);
      this.reviews.set(publisher.host, pending);
    }
    const review = await pending;
    if (
      Date.now() - review.checkedAt >= dailyRecheckMs ||
      !review.robots.allows(url)
    ) {
      this.stop();
      throw new FetchError(
        "admission_denied",
        "Publisher robots policy is stale or disallows this path",
      );
    }
    await this.assertCurrent(url);
    return Math.max(publisher.delayMs, review.robots.delayMs);
  }

  private async review(
    publisher: PublisherPolicy,
    readPolicy: PolicyReader,
  ): Promise<HostReview> {
    try {
      const robotsUrl = checkedUrl(`https://${publisher.host}/robots.txt`, [
        publisher.host,
      ]);
      const document = await readPolicy(robotsUrl, publisher.delayMs);
      const checkedAt = Date.now();
      this.assertRobotsDocument(publisher, document);
      const robots = parseRobots(document.text);
      const terms = publisher.terms!;
      const termsUrl = checkedUrl(terms.url, [new URL(terms.url).hostname]);
      const termsHost =
        termsUrl.hostname === publisher.host
          ? undefined
          : await this.termsHostRobots(publisher, termsUrl, readPolicy);
      const termsRobots = termsHost?.robots ?? robots;
      if (!termsRobots.allows(termsUrl))
        throw new FetchError(
          "admission_denied",
          "Robots policy disallows terms verification",
        );
      const currentTerms = await readPolicy(
        termsUrl,
        Math.max(publisher.delayMs, robots.delayMs, termsRobots.delayMs),
      );
      if (currentTerms.status !== 200 || currentTerms.sha256 !== terms.sha256)
        throw new FetchError(
          "admission_denied",
          "Publisher terms changed or are unavailable",
        );
      const receipt: AdmissionReceipt["hosts"][number] = {
        host: publisher.host,
        state: "allowed",
        termsSha256: terms.sha256,
        termsUrl: termsUrl.href,
        ...(termsHost && { termsRobots: termsHost.observation }),
        egressCountry: this.egressCountry ?? null,
        egress: this.egress?.receipt ?? null,
        ...(publisher.accessMode === "api-key" && {
          accessMode: "api-key" as const,
          apiKeyParam: publisher.apiKey!.queryParam,
        }),
        robots: {
          url: robotsUrl.href,
          status: document.status,
          sha256: document.sha256,
          absent: document.absent === true,
          ...(document.unauthorized && { notApplicable: true }),
          checkedAt: new Date(checkedAt).toISOString(),
        },
      };
      this.receipts.set(publisher.host, receipt);
      return { robots, checkedAt };
    } catch (error) {
      this.stop();
      if (error instanceof FetchError) throw error;
      throw new FetchError(
        "admission_denied",
        "Publisher policy could not be verified",
      );
    }
  }

  /**
   * Terms often live on the publisher's main site rather than its data host. That host's robots
   * file must permit reading the terms page; a direct 404/410 there means no rules. The read counts
   * against the publisher's job caps, and the host gains no data clearance.
   */
  private async termsHostRobots(
    publisher: PublisherPolicy,
    termsUrl: URL,
    readPolicy: PolicyReader,
  ): Promise<{ robots: RobotsPolicy; observation: TermsRobotsObservation }> {
    if (!this.hostCaps.has(termsUrl.hostname))
      this.hostCaps.set(termsUrl.hostname, publisher.jobCaps);
    const robotsUrl = checkedUrl(`https://${termsUrl.hostname}/robots.txt`, [
      termsUrl.hostname,
    ]);
    const document = await readPolicy(robotsUrl, publisher.delayMs);
    if (!document.absent) assertNotHtml(document);
    return {
      robots: parseRobots(document.text),
      observation: {
        url: robotsUrl.href,
        status: document.status,
        sha256: document.sha256,
        absent: document.absent === true,
      },
    };
  }

  /**
   * An HTML robots response is not directives. Absence counts only when the reviewed manifest also
   * recorded absence. The egress country is recorded in the receipt but does not restrict collection
   * (owner decision, 2026-11-09): self-hosters collect from many countries. A file that appears later
   * is parsed and obeyed, and any non-404/410 answer still holds.
   */
  private assertRobotsDocument(
    publisher: PublisherPolicy,
    document: PolicyDocument,
  ): void {
    if (document.unauthorized) {
      // A keyed API answers every unauthenticated path with 401. It counts as "robots not
      // applicable" only when the reviewed entry is a keyed API and recorded that 401 itself.
      if (
        publisher.accessMode !== "api-key" ||
        publisher.robots?.status !== 401 ||
        publisher.robots.notApplicable === undefined
      )
        throw (
          document.failure ??
          new FetchError(
            "http_status",
            "Publisher returned an unsuccessful HTTP status",
            401,
          )
        );
      return;
    }
    if (!document.absent) return assertNotHtml(document);
    const reviewed = publisher.robots;
    if (!reviewed || !absentRobotsStatuses.includes(reviewed.status))
      throw new FetchError(
        "admission_denied",
        "Robots absence was not recorded by the reviewed manifest",
      );
  }

  receipt(): AdmissionReceipt {
    if (this.stopped || !this.pinnedHash)
      throw new FetchError(
        "admission_denied",
        "Collection has no valid admission receipt",
      );
    return {
      manifestSha256: this.pinnedHash,
      hosts: [...this.receipts.values()],
    };
  }
}
