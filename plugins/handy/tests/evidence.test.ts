import { expect, it } from "vitest";
import {
  allowanceEvidence,
  allowanceBenchmark,
} from "../../../src/services/allowance-evidence.js";
import { rowProvenanceLeaks } from "../../../src/db/row-provenance.js";
import {
  allowanceJson,
  distributionPage,
  MAX_ALLOWANCE_BYTES,
} from "../src/allowance/evidence.js";
import { allowanceScenario } from "../src/allowance/service.js";
import { allowanceMcpAnswer } from "../src/allowance/mcp.js";
import { allowanceSourceManifest } from "../src/allowance/sheet.js";

// Synthetic dense evidence: source coordinates stand in for large publisher rows.
const source = {
  catalog: {
    plan_id: "synthetic-plan",
    snapshot_id: "synthetic-attributes",
    source_row: 7,
  },
  attributes: [
    {
      source_row: 7,
      created_at: "internal",
      raw: {
        ChildOnlyOffering: "Allows Adult and Child-Only",
        padding: "x".repeat(100_000),
      },
    },
  ],
  rating: {
    status: "rated",
    total_cents: 10000,
    provenance: {
      snapshot_ids: { rate: "synthetic-rates" },
      rating_rule: {
        snapshot_id: "synthetic-rule",
        method: "per_member",
        citation: "synthetic rule",
        updated_at: "internal",
      },
    },
    members: [
      {
        member_id: "1",
        age: 40,
        charged: true,
        premium_cents: 10000,
        rate_rows: [
          { provenance: { snapshot_id: "synthetic-rates", source_row: 8 } },
        ],
      },
    ],
    rate_rows_used: [
      { provenance: { snapshot_id: "synthetic-rates", source_row: 8 } },
    ],
  },
};
const input = {
  zip: "77002",
  county: "48201",
  year: 2026,
  preset: "family-40-40-10-8-v1" as const,
};
function dense() {
  const evidence = Array.from({ length: 1600 }, (_, index) => ({
    ...allowanceEvidence(source),
    catalog: {
      plan_id: `synthetic-${index}`,
      snapshot_id: "synthetic-attributes",
      source_row: index + 1,
    },
  }));
  return {
    evidence_format: "source-references-v1",
    data_generation: "synthetic-generation",
    status: "calculated",
    location: { zip: input.zip, county: input.county },
    provenance: {
      input_manifest: "synthetic-manifest",
      snapshots: [
        "synthetic-attributes",
        "synthetic-rates",
        "synthetic-rule",
      ].map((snapshot_id) => ({
        snapshot_id,
        sha256: "synthetic-hash",
        publisher: "synthetic publisher",
      })),
      evidence,
      excluded: [
        {
          plan_id: "synthetic-excluded",
          reason: "off_exchange",
          evidence_ref: 1599,
        },
      ],
    },
    profiles: [
      "employee_only",
      "employee_spouse",
      "employee_spouse_child",
      "employee_spouse_children",
    ].map((id, profile) => ({
      id,
      members: [{ age: 40, relationship: "subscriber", tobacco: false }],
      lowest_silver: {
        monthly_cents: 10000,
        evidence_refs: [profile],
        denominator: 400,
      },
      metals: [
        {
          metal: "silver",
          status: "calculated",
          counts: { eligible: 400 },
          completeness: { catalog: "complete", rates: "complete" },
          reasons: [],
          points: {
            minimum: {
              monthly_cents: 10000,
              evidence_refs: [profile],
              denominator: 400,
            },
          },
          candidates: Array.from({ length: 400 }, (_, index) => ({
            plan_id: `synthetic-${profile * 400 + index}`,
            evidence_ref: profile * 400 + index,
            monthly_cents: 10000,
            status: "rated",
          })),
        },
      ],
    })),
  };
}

it("replaces publisher payloads and internal columns with complete source coordinates", () => {
  const compact = allowanceEvidence(source);
  expect(compact.source_refs).toEqual(
    expect.arrayContaining([
      { snapshot_id: "synthetic-attributes", source_row: 7 },
      { snapshot_id: "synthetic-rates", source_row: 8 },
      { snapshot_id: "synthetic-rule" },
    ]),
  );
  expect(compact.rating).toMatchObject({
    total_cents: 10000,
    members: [{ premium_cents: 10000 }],
  });
  expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThan(2000);
  expect(rowProvenanceLeaks(compact)).toEqual([]);
  expect(JSON.stringify(compact)).not.toContain('"raw"');
  const benchmark = allowanceBenchmark({
    status: "calculated",
    slcsp_monthly_cents: 10000,
    lowest_silver_plans: [
      { plan_id: "synthetic-plan", provenance: source.rating.provenance },
    ],
    pediatric_dental: { evidence: [source] },
  });
  expect(benchmark.source_refs).toEqual(
    expect.arrayContaining([{ snapshot_id: "synthetic-rates", source_row: 8 }]),
  );
});

it("keeps filed-detail row numbers with their own snapshot and retains hashed policy citations", () => {
  const refused = allowanceEvidence({
    refused: {
      snapshot_id: "synthetic-refusal",
      attribute_snapshot_id: "synthetic-detail",
      source_rows: [7],
    },
  });
  expect(refused.source_refs).toContainEqual({
    snapshot_id: "synthetic-refusal",
  });
  expect(refused.source_refs).toContainEqual({
    snapshot_id: "synthetic-detail",
    source_row: 7,
  });
  expect(refused.source_refs).not.toContainEqual({
    snapshot_id: "synthetic-refusal",
    source_row: 7,
  });
  const compact = allowanceEvidence({
    catalog: {
      plan_id: "synthetic-filed",
      snapshot_id: "synthetic-filed-import",
      source_row: 10,
    },
    attributes: [{ source_row: 7, raw: { MetalLevel: "Silver" } }],
    filed_entries: [
      {
        exchange_evidence: {
          snapshot_id: "synthetic-detail",
          source_rows: [7],
        },
      },
    ],
    rating: {
      provenance: {
        tobacco_policy: {
          provenance: {
            source_sha256: "synthetic-policy-hash",
            source_locator: "synthetic policy row",
            reference: "https://example.test/policy",
          },
        },
      },
    },
  });
  expect(compact.source_refs).toContainEqual({
    snapshot_id: "synthetic-detail",
    source_row: 7,
  });
  expect(compact.source_refs).not.toContainEqual({
    snapshot_id: "synthetic-filed-import",
    source_row: 7,
  });
  expect(compact.source_refs).toContainEqual({
    source_sha256: "synthetic-policy-hash",
    source_locator: "synthetic policy row",
    reference: "https://example.test/policy",
  });
});

it("reconstructs every candidate and classification through bounded absolute-index pages", () => {
  const raw = dense();
  const seen: number[] = [];
  const candidates: string[] = [];
  for (let page = 1; ; page++) {
    const result = distributionPage(raw, page);
    expect(Buffer.byteLength(allowanceJson(result))).toBeLessThan(
      MAX_ALLOWANCE_BYTES,
    );
    for (const entry of result.provenance.evidence)
      seen.push(entry.evidence_ref);
    for (const profile of result.profiles)
      for (const group of profile.metals)
        for (const candidate of group.candidates) {
          expect(
            result.provenance.evidence.some(
              (entry) => entry.evidence_ref === candidate.evidence_ref,
            ),
          ).toBe(true);
          candidates.push(String(candidate.plan_id));
        }
    if (result.evidence_pagination.next_page === null) {
      expect(result.provenance.excluded).toHaveLength(1);
      break;
    }
  }
  expect(seen).toEqual(raw.provenance.evidence.map((_, index) => index));
  expect(new Set(candidates).size).toBe(1600);
});

it("refuses a dropped evidence record or source pin and an unbounded evidence mutant", () => {
  const raw = dense();
  const missing = structuredClone(raw);
  missing.provenance.evidence.pop();
  expect(() => distributionPage(missing, 1)).toThrow(
    "EVIDENCE_REFERENCE_MISSING",
  );
  const noPin = structuredClone(raw);
  noPin.provenance.snapshots.pop();
  expect(() => distributionPage(noPin, 1)).toThrow("EVIDENCE_SNAPSHOT_MISSING");
  const noPointRef = structuredClone(raw);
  noPointRef.profiles[0]!.lowest_silver.evidence_refs = [];
  expect(() => distributionPage(noPointRef, 1)).toThrow(
    "EVIDENCE_REFERENCE_MISSING",
  );
  const noDigest = structuredClone(raw);
  noDigest.provenance.snapshots[0]!.sha256 = "";
  expect(() => distributionPage(noDigest, 1)).toThrow(
    "EVIDENCE_SNAPSHOT_MISSING",
  );
  expect(() =>
    allowanceJson({ ...distributionPage(raw, 1), provenance: raw.provenance }),
  ).toThrow("RESULT_TOO_LARGE");
  expect(() => distributionPage(raw, 0)).toThrow("INVALID_EVIDENCE_PAGE");
});

it("keeps REST, manifest and complete MCP frames bounded, with generation-pinned next links", async () => {
  const raw = dense();
  const host = {
    householdDistributions: async () => raw,
    slcsp: async () => ({
      status: "calculated",
      data_generation: raw.data_generation,
      slcsp_monthly_cents: 12000,
      source_refs: [{ snapshot_id: "synthetic-rates", source_row: 8 }],
    }),
  } as never;
  const answer = await allowanceScenario(
    host,
    { db: {} as never, signal: new AbortController().signal },
    input,
  );
  expect(Buffer.byteLength(allowanceJson(answer))).toBeLessThan(65536);
  expect(
    Buffer.byteLength(allowanceJson(allowanceSourceManifest(answer))),
  ).toBeLessThan(65536);
  expect(answer.evidence_pagination).toMatchObject({
    next_page: 2,
    total: 1604,
    next_href: expect.stringContaining(
      "data_generation=synthetic-generation&evidence_page=2",
    ) as unknown,
  });
  const mcp = allowanceMcpAnswer(answer, input);
  const framed = {
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [{ type: "text", text: JSON.stringify(mcp) }],
      structuredContent: mcp,
    },
  };
  expect(Buffer.byteLength(JSON.stringify(framed))).toBeLessThan(65536);
});
