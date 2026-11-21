import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, statfs } from "node:fs/promises";
import { join, sep } from "node:path";
import { z } from "zod";
import { feedPlanSchema } from "@openplans/plugin-sdk";
import type { AnnualDomain, FeedSource } from "@openplans/plugin-sdk";
import type { SqlSession } from "../../db/database.js";
import { dataDirectory } from "../../config/access.js";
import {
  currentDataPolicy,
  servingPolicy,
  withDataPolicy,
} from "../../services/data-window.js";
import { readPackageDocument, sha256 } from "../package/files.js";
import { verifyDirectory } from "../package/verify.js";
import {
  asFetchBlobStore,
  hostBlobStore,
  LocalBlobStore,
} from "../../fetch/blob/index.js";
import type { AdmissionReceipt, SnapshotMetadata } from "../../fetch/index.js";
import { runFeedSource } from "./feed.js";
import type { FeedDatabase, FeedRunOptions } from "./feed.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
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
/** An operator review, stored separately from the publisher's package. */
export const packageInputReviewSchema = z.strictObject({
  schemaVersion: z.literal(1),
  manifestSha256: digest,
  source: z.string().min(1),
  sourceArgs: z.array(z.string().max(2048)).max(100),
  scope: z.enum(["annual", "snapshot"]),
  domain: z.enum(["individual", "medicare"]),
  planYears: z.array(z.int().min(2000).max(2200)),
  reviewedAt: z.iso.datetime(),
  files: z
    .array(
      z.strictObject({
        url: httpsUrl,
        upstreamSha256: digest,
        retrievedAt: z.iso.datetime(),
        response: z.strictObject({
          status: z.int().min(200).max(299),
          finalUrl: httpsUrl,
          redirectChain: z.array(httpsUrl).max(5),
          contentType: z.string().nullable(),
          etag: z.string().nullable(),
          lastModified: z.string().nullable(),
        }),
        admissionSha256: digest,
        redistribution: z.strictObject({
          status: z.enum(["allowed", "unknown"]),
          termsUrl: httpsUrl,
          evidenceSha256: digest,
        }),
      }),
    )
    .min(1),
});
const admissionSchema = z
  .object({
    manifestSha256: digest,
    hosts: z
      .array(
        z
          .object({
            host: z.string(),
            state: z.literal("allowed"),
            termsSha256: digest,
            termsUrl: httpsUrl,
            robots: z
              .object({
                url: httpsUrl,
                status: z.int(),
                sha256: digest.nullable(),
                checkedAt: z.iso.datetime(),
              })
              .passthrough(),
          })
          .passthrough(),
      )
      .min(1),
  })
  .passthrough();

async function checkYears(
  db: SqlSession,
  years: number[],
  domain: AnnualDomain,
  now: Date,
) {
  const policy = await withDataPolicy(
    currentDataPolicy().config,
    () => servingPolicy(db),
    now,
  );
  if (
    policy.history_years !== "all" &&
    years.some((year) => !policy.domains[domain].allowed_years.includes(year))
  )
    throw new Error("package_year_outside_window");
}

/** The caller selects an already approved feed importer. The package never supplies hooks. */
export async function runPackageFeed(
  input: string,
  reviewPath: string,
  source: FeedSource,
  args: readonly string[],
  database: FeedDatabase,
  options: FeedRunOptions = {},
): Promise<number> {
  const output = options.output ?? console;
  try {
    const root = await realpath(input);
    const reviewFile = await realpath(reviewPath);
    if (reviewFile === root || reviewFile.startsWith(root + sep))
      throw new Error("package_review_must_be_local");
    const document = await readPackageDocument(reviewFile);
    const review = packageInputReviewSchema.parse(document.value);
    const reviewSha256 = document.sha256;
    const verified = await verifyDirectory(root);
    const manifest = verified.manifest;
    if (manifest.kind !== "data") throw new Error("package_data_required");
    if (
      verified.evidence !== "complete" ||
      review.files.some((file) => file.redistribution.status !== "allowed")
    )
      throw new Error("package_evidence_unknown");
    if (
      review.manifestSha256 !== verified.manifestSha256 ||
      review.source !== source.id ||
      JSON.stringify(review.sourceArgs) !== JSON.stringify(args) ||
      (review.scope === "annual"
        ? !manifest.planYears.length
        : manifest.planYears.length !== 0) ||
      JSON.stringify(review.planYears) !== JSON.stringify(manifest.planYears) ||
      review.files.length !== manifest.data.files.length
    )
      throw new Error("package_review_mismatch");
    // One independently reviewed acquisition per original, including shared/multi-year files.
    if (
      new Set(review.files.map((file) => file.url)).size !==
        review.files.length ||
      new Set(manifest.data.files.map((file) => file.origin.url)).size !==
        manifest.data.files.length
    )
      throw new Error("package_source_set_invalid");
    const receipts = new Map<string, AdmissionReceipt>();
    for (const file of manifest.data.files) {
      const trusted = review.files.find(
        (entry) => entry.url === file.origin.url,
      );
      if (
        !trusted ||
        trusted.upstreamSha256 !== file.sha256 ||
        trusted.upstreamSha256 !== file.origin.sha256 ||
        trusted.retrievedAt !== file.origin.retrievedAt ||
        trusted.admissionSha256 !== file.origin.admission.sha256 ||
        trusted.redistribution.termsUrl !== file.redistribution.termsUrl ||
        trusted.redistribution.evidenceSha256 !==
          file.redistribution.evidence.sha256
      )
        throw new Error("package_origin_mismatch");
      const admission = await readPackageDocument(
        join(root, file.origin.admission.path),
      );
      if (admission.sha256 !== trusted.admissionSha256)
        throw new Error("package_origin_mismatch");
      const receipt = admissionSchema.parse(admission.value);
      if (
        !receipt.hosts.some(
          (entry) => entry.host === new URL(file.origin.url).hostname,
        )
      )
        throw new Error("package_admission_unknown");
      receipts.set(file.origin.url, receipt as AdmissionReceipt);
    }
    const db = typeof database === "function" ? await database() : database;
    await checkYears(
      db,
      manifest.planYears,
      review.domain,
      options.now?.() ?? new Date(),
    );
    const dataDir = options.dataDir ?? dataDirectory();
    const disk = await statfs(dataDir);
    if (
      disk.bavail * disk.bsize <
      manifest.data.files.reduce((sum, file) => sum + file.bytes, 0)
    )
      throw new Error("package_staging_space_insufficient");
    const cacheRun = `package-${verified.manifestSha256.slice(0, 16)}-${randomBytes(4).toString("hex")}`;
    const cacheSource = (url: string) =>
      `${cacheRun}-${sha256(url).slice(0, 16)}`;
    const host = hostBlobStore();
    const store = host
      ? asFetchBlobStore(host, dataDir)
      : new LocalBlobStore(dataDir);
    const prepareFiles: NonNullable<FeedRunOptions["prepareFiles"]> = async (
      plan,
    ) => {
      for (const file of plan.files) {
        const original = manifest.data.files.find(
          (entry) => entry.origin.url === file.url,
        )!;
        const fileSource = cacheSource(file.url);
        const temporary = await store.stage(`raw/${fileSource}`);
        try {
          const body = (async function* () {
            for (const chunk of original.chunks)
              yield* createReadStream(
                join(root, "chunks", chunk.sha256),
              ) as AsyncIterable<Buffer>;
          })();
          const stored = await store.put(`${temporary}/payload`, body, {
            sha256: original.sha256,
          });
          if (stored.bytes !== original.bytes)
            throw new Error("package_file_size_mismatch");
          const response = review.files.find(
            (entry) => entry.url === original.origin.url,
          )!.response;
          const metadata: SnapshotMetadata = {
            snapshot_id: original.sha256,
            source: fileSource,
            url: original.origin.url,
            final_url: response.finalUrl,
            redirect_chain: response.redirectChain,
            status: response.status,
            content_type: response.contentType,
            etag: response.etag,
            last_modified: response.lastModified,
            sha256: original.sha256,
            bytes: original.bytes,
            fetched_at: original.origin.retrievedAt,
            access_policy: receipts.get(original.origin.url)!,
          };
          const bytes = Buffer.from(JSON.stringify(metadata));
          await store.put(
            `${temporary}/meta.json`,
            (async function* () {
              yield bytes;
            })(),
            {},
          );
          await store.publish(
            temporary,
            `raw/${fileSource}/${original.sha256}`,
          );
        } finally {
          await store.discard(temporary);
        }
      }
    };
    const adapter: FeedSource = {
      ...source,
      async plan(ctx, parsed) {
        const plan = feedPlanSchema.parse(await source.plan(ctx, parsed));
        if (
          plan.files.length !== manifest.data.files.length ||
          new Set(plan.files.map((file) => file.url)).size !== plan.files.length
        )
          throw new Error("package_source_set_incomplete");
        for (const file of plan.files) {
          const original = manifest.data.files.find(
            (entry) => entry.origin.url === file.url,
          );
          if (
            !original ||
            (file.expectedSha256 && file.expectedSha256 !== original.sha256) ||
            original.bytes > file.maxBytes
          )
            throw new Error("package_source_plan_mismatch");
          file.expectedSha256 = original.sha256;
          file.cache = "content";
        }
        return plan;
      },
      async beforeActivate(ctx, tx, snapshotIds) {
        if (source.beforeActivate)
          await source.beforeActivate(ctx, tx, snapshotIds);
        // Resolve afresh after staging and the source's publication hook.
        await checkYears(
          tx,
          manifest.planYears,
          review.domain,
          options.now?.() ?? new Date(),
        );
      },
    };
    return await runFeedSource(adapter, args, db, {
      ...options,
      dataDir,
      cacheSource,
      prepareFiles,
      packageReceipt: JSON.stringify({
        via: `registry:${manifest.name}@${manifest.version}`,
        manifestSha256: verified.manifestSha256,
        reviewSha256,
        review,
        origins: manifest.data.files,
        packageDirectory: root,
      }),
    });
  } catch (error) {
    const reason =
      error instanceof Error && /^package_[a-z_]+$/.test(error.message)
        ? error.message
        : "package_input_refused";
    output.error(
      JSON.stringify({
        source: source.id,
        code: "package_ingest_refused",
        status: "unknown",
        reason,
      }),
    );
    return 1;
  }
}
