import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { FetchError } from "./errors.js";
import { checkedUrl } from "./policy.js";
import { parseRobots } from "./robots.js";
import type { RobotsPolicy } from "./robots.js";

const dailyRecheckMs = 24 * 60 * 60 * 1000;
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const robotsObservation = z
  .object({
    url: z.string().url(),
    status: z.number().int().min(100).max(599),
    sha256: sha256.nullable(),
    checkedAt: z.iso.datetime(),
  })
  .strict();
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
            country: z
              .string()
              .regex(/^[A-Z]{2}$/)
              .optional(),
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
    delayMs: z.number().finite().min(5000),
    jobCaps: z
      .object({
        maxRequests: z.number().int().positive(),
        maxTransferBytes: z.number().int().positive(),
      })
      .strict(),
    robots: robotsObservation.optional(),
    terms: z
      .object({
        url: httpsUrl,
        disposition: z.enum(["allowed", "restricted", "unknown"]),
        sha256,
        reviewedAt: z.iso.datetime(),
        expiresAt: z.iso.datetime(),
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
      if (
        publisher.state === "allowed" &&
        (publisher.terms?.disposition !== "allowed" ||
          !publisher.robots ||
          ![200, 404].includes(publisher.robots.status))
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
  status: 200 | 404;
  sha256: string | null;
  text: string;
}
export interface AdmissionReceipt {
  manifestSha256: string;
  hosts: {
    host: string;
    state: AccessState;
    termsSha256: string;
    robots: {
      url: string;
      status: number;
      sha256: string | null;
      checkedAt: string;
    };
  }[];
}
interface HostReview {
  robots: RobotsPolicy;
  checkedAt: number;
}
export type PolicyReader = (
  url: URL,
  delayMs: number,
) => Promise<PolicyDocument>;

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

/** One session per collection job. Input is a reviewed external manifest, never a URL allowlist. */
export class AdmissionSession {
  private pinnedHash?: string;
  private reviews = new Map<string, Promise<HostReview>>();
  private stopped = false;
  private requests = 0;
  private bytes = 0;
  private hostRequests = new Map<string, number>();
  private hostBytes = new Map<string, number>();
  private hostCaps = new Map<string, PublisherPolicy["jobCaps"]>();
  private receipts = new Map<string, AdmissionReceipt["hosts"][number]>();

  constructor(
    readonly manifestPath: string,
    readonly limits = { maxRequests: 200, maxTransferBytes: 50 * 1024 ** 2 },
  ) {
    if (
      !isAbsolute(manifestPath) ||
      !Object.values(limits).every(
        (value) => Number.isSafeInteger(value) && value > 0,
      )
    )
      throw new FetchError("invalid_options", "Invalid admission budget");
  }

  stop(): void {
    this.stopped = true;
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
      const bytes = await readFile(this.manifestPath);
      const hash = createHash("sha256").update(bytes).digest("hex");
      if (this.pinnedHash && hash !== this.pinnedHash)
        throw new FetchError(
          "admission_denied",
          "Reviewed access manifest changed during collection",
        );
      const manifest = admissionManifestSchema.parse(
        JSON.parse(bytes.toString("utf8")),
      );
      this.pinnedHash = hash;
      return manifest;
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
    const terms = publisher?.terms;
    const now = Date.now();
    if (
      !publisher ||
      publisher.state !== "allowed" ||
      terms?.disposition !== "allowed" ||
      Date.parse(terms.reviewedAt) > now ||
      Date.parse(terms.expiresAt) <= now ||
      !publisher.permittedPaths.some(
        (path) =>
          url.pathname === path ||
          url.pathname.startsWith(path.endsWith("/") ? path : `${path}/`),
      )
    ) {
      this.stop();
      throw new FetchError(
        "admission_denied",
        "Publisher or path lacks current access clearance",
      );
    }
    this.hostCaps.set(publisher.host, publisher.jobCaps);
    return publisher;
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
      const robots = parseRobots(document.text);
      const terms = publisher.terms!;
      const termsUrl = checkedUrl(terms.url, [publisher.host]);
      if (!robots.allows(termsUrl))
        throw new FetchError(
          "admission_denied",
          "Robots policy disallows terms verification",
        );
      const currentTerms = await readPolicy(
        termsUrl,
        Math.max(publisher.delayMs, robots.delayMs),
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
        robots: {
          url: robotsUrl.href,
          status: document.status,
          sha256: document.sha256,
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
