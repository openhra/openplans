// Synthetic feed source fixture for the feed lifecycle tests. Its files are served by the
// test's injected transport; no real publisher, host or data is involved.
import { readFile } from "node:fs/promises";
import { z } from "zod";

const HOST = "feed.synthetic.test";
const seen = () => (globalThis.syntheticFeedSeen ??= []);
const states = (tx, ids) =>
  tx
    .query(
      "SELECT validation_state FROM snapshot WHERE snapshot_id = ANY($1::text[]) ORDER BY snapshot_id",
      [ids],
    )
    .then(({ rows }) => rows.map((row) => row.validation_state));

let current = "happy";
let staged = [];

export const source = {
  kind: "feed",
  id: "synthetic-feed",
  publisher: "Synthetic test publisher",
  hosts: [HOST],
  command: {
    argv: ["ingest", "synthetic-feed"],
    usage: "Usage: worker ingest synthetic-feed --case NAME",
    args: z.tuple([z.literal("--case"), z.string().regex(/^[a-z-]+$/)]),
  },
  async plan(ctx, args) {
    current = args[1];
    if (current === "offhost")
      return {
        files: [
          {
            url: "https://elsewhere.synthetic.test/feed/items.json",
            expectedContent: "json",
            maxBytes: 4096,
          },
        ],
      };
    if (current === "unpermitted")
      // On the source's own host, outside the manifest's permitted paths.
      return {
        files: [
          {
            url: `https://${HOST}/private/items.json`,
            expectedContent: "json",
            maxBytes: 4096,
          },
        ],
      };
    if (current === "content" || current === "content-pinned")
      return {
        files: [
          {
            url: `https://${HOST}/feed/items.json`,
            expectedContent: "json",
            maxBytes: 4096,
            cache: "content",
            ...(current === "content-pinned"
              ? { expectedSha256: globalThis.syntheticFeedPin }
              : {}),
          },
        ],
        requireRows: ["synthetic_feed_item"],
      };
    // Discovery through the admitted fetch, as an HTML files page would be read.
    const page = await ctx.fetch(`https://${HOST}/feed/index.json`, {
      expectedContent: "json",
      maxBytes: 4096,
    });
    const index = JSON.parse(await readFile(page.path, "utf8"));
    return {
      files: index.files.map((path) => ({
        url: `https://${HOST}${path}`,
        expectedContent: "json",
        maxBytes: 4096,
      })),
      requireRows: ["synthetic_feed_item"],
    };
  },
  async stage(ctx, acquired, tx) {
    staged = acquired.map((file) => file.snapshotId);
    if (current === "late-fetch")
      await ctx.fetch(`https://${HOST}/feed/index.json`, {
        expectedContent: "json",
        maxBytes: 4096,
      });
    await tx.query("DELETE FROM synthetic_feed_item");
    let rows = 0;
    for (const file of acquired) {
      const items = JSON.parse(await readFile(file.path, "utf8"));
      for (const item of current === "empty" ? [] : items) {
        if (current === "forge")
          // A plugin trying to choose its own provenance; the row trigger ignores it.
          await tx.query(
            `INSERT INTO synthetic_feed_item(item_code,label,snapshot_id,sourced_by,sourced_slug,sourced_at)
             VALUES ($1,$2,$3,'forged-source','forged-slug','2001-01-01T00:00:00Z')`,
            [item.code, item.label, file.snapshotId],
          );
        else
          await tx.query(
            "INSERT INTO synthetic_feed_item(item_code,label,snapshot_id) VALUES ($1,$2,$3)",
            [item.code, item.label, file.snapshotId],
          );
        rows++;
      }
    }
    if (current === "untracked") {
      await tx.query(
        "INSERT INTO synthetic_feed_untracked(item_code,snapshot_id) VALUES ('U1',$1)",
        [staged[0]],
      );
      return {
        rows,
        tables: ["synthetic_feed_item", "synthetic_feed_untracked"],
      };
    }
    return { rows, tables: ["synthetic_feed_item"] };
  },
  async validate(_ctx, tx) {
    seen().push({
      hook: "validate",
      case: current,
      states: await states(tx, staged),
    });
    if (current === "invalid")
      return { ok: false, reasonCode: "synthetic_invalid" };
    return { ok: true };
  },
  async beforeActivate(_ctx, tx, snapshotIds) {
    seen().push({
      hook: "beforeActivate",
      case: current,
      states: await states(tx, snapshotIds),
    });
  },
};

export default {
  manifest: {
    name: "@synthetic/feed",
    version: "0.0.1",
    apiVersion: "0.1",
    kinds: ["sources"],
    capabilities: { network: [HOST], writes: ["staging"] },
  },
  setup(ctx) {
    ctx.sources.add(source);
  },
};
