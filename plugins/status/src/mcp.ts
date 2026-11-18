import { z } from "zod";
import type { StatusData } from "./read.js";
import {
  AGE_BUCKETS,
  ageBucket,
  publicStatusSchema,
  publicView,
} from "./views.js";

export const GET_STATUS_MAX_BYTES = 64 * 1024;
const MCP_FRAMING_RESERVE = 4096;
const MAX_YEARS = 20;
const MAX_VERSION_LENGTH = 128;
const MAX_DETAIL_ROWS = 100;

export const getStatusInputSchema = z.strictObject({
  section: z
    .enum(["summary", "sources", "worker", "passthrough"])
    .default("summary"),
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.number().int().min(1).max(MAX_DETAIL_ROWS).default(50),
});
export type GetStatusInput = z.input<typeof getStatusInputSchema>;

const count = z.number().int().nonnegative();
const ages = z.strictObject({
  "<1d": count,
  "<7d": count,
  "<30d": count,
  older: count,
  unknown: count,
});
const sourceDetail = publicStatusSchema.shape.sources.unwrap().element;
const ingestDetail = z.strictObject({
  source: z.string(),
  last_success: z.enum(AGE_BUCKETS),
});
const passthroughDetail = publicStatusSchema.shape.passthrough.unwrap().element;

export const getStatusSchema = publicStatusSchema
  .pick({
    api: true,
    db: true,
    cache: true,
    plugins: true,
    health_transitions: true,
  })
  .extend({
    version: z.string().max(MAX_VERSION_LENGTH),
    data: publicStatusSchema.shape.data
      .pick({ states: true, status_counts: true })
      .extend({
        years: z.array(z.number().int()).max(MAX_YEARS).nullable(),
      }),
    sources: z.strictObject({ total: count, freshness: ages }).nullable(),
    worker: z.strictObject({ total: count, last_success: ages }).nullable(),
    passthrough: z
      .strictObject({
        total: count,
        enabled: count,
        disabled: count,
        unknown: count,
        exhausted: count,
      })
      .nullable(),
    section: getStatusInputSchema.shape.section,
    details: z
      .array(z.union([sourceDetail, ingestDetail, passthroughDetail]))
      .max(MAX_DETAIL_ROWS)
      .nullable(),
    page: z
      .strictObject({
        offset: count,
        limit: count,
        total: count.nullable(),
        next_offset: count.nullable(),
        omitted: count,
      })
      .nullable(),
    truncated: z.boolean(),
  });
export type GetStatus = z.infer<typeof getStatusSchema>;

function ageCounts(dates: (Date | null)[], now: Date) {
  const counts = { "<1d": 0, "<7d": 0, "<30d": 0, older: 0, unknown: 0 };
  for (const date of dates) counts[ageBucket(date, now)]++;
  return counts;
}

/** Count the escaped text copy too; reserve room for the host's metadata and request ID. */
function resultBytes(view: GetStatus): number {
  return (
    Buffer.byteLength(
      JSON.stringify({
        content: [{ type: "text", text: JSON.stringify(view) }],
        structuredContent: view,
      }),
    ) + MCP_FRAMING_RESERVE
  );
}

/** MCP has its own bounded projection. REST views keep every public source and date. */
export function getStatusView(
  status: StatusData,
  args: GetStatusInput = {},
): GetStatus {
  const input = getStatusInputSchema.parse(args);
  const summary = publicView({
    ...status,
    sources: null,
    ingests: null,
    passthrough: null,
  });
  const years = summary.data.years;
  const view: GetStatus = {
    api: summary.api,
    db: summary.db,
    cache: summary.cache,
    plugins: summary.plugins,
    health_transitions: summary.health_transitions,
    version: summary.version.slice(0, MAX_VERSION_LENGTH),
    data: {
      states: summary.data.states,
      status_counts: summary.data.status_counts,
      years: years?.slice(0, MAX_YEARS) ?? null,
    },
    sources: status.sources && {
      total: status.sources.length,
      freshness: ageCounts(
        status.sources.map((row) => row.retrieved),
        status.now,
      ),
    },
    worker: status.ingests && {
      total: status.ingests.length,
      last_success: ageCounts(
        status.ingests.map((row) => row.lastSuccess),
        status.now,
      ),
    },
    passthrough: status.passthrough && {
      total: status.passthrough.length,
      enabled: status.passthrough.filter((row) => row.enabled === true).length,
      disabled: status.passthrough.filter((row) => row.enabled === false)
        .length,
      unknown: status.passthrough.filter((row) => row.enabled === null).length,
      exhausted: status.passthrough.filter((row) => row.exhausted === true)
        .length,
    },
    section: input.section,
    details: null,
    page: null,
    truncated:
      summary.version.length > MAX_VERSION_LENGTH ||
      (years?.length ?? 0) > MAX_YEARS,
  };
  if (input.section === "summary") return view;
  const rows = {
    sources: status.sources,
    worker: status.ingests,
    passthrough: status.passthrough,
  }[input.section];
  const selected = rows?.slice(input.offset, input.offset + input.limit) ?? [];
  view.details = [];
  const next = input.offset + selected.length;
  view.page = {
    offset: input.offset,
    limit: input.limit,
    total: rows?.length ?? null,
    next_offset: rows && next < rows.length ? next : null,
    omitted: 0,
  };
  for (const row of selected) {
    let detail: NonNullable<GetStatus["details"]>[number];
    if ("retrieved" in row) {
      detail = {
        id: row.id,
        freshness: ageBucket(row.retrieved, status.now),
        published_at: row.published,
        published_from: row.publishedFrom,
        ...(row.publishedFrom === "latest_of_files" &&
        row.publishedFiles !== undefined
          ? { published_files: row.publishedFiles }
          : {}),
      };
    } else if ("lastSuccess" in row) {
      detail = {
        source: row.source,
        last_success: ageBucket(row.lastSuccess, status.now),
      };
    } else {
      let budget: "unknown" | "exhausted" | "ok" = "unknown";
      if (row.exhausted !== null) budget = row.exhausted ? "exhausted" : "ok";
      detail = { id: row.id, enabled: row.enabled, budget, level: row.level };
    }
    view.details.push(detail);
    if (resultBytes(view) >= GET_STATUS_MAX_BYTES) {
      view.details.pop();
      view.page.omitted++;
      view.truncated = true;
    }
  }
  return view;
}
