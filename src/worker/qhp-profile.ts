import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { FetchError, fetchToCache } from "../fetch/index.js";

const file = z.object({
  source: z.string().regex(/^qhp-[a-z0-9._-]{1,120}$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative(),
  url: z.string().url(),
});
const schema = z.object({
  schema: z.literal(1),
  providers: z.literal(true),
  drugs: z.literal(false),
  taxonomy_names: z.literal(false),
  scopes: z.array(
    z.object({ state: z.string().regex(/^[A-Z]{2}$/), year: z.number().int() }),
  ),
  provider_feeds: z
    .array(
      z.object({
        issuer: z.string().regex(/^\d{5}$/),
        state: z.string().regex(/^[A-Z]{2}$/),
        set: z.string().regex(/^qhp-\d{5}-20\d{2}-index$/),
      }),
    )
    .min(1),
  feed_raw: z.array(file).min(1),
});
export type QhpProfile = z.infer<typeof schema>;

export async function readQhpProfile(path: string): Promise<QhpProfile> {
  if (!isAbsolute(path))
    throw new Error("Absolute prepared QHP profile required");
  const parsed = schema.safeParse(JSON.parse(await readFile(path, "utf8")));
  if (!parsed.success) throw new Error("Invalid prepared QHP profile");
  const profile = parsed.data;
  if (
    new Set(profile.scopes.map((s) => `${s.state}-${s.year}`)).size !==
      profile.scopes.length ||
    new Set(profile.provider_feeds.map((f) => `${f.issuer}-${f.state}`))
      .size !== profile.provider_feeds.length ||
    new Set(profile.feed_raw.map((f) => f.url)).size !==
      profile.feed_raw.length ||
    profile.provider_feeds.some(
      (f) =>
        !profile.feed_raw.some((p) => p.source === f.set) ||
        !profile.scopes.some((scope) => scope.state === f.state),
    ) ||
    profile.feed_raw.some((f) => {
      const url = new URL(f.url);
      return (
        url.protocol !== "https:" ||
        !!url.username ||
        !!url.password ||
        !!url.search ||
        !!url.hash
      );
    })
  )
    throw new Error("Invalid prepared QHP profile pins");
  return profile;
}

/** Pins select existing bytes. Stored admission receipts still decide whether they may be read. */
export function preparedQhpFetcher(profile: QhpProfile): typeof fetchToCache {
  return async (input, options) => {
    const pin = profile.feed_raw.find((f) => f.url === String(input));
    if (!pin)
      throw new FetchError(
        "cache_error",
        "not_cached: prepared QHP snapshot is not listed",
      );
    const deny = async (): Promise<never> => {
      throw new FetchError(
        "cache_error",
        "Prepared QHP inputs never send requests",
      );
    };
    const result = await fetchToCache(input, {
      ...options,
      source: pin.source,
      expectedSha256: pin.sha256,
      lookup: deny,
      transport: deny,
      maxAttempts: 1,
    });
    if (
      result.outcome !== "reused" ||
      result.metadata.bytes !== pin.bytes ||
      result.metadata.url !== pin.url
    )
      throw new FetchError(
        "cache_error",
        "Prepared QHP snapshot size mismatch",
      );
    return result;
  };
}

export function preparedQhpOutcome(report: Record<string, unknown>): boolean {
  const reasons =
    typeof report.reason === "string" && report.reason.length > 0
      ? report.reason.split(",")
      : [];
  return (
    report.completeness === "complete" ||
    (report.status === "QUARANTINED" &&
      reasons.length > 0 &&
      !reasons.some((reason) =>
        ["issuer_import_failed", "run_budget_exceeded"].includes(reason),
      )) ||
    // Only invalid-NPI records were dropped. The set publishes its positive rows and stays
    // labelled partial, so absence there stays unknown. Any other partial reason still fails.
    (report.status === "ACTIVE" &&
      report.completeness === "partial" &&
      reasons.length > 0 &&
      reasons.every((reason) => reason === "source_records_rejected"))
  );
}
