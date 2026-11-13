import { describe, expect, it } from "vitest";
import {
  checkResponse,
  reasonsIn,
  refusedEstimate,
  summarize,
  unexplainedRecords,
} from "../../scripts/oracle/surface-sweep-logic.mjs";

// SYNTHETIC responses in the shapes the sweep reads; no value here is source evidence.
const plan = { plan_id: "00000TX0000001", name: "Synthetic plan" };

describe("surface sweep pass rule", () => {
  it("passes an answer with items and an empty answer that names its reason", () => {
    expect(
      checkResponse({
        status: 200,
        body: { issues: [], plans: [plan] },
        items: [plan],
      }),
    ).toEqual([]);
    for (const body of [
      { issues: ["state_catalog_not_loaded"], plans: [] },
      { data: { location_issues: ["zip_limited_service_area"], plans: [] } },
      { status: "unknown", reason: "zip_not_in_loaded_geography" },
      { error: { code: "INVALID_INPUT", field: "zip" } },
      { status: "error", data: null, error: { code: "NOT_FOUND" } },
    ])
      expect(checkResponse({ status: 200, body, items: [] })).toEqual([]);
    expect(
      checkResponse({
        status: 200,
        body: { plans: [] },
        gaps: "state_catalog_not_loaded",
        items: [],
      }),
    ).toEqual([]);
  });

  it("fails a 5xx, an honesty check and an empty answer without a reason", () => {
    expect(
      checkResponse({
        status: 500,
        body: { error: { code: "INTERNAL_ERROR" } },
      }),
    ).toEqual(["http_5xx"]);
    // The old NY plan-key bug: MCP search_plans answered every loaded NY county like this.
    expect(
      checkResponse({
        status: 400,
        body: {
          status: "error",
          data: null,
          error: { code: "INTERNAL_HONESTY_CHECK", field: null },
        },
        items: [],
      }),
    ).toEqual(["internal_honesty_check"]);
    expect(
      checkResponse({
        status: 200,
        body: { thrown: "INTERNAL_HONESTY_CHECK: plan_ref is not a plan key" },
      }),
    ).toEqual(["internal_honesty_check"]);
    for (const body of [
      { issues: [], plans: [] },
      { data: { location_issues: [], plans: [] }, error: null },
      { status: "unknown", reason: null },
      { error: null },
    ])
      expect(checkResponse({ status: 200, body, items: [] })).toEqual([
        "empty_without_reason",
      ]);
  });

  it("counts a specific status as a reason, never a generic one", () => {
    for (const body of [
      { status: "ambiguous", issues: [], plans: [] },
      { location: { status: "ambiguous" }, slcsp_monthly_cents: null },
      { status: "unsupported_state", reason: null },
      { data: { location_status: "multiple_counties", plans: [] } },
    ])
      expect(checkResponse({ status: 200, body, items: [] })).toEqual([]);
    for (const body of [
      { status: "unknown", issues: [], plans: [] },
      { status: "available", location: { status: "available" }, plans: [] },
      { status: "ok", data: { location_status: "available", plans: [] } },
    ])
      expect(checkResponse({ status: 200, body, items: [] })).toEqual([
        "empty_without_reason",
      ]);
  });

  it("fails the MCP catch-all error, the tools' form of an internal error", () => {
    expect(
      checkResponse({
        status: 400,
        body: {
          status: "error",
          data: null,
          error: { code: "DATA_UNAVAILABLE", field: null, retryable: false },
        },
        items: [],
      }),
    ).toEqual(["mcp_internal_error"]);
  });

  it("skips the emptiness rule where the surface has no list", () => {
    expect(checkResponse({ status: 200, body: { results: [] } })).toEqual([]);
  });

  it("collects reason codes at any depth and from the gaps header", () => {
    expect(
      reasonsIn(
        { a: { b: [{ reason: "x" }] }, issues: ["y"], error: { code: "z" } },
        "g1, g2",
      ),
    ).toEqual(["g1", "g2", "x", "y", "z"]);
  });

  it("asks every unknown record inside an answer for its own reason", () => {
    // The MCP coverage answer that dropped the native reason, before the fix.
    const dropped = {
      kind: "drug_coverage",
      status: "unknown",
      gaps: ["SOURCE_METADATA_UNAVAILABLE"],
    };
    const kept = { ...dropped, gaps: ["source_set_not_available"] };
    const listed = { kind: "participation", status: "listed_participating" };
    expect(unexplainedRecords([listed, kept])).toEqual([]);
    expect(unexplainedRecords([listed, dropped])).toEqual([dropped]);
    expect(unexplainedRecords([{ status: "unknown", reason: "x" }])).toEqual(
      [],
    );
    expect(unexplainedRecords([{ rows: [] }])).toHaveLength(1);
    expect(
      checkResponse({
        status: 200,
        body: { data: { results: [dropped] } },
        records: [dropped],
      }),
    ).toEqual(["record_unknown_without_reason"]);
    // A reason elsewhere in the response does not explain this record.
    expect(
      checkResponse({
        status: 200,
        body: { reason: "other", data: { results: [dropped] } },
        records: [dropped],
      }),
    ).toEqual(["record_unknown_without_reason"]);
  });

  it("counts a gap as a reason, never the generic metadata gap", () => {
    expect(reasonsIn({ gaps: ["SOURCE_METADATA_UNAVAILABLE"] })).toEqual([]);
    expect(
      reasonsIn({ gaps: ["SOURCE_METADATA_UNAVAILABLE", "not_run_budget"] }),
    ).toEqual(["not_run_budget"]);
  });

  it("accepts only a closed answer or an error code as an estimator refusal", () => {
    const head = {
      plan_key: "H0000-001-0",
      contract_year: 2026,
      bindable_quote: false,
      price_basis: "none",
      estimate_scope: "supplied_schedule",
    };
    expect(
      refusedEstimate({
        status: 200,
        body: {
          ...head,
          status: "unknown",
          reason: "estimator_disabled",
          as_of: null,
        },
      }),
    ).toBe(true);
    expect(
      refusedEstimate({
        status: 400,
        body: { error: { code: "jsonrpc_-32602" } },
      }),
    ).toBe(true);
    expect(refusedEstimate({ status: 503, body: { error: {} } })).toBe(false);
    expect(
      refusedEstimate({
        status: 200,
        body: { ...head, status: "unknown", reason: null },
      }),
    ).toBe(false);
    // SYNTHETIC figures: an answer with any field beyond the closed head is not a refusal.
    expect(
      refusedEstimate({
        status: 200,
        body: { ...head, status: "unknown", reason: "x", fills: [] },
      }),
    ).toBe(false);
    expect(
      refusedEstimate({ status: 200, body: { ...head, status: "estimated" } }),
    ).toBe(false);
  });

  it("groups failures by class and surface, with sample inputs", () => {
    const failures = [1, 2, 3].map((n) => ({
      class: "empty_without_reason",
      surface: "GET /v1/plans",
      input: { county: `0000${n}` },
    }));
    const [group] = summarize(failures, 2);
    expect(group.count).toBe(3);
    expect(group.examples.map((e) => e.input.county)).toEqual([
      "00001",
      "00002",
    ]);
  });
});
