import type { FeedSource } from "@openplans/plugin-sdk";
import type {
  FeedDatabase,
  FeedRunOptions,
} from "../../plugins/sources/feed.js";
import { verifyDirectory } from "../../plugins/package/verify.js";
import { packagePufSource } from "../../registry/data/puf.js";
import { readPackageJson } from "../../plugins/package/files.js";
import {
  packageInputReviewSchema,
  runPackageFeed,
} from "../../plugins/sources/package-feed.js";

export const packageIngestUsage =
  "Usage: worker ingest package <source> <installed-directory> --review <local-review.json> -- <source-arguments>";

export async function runPackageIngest(
  source: FeedSource,
  args: readonly string[],
  database: FeedDatabase,
  options: FeedRunOptions = {},
): Promise<number> {
  if (!args[0] || args[1] !== "--review" || !args[2] || args[3] !== "--") {
    (options.output ?? console).error(packageIngestUsage);
    return 1;
  }
  return runPackageFeed(
    args[0],
    args[2],
    source,
    args.slice(4),
    database,
    options,
  );
}

export async function runCorePackageIngest(
  args: readonly string[],
  database: FeedDatabase,
  options: FeedRunOptions = {},
): Promise<number> {
  try {
    if (!args[0]) throw new Error("package_input_required");
    const { manifest } = await verifyDirectory(args[0]);
    if (manifest.kind !== "data") throw new Error("package_data_required");
    if (args[1] !== "--review" || !args[2])
      throw new Error("package_review_required");
    const review = packageInputReviewSchema.parse(
      await readPackageJson(args[2]),
    );
    const source = packagePufSource(
      manifest,
      review.files
        .flatMap((file) => [
          file.response.finalUrl,
          ...file.response.redirectChain,
        ])
        .map((url) => new URL(url).hostname),
    );
    return runPackageIngest(source, args, database, {
      ...options,
      declaredHosts: source.hosts,
    });
  } catch {
    (options.output ?? console).error(
      JSON.stringify({
        code: "package_ingest_refused",
        status: "unknown",
        reason: "package_puf_input_invalid",
      }),
    );
    return 1;
  }
}
