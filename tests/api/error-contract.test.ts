import { afterEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { createApp } from "../../src/api/app.js";
import { apiError, apiErrorFrom, snakeCode } from "../../src/api/errors.js";
import type { SqlSession } from "../../src/db/database.js";
import { REASON_CODES } from "../../src/api/reason-codes.js";
import { withUnknownReasons } from "../../src/services/availability.js";
import {
  assertErrorShape,
  assertRequestId,
  mountedRoutes,
  unknownsWithoutReason,
} from "../error-shape.js";
import { contract } from "../public-contract.js";

const unavailable: SqlSession = {
  query: async () => {
    throw new Error("Synthetic outage");
  },
  exec: async () => {},
};
afterEach(() => vi.restoreAllMocks());

/** Fail with the first route whose forced failure is not the house error shape. */
export async function routesOffShape(app: Hono): Promise<string[]> {
  const bad: string[] = [];
  for (const { method, path } of mountedRoutes(app)) {
    try {
      const response = await app.request(path, {
        method,
        ...(method === "POST"
          ? { body: "{", headers: { "content-type": "application/json" } }
          : {}),
      });
      if (response.status < 400) continue;
      if (!response.headers.get("content-type")?.includes("json"))
        throw new Error("not JSON");
      const body: unknown = await response.json();
      assertErrorShape(body);
      assertRequestId(response, body);
    } catch (error) {
      bad.push(`${method} ${path}: ${(error as Error).message}`);
    }
  }
  return bad;
}

describe("one error shape for every route family", () => {
  it("answers every mounted route's forced failure with { error: { code } } in lower snake case", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const app = createApp(unavailable, { publicCompat: true });
    expect(mountedRoutes(app).length).toBeGreaterThan(40);
    expect(await routesOffShape(app)).toEqual([]);
  });

  it("builds bodies with apiError and normalises casing", () => {
    expect(apiError("INVALID_INPUT", "year", "Use four digits.")).toEqual({
      error: { code: "invalid_input", field: "year", hint: "Use four digits." },
    });
    expect(apiError("rate_limited")).toEqual({
      error: { code: "rate_limited" },
    });
    expect(snakeCode("dataChanged")).toBe("data_changed");
    expect(
      apiErrorFrom({
        code: "PLAN_NOT_FOUND",
        message: "No such plan",
        year: 2026,
      }),
    ).toEqual({
      error: { code: "plan_not_found", hint: "No such plan", year: 2026 },
    });
  });

  it("fails a planted route that answers a string error (mutant 1)", async () => {
    const app = createApp(unavailable);
    app.get("/v1/planted-string-error", (c) => c.json({ error: "x" }, 400));
    expect(await routesOffShape(app)).toEqual([
      expect.stringContaining("GET /v1/planted-string-error"),
    ]);
  });

  it("fails a planted upper-case code and a planted non-JSON error", async () => {
    const app = createApp(unavailable);
    app.get("/v1/planted-upper", (c) =>
      c.json({ error: { code: "INVALID_INPUT" } }, 400),
    );
    app.get("/v1/planted-text", (c) => c.text("nope", 500));
    const bad = await routesOffShape(app);
    expect(bad).toHaveLength(2);
  });

  it("carries the JSON-RPC rate limit in the same code vocabulary", () => {
    expect(apiError("rate_limited").error.code).toBe("rate_limited");
    expect(contract.errors.rest.optional).toEqual({
      field: "string",
      hint: "string",
    });
  });
});

describe("unknown always says why", () => {
  it("lists every reason code the surfaces share in the contract vocabulary", () => {
    for (const { code } of REASON_CODES)
      expect(contract.reasons.codes, code).toContain(code);
    expect([...contract.reasons.codes].sort()).toEqual(contract.reasons.codes);
    for (const code of contract.reasons.codes)
      expect(code).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/);
  });

  it("gives an availability row a reason for every unknown status", () => {
    const row = withUnknownReasons({
      catalog_status: "unknown",
      premium_status: "unknown",
      provider_status: "available",
      drug_status: "unknown",
      drug_coverage: { status: "unknown", reason: "source_set_not_available" },
      formulary_status: "unknown",
    });
    expect(unknownsWithoutReason(row)).toEqual([]);
    expect(row).toMatchObject({
      catalog_reason: "catalog_not_loaded",
      premium_reason: "premium_not_available",
      formulary_reason: "source_set_not_available",
    });
    expect(row).not.toHaveProperty("drug_reason");
    for (const key of Object.keys(row).filter((k) => k.endsWith("_reason")))
      expect(contract.reasons.codes).toContain(
        (row as unknown as Record<string, string>)[key],
      );
  });

  it("fails a planted unknown without a reason (mutant 2)", () => {
    expect(
      unknownsWithoutReason([
        { status: "unknown", reason: "catalog_not_loaded" },
        { status: "unknown" },
        { provider_status: "unknown" },
        { provider_status: "unknown", provider_coverage: { reason: "x" } },
      ]),
    ).toEqual(["$[1]", "$[2].provider_status"]);
  });
});
