import { readFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/app.js";
import type { SqlSession } from "../../src/db/database.js";
import { InputError } from "../../src/api/validation.js";
import { ReadError } from "../../src/services/errors.js";
import { errorResult } from "../../src/mcp/tools.js";
import { assertErrorShape } from "../error-shape.js";
import { checkResponses } from "../response-columns.js";
import { importMutant, withMutantFile } from "../mutant-file.js";
import { replaceSyntax } from "../source-mutation.js";

const unavailable: SqlSession = {
  query: async () => {
    throw new Error("Synthetic outage");
  },
  exec: async () => {},
};
afterEach(() => vi.restoreAllMocks());

it("uses the house shape for availability, native, compatibility and unknown-route failures", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const app = createApp(unavailable, { publicCompat: true });
  for (const path of [
    "/v1/data-availability",
    "/v1/data-availability?year=bad",
    "/v1/plans?year=bad",
    "/compat/v1/zip_counties",
    "/compat/v1/drugs?search_term=x",
    "/v1/no-such-route",
    "/compat/v1/no-such-route",
    "/no-such-route",
    "/healthz",
    "/readyz",
  ]) {
    const response = await app.request(path);
    expect(response.status, path).toBeGreaterThanOrEqual(400);
    expect(response.headers.get("content-type"), path).toContain("json");
    assertErrorShape(await response.json());
  }
});

it("structures and redacts unexpected top-level failures", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const app = createApp(unavailable);
  app.get("/synthetic-failure", () => {
    throw new Error("Synthetic private detail");
  });
  const response = await app.request("/synthetic-failure");
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({
    error: {
      code: "internal_error",
      request_id: expect.any(String) as unknown,
    },
  });
});

it("maps REST service errors into structured MCP tool errors", () => {
  for (const error of [
    new InputError("year", "invalid_year"),
    new ReadError({ code: "plan_not_found", field: "plan_id" }),
  ]) {
    const result = errorResult(
      "get_data_status",
      error,
      "unknown",
      "2026-01-01T00:00:00.000Z",
    );
    assertErrorShape(result.structuredContent);
    expect(result.structuredContent.error).toMatchObject({
      code: error instanceof ReadError ? error.error.code : error.code,
      field: error instanceof ReadError ? error.error.field : error.field,
    });
  }
});

it("rejects a planted string error in a disposable app source", async () => {
  const source = new URL("../../src/api/app.ts", import.meta.url);
  const original = await readFile(source, "utf8");
  await withMutantFile(
    source,
    replaceSyntax(
      original,
      'apiError("data_availability_unavailable")',
      '{ error: "data_availability_unavailable" }',
    ),
    async (temporary) => {
      const mutant = await importMutant<{ createApp: typeof createApp }>(
        temporary,
        "createApp",
      );
      const app = checkResponses(mutant.createApp(unavailable));
      await expect(app.request("/v1/data-availability")).rejects.toThrow(
        "error object",
      );
    },
  );
});

it.each([
  {},
  { error: "planted" },
  { error: null },
  { error: {} },
  { error: { code: "" } },
  { error: { code: 123 } },
])("rejects malformed error %j", (body) => {
  expect(() => assertErrorShape(body)).toThrow();
});
