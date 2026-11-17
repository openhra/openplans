import type { z } from "zod";
import type { presetInput } from "./contract.js";

type Row = Record<string, unknown>;
const row = (value: unknown): Row =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
const rows = (value: unknown): Row[] =>
  Array.isArray(value) ? value.map(row) : [];
const point = (value: unknown) => {
  const entry = row(value);
  return {
    monthly_cents: entry.monthly_cents ?? null,
    denominator: entry.denominator ?? null,
  };
};

/** Keep offer rows in the downloadable manifest, outside the MCP transport budget. */
export function allowanceMcpAnswer(
  answer: Row,
  input: z.infer<typeof presetInput>,
) {
  const query = new URLSearchParams({
    ...input,
    year: String(input.year),
    data_generation: String(answer.data_generation),
  });
  const manifest = `/handy/allowance/manifest?${query}`;
  const snapshots = rows(row(answer.provenance).snapshots);
  const result = {
    schema_version: "1",
    status: row(answer.target).status === "calculated" ? "ok" : "unknown",
    data_generation: answer.data_generation,
    provenance: snapshots.slice(0, 10).map((snapshot) => ({
      id: String(snapshot.snapshot_id),
      snapshot_id: String(snapshot.snapshot_id),
      publisher: snapshot.publisher ?? null,
      url: snapshot.url ?? null,
      sha256: snapshot.sha256 ?? null,
      retrieved_at: null,
      publisher_updated_at: null,
      record_ref: null,
      status: "available",
    })),
    notes: [
      "Gross premium context for illustrative profiles. Inspect the generation-pinned source manifest for evidence and gaps.",
    ],
    truncated: snapshots.length > 10,
    freshness: {
      checked_at: new Date().toISOString(),
      status: "current_local",
    },
    page: null,
    error: null,
    data: {
      year: answer.year,
      location: answer.location,
      preset: answer.preset,
      preset_origin: answer.preset_origin,
      reason: answer.reason,
      target: answer.target,
      profiles: rows(answer.profiles).map((profile) => ({
        id: profile.id,
        members: profile.members,
        lowest_silver: point(profile.lowest_silver),
        metals: rows(profile.metals).map((group) => ({
          metal: group.metal,
          status: group.status,
          counts: group.counts,
          completeness: group.completeness,
          reasons: group.reasons,
          minimum: point(row(group.points).minimum),
          median: point(row(group.points).median),
        })),
      })),
      slcsp: rows(answer.slcsp).map((entry) => ({
        profile_id: entry.profile_id,
        status: row(entry.result).status,
        slcsp_monthly_cents: row(entry.result).slcsp_monthly_cents,
        data_generation: row(entry.result).data_generation,
      })),
      input_manifest: row(answer.provenance).input_manifest ?? null,
      manifest_href: manifest,
      print_href: `/handy/allowance/print?${query}`,
    },
  };
  const text = JSON.stringify(result);
  const framed = JSON.stringify({
    content: [{ type: "text", text }],
    structuredContent: result,
  });
  // Leave 4 KiB for JSON-RPC framing, request identifiers and transport metadata.
  if (
    Buffer.byteLength(text) > 24 * 1024 ||
    Buffer.byteLength(framed) > 60 * 1024
  )
    throw new Error("RESULT_TOO_LARGE");
  return result;
}
