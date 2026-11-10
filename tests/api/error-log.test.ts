// Synthetic failures and request sentinels; no external transport or database.
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/app.js";
import { logInternalError } from "../../src/api/error-log.js";
import type { SqlSession } from "../../src/db/database.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each(["native", "compat", "root"])(
  "logs only exception class and stack hash for %s 500s",
  async (kind) => {
    const error = new TypeError("synthetic-private-key-and-request-value");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const fail = async () => {
      throw error;
    };
    const db: SqlSession = { query: fail, exec: fail };
    vi.stubEnv("OPENPLANS_API_CACHE_MB", "0");
    vi.stubEnv("OPENPLANS_COMPAT_API_KEY", "");
    const app = createApp(db);
    app.get("/synthetic-error", () => {
      throw error;
    });
    let path = "/synthetic-error";
    let body: unknown;
    if (kind === "native") {
      path = "/v1/quotes";
      body = { year: 2026, county: "48201", members: [{ age: 35 }] };
    }
    if (kind === "compat") {
      path = "/compat/v1/plans/medical/search";
      body = {
        fips_code: "48201",
        market: "individual",
        applicants: [{ age: 35 }],
        enrollment_date: "2026-01-01",
      };
    }
    const response = await app.request(path, {
      method: kind === "root" ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    expect(response.status).toBe(500);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0]![0])).toEqual({
      event: "api_internal_error",
      error_class: "TypeError",
      stack_hash: createHash("sha256").update(error.stack!).digest("hex"),
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain(error.message);
    expect(await response.text()).not.toContain(error.message);
  },
);

it("keeps non-Error payloads and unsafe class names out of logs", () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  logInternalError({ secret: "synthetic-secret" });
  const error = new Error("synthetic-secret");
  Object.defineProperty(error, "constructor", {
    value: { name: "unsafe class synthetic-secret" },
  });
  logInternalError(error);
  expect(
    log.mock.calls.map(([entry]) => JSON.parse(entry).error_class),
  ).toEqual(["UnknownError", "Error"]);
  expect(JSON.stringify(log.mock.calls)).not.toContain("synthetic-secret");
});
